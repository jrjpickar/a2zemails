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
