import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { safeRasterType,signatureImage } from './signature-image.mjs';
import { MAX_STAGED_BYTES } from './staged-attachments.mjs';
import { mailAttachments } from './mail-attachments.mjs';
import { groqCategories } from './groq-classification.mjs';
import { classify,matchProject } from '../src/model.mjs';

const mailboxAddress = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
const messageId = /^<[^<>\s]+>$/u;
const standardFolders = new Map([
 ['\\Inbox','Inbox'], ['\\Sent','Sent'], ['\\Archive','Archive'], ['\\Trash','Trash'], ['\\Junk','Spam'],
]);
const folderAliases = new Map([
 ['inbox','Inbox'], ['sent','Sent'], ['sent items','Sent'], ['archive','Archive'],
 ['trash','Trash'], ['deleted items','Trash'], ['spam','Spam'], ['junk','Spam'],
]);
const retainedTrash = 'A2Z Trash';
const isRetainedTrash = entry => entry.path.toLowerCase() === retainedTrash.toLowerCase();
const folderName = entry => isRetainedTrash(entry) ? 'Trash' : standardFolders.get(entry.specialUse) || folderAliases.get(entry.path.toLowerCase()) || entry.path;
const isMailFolder = entry => !entry.flags.has('\\Noselect') && entry.specialUse !== '\\Drafts' && !/(?:^|[./])drafts$/i.test(entry.path);

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
  groqKey:env.GROQ_API_KEY?.trim(),
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

function attachedFiles(node) {
 if (!node) return [];
 if (node.type?.startsWith('multipart/')) return (node.childNodes||[]).flatMap(attachedFiles);
 const name=node.dispositionParameters?.filename||node.parameters?.name;
 if (!name && node.disposition!=='attachment' && node.type!=='message/rfc822') return [];
 if (node.id && node.disposition!=='attachment' && inlineImageTypes.has(node.type)) return [];
 return [{part:node.part||'1',name:String(name||'Attachment').replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180),
  type:node.type||'application/octet-stream',size:Number(node.size)||0}];
}

function previewType(file,content) {
 if ((file.type==='application/pdf'||/\.pdf$/i.test(file.name)) && content.subarray(0,5).toString()==='%PDF-') return 'application/pdf';
 const raster=safeRasterType(content);
 return raster || 'application/octet-stream';
}

export function forwardedReferences(input) {
 if (input===undefined) return [];
 if (!Array.isArray(input)||input.length>10) throw new TypeError('Forward up to 10 attachments.');
 return input.map(file=>{
  if (!messageLocation(file?.messageId)||typeof file.part!=='string'||!/^\d+(?:\.\d+)*$/.test(file.part)||file.part.length>64) {
   throw new TypeError('Invalid forwarded attachment.');
  }
  const name=typeof file.name==='string'?file.name.slice(0,180):'Attachment';
  return {messageId:file.messageId,part:file.part,name};
 });
}

async function readPart(imap,uid,part,limit,chunkSize) {
 const {content} = await imap.download(uid,part,{uid:true,maxBytes:limit+1,...(chunkSize?{chunkSize}:{})});
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

export function createIonosMailbox(config, {Imap=ImapFlow, parser=simpleParser, transport=nodemailer.createTransport,fetchGroq}={}) {
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
   const mime=await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail({...message,keepBcc:true});
   return Boolean(await imap.append(sent.path,mime.message,['\\Seen']));
  } catch { return false; }
  finally {imap.close();}
 }
 let fetching;
 async function readMail(includeTrash) {
  const imap = new Imap(config.imap);
  imap.on?.('error',()=>{});
  const mail = [];
  const contacts = new Map();
  let folders;
  let previewBudget = 3_000_000;
  try {
   await imap.connect();
   folders = (await imap.list()).filter(entry=>isMailFolder(entry)&&(includeTrash||folderName(entry)!=='Trash'));
   const priority = entry => entry.path.toUpperCase()==='INBOX'?0:entry.specialUse==='\\Sent'?1:2;
   folders.sort((a,b)=>priority(a)-priority(b));
   for (const entry of folders) {
    const folder = folderName(entry);
    const lock = await imap.getMailboxLock(entry.path, {readOnly:true});
    try {
     const {exists,uidValidity} = imap.mailbox;
     if (!exists) continue;
     const count = folder === 'Inbox' ? 75 : 25;
     const range = (folder==='Trash'?1:Math.max(1,exists-count+1))+':'+exists;
     const metadata = await imap.fetchAll(range,{uid:true,envelope:true,internalDate:true,flags:true,size:true,bodyStructure:true});
     const eligible = metadata.slice(-count).reverse().filter(item=>{
      if (item.flags.has('\\Deleted') || item.size>768000 || item.size>previewBudget) return false;
      previewBudget -= item.size;
      return true;
     }).map(item=>item.uid);
     const sources = eligible.length ? await imap.fetchAll(eligible,{uid:true,source:true},{uid:true}) : [];
     const rawByUid = new Map(sources.map(item=>[item.uid,item.source]));
     for (const item of metadata) {
      if (item.flags.has('\\Deleted')) continue;
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
      const attachments = attachedFiles(item.bodyStructure);
      mail.push({
       id, thread:references[0]||headerId||id, name:envelope?.from?.[0]?.name||from||'Unknown sender',
       company:'', subject, body, needsBody, date:item.internalDate?.toISOString()||new Date(0).toISOString(),
       from,to:addressList(envelope?.to),cc:addressList(envelope?.cc),bcc:folder==='Sent'?(addressList(envelope?.bcc)||addressList(parsed?.bcc?.value)):'',
       category,project:matchProject(subject+' '+body),folder,unread:!item.flags.has('\\Seen'),star:item.flags.has('\\Flagged'),
       files:attachments.length?attachments.map(file=>file.name):(parsed?.attachments||[]).map(file=>file.filename||'Attachment'),attachments,
       due:category==='Bid Invitations'?bidDue(subject,body):undefined,
       headers:{messageId:headerId,references},
      });
     }
    } finally { lock.release(); }
   }
  } finally { imap.close(); }
  const labels = await groqCategories(mail,config.email,config.groqKey,fetchGroq);
  for (const row of mail) {
   const category = labels.get(row.id);
   if (!category || category===row.category) continue;
   row.category = category;
   row.due = category==='Bid Invitations' ? bidDue(row.subject,row.body) : undefined;
  }
  return {email:config.email,folders:[...new Set(folders.map(folderName))],contacts:[...contacts.values()],mail:mail.sort((a,b)=>b.date.localeCompare(a.date))};
 }

 async function readConnection(operation) {
  const imap=new Imap(config.imap);
  imap.on?.('error',()=>{});
  try {await imap.connect();return await operation(imap);}
  finally {imap.close();}
 }

 async function readFolder(folder,operation) {
  return readConnection(async imap=>{
   const lock=await imap.getMailboxLock(folder,{readOnly:true});
   try {return await operation(imap);}
   finally {lock.release();}
  });
 }

 function messageMetadata(item,folder,generation) {
  const envelope=item.envelope||{};
  const flags=item.flags||new Set();
  return {
   id:folder+':'+generation+':'+item.uid,
   uid:item.uid,subject:envelope.subject||'(No subject)',
   date:item.internalDate?.toISOString()||null,
   sentAt:envelope.date?.toISOString()||null,
   from:addressList(envelope.from),to:addressList(envelope.to),cc:addressList(envelope.cc),bcc:addressList(envelope.bcc),
   replyTo:addressList(envelope.replyTo),messageId:envelope.messageId||'',inReplyTo:envelope.inReplyTo||'',
   flags:[...flags],bytes:item.size||0,attachments:attachedFiles(item.bodyStructure),
  };
 }

 const mailbox = {
  mail({includeTrash=true}={}) {
   if (!includeTrash) return readMail(false);
   if (!fetching) fetching = readMail(true).finally(()=>{fetching=undefined});
   return fetching;
  },
  folders() {
   return readConnection(async imap=>(await imap.list()).filter(
    folder=>!folder.flags.has('\\Noselect')).map(folder=>({path:folder.path,role:folder.specialUse||null})));
  },
  recentInbox(since) {
   return readFolder('INBOX',async imap=>{
    const generation=String(imap.mailbox.uidValidity);
    const uids=await imap.search({since},{uid:true})||[];
    const rows=[];
    for (let start=0;start<uids.length;start+=100) {
     const batch=await imap.fetchAll(uids.slice(start,start+100),{
      uid:true,envelope:true,internalDate:true,flags:true,
     },{uid:true});
     for (const item of batch) {
      if (item.internalDate>=since&&!item.flags?.has('\\Deleted')) rows.push(messageMetadata(item,'INBOX',generation));
     }
    }
    return rows.sort((a,b)=>a.uid-b.uid);
   });
  },
  messagePage(folder,{before,after,limit,generation}) {
   return readFolder(folder,async imap=>{
    const uidValidity=String(imap.mailbox.uidValidity);
    const uidNext=Number(imap.mailbox.uidNext);
    if (!Number.isSafeInteger(uidNext)||uidNext<1) throw new Error('IONOS did not provide the folder UID checkpoint.');
    const highWaterUid=uidNext-1;
    if (generation&&generation!==uidValidity) return {uidValidity,highWaterUid,resetRequired:true};
    const ascending=after!==undefined;
    let edge=ascending?after:Math.min(before??highWaterUid+1,highWaterUid+1);
    const uids=[];
    const windowSize=4096;
    // Bounded UID searches avoid downloading or enumerating the whole folder on every page.
    for (let step=0;step<4&&uids.length<limit;step++) {
     const low=ascending?edge+1:Math.max(1,edge-windowSize);
     const high=ascending?Math.min(highWaterUid,edge+windowSize):edge-1;
     if (low>high) break;
     const matches=await imap.search({uid:low+':'+high},{uid:true});
     const ordered=(matches||[]).sort(ascending?(a,b)=>a-b:(a,b)=>b-a);
     const available=limit-uids.length;
     const selected=ordered.slice(0,available);
     uids.push(...selected);
     edge=ordered.length>available?selected.at(-1):ascending?high:low;
    }
    const rows=uids.length
     ? await imap.fetchAll(uids,{uid:true,envelope:true,internalDate:true,flags:true,size:true,bodyStructure:true},{uid:true})
     : [];
    const byUid=new Map(rows.map(item=>[item.uid,item]));
    const messages=uids.filter(uid=>byUid.has(uid)).map(uid=>messageMetadata(byUid.get(uid),folder,uidValidity));
    const hasMore=ascending?edge<highWaterUid:edge>1;
    return {uidValidity,highWaterUid,messages,hasMore,next:hasMore?edge:null};
   });
  },
  async messageInfo(id,includeHeaders=false) {
   const match=messageLocation(id);
   if (!match) throw new TypeError('Invalid message ID.');
   const [,folder,generation,uid]=match;
   return readFolder(folder,async imap=>{
    if (String(imap.mailbox.uidValidity)!==generation) return null;
    const item=await imap.fetchOne(uid,{uid:true,envelope:true,internalDate:true,flags:true,size:true,bodyStructure:true,headers:includeHeaders},{uid:true});
    if (!item) return null;
    return {...messageMetadata(item,folder,generation),...(includeHeaders?{headers:item.headers?.toString('utf8')||''}:{})};
   });
  },
  async rawMessage(id,limit) {
   const match=messageLocation(id);
   if (!match) throw new TypeError('Invalid message ID.');
   const [,folder,generation,uid]=match;
   return readFolder(folder,async imap=>{
    if (String(imap.mailbox.uidValidity)!==generation) return null;
    const result=await readPart(imap,uid,undefined,limit,1024*1024);
    if (!result) return null;
    if (result.truncated) throw new TypeError('Original email exceeds the 96 MB export limit.');
    return {name:'message-'+uid+'.eml',type:'message/rfc822',content:result.raw};
   });
  },
  async body(id,{includeHtml=true,includeImages=true,includeSubject=false}={}) {
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
     const message = await imap.fetchOne(uid,{bodyStructure:true,...(includeSubject?{envelope:true}:{})},{uid:true});
     if (!message) return null;
     if (!message.bodyStructure) throw new Error('IONOS did not return a message structure.');
     const parts = textParts(message.bodyStructure).sort((a,b)=>Number(a.type==='text/html')-Number(b.type==='text/html'));
     let body='', html='', truncated=false;
     const images=Object.create(null);
     for (const {part,type} of parts.slice(0,4)) {
      if ((type==='text/plain' && body.trim()) || (type==='text/html' && (html||(!includeHtml&&body.trim())))) continue;
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
     if (html&&includeHtml&&includeImages) {
      const requested = new Set([...html.matchAll(/\bcid:([^"'<>\s]+)/gi)].map(match=>{
       try {return decodeURIComponent(match[1]).replace(/^<|>$/g,'').toLowerCase();} catch {return match[1].toLowerCase();}
      }));
      let remaining=imageBudget;
      const candidates=relatedImages(message.bodyStructure).filter(image=>requested.has(image.cid)).slice(0,12);
      for (const image of candidates) {
       if (remaining<=0) break;
       if (image.size>remaining*1.5) continue;
       try {
        const result=await readPart(imap,uid,image.part,remaining);
        if (!result || result.truncated || safeRasterType(result.raw)!==image.type) continue;
        images[image.cid]='data:'+image.type+';base64,'+result.raw.toString('base64');
        remaining-=result.raw.length;
       } catch { /* A missing inline image should not hide the message. */ }
      }
     }
     return {body,truncated,...(includeSubject?{subject:message.envelope?.subject||''}:{}),...(html&&includeHtml?{html,...(includeImages?{images}:{})}:{})};
    } finally {lock.release();}
   } finally {imap.close();}
  },
  async attachment(id,part,limit=MAX_STAGED_BYTES) {
   const match=messageLocation(id);
   if (!match || typeof part!=='string' || part.length>64 || !/^\d+(?:\.\d+)*$/.test(part)) throw new TypeError('Invalid attachment.');
   const [,path,generation,uid]=match;
   const imap=new Imap(config.imap);
   imap.on?.('error',()=>{});
   try {
    await imap.connect();
    const lock=await imap.getMailboxLock(path,{readOnly:true});
    try {
     if (String(imap.mailbox.uidValidity)!==generation) return null;
     const message=await imap.fetchOne(uid,{bodyStructure:true},{uid:true});
     const file=attachedFiles(message?.bodyStructure).find(item=>item.part===part);
     if (!file) return null;
     if (limit<=0) throw new TypeError('Attachments must total 24 MB or less.');
     const result=await readPart(imap,uid,part,limit);
     if (!result) return null;
     if (result.truncated) throw new TypeError(limit>MAX_STAGED_BYTES ? 'This attachment exceeds the download limit.' : 'Attachments must total 24 MB or less.');
     return {name:file.name,type:previewType(file,result.raw),content:result.raw};
    } finally {lock.release();}
   } finally {imap.close();}
  },
  async update(input) {
   const match = typeof input?.id==='string' && input.id.match(/^(.+):(\d+):(\d+)$/s);
   const patches = {read:'\\Seen',unread:'\\Seen',star:'\\Flagged',unstar:'\\Flagged'};
   const flag = Object.hasOwn(patches,input?.action) ? patches[input.action] : '';
   const destination = ['Inbox','Sent','Archive','Trash','Spam'].includes(input?.destination) ? input.destination : '';
   const permanent = input?.action==='delete-forever';
   if (!match || (!permanent && !flag && !(input.action==='move' && destination))) throw new TypeError('Invalid mailbox action.');
   const [,path,generation,uid] = match;
   const imap = new Imap(config.imap);
   imap.on?.('error',()=>{});
   try {
    await imap.connect();
    const folders = await imap.list();
    const source = folders.find(entry=>entry.path===path && !entry.flags.has('\\Noselect'));
    if (permanent && (!source || folderName(source)!=='Trash')) {
     return {error:'Move the message to Trash before deleting it forever.'};
    }
    if (permanent && !imap.capabilities.has('UIDPLUS')) {
     return {error:'This mail server cannot safely delete a single message forever.'};
    }
    let target;
    if (destination==='Trash') {
     if (source && folderName(source)==='Trash') return {ok:true};
     target=folders.find(entry=>isRetainedTrash(entry)&&!entry.flags.has('\\Noselect'));
     if (!target) {
      try { await imap.mailboxCreate(retainedTrash); } catch {
       // A concurrent move may already have created the folder.
      }
      target=(await imap.list()).find(entry=>isRetainedTrash(entry)&&!entry.flags.has('\\Noselect'));
     }
    } else if (destination) {
     target=folders.find(entry=>!entry.flags.has('\\Noselect') && folderName(entry)===destination);
    }
    if (destination && !target) return {error:'That folder is unavailable in IONOS.'};
    const lock = await imap.getMailboxLock(path);
    try {
     if (String(imap.mailbox.uidValidity)!==generation) return {error:'The mailbox changed. Refresh and try again.'};
     if (permanent) {
      if (!await imap.messageDelete(uid,{uid:true})) return {error:'The message could not be deleted. Refresh the mailbox and try again.'};
     } else if (target) {
      if (target.path!==path && !await imap.messageMove(uid,target.path,{uid:true})) {
       return {error:'The message could not be moved. Refresh the mailbox and try again.'};
      }
     } else if (['read','star'].includes(input.action)) {
      await imap.messageFlagsAdd(uid,[flag],{uid:true});
     } else {
      await imap.messageFlagsRemove(uid,[flag],{uid:true});
     }
     return {ok:true};
    } finally {lock.release();}
   } finally {imap.close();}
  },
  async send(input, uploaded=[], links=[]) {
   const addresses = value => typeof value === 'string' ? value.split(/[,;]/).map(part=>part.trim()).filter(Boolean) : [];
   const to = addresses(input?.to), cc = addresses(input?.cc), bcc = addresses(input?.bcc);
   const {subject,body,id} = input || {};
   if (!to.length&&!cc.length&&!bcc.length || to.length+cc.length+bcc.length>50 || [...to,...cc,...bcc].some(value=>!mailboxAddress.test(value)) ||
       typeof subject!=='string' || !subject.trim() || subject.length>500 || /[\r\n]/.test(subject) ||
       typeof body!=='string' || (!body.trim()&&!links.length) || body.length>150000 ||
       typeof id!=='string' || !/^out-[0-9a-f-]{36}$/i.test(id)) {
    throw new TypeError('Enter valid recipients, a subject, and a message.');
   }
   const refs = Array.isArray(input.references) ? input.references.filter(ref=>typeof ref==='string'&&messageId.test(ref)).slice(-30) : [];
   const attachments=mailAttachments(input.attachments).map(file=>({
    filename:file.name,content:Buffer.from(file.data,'base64'),
   }));
   const sources=forwardedReferences(input.forwardedAttachments);
   if (attachments.length+uploaded.length+sources.length>10) throw new TypeError('Attach up to 10 files.');
   let total=[...attachments,...uploaded].reduce((sum,file)=>sum+file.content.length,0);
   for (const source of sources) {
    const forwarded=await mailbox.attachment(source.messageId,source.part,MAX_STAGED_BYTES-total);
    if (!forwarded) throw new TypeError('An original attachment moved or is unavailable. Refresh and forward the message again.');
    total+=forwarded.content.length;
    attachments.push({filename:forwarded.name,content:forwarded.content});
   }
   const inline=signatureImage(input.signatureImage);
   const cid='a2z-signature-'+id+'@'+config.email.split('@')[1];
   const escape=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
   const linksText=links.length?'\n\nDownloads (links expire in 7 days)\n'+links.map(link=>link.name+'\n'+link.url).join('\n\n'):'';
   const linksHtml=links.length?'<p>Downloads (links expire in 7 days)</p><ul>'+links.map(link=>'<li><a href="'+escape(link.url)+'">'+escape(link.name)+'</a></li>').join('')+'</ul>':'';
   const inlineHtml=inline?'<p><img src="cid:'+cid+'" alt="Email signature" style="max-width:320px;height:auto"></p>':'';
   const html=inline||links.length?'<div style="white-space:pre-wrap">'+escape(body)+'</div>'+inlineHtml+linksHtml:undefined;
   if (inline) attachments.push({filename:'signature.'+inline.type.split('/')[1],content:inline.content,contentType:inline.type,cid});
   const message = {
    from:config.email,to,cc,bcc,subject,text:body+linksText,html,attachments:[...attachments,...uploaded],
    messageId:'<'+id+'@'+config.email.split('@')[1]+'>',
    references:refs,inReplyTo:refs.at(-1),disableFileAccess:true,disableUrlAccess:true,
   };
   const result = await smtp.sendMail(message);
   const sentSaved = await saveSent(message);
   return {messageId:result.messageId,rejected:result.rejected||[],sentSaved};
  },
 };
 return mailbox;
}
