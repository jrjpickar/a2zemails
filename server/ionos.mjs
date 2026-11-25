import {dateOnly,searchTerms} from '../src/mail-search-scope.mjs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { safeRasterType,signatureImage } from './signature-image.mjs';
import { MAX_STAGED_BYTES } from './staged-attachments.mjs';
import { mailAttachments } from './mail-attachments.mjs';
import { groqCategories } from './groq-classification.mjs';
import { cloudflareConfig } from './cloudflare-ai.mjs';
import { classify as classifyBase, keywordCategory, currentMessageText } from '../src/model.mjs';

// The project list in src/model.mjs is sandbox sample data (Harbor Point, Westfield, Riverside, Civic Center).
// Matching real mail against it tagged any email naming Riverside or Westfield as an active project, including bid invites.
// Live mail gets no project until a real project source is connected.
const matchProject = () => '';

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
const isMailFolder = entry => !entry.flags?.has('\\Noselect') && entry.specialUse !== '\\Drafts' && !/(?:^|[./])drafts$/i.test(entry.path);

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
  cloudflare:cloudflareConfig(env),
  imap:{host:env.IONOS_IMAP_HOST||'imap.ionos.com',port:Number(env.IONOS_IMAP_PORT||993),secure:true,auth,logger:false,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:30000},
  smtp:{host:env.IONOS_SMTP_HOST||'smtp.ionos.com',port:smtpPort,secure:smtpPort===465,requireTLS:smtpPort===587,auth,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:30000},
 };
}

function addressList(items) {
 return (items||[]).map(address=>address?.address).filter(Boolean).join(', ');
}

function isoDate(value) {
 return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
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

function searchScope(input) {
 if (input===undefined) return {};
 if (!input||typeof input!=='object'||Array.isArray(input)) throw new TypeError('Invalid search filters.');
 const {folder,field,fromDate,toDate}=input;
 if ((folder!==undefined&&(typeof folder!=='string'||folder.length>1024||/[\x00-\x1f\x7f]/.test(folder)))||
     (field!==undefined&&!['text','subject','from','body'].includes(field))) throw new TypeError('Invalid search filters.');
 const since=fromDate===undefined?null:dateOnly(fromDate);
 const end=toDate===undefined?null:dateOnly(toDate);
 if (fromDate!==undefined&&!since||toDate!==undefined&&!end||since&&end&&since>end) {
  throw new TypeError('Choose a valid date range. The end date must be on or after the start date.');
 }
 const before=end?new Date(end.getTime()+86400000):null;
 return {folder,field,since,before};
}

function searchCriteria(query,scope={}) {
 const terms=searchTerms(query).slice(0,16);
 const criteria=[];
 const attachments=[];
 for (const term of terms) {
  const match=term.match(/^(from|to|subject|project|date|attachment|is):(.*)$/i);
  const field=match?.[1].toLowerCase();
  const value=(match?.[2]??term).replaceAll('"','');
  if (!value) continue;
  if (field==='is') {
   const flag={starred:{flagged:true},unread:{seen:false},read:{seen:true}}[value.toLowerCase()];
   if (flag) criteria.push(flag);
   continue;
  }
  if (field==='attachment') {attachments.push(value.toLowerCase());continue;}
  if (field==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))) {
   criteria.push({on:new Date(value+'T12:00:00Z')});continue;
  }
  if (field==='to') {criteria.push({or:[{to:value},{cc:value}]});continue;}
  const key=field==='from'||field==='subject'?field:field?'text':scope.field||'text';
  criteria.push({[key]:value});
 }
 // IMAP keys are ANDed. De Morgan's law preserves repeated fields such as two text terms.
 const filter=criteria.length>1?{not:{or:criteria.map(value=>({not:value}))}}:criteria[0]||{all:true};
 return {filter:{...filter,...(scope.since?{since:scope.since}:{}),...(scope.before?{before:scope.before}:{})},attachments};
}

const detailLimit = 1024 * 1024;
// Export limits keep each JSON page under the 6 MB Netlify response cap.
const exportTextBytes = 2.5 * 1024 * 1024;
const exportPageTextBytes = 1024 * 1024;

function messageLocation(id) {
 return typeof id === 'string' && id.length <= 2048 && id.match(/^(.+):(\d+):([1-9]\d*)$/s);
}

function textParts(node) {
 if (!node || node.disposition==='attachment' || node.dispositionParameters?.filename || node.parameters?.name) return [];
 if (node.type?.startsWith('multipart/')) return (node.childNodes||[]).flatMap(textParts);
 if (node.type==='text/plain' || node.type==='text/html') return [{type:node.type,part:node.part||'1',encoding:node.encoding,charset:node.parameters?.charset}];
 return [];
}

// Bounded text excerpt for messages whose full source is skipped (large plan sets, exhausted preview budget).
// Classification and bid detection use it so big bid invitations are not categorized by subject alone.
const previewBytes = 6000;
function previewPart(structure) {
 const parts = textParts(structure);
 return parts.find(part=>part.type==='text/plain') || parts.find(part=>part.type==='text/html') || null;
}
const htmlEntities = {nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",'#39':"'"};
export function decodePreview(part, raw) {
 let bytes = raw;
 const encoding = String(part.encoding||'').toLowerCase();
 if (encoding==='base64') {
  const text = raw.toString('latin1').replace(/[^A-Za-z0-9+/]/g,'');
  bytes = Buffer.from(text.slice(0,text.length-text.length%4),'base64');
 } else if (encoding==='quoted-printable') {
  const text = raw.toString('latin1').replace(/=\r?\n/g,'');
  const out = [];
  for (let index=0;index<text.length;index++) {
   const hex = text.slice(index+1,index+3);
   if (text[index]==='=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {out.push(parseInt(hex,16));index+=2;}
   else out.push(text.charCodeAt(index)&255);
  }
  bytes = Buffer.from(out);
 }
 let text;
 try { text = new TextDecoder(part.charset||'utf-8').decode(bytes); }
 catch { text = bytes.toString('utf8'); }
 if (part.type==='text/html') {
  text = text.replace(/<(style|script)[\s\S]*?(?:<\/\1>|$)/gi,' ').replace(/<[^>]*>?/g,' ')
   .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi,(_,name)=>htmlEntities[name.toLowerCase()]);
 }
 return text.replace(/\s+/g,' ').trim();
}

// Delivery reports (DSNs) and bounces for mail sent from this app. The app's Message-ID and DSN envelope ID
// both carry the out-<uuid> send ID, so a report maps back to the sent message.
const sendId = /out-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function deliveryReport(raw, {from='',subject=''}={}) {
 const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw||'');
 const isReport = /report-type="?delivery-status/i.test(text);
 const isBounce = /mailer-daemon|postmaster/i.test(from) && /undeliver|delivery (?:status|failure)|failure notice|returned mail|could not be delivered|delivery has failed/i.test(subject);
 if (!isReport && !isBounce) return null;
 const id = text.match(/Original-Envelope-Id:\s*(out-[0-9a-f-]{36})/i)?.[1] || text.match(sendId)?.[0];
 if (!id) return null;
 const recipients = [];
 for (const block of text.split(/\r?\n\r?\n/)) {
  const address = block.match(/^Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/im)?.[1]?.toLowerCase();
  const action = block.match(/^Action:\s*(failed|delayed|delivered|relayed|expanded)/im)?.[1]?.toLowerCase();
  if (!address || !action) continue;
  recipients.push({address,action,status:block.match(/^Status:\s*([245]\.\d+\.\d+)/im)?.[1]||'',
   detail:(block.match(/^Diagnostic-Code:\s*(.+(?:\r?\n[ \t].+)*)/im)?.[1]||'').replace(/\s+/g,' ').slice(0,240)});
 }
 if (!recipients.length && isBounce) recipients.push({address:'',action:'failed',status:'',detail:subject.slice(0,240)});
 return recipients.length ? {id:id.toLowerCase(),recipients} : null;
}

async function textPreviews(imap, items) {
 const previews = new Map();
 const wanted = new Map();
 for (const item of items) {
  const part = previewPart(item.bodyStructure);
  if (part) wanted.set(item.uid,part);
 }
 const groups = new Map();
 for (const [uid,part] of wanted) groups.set(part.part,[...(groups.get(part.part)||[]),uid]);
 try {
  for (const [key,uids] of groups) {
   const rows = await imap.fetchAll(uids,{uid:true,bodyParts:[{key,maxLength:previewBytes}]},{uid:true});
   for (const row of rows||[]) {
    const raw = row.bodyParts?.get?.(key);
    const part = wanted.get(row.uid);
    if (raw && part) previews.set(row.uid,decodePreview(part,raw));
   }
  }
 } catch { /* Previews are optional. The reader still downloads the body on open. */ }
 return previews;
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
 let name=node.dispositionParameters?.filename||node.parameters?.name;
 // Some senders (Outlook, scanners, phone apps) attach files without a file name. Keep any
 // non-text file part, so Sent and received attachments are not hidden. Skip signatures and reports.
 const unnamedFile=!name&&node.type&&!/^(?:text\/|multipart\/)/.test(node.type)&&
  !/^application\/(?:pkcs7-signature|x-pkcs7-signature|pgp-signature|pgp-encrypted|ms-tnef)$|^message\/(?:delivery-status|disposition-notification)$/.test(node.type)&&
  !(node.id&&inlineImageTypes.has(node.type));
 if (!name && node.disposition!=='attachment' && node.type!=='message/rfc822' && !unnamedFile) return [];
 if (!name && unnamedFile) name='Attachment.'+(node.type.split('/')[1]||'bin').replace(/[^a-z0-9]+/gi,'').slice(0,10);
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
 // Senior admin sorting keywords travel with the mailbox config.
 const classify=(subject,body,from)=>classifyBase(subject,body,from,{},config.keywords||[]);
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
  const reports = [];
  let folders;
  const unavailableFolders = new Set();
  let previewBudget = 3_000_000;
  try {
   await imap.connect();
   folders = (await imap.list()).filter(entry=>isMailFolder(entry)&&(includeTrash||folderName(entry)!=='Trash'));
   const priority = entry => entry.path.toUpperCase()==='INBOX'?0:entry.specialUse==='\\Sent'?1:2;
   folders.sort((a,b)=>priority(a)-priority(b));
   for (const entry of folders) {
    const folder = folderName(entry);
    let lock;
    try {
     lock = await imap.getMailboxLock(entry.path, {readOnly:true});
     const {exists,uidValidity} = imap.mailbox;
     if (!exists) continue;
     const count = folder === 'Inbox' ? 200 : 25;
     const range = Math.max(1,exists-count+1)+':'+exists;
     const metadata = await imap.fetchAll(range,{uid:true,envelope:true,internalDate:true,flags:true,size:true,bodyStructure:true});
     const eligible = metadata.slice(-count).reverse().filter(item=>{
      if (item.flags?.has('\\Deleted') || !Number.isFinite(item.size) || item.size<0 || item.size>768000 || item.size>previewBudget) return false;
      previewBudget -= item.size;
      return true;
     }).map(item=>item.uid);
     const sources = eligible.length ? await imap.fetchAll(eligible,{uid:true,source:true},{uid:true}).catch(()=>[]) : [];
     const rawByUid = new Map(sources.map(item=>[item.uid,item.source]));
     const previews = await textPreviews(imap,metadata.filter(item=>!item.flags?.has('\\Deleted')&&!rawByUid.has(item.uid)));
     for (const item of metadata) {
      if (item.flags?.has('\\Deleted')) continue;
      const raw = rawByUid.get(item.uid);
      const parsed = raw ? await parser(raw,{skipHtmlToText:false,skipImageLinks:true}).catch(()=>null) : null;
      const {envelope}=item;
      const from = addressList(envelope?.from);
      if (!['Spam','Trash'].includes(folder)) {
       for (const contact of [...(envelope?.from||[]),...(envelope?.to||[]),...(envelope?.cc||[])]) {
        const address = contact?.address?.toLowerCase();
        if (!address || !mailboxAddress.test(address) || address===config.email.toLowerCase()) continue;
        if (!contacts.has(address) && contacts.size>=1000) continue;
        if (!contacts.get(address)?.name) contacts.set(address,{address,name:contact.name||''});
       }
      }
      const id = entry.path+':'+uidValidity+':'+item.uid;
      if (folder==='Inbox' && raw) {
       const report = deliveryReport(raw,{from,subject:envelope?.subject||''});
       if (report) {
        reports.push({...report,messageId:id,date:isoDate(item.internalDate)||new Date().toISOString(),
         successOnly:report.recipients.every(entry=>['delivered','relayed','expanded'].includes(entry.action))});
       }
      }
      const headerId = parsed?.messageId || envelope?.messageId || '';
      const references = mimeReferences(parsed,envelope);
      const subject = envelope?.subject || '(No subject)';
      const body = (parsed?.text || previews.get(item.uid) || '').slice(0,90000);
      const needsBody = !parsed || (parsed.text?.length || 0)>90000 || Boolean(parsed.html) || textParts(item.bodyStructure).some(part=>part.type==='text/html');
      const category = classify(subject,body,from);
      const attachments = attachedFiles(item.bodyStructure);
      mail.push({
       id, thread:references[0]||headerId||id, name:envelope?.from?.[0]?.name||from||'Unknown sender',
       company:'', subject, body, needsBody, date:isoDate(item.internalDate)||new Date(0).toISOString(),
       from,to:addressList(envelope?.to),cc:addressList(envelope?.cc),bcc:folder==='Sent'?(addressList(envelope?.bcc)||addressList(parsed?.bcc?.value)):'',
       category,project:matchProject(subject+' '+body),folder,unread:!item.flags?.has('\\Seen'),star:Boolean(item.flags?.has('\\Flagged')),
       files:attachments.length?attachments.map(file=>file.name):(parsed?.attachments||[]).map(file=>file.filename||'Attachment'),attachments,
       due:category==='Bid Invitations'?bidDue(subject,body):undefined,
       headers:{messageId:headerId,references},
      });
     }
    } catch (error) {
     if (folder==='Inbox') throw error;
     unavailableFolders.add(folder);
    } finally { lock?.release(); }
   }
  } finally { imap.close(); }
  // Categories saved by the scheduled 9 AM / 3 PM AI sort are reused, so only new mail goes to the model.
  const stored = config.storedLabels instanceof Map ? config.storedLabels : new Map();
  // Skip mail already decided by saved AI labels or admin keywords, so the model only sees what it can change.
  const labels = await groqCategories(mail.filter(row=>!stored.has(row.id)&&!keywordCategory(row.subject,row.body,config.keywords||[])),
   config.email,config.groqKey,fetchGroq,{deadline:config.groqDeadline,cloudflare:config.cloudflare});
  const aiLabels = new Map(labels);
  for (const [id,category] of stored) if (!labels.has(id)) labels.set(id,category);
  for (const row of mail) {
   const category = labels.get(row.id);
   if (!category || category===row.category) continue;
   // Rules found bid invite wording. Never let the model demote it to General and hide a bid.
   if (row.category==='Bid Invitations' && category==='General') continue;
   // Admin keywords are explicit company rules and always win over the model.
   if (keywordCategory(row.subject,row.body,config.keywords||[])) continue;
   row.category = category;
   row.due = category==='Bid Invitations' ? bidDue(row.subject,row.body) : undefined;
  }
  return {email:config.email,folders:[...new Set(folders.map(folderName))],contacts:[...contacts.values()],mail:mail.sort((a,b)=>b.date.localeCompare(a.date)),reports,
   ...(unavailableFolders.size?{unavailableFolders:[...unavailableFolders]}:{}),
   ...(config.returnAiLabels?{aiLabels:Object.fromEntries(aiLabels)}:{})};
 }

 async function readConnection(operation,options={}) {
  const imap=new Imap({...config.imap,...options});
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
   date:isoDate(item.internalDate)||null,
   sentAt:isoDate(envelope.date)||null,
   from:addressList(envelope.from),to:addressList(envelope.to),cc:addressList(envelope.cc),bcc:addressList(envelope.bcc),
   replyTo:addressList(envelope.replyTo),messageId:envelope.messageId||'',inReplyTo:envelope.inReplyTo||'',
   flags:[...flags],bytes:item.size||0,attachments:attachedFiles(item.bodyStructure),
  };
 }

 // Full readable text for exports: every inline text/plain part in order, or every HTML part converted to text.
 async function fullText(imap,uid,structure,maxBytes=exportTextBytes) {
  const parts=textParts(structure);
  const plain=parts.filter(part=>part.type==='text/plain');
  const chosen=plain.length?plain:parts.filter(part=>part.type==='text/html');
  const pieces=[];
  let bytes=0, truncated=chosen.length>40;
  for (const {part,type} of chosen.slice(0,40)) {
   if (bytes>=maxBytes) {truncated=true;break;}
   const result=await readPart(imap,uid,part,maxBytes-bytes);
   if (!result) continue;
   bytes+=result.raw.length;
   truncated||=result.truncated;
   let text=result.raw.toString('utf8');
   if (type==='text/html') {
    const mime='Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+result.raw.toString('base64');
    text=(await parser(mime,{skipHtmlToText:false,skipImageLinks:true}).catch(()=>null))?.text||'';
   }
   if (text.trim()) pieces.push(text.replace(/\s+$/,''));
  }
  return {body:pieces.join('\n\n'),truncated,bytes};
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
  recentBidInbox(since,{terms,domains}) {
   return readFolder('INBOX',async imap=>{
    const generation=String(imap.mailbox.uidValidity);
    const base={since,deleted:false};
    const broad=new Set(['bid','pricing','estimate','quote','demo','demolition']);
    const keywords=[...new Set([...terms.filter(word=>!broad.has(word)),'pricing request','request for pricing',
     'request for quotation','request for quote','submit your bid','bid due','bids due','proposals due','bid opportunity',
     'project out to bid','invited to bid','invitation to tender','bid addendum','demo bid','demolition bid'])];
    const trade=terms.filter(word=>word==='demo'||word==='demolition');
    const alternatives=[...keywords.map(text=>({text})),...domains.map(from=>({from})),
     ...trade.flatMap(text=>['subcontractor','bid package','pricing','bidding','scope of work'].map(value=>({
      not:{or:[{not:{text}},{not:{text:value}}]},
     })))];

    const all=await imap.search(base,{uid:true});
    if (all===false) throw new Error('IONOS bid date search failed.');
    const matching=await imap.search({...base,or:alternatives},{uid:true});
    if (matching===false) throw new Error('IONOS bid candidate search failed.');
    const allowed=new Set(all);
    const uids=matching.filter(uid=>allowed.has(uid)).sort((a,b)=>b-a);
    const mail=[];
    for (let start=0;start<uids.length;start+=100) {
     const rows=await imap.fetchAll(uids.slice(start,start+100),{
      uid:true,envelope:true,internalDate:true,flags:true,
     },{uid:true});
     for (const row of rows) {
      if (row.internalDate>=since&&!row.flags?.has('\\Deleted')) mail.push(messageMetadata(row,'INBOX',generation));
     }
    }
    return {mail,generation,matched:uids.length,total:all.length};
   });
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
  exportFolders() {
   return readConnection(async imap=>(await imap.list()).filter(isMailFolder).map(entry=>({path:entry.path,folder:folderName(entry)})));
  },
  async exportPage(input) {
   if (typeof input?.path!=='string'||!input.path||input.path.length>1024) throw new TypeError('Select a mailbox folder.');
   const result=await mailbox.mailSearch(input,12,false,input.path);
   if (result.resetRequired) return result;
   let bytes=0;
   let count=0;
   for (const row of result.mail) {
    const estimate=Math.min(row.messageBytes||0,detailLimit);
    if (count&&bytes+estimate>2*1024*1024) break;
    bytes+=estimate;
    count++;
   }
   // One read-only connection per page. Every text part is exported, not only the first one.
   const texts=new Map();
   let processed=0;
   let textBytes=0;
   const candidates=result.mail.slice(0,count);
   if (candidates.length) await readFolder(input.path,async imap=>{
    const generation=String(imap.mailbox.uidValidity);
    for (const row of candidates) {
     if (processed&&textBytes>=exportPageTextBytes) break;
     processed++;
     const [,rowGeneration,uid]=row.id.match(/:(\d+):(\d+)$/)||[];
     if (rowGeneration!==generation) continue;
     const item=await imap.fetchOne(uid,{bodyStructure:true},{uid:true});
     if (!item?.bodyStructure) continue;
     const text=await fullText(imap,uid,item.bodyStructure);
     textBytes+=text.bytes;
     texts.set(row.id,text);
    }
   });
   count=processed;
   const page=candidates.slice(0,count);
   const mail=page.map(row=>{
    const message=texts.get(row.id);
    if (!message) return {...row,bodyStatus:'Message no longer available'};
    const body=message.body;
    const category=classify(row.subject,body,row.from);
    return {...row,body,category,project:matchProject(row.subject+' '+body),
     due:category==='Bid Invitations'?bidDue(row.subject,body):undefined,
     bodyStatus:message.truncated?'Truncated at the 2.5 MB export limit':'Complete'};
   });
   const consumed=page.at(-1)?.id.match(/:(\d+):(\d+)$/);
   const next=count<result.mail.length&&consumed
    ? [{path:input.path,generation:consumed[1],before:Number(consumed[2])}] : result.next;
   return {mail,next};
  },
  async mailSearch(input,limit=40,anyTerm=false,exportPath,windowSize=0) {
   const {query,positions}=input||{};
   if (typeof query!=='string'||(!exportPath&&!query.trim())||query.length>512||/[\x00-\x1f\x7f]/.test(query)||
       (positions!==undefined&&(!Array.isArray(positions)||positions.length>2000||
        positions.some(cursor=>typeof cursor?.path!=='string'||typeof cursor.generation!=='string'||
         !Number.isSafeInteger(cursor.before)||cursor.before<2||cursor.before>4294967296)))) {
    throw new TypeError('Invalid mailbox search.');
   }
   const scope=searchScope(input?.scope);
   const {filter,attachments:attachmentTerms}=searchCriteria(query,scope);
   const keywords=anyTerm?query.split(' ').filter(Boolean):[];
   const criteria=keywords.length>1?{or:keywords.map(text=>({text}))}:filter;
   return readConnection(async imap=>{
    const folders=(await imap.list()).filter(entry=>isMailFolder(entry)&&(!exportPath||entry.path===exportPath)&&(!scope.folder||folderName(entry)===scope.folder));
    if(exportPath&&!folders.length) return {resetRequired:true};
    const cursors=positions?new Map(positions.map(cursor=>[cursor.path,cursor])):null;
    const mail=[],next=[];
    for (const entry of folders) {
     const cursor=cursors?.get(entry.path);
     if (cursors&&!cursor) continue;
     const lock=await imap.getMailboxLock(entry.path,{readOnly:true});
     try {
      const generation=String(imap.mailbox.uidValidity);
      if (cursor&&cursor.generation!==generation) return {resetRequired:true};
      const before=cursor?.before??Number(imap.mailbox.uidNext);
      if (!Number.isSafeInteger(before)||before<1) throw new Error('IONOS search is missing a UID checkpoint.');
      if (before===1) continue;
      const low=windowSize?Math.max(1,before-windowSize):1;
      const matches=await imap.search({...criteria,uid:low+':'+(before-1),deleted:false},{uid:true});
      if (matches===false) throw new Error('IONOS search did not complete.');
      const uids=matches.filter(uid=>uid>=low&&uid<before).sort((a,b)=>b-a);
      const page=uids.slice(0,limit);
      let nextBefore=uids.length>page.length?page.at(-1):low;
      // If the current window has no matches, use the IMAP date index to
      // avoid paging through older messages outside the selected range.
      if (!uids.length&&scope.since&&windowSize&&low>1) {
       const older=await imap.search({
        since:scope.since,...(scope.before?{before:scope.before}:{}),uid:'1:'+(low-1),deleted:false,
       },{uid:true});
       if (older!==false) {
        let last=0;
        for (const uid of older) if (uid<low&&uid>last) last=uid;
        nextBefore=last+1;
       }
      }
      if (nextBefore>1) next.push({path:entry.path,before:nextBefore,generation});
      if (!page.length) continue;
      const rows=await imap.fetchAll(page,{uid:true,envelope:true,internalDate:true,flags:true,bodyStructure:true},{uid:true});
      const folder=folderName(entry);
      for (const row of rows) {
       if (row.flags?.has('\\Deleted')) continue;
       const item=messageMetadata(row,entry.path,generation);
       if (!attachmentTerms.every(term=>item.attachments.some(file=>file.name.toLowerCase().includes(term)))) continue;
       const category=classify(item.subject,'',item.from);
       const references=[item.inReplyTo].filter(Boolean);
       mail.push({
        id:item.id,thread:item.inReplyTo||item.messageId||item.id,name:row.envelope?.from?.[0]?.name||item.from||'Unknown sender',company:'',
        subject:item.subject,body:'',needsBody:true,date:item.date||new Date(0).toISOString(),
        from:item.from,to:item.to,cc:item.cc,bcc:folder==='Sent'?item.bcc:'',category,project:matchProject(item.subject),folder,
        unread:!item.flags.includes('\\Seen'),star:item.flags.includes('\\Flagged'),
        files:item.attachments.map(file=>file.name),attachments:item.attachments,
        ...(exportPath?{messageBytes:item.bytes}:{}),
        due:category==='Bid Invitations'?bidDue(item.subject,''):undefined,
        headers:{messageId:item.messageId,references},
       });
      }
     } finally {lock.release();}
    }
    return {mail:mail.sort(exportPath?(a,b)=>Number(b.id.split(':').at(-1))-Number(a.id.split(':').at(-1)):(a,b)=>b.date.localeCompare(a.date)),next};
   },windowSize?{connectionTimeout:5000,greetingTimeout:5000,socketTimeout:6500}:undefined);
  },
  async searchMailboxPage(input) {
   const {query,positions}=input||{};
   if (typeof query!=='string'||!query.trim()||query.length>512||/[\x00-\x1f\x7f]/.test(query)||
       (positions!==undefined&&(!Array.isArray(positions)||positions.length>2000||
        positions.some(cursor=>typeof cursor?.path!=='string'||!cursor.path||cursor.path.length>1024||
         /[\x00-\x1f\x7f]/.test(cursor.path)||!(cursor.before===null&&cursor.generation===null||
          Number.isSafeInteger(cursor.before)&&cursor.before>=2&&cursor.before<=4294967296&&
          typeof cursor.generation==='string'&&/^\d{1,20}$/.test(cursor.generation)))))) {
    throw new TypeError('Enter a mailbox search of up to 512 characters.');
   }
   const scope=searchScope(input?.scope);
   let queue=positions;
   if (!queue) {
    const folders=await readConnection(async imap=>(await imap.list()).filter(entry=>isMailFolder(entry)&&(!scope.folder||folderName(entry)===scope.folder)),{
     connectionTimeout:5000,greetingTimeout:5000,socketTimeout:6500,
    });
    const priority=entry=>folderName(entry)==='Inbox'?0:folderName(entry)==='Archive'?1:2;
    queue=folders.sort((a,b)=>priority(a)-priority(b)).map(({path})=>({path,before:null,generation:null}));
   }
   const batch=queue.slice(0,3);
   const remaining=queue.slice(3);
   const mail=[],failed=[];
   const results=await Promise.allSettled(batch.map(cursor=>mailbox.mailSearch({
    query,scope:input.scope,positions:cursor.before===null?undefined:[cursor],
   },40,false,cursor.path,4096)));
   for (const [index,result] of results.entries()) {
    const cursor=batch[index];
    if (result.status==='fulfilled'&&!result.value.resetRequired) {
     mail.push(...result.value.mail);
     remaining.push(...result.value.next);
    } else {
     if (result.status==='rejected'&&(result.reason?.authenticationFailed||result.reason?.code==='EAUTH'||
         result.reason?.serverResponseCode==='AUTHENTICATIONFAILED')) throw result.reason;
     const retry=result.status==='fulfilled'?{path:cursor.path,before:null,generation:null}:cursor;
     remaining.push(retry);
     failed.push(cursor.path);
    }
   }
   return {mail:mail.sort((a,b)=>b.date.localeCompare(a.date)),next:remaining,failed,deferred:queue.length>batch.length};
  },
  // Incremental index sync for Ask AI and MCP. Read-only. Returns new rows (newest first on the first run),
  // a backfill page below the oldest indexed UID, and current flags for the most recent indexed UIDs.
  indexFolders() {
   return readConnection(async imap=>(await imap.list()).filter(entry=>isMailFolder(entry)).map(entry=>({path:entry.path,folder:folderName(entry)})));
  },
  async indexFolder(path,{uidValidity,highUid=0,lowUid=0,newLimit=300,backfillLimit=150,flagUids=[]}={}) {
   return readFolder(path,async imap=>{
    const generation=String(imap.mailbox.uidValidity);
    const uidNext=Number(imap.mailbox.uidNext)||1;
    const reset=Boolean(uidValidity&&uidValidity!==generation);
    const high=reset?0:highUid, low=reset?0:lowUid;
    const pick=async(range,limit,newest)=>{
     if (limit<=0) return [];
     const found=await imap.search({uid:range},{uid:true});
     const sorted=(found||[]).sort((a,b)=>a-b);
     return newest?sorted.slice(-limit):sorted.slice(0,limit);
    };
    let fresh=[];
    if (!high) fresh=uidNext>1?await pick('1:'+(uidNext-1),newLimit,true):[];
    else if (uidNext-1>high) fresh=await pick((high+1)+':'+(uidNext-1),newLimit,false);
    const floor=high?low:(fresh[0]||0);
    const older=floor>1&&backfillLimit>0?(await pick('1:'+(floor-1),backfillLimit,true)):[];
    const wanted=[...fresh,...older];
    const rows=wanted.length?await imap.fetchAll(wanted,{uid:true,envelope:true,internalDate:true,flags:true,size:true,bodyStructure:true,headers:['references']},{uid:true}):[];
    const previews=await textPreviews(imap,rows);
    const folder=folderName({path,specialUse:imap.mailbox.specialUse,flags:new Set()});
    const toRow=item=>{
     const envelope=item.envelope||{};
     const subject=envelope.subject||'(No subject)';
     const preview=currentMessageText(previews.get(item.uid)||'').replace(/\s+/g,' ').trim().slice(0,1200);
     const from=addressList(envelope.from);
     const refs=String(item.headers?.toString?.('utf8')||'').match(/<[^<>\s]+>/g)||[];
     return {id:path+':'+generation+':'+item.uid,uid:item.uid,path,folder,date:isoDate(item.internalDate)||null,
      from,fromName:envelope.from?.[0]?.name||'',to:addressList(envelope.to),cc:addressList(envelope.cc),subject,
      messageId:envelope.messageId||'',inReplyTo:envelope.inReplyTo||'',refs:refs.slice(-6),
      flags:[...(item.flags||[])].filter(flag=>/^\\(Seen|Answered|Flagged)$/.test(flag)),
      attachments:attachedFiles(item.bodyStructure).map(file=>({name:file.name,type:file.type,size:file.size,part:file.part})),
      preview,category:classify(subject,preview,from),deleted:Boolean(item.flags?.has('\\Deleted'))};
    };
    const built=rows.map(toRow).filter(row=>!row.deleted);
    let flags=null;
    const recheck=reset?[]:flagUids.filter(uid=>Number.isSafeInteger(uid)).slice(-400);
    if (recheck.length) {
     const current=await imap.fetchAll(recheck,{uid:true,flags:true},{uid:true});
     flags=Object.fromEntries((current||[]).filter(item=>!item.flags?.has('\\Deleted')).map(item=>[item.uid,[...item.flags].filter(flag=>/^\\(Seen|Answered|Flagged)$/.test(flag))]));
    }
    return {uidValidity:generation,reset,folder,uidNext,rows:built,newHigh:fresh.length?Math.max(high,...fresh):high,
     newLow:Math.min(...[floor||Infinity,...older].filter(Boolean)),reachedStart:(older.length?older[0]:floor)<=1,flags};
   });
  },
  // Success-only delivery reports move out of Inbox into an "A2Z Delivery Reports" folder after they are recorded.
  async archiveReports(ids) {
   const byUid=ids.map(messageLocation).filter(match=>match&&match[1]==='INBOX');
   if (!byUid.length) return 0;
   const imap=new Imap(config.imap);
   imap.on?.('error',()=>{});
   try {
    await imap.connect();
    const target='A2Z Delivery Reports';
    if (!(await imap.list()).some(entry=>entry.path===target)) await imap.mailboxCreate(target).catch(()=>{});
    const lock=await imap.getMailboxLock('INBOX');
    try {
     const generation=String(imap.mailbox.uidValidity);
     const uids=byUid.filter(match=>match[2]===generation).map(match=>match[3]);
     if (!uids.length) return 0;
     await imap.messageMove(uids.join(','),target,{uid:true});
     return uids.length;
    } finally {lock.release();}
   } finally {imap.close();}
  },
  // Text excerpts for several messages over one connection (Ask AI context).
  async textExcerpts(ids,chars=4000) {
   const byFolder=new Map();
   for (const id of ids.slice(0,12)) {
    const match=messageLocation(id);
    if (!match) continue;
    const [,path,generation,uid]=match;
    byFolder.set(path,[...(byFolder.get(path)||[]),{id,generation,uid}]);
   }
   const texts=new Map();
   if (!byFolder.size) return texts;
   await readConnection(async imap=>{
    for (const [path,items] of byFolder) {
     const lock=await imap.getMailboxLock(path,{readOnly:true});
     try {
      for (const item of items) {
       if (String(imap.mailbox.uidValidity)!==item.generation) continue;
       const message=await imap.fetchOne(item.uid,{bodyStructure:true},{uid:true});
       if (!message?.bodyStructure) continue;
       const text=await fullText(imap,item.uid,message.bodyStructure,chars*4);
       texts.set(item.id,text.body.slice(0,chars));
      }
     } finally {lock.release();}
    }
   });
   return texts;
  },
  async olderMail(input) {
   const {path,generation,before}=input||{};
   if (typeof path!=='string'||!path||path.length>1024||/[\x00-\x1f\x7f]/.test(path)||
       typeof generation!=='string'||!/^\d{1,20}$/.test(generation)||
       !Number.isSafeInteger(before)||before<1||before>4294967296) throw new TypeError('Invalid older mail request.');
   if (before<2) return {mail:[],next:null};
   const mail=[];
   let cursor={path,generation,before};
   // Skip sparse UID windows so one request normally returns a page of older mail.
   for (let step=0;step<4&&cursor&&!mail.length;step++) {
    const result=await mailbox.mailSearch({query:'',positions:[cursor]},50,false,path,4096);
    if (result.resetRequired) return {resetRequired:true};
    mail.push(...result.mail.map(({messageBytes,...row})=>row));
    cursor=result.next[0]||null;
   }
   if (mail.length) {
    await readFolder(path,async imap=>{
     if (String(imap.mailbox.uidValidity)!==generation) return;
     const uids=mail.map(row=>Number(row.id.split(':').at(-1)));
     const structures=await imap.fetchAll(uids,{uid:true,bodyStructure:true},{uid:true});
     const previews=await textPreviews(imap,structures||[]);
     for (const row of mail) {
      const preview=previews.get(Number(row.id.split(':').at(-1)));
      if (!preview) continue;
      row.body=preview.slice(0,90000);
      row.category=classify(row.subject,row.body,row.from);
      row.project=matchProject(row.subject+' '+row.body);
      row.due=row.category==='Bid Invitations'?bidDue(row.subject,row.body):undefined;
     }
    }).catch(()=>{});
   }
   return {mail,next:cursor};
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
    const source = folders.find(entry=>entry.path===path && !entry.flags?.has('\\Noselect'));
    if (permanent && (!source || folderName(source)!=='Trash')) {
     return {error:'Move the message to Trash before deleting it forever.'};
    }
    if (permanent && !imap.capabilities.has('UIDPLUS')) {
     return {error:'This mail server cannot safely delete a single message forever.'};
    }
    let target;
    if (destination==='Trash') {
     if (source && folderName(source)==='Trash') return {ok:true};
     target=folders.find(entry=>isRetainedTrash(entry)&&!entry.flags?.has('\\Noselect'));
     if (!target) {
      try { await imap.mailboxCreate(retainedTrash); } catch {
       // A concurrent move may already have created the folder.
      }
      target=(await imap.list()).find(entry=>isRetainedTrash(entry)&&!entry.flags?.has('\\Noselect'));
     }
    } else if (destination) {
     target=folders.find(entry=>!entry.flags?.has('\\Noselect') && folderName(entry)===destination);
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
   const html='<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">'+
    escape(body).replace(/\r\n|\r|\n/g,'<br>')+'</div>'+inlineHtml+linksHtml;
   if (inline) attachments.push({filename:'signature.'+inline.type.split('/')[1],content:inline.content,contentType:inline.type,cid});
   const message = {
    from:config.email,to,cc,bcc,subject,text:body+linksText,html,textEncoding:'quoted-printable',attachments:[...attachments,...uploaded],
    messageId:'<'+id+'@'+config.email.split('@')[1]+'>',
    references:refs,inReplyTo:refs.at(-1),disableFileAccess:true,disableUrlAccess:true,
   };
   // Ask receiving servers for delivery reports. Sent only when IONOS advertises DSN support.
   const result = await smtp.sendMail({...message,dsn:{id,return:'headers',notify:['success','failure','delay'],recipient:config.email}});
   const sentSaved = await saveSent(message);
   return {messageId:result.messageId,accepted:result.accepted||[],rejected:result.rejected||[],sentSaved};
  },
 };
 return mailbox;
}
