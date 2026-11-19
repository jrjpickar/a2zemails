import {randomUUID} from 'node:crypto';
import {getStore} from '@netlify/blobs';
import {mcpMailboxLogin} from '../../server/mcp-mail-auth.mjs';
import {createIonosMailbox,ionosConfig} from '../../server/ionos.mjs';
import {mailboxPreferences} from '../../server/mail-preferences.mjs';
import {dashboardQueues,commandCenterStats} from '../../src/model.mjs';
import {stagedAttachments} from '../../server/staged-attachments.mjs';

const base='/api/mcp/mail';
const rawLimit=96*1024*1024;
const common={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(body,status=200)=>Response.json(body,{status,headers:common});
const missing=()=>json({error:'The message or attachment is no longer available.'},404);
const columns=['uid','receivedAt','from','subject','flags','attachments'];
const integer=(query,key,min,max,defaultValue)=>{
 const raw=query.get(key);
 if (raw===null) return defaultValue;
 const value=Number(raw);
 if (!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max) throw new TypeError('Invalid '+key+'.');
 return value;
};

export function createMailFeedHandler(env,{
 makeMailbox=createIonosMailbox,
 preferences=mailboxPreferences,
 downloads=email=>stagedAttachments(email,getStore({name:'mcp-mail-downloads',consistency:'strong'})),
}={}) {
 return async request=>{
  if (!['GET','POST','DELETE'].includes(request.method)) return json({error:'Method not allowed.'},405);
  const url=new URL(request.url);
  const action=url.pathname.slice(base.length).replace(/^\//,'');
  const login=mcpMailboxLogin(env,request,action==='draft'?'MCP_MAIL_DRAFT_TOKEN':'MCP_MAIL_TOKEN');
  if (login.status) return json({error:login.status===401?'Unauthorized':'Mailbox feed is unavailable.'},login.status);
  const {email,password}=login;
  const params=url.searchParams;
  try {
   if (action==='draft' && request.method==='POST') {
    const raw=await request.text();
    if (raw.length>16000) return json({error:'Draft request is too large.'},413);
    let input;
    try {input=JSON.parse(raw);} catch {return json({error:'Invalid draft JSON.'},400);}
    const {id,to='',cc='',bcc='',subject='',body}=input??{};
    if (typeof id!=='string') throw new TypeError('Invalid draft ID.');
    if (typeof body!=='string'||!body.trim()||body.length>10000) throw new TypeError('Enter a draft body.');
    for (const value of [to,cc,bcc,subject]) {
     if (typeof value!=='string'||/[\r\n\x00]/.test(value)) throw new TypeError('Invalid draft header.');
    }
    const saved=await preferences(email).saveDraft({id,to,cc,bcc,subject,body},{createOnly:true});
    return saved?json({id,status:'draft_saved'}):json({error:'A different draft already uses that ID.'},409);
   }
   if (action==='draft') return json({error:'Method not allowed.'},405);
   if (action==='export'&&request.method==='DELETE') {
    await downloads(email).clean(params.get('ticket'));
    return json({ok:true});
   }
   if (action==='chunk'&&request.method==='GET') {
    const index=integer(params,'index',0,47);
    const chunk=await downloads(email).readChunk(params.get('ticket'),params.get('file'),index,rawLimit);
    return chunk ? new Response(chunk,{headers:{...common,'Content-Type':'application/octet-stream'}}) : missing();
   }
   const mailbox=makeMailbox(ionosConfig({...env,A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:email,IONOS_PASSWORD:password}));
   if (action==='command-center'&&request.method==='GET') {
    const {mail}=await mailbox.mail({includeTrash:false});
    const row=({id,subject,from,date,due})=>({id,subject,from,date,...(due?{due}:{})});
    const queues=Object.fromEntries(Object.entries(dashboardQueues(mail)).map(([key,items])=>[key,items.slice(0,5).map(row)]));
    return json({stats:commandCenterStats(mail),queues,recent:mail.slice(0,6).map(row),asOf:new Date().toISOString()});
   }
   if (action==='folders'&&request.method==='GET') return json({folders:await mailbox.folders()});
   if (action==='messages'&&request.method==='GET') {
    const folder=params.get('folder')||'INBOX';
    if (folder.length>1024||/[\x00-\x1f\x7f]/.test(folder)) throw new TypeError('Invalid folder.');
    const before=integer(params,'before',1,4294967296);
    const after=integer(params,'after',0,4294967295);
    const limit=integer(params,'limit',1,100,25);
    const generation=params.get('uidValidity');
    if (before!==undefined&&after!==undefined) throw new TypeError('Use before or after, not both.');
    if ((before!==undefined||after!==undefined)&&!generation) throw new TypeError('Pass the folder uidValidity when using a cursor.');
    if (generation&&!/^\d{1,20}$/.test(generation)) throw new TypeError('Invalid UIDVALIDITY.');
    const {messages,...page}=await mailbox.messagePage(folder,{before,after,limit,generation});
    if (page.resetRequired) return json(page,409);
    if (params.get('view')==='full') return json({folder,...page,messages});
    return json({folder,...page,columns,rows:messages.map(message=>[
     message.uid,message.date,message.from,message.subject,message.flags,message.attachments.length
    ])});
   }
   const id=params.get('id');
   if (action==='message'&&request.method==='GET') {
    const format=params.get('format')||'text';
    if (!['text','html','metadata'].includes(format)) throw new TypeError('Unknown message format.');
    const metadata=await mailbox.messageInfo(id,params.get('headers')==='1');
    if (!metadata) return missing();
    if (format==='metadata') return json(metadata);
    const body=await mailbox.body(id,{includeHtml:format==='html',includeImages:false});
    if (!body) return missing();
    return json({...metadata,...body});
   }
   if (action==='export'&&request.method==='POST') {
    const part=params.get('part');
    const item=part ? await mailbox.attachment(id,part,rawLimit) : await mailbox.rawMessage(id,rawLimit);
    if (!item) return missing();
    const ticket=randomUUID();
    const file=randomUUID();
    const cache=downloads(email);
    try {
     const chunks=await cache.saveFile(ticket,file,item.content);
     return json({ticket,file,chunks,name:item.name,type:item.type,bytes:item.content.length});
    } catch(error) {
     try {await cache.clean(ticket);} catch {}
     throw error;
    }
   }
   return json({error:'Unknown mailbox action.'},404);
  } catch(error) {
   if (error instanceof TypeError) return json({error:error.message},400);
   console.warn('[MCP] Mail read or export could not complete.');
   return json({error:'Mailbox request failed.'},502);
  }
 };
}
export default createMailFeedHandler(process.env);
export const config={path:'/api/mcp/mail/*',rateLimit:{windowLimit:90,windowSize:60,aggregateBy:['ip','domain']}};
