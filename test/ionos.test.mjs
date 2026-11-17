import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIonosMailbox, ionosConfig } from '../server/ionos.mjs';
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
  mailboxFactory:config=>({mail:async()=>({email:config.email,mail:[],contacts:[]})}),
 });
 const call=(action,{body,token,origin}={})=>handler(new Request('https://test.example/.netlify/functions/ionos?action='+action,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})},
  body:body?JSON.stringify(body):undefined,
 }));
 assert.equal((await call('mail')).status,401);
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
   const body=part==='1.1'?'  ':'<p>Use the <strong>revised plans</strong>.</p><img src="https://example.com/pixel"><img src="cid:logo@sample">';
   return {content:Readable.from([Buffer.from(body)])};
  }
  close() {}
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{Imap:FakeImap,transport:()=>({})});
 const {mail}=await mailbox.mail();
 assert.equal(mail[0].body,'');
 assert.equal(mail[0].needsBody,true);
 const detail=await mailbox.body(mail[0].id);
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
 const deps={mailboxFactory:mailConfig=>({mail:async()=>{
  assert.equal(mailConfig.imap.auth.pass,env.IONOS_PASSWORD);
  return {email:mailConfig.email,mail:[]};
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
  async setJSON(key,data,{metadata}={}) {records.set(key,{data,metadata});},
  async delete(key) {records.delete(key);},
 };
 const first=mailboxPreferences('one@example.com',store);
 const second=mailboxPreferences('two@example.com',store);
 const id='0d8bac5c-d3f4-4fa5-ad0b-e967daee3afd';
 const attachments=[{name:'plans.txt',data:Buffer.from('test plans').toString('base64')}];
 await first.saveDraft({id,to:'gc@example.com',cc:'',subject:'Revised plans',body:'Draft message',attachments,identity:'two@example.com'});
 await first.saveSignature('Operations\nA2Z Construction');
 await second.saveSignature('');
 const firstSummary=await first.load();
 assert.equal(firstSummary.signature,'Operations\nA2Z Construction');
 assert.equal(firstSummary.drafts[0].subject,'Revised plans');
 assert.equal(firstSummary.drafts[0].attachments,undefined);
 const opened=await first.loadDraft(id);
 assert.deepEqual(opened.attachments,attachments);
 assert.equal(opened.identity,'one@example.com');
 assert.equal(await second.loadDraft(id),null);
 assert.deepEqual(await second.load(),{drafts:[],signature:''});
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
