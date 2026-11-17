import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { mailAttachments } from './mail-attachments.mjs';
import { classify } from '../src/model.mjs';

const mailboxAddress = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
const messageId = /^<[^<>\s]+>$/u;
const standardFolders = new Map([
 ['\\Inbox','Inbox'], ['\\Sent','Sent'], ['\\Archive','Archive'], ['\\Trash','Trash'], ['\\Junk','Spam'],
]);
const folderAliases = new Map([
 ['inbox','Inbox'], ['sent','Sent'], ['sent items','Sent'], ['archive','Archive'],
 ['trash','Trash'], ['deleted items','Trash'], ['spam','Spam'], ['junk','Spam'],
]);

export function ionosConfig(env) {
 if (env.A2Z_MODE !== 'live' || env.A2Z_ENABLE_LIVE !== 'true') {
  throw new Error('Enable A2Z_MODE=live and A2Z_ENABLE_LIVE=true to start the local IONOS app.');
 }
 const email = env.IONOS_EMAIL?.trim();
 const pass = env.IONOS_PASSWORD;
 if (!email || !mailboxAddress.test(email) || !pass) {
  throw new Error('Set IONOS_EMAIL and IONOS_PASSWORD to your IONOS mailbox login.');
 }
 const smtpPort = Number(env.IONOS_SMTP_PORT || 465);
 if (![465,587].includes(smtpPort)) throw new Error('Use IONOS SMTP port 465 or 587.');
 const auth = {user:email, pass};
 return {
  email,
  imap:{host:env.IONOS_IMAP_HOST||'imap.ionos.com',port:Number(env.IONOS_IMAP_PORT||993),secure:true,auth,logger:false,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:30000},
  smtp:{host:env.IONOS_SMTP_HOST||'smtp.ionos.com',port:smtpPort,secure:smtpPort===465,requireTLS:smtpPort===587,auth,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:30000},
 };
}

function addressList(items) {
 return (items||[]).map(address=>address.address).filter(Boolean).join(', ');
}

function mimeReferences(parsed, envelope) {
 const raw = parsed?.references;
 const items = Array.isArray(raw) ? raw : raw?.match(/<[^<>\s]+>/g) || [];
 const fallback = parsed?.inReplyTo || envelope?.inReplyTo;
 return [...new Set([...items, fallback].filter(id => typeof id === 'string' && messageId.test(id)))];
}

function bidDue(subject, body) {
 const match = (subject+'\n'+body).match(/\b(?:bid(?: submission)? (?:due|deadline)|proposals? due)\s*(?:on\s+|[:–-]\s*)?(\d{4}-\d{2}-\d{2})\b/i);
 if (!match) return undefined;
 const candidate = new Date(match[1]+'T12:00:00Z');
 return !Number.isNaN(candidate.getTime()) && candidate.toISOString().startsWith(match[1]) ? match[1] : undefined;
}

const detailLimit = 1024 * 1024;

function messageLocation(id) {
 return typeof id === 'string' && id.length <= 2048 && id.match(/^(.+):(\d+):([1-9]\d*)$/s);
}

function textParts(node) {
 if (!node || node.disposition==='attachment' || node.dispositionParameters?.filename || node.parameters?.name) return [];
 if (node.type?.startsWith('multipart/')) return (node.childNodes||[]).flatMap(textParts);
 if (node.type==='text/plain' || node.type==='text/html') return [{type:node.type,part:node.part||'1'}];
 return [];
}

const inlineImageTypes = new Set(['image/png','image/jpeg','image/gif','image/webp']);
const imageBudget = 1024 * 1024;

function relatedImages(node) {
 if (!node) return [];
 if (node.type?.startsWith('multipart/')) return (node.childNodes||[]).flatMap(relatedImages);
 if (!node.part || !node.id || !inlineImageTypes.has(node.type)) return [];
 return [{...node,cid:node.id.replace(/^<|>$/g,'').toLowerCase()}];
}

async function readPart(imap,uid,part,limit) {
 const {content} = await imap.download(uid,part,{uid:true,maxBytes:limit+1});
 if (!content) return null;
 const chunks=[];
 let size=0;
 for await (const chunk of content) {
  chunks.push(chunk);
  size+=chunk.length;
  if (size>limit) break;
 }
 return {raw:Buffer.concat(chunks).subarray(0,limit),truncated:size>limit};
}

export function createIonosMailbox(config, {Imap=ImapFlow, parser=simpleParser, transport=nodemailer.createTransport}={}) {
 const smtp = transport(config.smtp);
 async function saveSent(message) {
  const imap = new Imap(config.imap);
  imap.on?.('error',()=>{});
  try {
   await imap.connect();
   const folders=await imap.list();
   const sent=folders.find(folder=>folder.specialUse==='\\Sent') ||
    folders.find(folder=>folderAliases.get(folder.path.toLowerCase())==='Sent');
   if (!sent) return false;
   const mime=await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail(message);
   return Boolean(await imap.append(sent.path,mime.message,['\\Seen']));
  } catch { return false; }
  finally {imap.close();}
 }
 let fetching;
 async function readMail() {
  const imap = new Imap(config.imap);
  imap.on?.('error',()=>{});
  const mail = [];
  const contacts = new Map();
  let previewBudget = 3_000_000;
  try {
   await imap.connect();
   const folders = await imap.list();
   const priority = entry => entry.path.toUpperCase()==='INBOX'?0:entry.specialUse==='\\Sent'?1:2;
   folders.sort((a,b)=>priority(a)-priority(b));
   for (const entry of folders) {
    if (entry.flags.has('\\Noselect') || entry.specialUse === '\\Drafts' || /(?:^|[./])drafts$/i.test(entry.path)) continue;
    const folder = standardFolders.get(entry.specialUse) || folderAliases.get(entry.path.toLowerCase()) || entry.path;
    const lock = await imap.getMailboxLock(entry.path, {readOnly:true});
    try {
     const {exists,uidValidity} = imap.mailbox;
     if (!exists) continue;
     const count = folder === 'Inbox' ? 75 : 25;
     const range = Math.max(1,exists-count+1)+':'+exists;
     const metadata = await imap.fetchAll(range,{uid:true,envelope:true,internalDate:true,flags:true,size:true,bodyStructure:true});
     const eligible = metadata.slice().reverse().filter(item=>{
      if (item.size>768000 || item.size>previewBudget) return false;
      previewBudget -= item.size;
      return true;
     }).map(item=>item.uid);
     const sources = eligible.length ? await imap.fetchAll(eligible,{uid:true,source:true},{uid:true}) : [];
     const rawByUid = new Map(sources.map(item=>[item.uid,item.source]));
     for (const item of metadata) {
      const raw = rawByUid.get(item.uid);
      const parsed = raw ? await parser(raw,{skipHtmlToText:false,skipImageLinks:true}).catch(()=>null) : null;
      const {envelope}=item;
      const from = addressList(envelope?.from);
      if (!['Spam','Trash'].includes(folder)) {
       for (const contact of [...(envelope?.from||[]),...(envelope?.to||[]),...(envelope?.cc||[])]) {
        const address = contact.address?.toLowerCase();
        if (!address || !mailboxAddress.test(address) || address===config.email.toLowerCase()) continue;
        if (!contacts.has(address) && contacts.size>=1000) continue;
        if (!contacts.get(address)?.name) contacts.set(address,{address,name:contact.name||''});
       }
      }
      const id = entry.path+':'+uidValidity+':'+item.uid;
      const headerId = parsed?.messageId || envelope?.messageId || '';
      const references = mimeReferences(parsed,envelope);
      const subject = envelope?.subject || '(No subject)';
      const body = (parsed?.text || '').slice(0,90000);
      const needsBody = !parsed || (parsed.text?.length || 0)>90000 || Boolean(parsed.html) || textParts(item.bodyStructure).some(part=>part.type==='text/html');
      const category = classify(subject,body,from);
      mail.push({
       id, thread:references[0]||headerId||id, name:envelope?.from?.[0]?.name||from||'Unknown sender',
       company:'', subject, body, needsBody, date:item.internalDate?.toISOString()||new Date(0).toISOString(),
       from,to:addressList(envelope?.to),cc:addressList(envelope?.cc),
       category,project:'',folder,unread:!item.flags.has('\\Seen'),star:item.flags.has('\\Flagged'),
       files:(parsed?.attachments||[]).map(file=>file.filename||'Attachment'),
       due:category==='Bid Invitations'?bidDue(subject,body):undefined,
       headers:{messageId:headerId,references},
      });
     }
    } finally { lock.release(); }
   }
   return {email:config.email,contacts:[...contacts.values()],mail:mail.sort((a,b)=>b.date.localeCompare(a.date))};
  } finally { imap.close(); }
 }

 return {
  mail() {
   if (!fetching) fetching = readMail().finally(()=>{fetching=undefined});
   return fetching;
  },
  async body(id) {
   const match = messageLocation(id);
   if (!match) throw new TypeError('Invalid message.');
   const [,path,generation,uid] = match;
   const imap = new Imap(config.imap);
   imap.on?.('error',()=>{});
   try {
    await imap.connect();
    const lock = await imap.getMailboxLock(path,{readOnly:true});
    try {
     if (String(imap.mailbox.uidValidity)!==generation) return null;
     const message = await imap.fetchOne(uid,{bodyStructure:true},{uid:true});
     if (!message) return null;
     if (!message.bodyStructure) throw new Error('IONOS did not return a message structure.');
     const parts = textParts(message.bodyStructure).sort((a,b)=>Number(a.type==='text/html')-Number(b.type==='text/html'));
     let body='', html='', truncated=false;
     const images=Object.create(null);
     for (const {part,type} of parts.slice(0,4)) {
      if ((type==='text/plain' && body.trim()) || (type==='text/html' && html)) continue;
      const result=await readPart(imap,uid,part,detailLimit);
      if (!result) continue;
      const text=result.raw.toString('utf8');
      if (type==='text/plain') {
       body=text;
       truncated=result.truncated;
       continue;
      }
      if (!body.trim()) {
       const mime = 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+result.raw.toString('base64');
       const parsed = await parser(mime,{skipHtmlToText:false,skipImageLinks:true});
       body=parsed.text||'';
       truncated=result.truncated;
      }
      if (!result.truncated && text.trim()) html=text;
     }
     if (html) {
      const requested = new Set([...html.matchAll(/\bcid:([^"'<>\s]+)/gi)].map(match=>{
       try {return decodeURIComponent(match[1]).toLowerCase();} catch {return match[1].toLowerCase();}
      }));
      let remaining=imageBudget;
      const candidates=relatedImages(message.bodyStructure).filter(image=>requested.has(image.cid)).slice(0,12);
      for (const image of candidates) {
       if (remaining<=0) break;
       if (image.size>remaining*1.5) continue;
       try {
        const result=await readPart(imap,uid,image.part,remaining);
        if (!result || result.truncated || !result.raw.length) continue;
        images[image.cid]='data:'+image.type+';base64,'+result.raw.toString('base64');
        remaining-=result.raw.length;
       } catch { /* A missing inline image should not hide the message. */ }
      }
     }
     return {body,truncated,...(html?{html,images}:{})};
    } finally {lock.release();}
   } finally {imap.close();}
  },
  async update(input) {
   const match = typeof input?.id==='string' && input.id.match(/^(.+):(\d+):(\d+)$/s);
   const patches = {read:'\\Seen',unread:'\\Seen',star:'\\Flagged',unstar:'\\Flagged'};
   const flag = Object.hasOwn(patches,input?.action) ? patches[input.action] : '';
   const destination = ['Inbox','Archive','Trash','Spam'].includes(input?.destination) ? input.destination : '';
   if (!match || (!flag && !(input.action==='move' && destination))) throw new TypeError('Invalid mailbox action.');
   const [,path,generation,uid] = match;
   const imap = new Imap(config.imap);
   imap.on?.('error',()=>{});
   try {
    await imap.connect();
    const folders = await imap.list();
    const target = destination && folders.find(entry=>!entry.flags.has('\\Noselect') &&
     (standardFolders.get(entry.specialUse)||folderAliases.get(entry.path.toLowerCase()))===destination);
    if (destination && !target) return {error:'That folder is unavailable in IONOS.'};
    const lock = await imap.getMailboxLock(path);
    try {
     if (String(imap.mailbox.uidValidity)!==generation) return {error:'The mailbox changed. Refresh and try again.'};
     if (target) {
      if (target.path!==path) await imap.messageMove(uid,target.path,{uid:true});
     } else if (['read','star'].includes(input.action)) {
      await imap.messageFlagsAdd(uid,[flag],{uid:true});
     } else {
      await imap.messageFlagsRemove(uid,[flag],{uid:true});
     }
     return {ok:true};
    } finally {lock.release();}
   } finally {imap.close();}
  },
  async send(input, uploaded=[]) {
   const addresses = value => typeof value === 'string' ? value.split(/[,;]/).map(part=>part.trim()).filter(Boolean) : [];
   const to = addresses(input?.to), cc = addresses(input?.cc);
   const {subject,body,id} = input || {};
   if (!to.length || to.length+cc.length>50 || [...to,...cc].some(value=>!mailboxAddress.test(value)) ||
       typeof subject!=='string' || !subject.trim() || subject.length>500 || /[\r\n]/.test(subject) ||
       typeof body!=='string' || !body.trim() || body.length>150000 ||
       typeof id!=='string' || !/^out-[0-9a-f-]{36}$/i.test(id)) {
    throw new TypeError('Enter valid recipients, a subject, and a message.');
   }
   const refs = Array.isArray(input.references) ? input.references.filter(ref=>typeof ref==='string'&&messageId.test(ref)).slice(-30) : [];
   const attachments=mailAttachments(input.attachments).map(file=>({
    filename:file.name,content:Buffer.from(file.data,'base64'),
   }));
   const message = {
    from:config.email,to,cc,subject,text:body,attachments:[...attachments,...uploaded],
    messageId:'<'+id+'@'+config.email.split('@')[1]+'>',
    references:refs,inReplyTo:refs.at(-1),disableFileAccess:true,disableUrlAccess:true,
   };
   const result = await smtp.sendMail(message);
   const sentSaved = await saveSent(message);
   return {messageId:result.messageId,rejected:result.rejected||[],sentSaved};
  },
 };
}
