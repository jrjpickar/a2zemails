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
 });
 assert.equal(outgoing.from,env.IONOS_EMAIL);
 assert.equal(outgoing.text,'We intend to bid.\n\n-- \nA2Z Operations\nEstimating');
 assert.equal(outgoing.inReplyTo,id);
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
   const body=part==='1.1'?'  ':'<p>Use the <strong>revised plans</strong>.</p><img src="https://example.com/pixel">';
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
 assert.deepEqual(calls,['1.1','1.2']);
 assert.equal(await mailbox.body('INBOX:21:4'),null);
});
