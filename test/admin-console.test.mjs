import test from 'node:test';
import assert from 'node:assert/strict';
import {adminConsole,healthChecks} from '../server/admin-console.mjs';
import {teamDirectory} from '../server/team-directory.mjs';
import {classify,keywordCategory} from '../src/model.mjs';

function memoryStores() {
 const stores=new Map();
 return name=>{
  if (stores.has(name)) return stores.get(name);
  const data=new Map();
  let version=0;
  const store={
   async get(key){return data.has(key)?structuredClone(data.get(key)):null;},
   async getWithMetadata(key){return data.has(key)?{data:structuredClone(data.get(key)),etag:'v'+version}:null;},
   async setJSON(key,value,options={}){
    if (options.onlyIfNew&&data.has(key)) return {modified:false};
    if (options.onlyIfMatch&&options.onlyIfMatch!=='v'+version) return {modified:false};
    data.set(key,structuredClone(value));version++;return {modified:true};
   },
   async set(key,value){data.set(key,value);},
   async delete(key){data.delete(key);},
   async list({prefix}){return {blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};},
  };
  stores.set(name,store);
  return store;
 };
}

test('admin keywords sort mail before built-in rules', () => {
 const keywords=[{term:'pricing due',category:'Bid Invitations',field:'subject'},{term:'planhub digest',category:'General',field:'any'},
  {term:'c++ (demo)',category:'Estimating',field:'subject'}];
 assert.equal(classify('Pricing due Friday for Lot 4','','pm@gc.example',{},keywords),'Bid Invitations');
 assert.equal(classify('Weekly projects','Your PlanHub digest is ready','news@planhub.com',{},keywords),'General');
 assert.equal(classify('Weekly projects','Your PlanHub digest is ready','news@planhub.com'),'Bid Invitations','built-in rule without keyword');
 assert.equal(keywordCategory('Re: c++ (demo) scope','',keywords),'Estimating','special characters are escaped');
 assert.equal(keywordCategory('Repricing due','',keywords),'','matches whole words only');
});

test('keywords and activity persist in Blobs', async () => {
 let clock=Date.UTC(2026,10,24,18);
 const admin=adminConsole({storeFactory:memoryStores(),now:()=>clock});
 const list=await admin.updateKeywords('jesse@a2z.example',{op:'add',term:'  Bid   Date ',category:'Bid Invitations',field:'any'});
 assert.deepEqual(list.map(({term,field})=>[term,field]),[['Bid Date','any']]);
 await assert.rejects(admin.updateKeywords('jesse@a2z.example',{op:'add',term:'x',category:'Bid Invitations'}),/2 to 80/);
 await assert.rejects(admin.updateKeywords('jesse@a2z.example',{op:'add',term:'ok term',category:'Nope'}),/category/);
 assert.equal((await admin.keywords(true)).length,1);
 await admin.updateKeywords('jesse@a2z.example',{op:'remove',id:list[0].id});
 assert.equal((await admin.keywords(true)).length,0);

 await admin.record('crew@a2z.example','sign-in');
 await admin.record('crew@a2z.example','open',{throttle:true});
 await admin.record('crew@a2z.example','open',{throttle:true});
 clock+=60_000;
 await admin.record('crew@a2z.example','send');
 clock+=1000;
 await admin.record('jesse@a2z.example','ask-ai');
 const activity=await admin.activity({days:7});
 const crew=activity.users.find(user=>user.email==='crew@a2z.example');
 assert.deepEqual([crew.counts['sign-in'],crew.counts.open,crew.counts.send],[1,1,1],'opens are throttled');
 assert.equal(activity.events[0].action,'ask-ai');
 assert.equal(activity.daily[0].date,'2026-11-24');
});

test('health checks report ok, warn and fail with timing', async () => {
 const result=await healthChecks({
  good:async()=>({detail:'fine'}),
  soft:async()=>({status:'warn',detail:'missing key'}),
  broken:async()=>{throw new Error('HTTP 500');},
  slow:()=>new Promise(()=>{}),
 },{timeout:50});
 assert.deepEqual(result.checks.map(check=>[check.name,check.status]),[['good','ok'],['soft','warn'],['broken','fail'],['slow','fail']]);
 assert.match(result.checks[3].detail,/Timed out/);
});

test('admin console routes are senior admin only and keywords reach the mailbox', async () => {
 const {createHostedHandler}=await import('../netlify/functions/ionos.mjs');
 const stores=memoryStores();
 const admin='jesse@a2z.example';
 class FakeImap {on(){} async connect(){} close(){}}
 let seenKeywords;
 const handler=createHostedHandler({
  A2Z_MODE:'live',SESSION_SECRET:'fixture-session-key-only-000000000000000000000000000000',
  IONOS_ALLOWED_MAILBOXES:'crew@a2z.example',SENIOR_ADMIN_EMAILS:admin,CLOUDFLARE_ACCOUNT_ID:'c'.repeat(32),CLOUDFLARE_API_TOKEN:'fixture-cloudflare',
 },{
  Imap:FakeImap,
  directoryFactory:env=>teamDirectory(env,{storeFactory:()=>stores('team-directory'),ttl:0}),
  adminFactory:()=>adminConsole({storeFactory:stores}),
  mailboxFactory:config=>({mail:async()=>{seenKeywords=config.keywords;return {email:config.email,mail:[],contacts:[]};}}),
  smtpFactory:()=>({verify:async()=>true}),
  fetcher:async url=>url.includes('/ai/models/search')?Response.json({result:[{name:'@cf/openai/gpt-oss-120b'},{name:'@cf/openai/gpt-oss-20b'}]}):new Response(null,{status:404}),
 });
 const call=(action,{body,token}={})=>handler(new Request('https://test.example/.netlify/functions/ionos?action='+action,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
  body:body?JSON.stringify(body):undefined,
 }));
 const signIn=async email=>(await (await call('login',{body:{email,password:'fixture-only'}})).json()).token;
 const adminToken=await signIn(admin);
 const crewToken=await signIn('crew@a2z.example');
 for (const action of ['admin-keywords','admin-activity','admin-health']) assert.equal((await call(action,{token:crewToken})).status,403);

 const added=await call('admin-keywords',{token:adminToken,body:{op:'add',term:'pricing due',category:'Bid Invitations'}});
 assert.equal(added.status,200);
 assert.equal((await call('admin-keywords',{token:adminToken,body:{op:'add',term:'',category:'General'}})).status,400);
 await call('mail',{token:crewToken});
 assert.deepEqual(seenKeywords.map(item=>item.term),['pricing due']);

 const activity=await (await call('admin-activity&days=7',{token:adminToken})).json();
 assert.ok(activity.users.some(user=>user.email==='crew@a2z.example'&&user.counts['sign-in']===1&&user.counts.open===1));
 assert.ok(activity.events.some(event=>event.action==='keywords'));

 const health=await (await call('admin-health',{token:adminToken})).json();
 const byName=Object.fromEntries(health.checks.map(check=>[check.name,check]));
 assert.equal(byName['IONOS mailbox (IMAP)'].status,'ok');
 assert.equal(byName['IONOS sending (SMTP)'].status,'ok');
 assert.equal(byName['Cloudflare Workers AI'].status,'ok');
 assert.match(byName['Cloudflare Workers AI'].detail,/Primary @cf\/openai\/gpt-oss-120b, fallback @cf\/openai\/gpt-oss-20b/);
 assert.equal(byName['Gemini (bid scans and attachment text backup)'].status,'warn');
 assert.equal(JSON.stringify(health).includes('fixture'),false,'no secrets in health output');
});
