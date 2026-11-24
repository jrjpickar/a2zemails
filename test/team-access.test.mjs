import test from 'node:test';
import assert from 'node:assert/strict';
import {teamDirectory,displayName} from '../server/team-directory.mjs';
import {createIonosMailbox,decodePreview,ionosConfig} from '../server/ionos.mjs';

function memoryStore() {
 let value=null, version=0;
 return {
  async get() {return value&&structuredClone(value);},
  async getWithMetadata() {return value?{data:structuredClone(value),etag:'v'+version}:null;},
  async setJSON(_key,data,options={}) {
   if (options.onlyIfNew&&value) return {modified:false};
   if (options.onlyIfMatch&&options.onlyIfMatch!=='v'+version) return {modified:false};
   value=structuredClone(data);version++;
   return {modified:true,etag:'v'+version};
  },
 };
}

const secret='fixture-session-key-only-000000000000000000000000000000';
const admin='jesse@a2z.example';

test('display names fall back to the mailbox name', () => {
 assert.equal(displayName('jesse.pickar@a2z.example'),'Jesse Pickar');
 assert.equal(displayName('estimating@a2z.example',''),'Estimating');
 assert.equal(displayName('x@a2z.example','  Art Jr '),'Art Jr');
});

test('senior admin onboards, renames, revokes and offboards without a redeploy', async () => {
 const store=memoryStore();
 let clock=1_000;
 const directory=teamDirectory({IONOS_ALLOWED_MAILBOXES:'field@a2z.example',SENIOR_ADMIN_EMAILS:admin},{storeFactory:()=>store,now:()=>clock,ttl:0});
 assert.equal((await directory.access(admin)).admin,true);
 assert.equal((await directory.access('field@a2z.example')).allowed,true);
 assert.equal((await directory.access('new@a2z.example')).allowed,false);

 let users=await directory.update(admin,{op:'onboard',email:'New@A2Z.example',name:'Nina New'});
 assert.equal(users.find(user=>user.email==='new@a2z.example').status,'active');
 const access=await directory.access('new@a2z.example',clock);
 assert.deepEqual([access.allowed,access.name,access.namedByAdmin],[true,'Nina New',true]);

 clock=2_000;
 await directory.update(admin,{op:'revoke',email:'new@a2z.example'});
 assert.equal((await directory.access('new@a2z.example',1_500)).allowed,false,'older session is revoked');
 assert.equal((await directory.access('new@a2z.example',2_500)).allowed,true,'new sign-in works');

 users=await directory.update(admin,{op:'offboard',email:'field@a2z.example'});
 assert.equal(users.find(user=>user.email==='field@a2z.example').status,'offboarded');
 assert.equal((await directory.access('field@a2z.example',9_999)).allowed,false,'env-listed mailbox is blocked');

 await directory.update(admin,{op:'onboard',email:'field@a2z.example'});
 clock=3_000;
 assert.equal((await directory.access('field@a2z.example',3_000)).allowed,true);

 await assert.rejects(directory.update(admin,{op:'offboard',email:admin}),/SENIOR_ADMIN_EMAILS/);
 await assert.rejects(directory.update(admin,{op:'onboard',email:'not-an-address'}),/full mailbox/);
});

test('hosted team routes are limited to senior admins and offboarding ends sessions', async () => {
 const {createHostedHandler}=await import('../netlify/functions/ionos.mjs');
 const store=memoryStore();
 class FakeImap {on(){} async connect(){} close(){}}
 const handler=createHostedHandler({
  A2Z_MODE:'live',SESSION_SECRET:secret,IONOS_ALLOWED_MAILBOXES:'crew@a2z.example',SENIOR_ADMIN_EMAILS:admin,
 },{
  Imap:FakeImap,
  directoryFactory:env=>teamDirectory(env,{storeFactory:()=>store,ttl:0}),
  mailboxFactory:config=>({mail:async()=>({email:config.email,mail:[],contacts:[]})}),
 });
 const call=(action,{body,token}={})=>handler(new Request('https://test.example/.netlify/functions/ionos?action='+action,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
  body:body?JSON.stringify(body):undefined,
 }));
 const signIn=async email=>(await (await call('login',{body:{email,password:'fixture-only'}})).json()).token;

 const adminToken=await signIn(admin);
 const crewToken=await signIn('crew@a2z.example');
 assert.ok(adminToken&&crewToken);
 assert.equal((await call('login',{body:{email:'hire@a2z.example',password:'fixture-only'}})).status,401);

 const mail=await (await call('mail',{token:adminToken})).json();
 assert.deepEqual(mail.profile,{email:admin,admin:true,name:'Jesse'});
 assert.equal((await call('team',{token:crewToken})).status,403);
 assert.equal((await call('team',{token:crewToken,body:{op:'offboard',email:admin}})).status,403);

 const onboard=await call('team',{token:adminToken,body:{op:'onboard',email:'hire@a2z.example',name:'Sam Hire'}});
 assert.equal(onboard.status,200);
 const hireToken=await signIn('hire@a2z.example');
 assert.equal((await (await call('mail',{token:hireToken})).json()).profile.name,'Sam Hire');

 assert.equal((await call('team',{token:adminToken,body:{op:'offboard',email:'crew@a2z.example'}})).status,200);
 assert.equal((await call('mail',{token:crewToken})).status,401);
 assert.equal((await call('login',{body:{email:'crew@a2z.example',password:'fixture-only'}})).status,401);
 assert.equal((await call('team',{token:adminToken,body:{op:'explode',email:'crew@a2z.example'}})).status,400);
});

test('previews decode base64, quoted-printable and HTML parts', () => {
 const encoded=Buffer.from('Invitation to bid: demolition scope, walkthrough Monday').toString('base64');
 assert.equal(decodePreview({type:'text/plain',encoding:'base64'},Buffer.from(encoded.slice(0,40)+'\r\n'+encoded.slice(40,50))),
  'Invitation to bid: demolition scope,');
 assert.equal(decodePreview({type:'text/plain',encoding:'quoted-printable',charset:'utf-8'},Buffer.from('Bids due =E2=80=94 Friday=\r\n at 2 PM')),
  'Bids due — Friday at 2 PM');
 assert.equal(decodePreview({type:'text/html'},Buffer.from('<style>p{}</style><p>Submit your bid&nbsp;by 12/4</p>')),'Submit your bid by 12/4');
});

test('large messages are classified from a partial text preview and older pages load by UID', async () => {
 const env={A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'jesse@a2z.example',IONOS_PASSWORD:'fixture-only'};
 const structure={type:'multipart/mixed',childNodes:[
  {type:'text/plain',part:'1',encoding:'7bit'},
  {type:'application/pdf',part:'2',disposition:'attachment',dispositionParameters:{filename:'plans.pdf'},size:5_000_000},
 ]};
 const body='You are invited to bid on the interior demolition. Bids due 12/18/2026.';
 const row=uid=>({uid,size:5_000_000,flags:new Set(),internalDate:new Date(Date.UTC(2026,9,uid)),
  envelope:{subject:'Harbor Point TI',from:[{address:'pm@gc.example',name:'PM'}]},bodyStructure:structure});
 const requests=[];
 class FakeImap {
  on(){} async connect(){} close(){}
  async list(){return [{path:'INBOX',flags:new Set()}];}
  async getMailboxLock(){this.mailbox={exists:3,uidValidity:7n,uidNext:31};return {release(){}};}
  async search(query){requests.push(query.uid);return [10,11,12,20,21];}
  async fetchAll(range,query){
   if (query.bodyParts) return (Array.isArray(range)?range:[]).map(uid=>({uid,bodyParts:new Map([[query.bodyParts[0].key,Buffer.from(body)]])}));
   if (query.source) return [];
   if (Array.isArray(range)) return range.map(row);
   return [row(28),row(29),row(30)];
  }
 }
 const mailbox=createIonosMailbox(ionosConfig(env),{Imap:FakeImap,transport:()=>({})});
 const {mail}=await mailbox.mail();
 assert.equal(mail[0].category,'Bid Invitations');
 assert.match(mail[0].body,/invited to bid/);
 assert.equal(mail[0].needsBody,true);

 const older=await mailbox.olderMail({path:'INBOX',generation:'7',before:28});
 assert.deepEqual(older.mail.map(message=>message.id),['INBOX:7:21','INBOX:7:20','INBOX:7:12','INBOX:7:11','INBOX:7:10']);
 assert.equal(older.mail[0].category,'Bid Invitations');
 assert.equal(older.next,null);
 assert.deepEqual(await mailbox.olderMail({path:'INBOX',generation:'8',before:28}),{resetRequired:true});
 await assert.rejects(mailbox.olderMail({path:'INBOX',generation:'x',before:28}),TypeError);
});

test('senior admin saves a HighLevel password in Team access and auto sign-in uses it', async () => {
 const {createCipheriv,createHash}=await import('node:crypto');
 const {createHostedHandler}=await import('../netlify/functions/ionos.mjs');
 const shared='example HighLevel shared secret';
 function payload(context) {
  const salt=Buffer.from('01234567');
  let digest=Buffer.alloc(0), material=Buffer.alloc(0);
  while(material.length<48) {digest=createHash('md5').update(digest).update(shared).update(salt).digest();material=Buffer.concat([material,digest]);}
  const cipher=createCipheriv('aes-256-cbc',material.subarray(0,32),material.subarray(32,48));
  return Buffer.concat([Buffer.from('Salted__'),salt,cipher.update(JSON.stringify(context)),cipher.final()]).toString('base64');
 }
 const store=memoryStore();
 const passwords={[admin]:'admin-pass','hire@a2z.example':'right-pass'};
 class FakeImap {
  constructor(config){this.auth=config.auth;}
  on(){}
  async connect(){if(passwords[this.auth.user]!==this.auth.pass) throw Object.assign(new Error('auth'),{authenticationFailed:true});}
  close(){}
 }
 let mailboxPassword;
 const handler=createHostedHandler({
  A2Z_MODE:'live',SESSION_SECRET:secret,SENIOR_ADMIN_EMAILS:admin,
  GHL_APP_SHARED_SECRET:shared,GHL_COMPANY_ID:'company-1',GHL_LOCATION_IDS:'location-1',
 },{
  Imap:FakeImap,
  directoryFactory:env=>teamDirectory(env,{storeFactory:()=>store,ttl:0}),
  mailboxFactory:config=>({mail:async()=>{mailboxPassword=config.imap.auth.pass;return {email:config.email,mail:[],contacts:[]};}}),
 });
 const call=(action,{body,token}={})=>handler(new Request('https://test.example/.netlify/functions/ionos?action='+action,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
  body:body?JSON.stringify(body):undefined,
 }));
 const ghl=email=>call('ghl-login',{body:{encryptedData:payload({email,userId:'u',companyId:'company-1',activeLocation:'location-1',userName:'Sam Hire'}),parentOrigin:'https://app.gohighlevel.com'}});
 const adminToken=(await (await call('login',{body:{email:admin,password:'admin-pass'}})).json()).token;

 await call('team',{token:adminToken,body:{op:'onboard',email:'hire@a2z.example'}});
 assert.equal((await ghl('hire@a2z.example')).status,401,'no password saved yet');

 const wrong=await call('team',{token:adminToken,body:{op:'set-ghl-password',email:'hire@a2z.example',password:'wrong'}});
 assert.equal(wrong.status,400);
 assert.match((await wrong.json()).error,/rejected/);

 const saved=await call('team',{token:adminToken,body:{op:'set-ghl-password',email:'hire@a2z.example',password:'right-pass'}});
 const users=(await saved.json()).users;
 const hire=users.find(user=>user.email==='hire@a2z.example');
 assert.equal(hire.ghlSaved,true);
 assert.equal(JSON.stringify(users).includes('right-pass'),false,'password never returned');
 assert.equal(JSON.stringify(await store.get()).includes('right-pass'),false,'password stored encrypted');

 const signIn=await ghl('hire@a2z.example');
 assert.equal(signIn.status,200);
 const ghlToken=(await signIn.json()).token;
 const mail=await (await call('mail',{token:ghlToken})).json();
 assert.equal(mailboxPassword,'right-pass');
 assert.equal(mail.profile.name,'Sam Hire');

 await call('team',{token:adminToken,body:{op:'offboard',email:'hire@a2z.example'}});
 assert.equal((await call('mail',{token:ghlToken})).status,401);
 await call('team',{token:adminToken,body:{op:'onboard',email:'hire@a2z.example'}});
 assert.equal((await ghl('hire@a2z.example')).status,401,'offboarding deleted the saved password');
});
