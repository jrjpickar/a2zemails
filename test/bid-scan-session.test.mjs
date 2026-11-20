import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sealBidScan,openBidScan} from '../server/bid-scan-session.mjs';
import {createBidDryRunHandler} from '../netlify/functions/bid-dry-run-background.mjs';
import {verifyEvidence} from '../server/bid-leads.mjs';

const env={A2Z_MODE:'live',SESSION_SECRET:'session-fixture-'.repeat(3),BID_DRY_RUN_TOKEN:'bearer-fixture-'.repeat(3),
 IONOS_ALLOWED_MAILBOXES:'one@example.test,two@example.test',MCP_IONOS_EMAIL:'one@example.test'};
const login={email:'two@example.test',password:'fixture-mailbox-credential'};

test('Background scan can use a second allowed signed-in mailbox',async ()=>{
 const ticket=sealBidScan(env.SESSION_SECRET,login,true);
 assert.ok(!ticket.includes(login.password));
 const mailbox={};
 const handler=createBidDryRunHandler(env,config=>{
  assert.equal(config.email,login.email);
  assert.equal(config.imap.auth.pass,login.password);
  return mailbox;
 },async input=>{
  assert.equal(input.email,login.email);
  assert.equal(input.mailbox,mailbox);
  assert.equal(input.fresh,true);
  return {complete:true};
 },async (email,run)=>{assert.equal(email,login.email);return run();});
 const request=()=>new Request('https://inbox.example.test',{method:'POST',
  headers:{Authorization:'Bearer '+env.BID_DRY_RUN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
 assert.equal((await handler(request())).status,204);
 assert.equal(openBidScan({...env,IONOS_ALLOWED_MAILBOXES:env.MCP_IONOS_EMAIL},ticket),null);
 assert.equal(openBidScan(env,ticket,Date.now()+6*60000),null);
 assert.equal(openBidScan({...env,SESSION_SECRET:'different-'.repeat(5)},ticket),null);
});

test('A named deadline without a year is accepted only near the email date',()=>{
 const row={due_date:'2026-12-04',size_sf:null};
 const received='2026-11-20T20:00:00Z';
 assert.equal(verifyEvidence(row,'Proposals Due December 4 by 2:00 PM',received).due_date,row.due_date);
 assert.equal(verifyEvidence(row,'Site walk December 4 by 2:00 PM',received).due_date,null);
 assert.equal(verifyEvidence(row,'Proposals Due December 4, 2027',received).due_date,null);
});

test('Optimized intake gives all matching messages AI review in bounded parallel waves',async ()=>{
 const {dryRunBidLeads}=await import('../server/bid-leads.mjs');
 let stored,version=0,inFlight=0,peak=0;
 const messages=Array.from({length:10},(_,i)=>({id:'INBOX:4:'+(i+1),uid:i+1,
  date:'2026-11-18T18:00:00Z',subject:'Project pricing request '+i,from:'gc@example.test'}));
 const opened=[];
 const summary=await dryRunBidLeads({
  email:login.email,now:new Date('2026-11-20T18:00:00Z'),
  config:{desk:{token:'fixture',locationId:'loc',projectNameId:'project'},ai:{gemini:'fixture'},terms:['bid invite'],domains:[],scope:'global'},
  mailbox:{async recentBidInbox(){return {mail:messages,total:41,matched:10,generation:'4'};},
   async body(id){opened.push(id);return {body:'New project pricing request.'};}},
  store:{async getWithMetadata(){return null;},async setJSON(_key,data){stored=data;return {modified:true,etag:String(++version)};}},
  fetcher:async url=>{
   if (url.includes('googleapis.com')) {
    peak=Math.max(peak,++inFlight);
    await new Promise(resolve=>setTimeout(resolve,10));
    inFlight--;
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"invites":[]}'}]}}]});
   }
   return Response.json(url.includes('/pipelines')?{pipelines:[{id:'main'}]}:{opportunities:[]});
  },
 });
 assert.equal(summary.complete,true);
 assert.equal(summary.counts.messagesScanned,41);
 assert.equal(summary.counts.candidates,10);
 assert.equal(summary.providers.Gemini,10);
 assert.equal(opened[0],'INBOX:4:10');
 assert.equal(opened.length,10);
 assert.equal(peak,6);
 assert.equal(stored.complete,true);
});

test('Bid extraction falls back across Groq models and cools down timed-out models',async ()=>{
 const {runAiChain}=await import('../server/ask-ai.mjs');
 const attempted=[];
 const cooldowns=new Map();
 const fetcher=async (url,options)=>{
  const request=JSON.parse(options.body);
  const model=url.includes('googleapis.com')?'Gemini':request.model;
  attempted.push(model);
  if (model!=='qwen/qwen3.8-27b') throw new DOMException('Fixture timeout','TimeoutError');
  assert.equal(request.response_format.type,'json_schema');
  return Response.json({choices:[{message:{content:'{"invites":[]}'}}]});
 };
 const settings={bidScan:true,cooldowns,fetcher,json:true,schema:{type:'object'},validate:JSON.parse};
 const config={gemini:'fixture',groq:'fixture'};
 const messages=[{role:'user',content:'Bid invite'}];
 const first=await runAiChain(config,messages,settings);
 assert.equal(first.model,'qwen/qwen3.8-27b');
 assert.deepEqual(attempted,['Gemini','openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b']);
 attempted.length=0;
 assert.equal((await runAiChain(config,messages,settings)).provider,'Groq');
 assert.deepEqual(attempted,['qwen/qwen3.8-27b']);
});

test('A failed candidate does not block other waves and retry touches only the failed email',async ()=>{
 const {dryRunBidLeads}=await import('../server/bid-leads.mjs');
 let state,etag=0,fail=true;
 const opened=[];
 const mail=Array.from({length:7},(_,i)=>({id:'INBOX:4:'+(i+1),uid:i+1,
  date:'2026-11-18T18:00:00Z',subject:'Candidate fixture '+(i+1),from:'gc@example.test'}));
 const options={
  email:login.email,now:new Date('2026-11-20T18:00:00Z'),
  config:{desk:{token:'fixture',locationId:'loc',projectNameId:'project'},ai:{gemini:'fixture'},terms:['bid invite'],domains:[],scope:'global'},
  mailbox:{async recentBidInbox(){return {mail,total:862,matched:7,generation:'4'};},
   async body(id){opened.push(id);return {body:id.endsWith(':7')?'This fixture fails':'Good invite'};}},
  store:{async getWithMetadata(){return state?{data:state,etag:String(etag)}:null;},
   async setJSON(_key,data){state=structuredClone(data);return {modified:true,etag:String(++etag)};}},
  fetcher:async (url,{body})=>{
   if (!url.includes('googleapis.com')) return Response.json(url.includes('/pipelines')?{pipelines:[{id:'main'}]}:{opportunities:[]});
   const request=JSON.parse(body);
   assert.ok(request.generationConfig.responseJsonSchema.properties.invites);
   if (fail&&request.contents[0].parts[0].text.includes('This fixture fails')) return Response.json({});
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"invites":[]}'}]}}]});
  },
 };
 const first=await dryRunBidLeads(options);
 assert.equal(first.complete,true);
 assert.equal(first.retryable,1);
 assert.equal(first.providers.Gemini,6);
 assert.equal(first.counts.messagesScanned,862);
 assert.equal(opened.length,7);
 fail=false;opened.length=0;
 const second=await dryRunBidLeads(options);
 assert.equal(second.retryable,0);
 assert.deepEqual(opened,['INBOX:4:7']);
 assert.equal(second.providers.Gemini,7);
});
