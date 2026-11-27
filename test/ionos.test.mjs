import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIonosMailbox, ionosConfig } from '../server/ionos.mjs';
import { groqCategories } from '../server/groq-classification.mjs';
import { llmConfig, resetLlmState } from '../server/intel/llm.mjs';
import { appendSignature, dashboardQueues, seed } from '../src/model.mjs';

const env = {
 A2Z_MODE:'live', A2Z_ENABLE_LIVE:'true',
 IONOS_EMAIL:'mailbox@example.com', IONOS_PASSWORD:'fixture-only',
};

test('IONOS requires explicit live configuration and encrypted mail transports', () => {
 assert.throws(() => ionosConfig({...env,A2Z_ENABLE_LIVE:'false'}), /Enable A2Z_MODE/);
 const config = ionosConfig(env);
 assert.equal(config.imap.host,'imap.ionos.com');
 assert.equal(config.imap.port,993);
 assert.equal(config.imap.secure,true);
 assert.equal(config.smtp.host,'smtp.ionos.com');
 assert.equal(config.smtp.secure,true);
 assert.equal(ionosConfig({...env,IONOS_SMTP_PORT:'587'}).smtp.requireTLS,true);
 assert.throws(() => ionosConfig({...env,IONOS_SMTP_PORT:'25'}), /465 or 587/);
});

test('IONOS adapter reads a message and sends a signed reply using the authenticated mailbox', async () => {
 const id = '<itb@builder.example>';
 let options, outgoing, closed;
 class FakeImap {
  async connect() {}
  async list() { return [{path:'INBOX',flags:new Set()}]; }
  async getMailboxLock(path,settings) {
   assert.equal(path,'INBOX');
   assert.equal(settings.readOnly,true);
   this.mailbox = {exists:1,uidValidity:22n};
   return {release() {}};
  }
  async fetchAll(range, fields) {
   if (fields.source) return [{uid:4,source:Buffer.from([
    'From: GC <gc@builder.example>','To: mailbox@example.com','Message-ID: '+id,
    'Subject: Invitation to bid','','Bid due: 2026-12-03',
   ].join('\r\n'))}];
   return [{
    uid:4,size:200,flags:new Set(),internalDate:new Date('2026-11-17T15:00:00Z'),
    envelope:{from:[{name:'GC',address:'gc@builder.example'}],subject:'Invitation to bid',messageId:id},
   }];
  }
  close() { closed=true; }
 }
 const adapter = createIonosMailbox(ionosConfig(env), {
  Imap:FakeImap,
  transport:config=>{
   options=config;
   return {async sendMail(message) { outgoing=message; return {messageId:message.messageId,rejected:[]}; }};
  },
 });
 const {mail,contacts} = await adapter.mail();
 assert.deepEqual(contacts,[{address:"gc@builder.example",name:"GC"}]);
 assert.equal(closed,true);
 assert.equal(mail[0].thread,id);
 assert.equal(mail[0].category,'Bid Invitations');
 assert.equal(mail[0].due,'2026-12-03');
 assert.equal(options.auth.user,env.IONOS_EMAIL);

 resetLlmState();
 const enhanced = createIonosMailbox(ionosConfig({...env,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:' fixture-cf-token '}),{
  Imap:FakeImap,transport:()=>({}),
  fetchGroq:async (url,{headers,body})=>{
   assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/ai/v1/chat/completions');
   assert.equal(headers.Authorization,'Bearer fixture-cf-token');
   const request=JSON.parse(body);
   assert.equal(request.model,'@cf/openai/gpt-oss-120b');
   assert.equal(request.response_format.type,'json_object');
   assert.deepEqual(JSON.parse(request.messages[1].content),[
    {index:0,subject:'Invitation to bid',excerpt:'Bid due: 2026-12-03'},
   ]);
   return groqReply([{index:0,category:'Estimating'}]);
  },
 });
 const {mail:reclassified}=await enhanced.mail();
 assert.equal(reclassified[0].category,'Estimating');
 assert.equal(reclassified[0].due,undefined);

 const body = appendSignature('We intend to bid.','A2Z Operations\nEstimating');
 const result = await adapter.send({
  id:'out-12345678-1234-1234-1234-123456789012',to:'gc@builder.example',cc:'',
  subject:'Re: Invitation to bid',body,references:[id],from:'untrusted@example.com',
  attachments:[{name:'plans.txt',data:Buffer.from('test plan').toString('base64')}],
 });
 assert.equal(outgoing.from,env.IONOS_EMAIL);
 assert.equal(outgoing.text,'We intend to bid.\n\n-- \nA2Z Operations\nEstimating');
 assert.equal(outgoing.inReplyTo,id);
 assert.equal(outgoing.attachments[0].filename,'plans.txt');
 assert.equal(outgoing.attachments[0].content.toString(),'test plan');
 assert.equal(result.messageId,outgoing.messageId);
 assert.equal(appendSignature('Reply','  '),'Reply');
});

test('recent mail survives a rejected custom folder, missing flags, and an invalid timestamp', async () => {
 class FakeImap {
  async connect() {}
  async list() { return ['INBOX','Unavailable folder','Sent'].map(path=>({path,flags:new Set()})); }
  async getMailboxLock(path) {
   if (path==='Unavailable folder') throw new Error('Folder unavailable');
   this.path=path;
   this.mailbox={exists:1,uidValidity:22n};
   return {release() {}};
  }
  async fetchAll(_range,fields) {
   if (fields.source) throw new Error('Message source unavailable');
   return [{uid:1,size:200,internalDate:new Date(NaN),envelope:{subject:this.path,from:[null]}}];
  }
  close() {}
 }
 const adapter=createIonosMailbox(ionosConfig(env),{Imap:FakeImap,transport:()=>({})});
 const {mail,unavailableFolders}=await adapter.mail();
 assert.deepEqual(unavailableFolders,['Unavailable folder']);
 assert.deepEqual(mail.map(row=>row.folder),['Inbox','Sent']);
 assert.equal(mail[0].date,'1970-01-01T00:00:00.000Z');
 assert.equal(mail[0].needsBody,true);
 assert.equal(mail[0].unread,true);
});

test('Inbox recovery fetches only the latest envelopes from INBOX', async () => {
 let released=false,closed=false;
 class FakeImap {
  async connect() {}
  async list() { assert.fail('Recovery must not enumerate folders'); }
  async getMailboxLock(path,options) {
   assert.equal(path,'INBOX');
   assert.deepEqual(options,{readOnly:true});
   this.mailbox={exists:200,uidValidity:22n};
   return {release() { released=true; }};
  }
  async fetchAll(range,fields) {
   assert.equal(range,'141:200');
   assert.deepEqual(fields,{uid:true,envelope:true,internalDate:true,flags:true,headers:['REFERENCES']});
   return [
    {uid:12,flags:new Set(['\\Deleted'])},
    {uid:13,flags:new Set(['\\Seen']),envelope:{subject:'A real message'}},
   ];
  }
  close() { closed=true; }
 }
 const result=await createIonosMailbox(ionosConfig(env),{Imap:FakeImap,transport:()=>({})}).inboxSummary();
 assert.equal(result.inboxOnly,true);
 assert.equal(result.email,env.IONOS_EMAIL);
 assert.deepEqual(result.mail.map(({id,subject,needsBody,unread})=>({id,subject,needsBody,unread})),
  [{id:'INBOX:22:13',subject:'A real message',needsBody:true,unread:false}]);
 assert.ok(released&&closed);
});

function groqReply(results) {
 return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({results})}}]});
}

test('AI sorting uses Cloudflare and falls back on uncertainty, failures and ambiguous output',async ()=>{
 const mail=[
  {id:'a',folder:'Inbox',subject:'Demo Bid',body:'Scope attached.\n\n-----Original Message-----\nOld invoice'},
  {id:'b',folder:'Inbox',subject:'Project Message',body:'Hello'},
  {id:'c',folder:'Spam',subject:'Do not send',body:'Spam'},
 ];
 const email='cf-sort-test@example.test';
 const cloudflare=llmConfig({CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32),CLOUDFLARE_API_TOKEN:'fixture-token'});
 resetLlmState();
 assert.equal((await groqCategories(mail,email,undefined,()=>assert.fail('AI is disabled'))).size,0);
 assert.equal((await groqCategories(mail,email,undefined,async()=>new Response(null,{status:429}),{cloudflare})).size,0);
 resetLlmState();
 assert.equal((await groqCategories(mail,email,undefined,async()=>groqReply([
  {index:0,category:'Invoices'},{index:0,category:'Estimating'},
 ]),{cloudflare})).size,0);
 resetLlmState();
 const classify=async (_url,{body})=>{
  assert.deepEqual(JSON.parse(JSON.parse(body).messages[1].content),[
   {index:0,subject:'Demo Bid',excerpt:'Scope attached.'},
   {index:1,subject:'Project Message',excerpt:'Hello'},
  ]);
  return groqReply([{index:1,category:'Uncertain'},{index:0,category:'Estimating'}]);
 };
 assert.deepEqual([...await groqCategories(mail,email,undefined,classify,{cloudflare})],[['a','Estimating']]);
 const requests=[];
 const refreshed=await groqCategories(mail,email,undefined,async (_url,{body})=>{
  requests.push(...JSON.parse(JSON.parse(body).messages[1].content));
  return groqReply([{index:0,category:'General'}]);
 },{cloudflare});
 assert.deepEqual(requests.map(message=>message.subject),['Project Message']);
 assert.deepEqual([...refreshed],[['a','Estimating'],['b','General']]);
});

test('Command Center sorts deadlines and returns to awaiting reply after a new inbound message', () => {
 const bid = seed[0];
 const sent = {
  ...bid,id:'reply',folder:'Sent',date:'2026-11-18T00:00:00Z',
  headers:{messageId:'<reply@example.com>',references:[bid.headers.messageId]},
 };
 const followup = {...bid,id:'followup',date:'2026-11-19T00:00:00Z'};
 const result = dashboardQueues([...seed,sent,followup]);
 assert.equal(result.bids[0].due,'2026-11-30');
 assert.ok(result.urgent.some(message=>message.category==='RFIs & Change Orders'));
 assert.ok(result.invoices.some(message=>message.category==='Invoices'));
 assert.ok(!result.unanswered.some(message=>message.id===bid.id));
 assert.ok(result.unanswered.some(message=>message.id===followup.id));
});

test('hosted mailbox login requires an allowed address and an authenticated unmodified session', async () => {
 const {createHostedHandler} = await import('../netlify/functions/ionos.mjs');
 let loginCount=0;
 let mail=[];
 let fullRefreshError;
 class FakeImap {
  constructor(config) { assert.equal(config.auth.user,env.IONOS_EMAIL); assert.equal(config.auth.pass,env.IONOS_PASSWORD); }
  on() {}
  async connect() { loginCount++; }
  close() {}
 }
 const handler=createHostedHandler({
  ...env,SESSION_SECRET:'fixture-session-key-only-000000000000000000000000000000',
  IONOS_ALLOWED_MAILBOXES:env.IONOS_EMAIL,
 },{
  Imap:FakeImap,
  mailboxFactory:config=>({
   async mail() {
    if (fullRefreshError) throw fullRefreshError;
    return {email:config.email,mail,contacts:[]};
   },
   async inboxSummary() {return {email:config.email,mail:[],inboxOnly:true};},
   async exportFolders() { return [{path:'INBOX',folder:'Inbox'},{path:'Stored Jobs',folder:'Archive'}]; },
   async folderSummary(path,folder) {
    assert.equal(path,folder==='Inbox'?'INBOX':'Stored Jobs');
    return {email:config.email,mail:[{id:path+':1:1',folder,subject:'Fixture',category:'General'}]};
   },
  }),
 });
 const call=(action,{body,token,origin,cookie}={})=>handler(new Request('https://test.example/.netlify/functions/ionos?action='+action,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:token==='MailboxCookie'?token:'Bearer '+token}:{}),...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},
  body:body?JSON.stringify(body):undefined,
 }));
 assert.equal((await call('mail')).status,401);
 assert.equal((await call('mail-inbox')).status,401);
 assert.equal((await call('login',{body:{email:'other@example.com',password:'fixture-only'}})).status,401);
 assert.equal((await call('login',{origin:'https://other.example',body:{email:env.IONOS_EMAIL,password:env.IONOS_PASSWORD}})).status,403);
 const result=await call('login',{body:{email:env.IONOS_EMAIL,password:env.IONOS_PASSWORD}});
 assert.equal(result.status,200);
 const {token}=await result.json();
 assert.equal(loginCount,1);
 assert.equal(Buffer.from(token,'base64url').includes(env.IONOS_PASSWORD),false);
 assert.equal((await call('mail',{token:(token[0]==='A'?'B':'A')+token.slice(1)})).status,401);
 const response=await call('mail',{token});
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await response.json()).email,env.IONOS_EMAIL);
 fullRefreshError=new Error('private fixture detail');
 const failed=await call('mail',{token});
 assert.equal(failed.status,502);
 const failure=await failed.json();
 assert.match(failure.reference,/^[a-f0-9]{12}$/);
 assert.doesNotMatch(failure.error,/private fixture detail/);
 const recovered=await call('mail-inbox',{token});
 assert.equal(recovered.status,200);
 const summary=await recovered.json();
 assert.equal(summary.inboxOnly,true);
 assert.equal(summary.email,env.IONOS_EMAIL);
 const folders=await call('mail-folders',{token});
 assert.deepEqual((await folders.json()).folders.map(entry=>entry.folder),['Inbox','Archive']);
 const archive=await call('mail-folder',{token,body:{folder:'Archive'}});
 assert.equal(archive.status,200);
 assert.equal((await archive.json()).mail[0].id,'Stored Jobs:1:1');
 const labels=await call('mail-labels',{token,body:{folder:'Inbox'}});
 assert.equal(labels.status,200);
 assert.deepEqual((await labels.json()).labels,[{id:'INBOX:1:1'}]);
 fullRefreshError=Object.assign(new Error('Bad credentials'),{authenticationFailed:true});
 assert.equal((await call('mail',{token})).status,401);
 fullRefreshError=undefined;
 mail=Array.from({length:12},(_,index)=>({id:String(index),folder:'Inbox',body:'😀'.repeat(45000)}));
 const oversized=await call('mail',{token});
 const bounded=await oversized.text();
 assert.ok(Buffer.byteLength(bounded)<1_010_000);
 const rows=JSON.parse(bounded).mail;
 assert.equal(rows.length,12);
 assert.ok(rows[0].body);
 assert.equal(rows.at(-1).body,'');
 assert.equal(rows.at(-1).needsBody,true);
 mail=[];
 const saved=await call('login',{body:{email:env.IONOS_EMAIL,password:env.IONOS_PASSWORD,remember:true}});
 const remembered=(await saved.json()).token;
 assert.equal(remembered,'MailboxCookie');
 const cookieHeader=saved.headers.get('set-cookie');
 assert.match(cookieHeader,/Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Strict/);
 const cookie=cookieHeader.split(';')[0];
 assert.equal((await call('session',{cookie,token:remembered})).status,200);
 assert.equal((await call('mail',{cookie,token:remembered})).status,200);
 assert.equal((await call('mail',{cookie})).status,401);
 assert.equal((await call('logout',{cookie,token:remembered,body:{},origin:'https://other.example'})).status,403);
 const logout=await call('logout',{cookie,token:remembered,body:{}});
 assert.match(logout.headers.get('set-cookie'),/^__Host-a2z-mail=; Max-Age=0;/);
 assert.equal((await call('session',{token:remembered})).status,401);
 const device=await call('login',{body:{email:env.IONOS_EMAIL,password:env.IONOS_PASSWORD,remember:'device'}});
 assert.equal((await device.json()).token,'MailboxCookie');
 assert.match(device.headers.get('set-cookie'),/Max-Age=34560000; Path=\/; Secure; HttpOnly; SameSite=Strict/);
 const deviceCookie=device.headers.get('set-cookie').split(';')[0];
 const fresh=await call('session',{cookie:deviceCookie,token:remembered});
 assert.equal(fresh.status,200);
 assert.equal(fresh.headers.get('set-cookie'),null);
 const realNow=Date.now;
 Date.now=()=>realNow()+2*86400000;
 try {
  const renewed=await call('session',{cookie:deviceCookie,token:remembered});
  assert.equal(renewed.status,200);
  assert.match(renewed.headers.get('set-cookie'),/^__Host-a2z-mail=[A-Za-z0-9_-]+; Max-Age=34560000;/);
  const old=await call('session',{cookie:saved.headers.get('set-cookie').split(';')[0],token:remembered});
  assert.equal(old.headers.get('set-cookie')?.includes('Max-Age=34560000')??false,false);
 } finally { Date.now=realNow; }
});

test('Trash creates a retained folder and permanent deletion targets only a Trash UID', async () => {
 const inbox={path:'INBOX',flags:new Set()};
 const trash={path:'Deleted Items',specialUse:'\\Trash',flags:new Set()};
 const retained={path:'A2Z Trash',flags:new Set()};
 let created=false, moved=false, deleted=false, supportsUidPlus=true;
 class FakeImap {
  get capabilities() {return new Map(supportsUidPlus?[['UIDPLUS',true]]:[]);}
  async connect() {}
  async list() {return [trash,inbox,{path:'Completed Jobs',flags:new Set()},...(created?[retained]:[])];}
  async mailboxCreate(path) {
   assert.equal(path,retained.path);
   created=true;
  }
  async getMailboxLock(path) {
   this.path=path;
   const exists=path===inbox.path&&!moved||path===retained.path&&moved&&!deleted;
   this.mailbox={exists:exists?1:0,uidValidity:22n};
   return {release(){}};
  }
  async fetchAll(_range,fields) {
   if (fields.source) return [];
   return [{uid:4,flags:new Set(),size:40,envelope:{subject:'Invoice for Harbor Point'}}];
  }
  async messageMove(uid,destination,options) {
   assert.equal(uid,'4');
   assert.equal(destination,retained.path);
   assert.deepEqual(options,{uid:true});
   moved=true;
   return {destination};
  }
  async messageDelete(uid,options) {
   assert.equal(this.path,retained.path);
   assert.equal(uid,'4');
   assert.deepEqual(options,{uid:true});
   deleted=true;
   return true;
  }
  close() {}
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{Imap:FakeImap});
 const before=await mailbox.mail();
 assert.deepEqual(before.folders,['Inbox','Trash','Completed Jobs']);
 assert.equal(before.mail[0].project,'',"live mail is not matched to sandbox sample projects");
 const remove=id=>mailbox.update({id,action:'delete-forever'});
 assert.match((await remove('INBOX:22:4')).error,/Move the message to Trash/);
 assert.deepEqual(await mailbox.update({id:'INBOX:22:4',action:'move',destination:'Trash'}),{ok:true});
 const {mail}=await mailbox.mail();
 assert.deepEqual(mail.map(message=>message.folder),['Trash']);
 assert.equal(mail[0].id,'A2Z Trash:22:4');
 assert.deepEqual((await mailbox.mail({includeTrash:false})).mail,[]);
 supportsUidPlus=false;
 assert.match((await remove(mail[0].id)).error,/cannot safely delete/);
 supportsUidPlus=true;
 assert.match((await remove('A2Z Trash:21:4')).error,/mailbox changed/);
 assert.equal(deleted,false);
 assert.deepEqual(await remove(mail[0].id),{ok:true});
 assert.deepEqual((await mailbox.mail()).mail,[]);
});

test('opening a large IONOS email fetches only its readable MIME body', async () => {
 const {Readable}=await import('node:stream');
 const calls=[];
 const bodyStructure={type:'multipart/mixed',childNodes:[
  {type:'multipart/alternative',part:'1',childNodes:[
   {type:'text/plain',part:'1.1'}, {type:'text/html',part:'1.2'},
  ]},
  {type:'application/pdf',part:'2',disposition:'attachment'},
  {type:'text/plain',part:'3',disposition:'attachment'},
  {type:'image/png',part:'4',id:'<logo@sample>',disposition:'inline'},
  {type:'image/png',part:'5',id:'<unused@sample>',disposition:'inline'},
 ]};
 class FakeImap {
  async connect() {}
  async list() { return [{path:'INBOX',flags:new Set()}]; }
  async getMailboxLock(path,options) {
   assert.equal(path,'INBOX');
   assert.equal(options.readOnly,true);
   this.mailbox={exists:1,uidValidity:22n};
   return {release() {}};
  }
  async fetchAll(range,query) {
   assert.equal(query.source,undefined,'mail list must not download the 20 MB message');
   return [{uid:4,size:20_000_000,flags:new Set(),envelope:{subject:'Plans attached'}}];
  }
  async fetchOne(uid,query,options) {
   assert.equal(uid,'4');
   assert.equal(query.bodyStructure,true);
   assert.equal(options.uid,true);
   return {bodyStructure};
  }
  async download(uid,part,options) {
   calls.push(part);
   assert.equal(options.uid,true);
   assert.equal(options.maxBytes,1024*1024+1);
   if (part==='4') return {content:Readable.from([Buffer.from('iVBORw0KGgo=','base64')])};
   const body=part==='1.1'?'  ':'<p>Use the <strong>revised plans</strong>.</p><img src="https://example.com/pixel"><img src="cid:%3Clogo@sample%3E">';
   return {content:Readable.from([Buffer.from(body)])};
  }
  close() {}
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{Imap:FakeImap,transport:()=>({})});
 const {mail}=await mailbox.mail();
 assert.equal(mail[0].body,'');
 assert.equal(mail[0].needsBody,true);
 const detail=await mailbox.body(mail[0].id,{includeAttachments:true});
 assert.ok(detail.attachments.some(file=>file.name.endsWith('.pdf')));
 assert.match(detail.body,/Use the revised plans\./);
 assert.doesNotMatch(detail.body,/<img|<strong>/);
 assert.equal(detail.truncated,false);
 assert.match(detail.html,/<strong>revised plans<\/strong>/);
 assert.equal(detail.images['logo@sample'],'data:image/png;base64,iVBORw0KGgo=');
 assert.deepEqual(calls,['1.1','1.2','4']);
 assert.equal(await mailbox.body('INBOX:21:4'),null);
});

test('HighLevel auto sign-in uses only a matching allowed mailbox in the approved agency and location', async () => {
 const {createCipheriv,createHash}=await import('node:crypto');
 const {createHostedHandler}=await import('../netlify/functions/ionos.mjs');
 const secret='example HighLevel shared secret';
 const identity={email:env.IONOS_EMAIL.toUpperCase(),userId:'user-1',companyId:'company-1',activeLocation:'location-1'};
 function payload(context,key=secret) {
  const salt=Buffer.from('01234567');
  let digest=Buffer.alloc(0);
  let material=Buffer.alloc(0);
  while(material.length<48) {
   digest=createHash('md5').update(digest).update(key).update(salt).digest();
   material=Buffer.concat([material,digest]);
  }
  const cipher=createCipheriv('aes-256-cbc',material.subarray(0,32),material.subarray(32,48));
  return Buffer.concat([Buffer.from('Salted__'),salt,cipher.update(JSON.stringify(context)),cipher.final()]).toString('base64');
 }
 const config={
  ...env,
  SESSION_SECRET:'fixture-session-key-only-000000000000000000000000000000',
  IONOS_ALLOWED_MAILBOXES:env.IONOS_EMAIL,
  GHL_APP_SHARED_SECRET:secret,GHL_COMPANY_ID:'company-1',GHL_LOCATION_IDS:'location-1',
  GHL_IONOS_MAILBOX_PASSWORDS:JSON.stringify({[env.IONOS_EMAIL]:env.IONOS_PASSWORD}),
 };
 const stagedFile={id:'12345678-1234-4321-8999-123456789012',name:'plans.pdf',size:5};
 const draftId='0d8bac5c-d3f4-4fa5-ad0b-e967daee3afd';
 const deps={mailboxFactory:mailConfig=>({mail:async()=>{
  assert.equal(mailConfig.imap.auth.pass,env.IONOS_PASSWORD);
  return {email:mailConfig.email,mail:[]};
 }}),uploadsFactory:email=>({readChunk:async(draft,file,index)=>{
  assert.deepEqual([email,draft,file,index],[env.IONOS_EMAIL,draftId,stagedFile.id,0]);
  return Buffer.from('%PDF-');
 }})};
 const handler=createHostedHandler(config,deps);
 const call=(action,{body,token}={},handle=handler)=>handle(new Request('https://inbox.example/.netlify/functions/ionos?action='+action,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
  body:body?JSON.stringify(body):undefined,
 }));
 const exchange=(encryptedData,parentOrigin='https://app.gohighlevel.com')=>call('ghl-login',{body:{encryptedData,parentOrigin}});
 assert.equal((await exchange(payload({...identity,activeLocation:'wrong-location'}))).status,401);
 assert.equal((await exchange(payload({...identity,companyId:'wrong-company'}))).status,401);
 assert.equal((await exchange(payload({...identity,email:'other@example.com'}))).status,401);
 assert.equal((await exchange(payload(identity,'wrong-secret'))).status,401);
 assert.equal((await exchange(payload(identity),'https://example.com')).status,401);
 const result=await exchange(payload(identity));
 assert.equal(result.status,200);
 const {token,email}=await result.json();
 assert.equal(email,env.IONOS_EMAIL);
 assert.equal((await call('mail',{token})).status,200);
 const body={draftId,file:stagedFile,index:0};
 assert.equal((await call('draft-attachment-chunk',{body})).status,401);
 assert.equal((await call('draft-attachment-chunk',{body:{...body,index:1},token})).status,400);
 const chunk=await call('draft-attachment-chunk',{body,token});
 assert.equal(chunk.status,200);
 assert.equal(Buffer.from((await chunk.json()).data,'base64').toString(),'%PDF-');
 const rejected=createHostedHandler(config,{mailboxFactory:()=>({mail:async()=>{
  throw Object.assign(new Error('authentication rejected'),{authenticationFailed:true});
 }})});
 const rejectedResponse=await call('mail',{token},rejected);
 assert.equal(rejectedResponse.status,401);
 assert.equal((await rejectedResponse.json()).reason,'ghl_ionos_auth');
 const revoked=createHostedHandler({...config,GHL_IONOS_MAILBOX_PASSWORDS:'{}'},deps);
 assert.equal((await call('mail',{token},revoked)).status,401);
});

test('saved drafts keep attachments and signatures under the authenticated mailbox', async () => {
 const {mailboxPreferences}=await import('../server/mail-preferences.mjs');
 const records=new Map();
 const store={
  async get(key) {return records.get(key)?.data??null;},
  async getMetadata(key) {return records.get(key)||null;},
  async list({prefix}) {return {blobs:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};},
  async setJSON(key,data,{metadata,onlyIfNew}={}) {
   if (onlyIfNew&&records.has(key)) return {modified:false};
   records.set(key,{data,metadata});
   return {modified:true};
  },
  async delete(key) {records.delete(key);},
 };
 const first=mailboxPreferences('one@example.com',store);
 const second=mailboxPreferences('two@example.com',store);
 const id='0d8bac5c-d3f4-4fa5-ad0b-e967daee3afd';
 const attachments=[{name:'plans.txt',data:Buffer.from('test plans').toString('base64')}];
 await first.saveDraft({id,to:'gc@example.com',cc:'',subject:'Revised plans',body:'Draft message',attachments,identity:'two@example.com'});
 const {createMailFeedHandler}=await import('../netlify/functions/mail-feed.mjs');
 const draftToken='fixture-mail-draft-token-at-least-32-characters';
 const readToken='fixture-mail-read-token-at-least-32-characters';
 const handler=createMailFeedHandler({
  A2Z_MODE:'live',MCP_MAIL_TOKEN:readToken,MCP_MAIL_DRAFT_TOKEN:draftToken,
  MCP_IONOS_EMAIL:'one@example.com',MCP_IONOS_PASSWORD:'test',IONOS_ALLOWED_MAILBOXES:'one@example.com',
 },{preferences:email=>mailboxPreferences(email,store),makeMailbox:()=>assert.fail('Drafts do not use IMAP or SMTP')});
 const draft={id:'1269fce3-ae54-4d08-bd4c-618f4828ea13',body:'Draft for review'};
 const post=(data,token=draftToken)=>handler(new Request('https://test.example/api/mcp/mail/draft',{
  method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(data),
 }));
 assert.equal((await post(draft,readToken)).status,401);
 assert.equal((await post(draft)).status,200);
 assert.equal((await post(draft)).status,200);
 assert.equal((await post({...draft,body:'Different text'})).status,409);
 assert.equal((await first.loadDraft(draft.id)).body,draft.body);
 assert.equal(await second.loadDraft(draft.id),null);
 await first.discard(draft.id);
 const logo='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
 await first.saveSignature('Operations\nA2Z Construction',logo);
 await second.saveSignature('');
 const firstSummary=await first.load();
 assert.equal(firstSummary.signature,'Operations\nA2Z Construction');
 assert.equal(firstSummary.signatureImage,logo);
 assert.equal(firstSummary.drafts[0].subject,'Revised plans');
 assert.equal(firstSummary.drafts[0].attachments,undefined);
 const opened=await first.loadDraft(id);
 assert.deepEqual(opened.attachments,attachments);
 assert.equal(opened.identity,'one@example.com');
 assert.equal(await second.loadDraft(id),null);
 assert.deepEqual(await second.load(),{drafts:[],signature:'',signatureImage:null});
 await first.discard(id);
 assert.deepEqual((await first.load()).drafts,[]);
 assert.equal((await first.load()).signature,'Operations\nA2Z Construction');
});

test('large staged attachments are reassembled in order and isolated by draft and mailbox', async () => {
 const {stagedAttachments,CHUNK_BYTES,MAX_STAGED_BYTES}=await import('../server/staged-attachments.mjs');
 const records=new Map();
 const store={
  async set(key,data){records.set(key,data);},
  async get(key){return records.get(key)||null;},
  async list({prefix}){return {blobs:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};},
  async delete(key){records.delete(key);},
 };
 const uploads=stagedAttachments('one@example.com',store);
 const other=stagedAttachments('two@example.com',store);
 const id='0d8bac5c-d3f4-4fa5-ad0b-e967daee3afd';
 const file={id:'12345678-1234-4321-8999-123456789012',name:'project-plans.pdf',size:CHUNK_BYTES+5};
 const start=Buffer.alloc(CHUNK_BYTES,0x24);
 const tail=Buffer.from('tail!');
 await uploads.upload({draftId:id,file,index:0,data:start.toString('base64')});
 await assert.rejects(uploads.resolve(id,[file]),/did not finish uploading/);
 await uploads.upload({draftId:id,file,index:1,data:tail.toString('base64')});
 const [attachment]=await uploads.resolve(id,[file]);
 assert.equal(attachment.filename,'project-plans.pdf');
 assert.deepEqual(attachment.content,Buffer.concat([start,tail]));
 await assert.rejects(other.resolve(id,[file]),/did not finish uploading/);
 await assert.rejects(uploads.resolve(id,[{...file,size:MAX_STAGED_BYTES+1}]),/24 MB/);
 await uploads.clean(id);
 assert.equal(records.size,0);
});

test('HighLevel status identifies malformed mailbox configuration without returning secret values', async () => {
 const {createHostedHandler}=await import('../netlify/functions/ionos.mjs');
 const handler=createHostedHandler({
  A2Z_MODE:'live',SESSION_SECRET:'a'.repeat(32),IONOS_ALLOWED_MAILBOXES:'first@example.com',
  GHL_APP_SHARED_SECRET:'fixture secret',GHL_COMPANY_ID:'agency',GHL_LOCATION_IDS:'subaccount',
  GHL_IONOS_MAILBOX_PASSWORDS:'{"first@example.com":"fixture password",}',
 });
 const response=await handler(new Request('https://test.example/.netlify/functions/ionos?action=status'));
 const status=await response.json();
 assert.deepEqual(status.highLevelOrigins,[]);
 assert.deepEqual(status.highLevelIssues,['GHL_IONOS_MAILBOX_PASSWORDS is not valid JSON']);
 assert.doesNotMatch(JSON.stringify(status),/fixture|first@example/);
});

test('a live PDF can be opened and forwarded unchanged with a CID signature image', async () => {
 const {Readable}=await import('node:stream');
 const bytes=Buffer.from('%PDF-1.7\nfixture PDF');
 const bodyStructure={type:'multipart/mixed',childNodes:[
  {type:'text/plain',part:'1'},
  {type:'application/pdf',part:'2',disposition:'attachment',dispositionParameters:{filename:'plans.pdf'},size:24},
  {type:'image/png',part:'3',id:'embedded-logo',parameters:{name:'logo.png'}},
 ]};
 let sent;
 class FakeImap {
  async connect(){}
  async list(){return [{path:'INBOX',flags:new Set()}];}
  async getMailboxLock(){this.mailbox={exists:1,uidValidity:22n};return {release(){}};}
  async fetchAll(){return [{uid:4,size:25_000_000,flags:new Set(),envelope:{subject:'Plans'},bodyStructure}];}
  async fetchOne(){return {bodyStructure};}
  async download(uid,part){
   assert.equal(uid,'4');
   assert.equal(part,'2');
   return {content:Readable.from([bytes])};
  }
  close(){}
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{
  Imap:FakeImap,transport:()=>({async sendMail(message){sent=message;return {messageId:message.messageId,rejected:[]};}}),
 });
 const {mail}=await mailbox.mail();
 assert.deepEqual(mail[0].attachments.map(file=>file.name),['plans.pdf']);
 const fetched=await mailbox.attachment(mail[0].id,'2');
 assert.equal(fetched.type,'application/pdf');
 assert.deepEqual(fetched.content,bytes);
 assert.equal(await mailbox.attachment(mail[0].id,'1'),null);
 assert.equal(await mailbox.attachment('INBOX:21:4','2'),null);
 await mailbox.send({
  id:'out-12345678-1234-1234-1234-123456789012',to:'gc@builder.example',cc:'',
  subject:'Fwd: Plans',body:'See <plans> & notes.',forwardedAttachments:[{messageId:mail[0].id,part:'2',name:'ignored.pdf'}],
  signatureImage:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
 });
 const [file,logo]=sent.attachments;
 assert.equal(file.filename,'plans.pdf');
 assert.deepEqual(file.content,bytes);
 assert.equal(logo.contentType,'image/gif');
 assert.ok(sent.html.includes('cid:'+logo.cid));
 assert.match(sent.html,/See &lt;plans&gt; &amp; notes/);
});

test('MCP Command Center exposes only authenticated aggregate stats', async () => {
 const {createCommandCenterHandler}=await import('../netlify/functions/command-center.mjs');
 const {commandCenterStats}=await import('../src/model.mjs');
 const token='test-only-a2z-command-center-reference-key';
 let reads=0;
 const handler=createCommandCenterHandler({
  A2Z_MODE:'live',MCP_COMMAND_CENTER_TOKEN:token,MCP_IONOS_EMAIL:env.IONOS_EMAIL,
  MCP_IONOS_PASSWORD:env.IONOS_PASSWORD,IONOS_ALLOWED_MAILBOXES:env.IONOS_EMAIL,
 },()=>({async mail(){reads++;return {mail:seed};}}));
 const request=(method='GET',authorization)=>new Request('https://test.example/api/mcp/command-center',{
  method,headers:authorization?{Authorization:authorization}:{},
 });
 assert.equal((await handler(request())).status,401);
 assert.equal((await handler(request('POST','Bearer '+token))).status,405);
 const response=await handler(request('GET','Bearer '+token));
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).stats,commandCenterStats(seed));
 assert.equal(reads,1);
});

test('mail feed paginates oldest/newest by stable UID and rejects stale folder generations', async () => {
 const {createMailFeedHandler}=await import('../netlify/functions/mail-feed.mjs');
 const token='separate-fixture-token-for-mail-data-123';
 const uids=[1,5,6,12,18];
 let reads=0;
 class FakeImap {
  async connect(){}
  async getMailboxLock(folder,options){
   assert.equal(folder,'INBOX');assert.equal(options.readOnly,true);
   this.mailbox={uidValidity:9n,uidNext:19};return {release(){}};
  }
  async search(query){
   const [lo,hi]=query.uid.split(':').map(Number);
   return uids.filter(uid=>uid>=lo&&uid<=hi);
  }
  async fetchAll(ids,query){
   reads++;
   assert.equal(query.source,undefined);
   return [...ids].reverse().map(uid=>({uid,flags:new Set(['\\Seen']),envelope:{subject:'Message '+uid}}));
  }
  close(){}
 }
 const handler=createMailFeedHandler({
  A2Z_MODE:'live',MCP_MAIL_TOKEN:token,MCP_COMMAND_CENTER_TOKEN:'different-stats-token',
  MCP_IONOS_EMAIL:env.IONOS_EMAIL,MCP_IONOS_PASSWORD:env.IONOS_PASSWORD,IONOS_ALLOWED_MAILBOXES:env.IONOS_EMAIL,
 },{makeMailbox:config=>createIonosMailbox(config,{Imap:FakeImap,transport:()=>({})})});
 const call=(query,auth=token)=>handler(new Request('https://test.example/api/mcp/mail/messages?'+query,{headers:{Authorization:'Bearer '+auth}}));
 assert.equal((await call('','different-stats-token')).status,401);
 const newer=await (await call('limit=2')).json();
 assert.deepEqual(newer.rows.map(row=>row[0]),[18,12]);
 assert.equal(newer.next,12);
 assert.equal(newer.highWaterUid,18);
 assert.equal(newer.uidValidity,'9');
 assert.equal(newer.rows[0].length,newer.columns.length);
 const older=await (await call('limit=2&before=12&uidValidity=9&view=full')).json();
 assert.deepEqual(older.messages.map(message=>message.uid),[6,5]);
 assert.equal(older.messages[0].id,'INBOX:9:6');
 const incremental=await (await call('limit=2&after=5&uidValidity=9')).json();
 assert.deepEqual(incremental.rows.map(row=>row[0]),[6,12]);
 assert.equal(incremental.next,12);
 const last=await (await call('limit=2&after=12&uidValidity=9')).json();
 assert.deepEqual(last.rows.map(row=>row[0]),[18]);
 assert.equal(last.hasMore,false);
 assert.equal((await call('after=12')).status,400);
 assert.equal((await call('after=12&uidValidity=7')).status,409);
 assert.equal(reads,4);
});

test('large file links sign upload parts for 1 GB and send a time-limited private link', async () => {
 const {largeFileLinks,LARGE_FILE_LIMIT}=await import('../server/large-file-links.mjs');
 const draftId='0d8bac5c-d3f4-4fa5-ad0b-e967daee3afd';
 const file={id:'12345678-1234-4321-8999-123456789012',name:'project set.pdf',size:LARGE_FILE_LIMIT};
 const events=[];
 const storage=largeFileLinks({
  R2_ACCOUNT_ID:'a'.repeat(32),ATTACHMENT_STORAGE_BUCKET:'private-files',
  R2_ACCESS_KEY_ID:'fixture key',R2_SECRET_ACCESS_KEY:'fixture secret',
 },'fixture@example.com',{
  client:{async send(command){
   events.push(command);
   if (command.constructor.name==='CreateMultipartUploadCommand') return {UploadId:'fixture-upload'};
   if (command.constructor.name==='HeadObjectCommand') return {ContentLength:file.size};
   return {};
  }},
  async sign(client,command,options){
   events.push(command);
   return 'https://r2.example/'+(command.input.PartNumber||'download')+'?expires='+options.expiresIn;
  }
 });
 const {urls,partBytes,uploadId}=await storage.begin({draftId,file});
 assert.equal(urls.length,64);
 assert.equal(partBytes*urls.length,LARGE_FILE_LIMIT);
 assert.equal(uploadId,'fixture-upload');
 assert.ok(urls[0].endsWith('?expires=7200'));
 await storage.complete({draftId,file,uploadId,etags:urls.map(()=>'"'+ 'a'.repeat(32)+'"')});
 const completion=events.find(command=>command.constructor.name==='CompleteMultipartUploadCommand');
 assert.equal(completion.input.MultipartUpload.Parts.at(-1).PartNumber,64);
 const links=await storage.links(draftId,[file]);
 assert.deepEqual(links,[{name:file.name,url:'https://r2.example/download?expires=604800'}]);
 await assert.rejects(storage.begin({draftId,file:{...file,size:LARGE_FILE_LIMIT+1}}),/up to 1 GB/);
});

test('outbound MIME preserves Unicode, readable line breaks and a binary attachment', async () => {
 const {default:nodemailer}=await import('nodemailer');
 const {simpleParser}=await import('mailparser');
 const stream=nodemailer.createTransport({streamTransport:true,buffer:true});
 let mime;
 class NoSentFolder {
  async connect() {}
  async list() { return []; }
  close() {}
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{
  Imap:NoSentFolder,
  transport:()=>({async sendMail(message) {
   const result=await stream.sendMail(message);
   mime=result.message;
   return result;
  }}),
 });
 const body='你好 👋\n\nCafé & <details>';
 const bytes=Buffer.from([0,128,255,13,10]);
 await mailbox.send({
  id:'out-12345678-1234-1234-1234-123456789012',to:'recipient@example.com',
  subject:'Résumé',body,attachments:[{name:'sample.bin',data:bytes.toString('base64')}],
 });
 const raw=mime.toString();
 assert.equal((raw.match(/^Content-Transfer-Encoding: quoted-printable$/gim)||[]).length,2);
 assert.match(raw,/^Content-Transfer-Encoding: base64$/im);
 const parsed=await simpleParser(mime);
 assert.equal(parsed.text.replace(/\r\n/g,'\n'),body);
 assert.match(parsed.html,/你好 👋<br><br>Café &amp; &lt;details&gt;/);
 assert.equal(parsed.subject,'Résumé');
 assert.deepEqual(parsed.attachments[0].content,bytes);
});

test('Bcc is routed by SMTP without a public header and preserved in the sender’s Sent copy', async () => {
 const {default:nodemailer}=await import('nodemailer');
 let smtpEnvelope,smtpHeaders,sentHeaders;
 const headers=buffer=>buffer.toString().split('\r\n\r\n',1)[0];
 class SentImap {
  async connect(){}
  async list(){return [{path:'Sent',specialUse:'\\Sent',flags:new Set()}];}
  async append(path,bytes){
   assert.equal(path,'Sent');
   sentHeaders=headers(bytes);
   return {};
  }
  close(){}
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{
  Imap:SentImap,
  transport:()=>nodemailer.createTransport({
   name:'fixture-smtp',version:'1',
   send(message,callback) {
    smtpEnvelope=message.message.getEnvelope();
    message.message.build((error,mime)=>{
     if (error) return callback(error);
     smtpHeaders=headers(mime);
     callback(null,{messageId:message.message.messageId(),rejected:[]});
    });
   },
  }),
 });
 await mailbox.send({id:'out-12345678-1234-1234-1234-123456789012',to:'',cc:'',bcc:'blind@example.com',subject:'Mail',body:'Test'});
 assert.deepEqual(smtpEnvelope.to,['blind@example.com']);
 assert.doesNotMatch(smtpHeaders,/^Bcc:|blind@example\.com/im);
 assert.match(sentHeaders,/^Bcc: blind@example\.com/im);
});

test('HighLevel lookup sends only the configured location and returns deduplicated recipient fields', async () => {
 const {contactsConfig,searchContacts}=await import('../server/ghl-contacts.mjs');
 const config=contactsConfig({GHL_CONTACTS_PIT_TOKEN:'fixture-token',GHL_LOCATION_IDS:'a,b',GHL_CONTACTS_LOCATION_ID:'b'});
 assert.equal(contactsConfig({GHL_CONTACTS_PIT_TOKEN:'fixture-token',GHL_LOCATION_IDS:'a,b'}),null);
 const matches=await searchContacts(config,'Pat',async(url,options)=>{
  assert.equal(url,'https://services.leadconnectorhq.com/contacts/search');
  assert.equal(options.headers.Authorization,'Bearer fixture-token');
  assert.equal(options.headers.Version,'v3');
  assert.deepEqual(JSON.parse(options.body),{locationId:'b',query:'Pat',page:1,pageLimit:12});
  return Response.json({contacts:[
   {firstName:'Pat',lastName:'Lee',email:'pat@example.com',locationId:'b',phone:'555-0100'},
   {email:'PAT@example.com',locationId:'b'},
   {email:'other@example.com',locationId:'a'},
   {firstName:'Missing email',locationId:'b'},
  ]});
 });
 assert.deepEqual(matches,[{name:'Pat Lee',address:'pat@example.com',source:'HighLevel'}]);
});
