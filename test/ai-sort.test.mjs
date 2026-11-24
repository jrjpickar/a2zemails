import test from 'node:test';
import assert from 'node:assert/strict';
import {createScheduledSort} from '../netlify/functions/ai-sort-scheduled.mjs';
import {createSortHandler} from '../netlify/functions/ai-sort-background.mjs';
import {runScheduledSort,pacificTime} from '../server/ai-sort.mjs';
import {createIonosMailbox,ionosConfig} from '../server/ionos.mjs';

const token='t'.repeat(40);

test('schedule starts only at 9 AM and 3 PM Pacific across daylight saving time', async () => {
 const calls=[];
 const fetcher=async(url,options)=>{calls.push([String(url),options.headers.Authorization]);return new Response(null,{status:202});};
 const at=iso=>createScheduledSort({URL:'https://inbox.example',BID_DRY_RUN_TOKEN:token},{fetcher,now:()=>new Date(iso)})();
 assert.equal((await at('2026-12-01T16:00:00Z')).status,204,'8 AM PST');
 assert.equal((await at('2026-12-01T17:00:00Z')).status,202,'9 AM PST');
 assert.equal((await at('2026-12-01T23:00:00Z')).status,202,'3 PM PST');
 assert.equal((await at('2026-07-01T16:00:00Z')).status,202,'9 AM PDT');
 assert.equal((await at('2026-07-01T23:00:00Z')).status,204,'4 PM PDT');
 assert.equal(calls.length,3);
 assert.deepEqual(calls[0],['https://inbox.example/.netlify/functions/ai-sort-background','Bearer '+token]);
 assert.deepEqual(pacificTime(new Date('2026-12-01T17:00:00Z')),{hour:9,day:'2026-12-01'});
});

test('background sort requires the token', async () => {
 let ran=false;
 const handler=createSortHandler({A2Z_MODE:'live',BID_DRY_RUN_TOKEN:token},{run:async()=>{ran=true;},directoryFactory:()=>({}),adminFactory:()=>({})});
 const post=auth=>handler(new Request('https://inbox.example/x',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:'{}'}));
 assert.equal((await post('Bearer wrong')).status,401);
 assert.equal(ran,false);
 assert.equal((await post('Bearer '+token)).status,204);
 assert.equal(ran,true);
});

test('scheduled sort stores AI labels per mailbox and skips mailboxes without a password', async () => {
 const saved=new Map();
 let run;
 const labels={
  async load(email){return new Map(Object.entries(saved.get(email)||{}));},
  async save(email,fresh){saved.set(email,{...(saved.get(email)||{}),...Object.fromEntries(fresh)});return fresh.size;},
  async lastRun(){return run;}, async saveRun(summary){run=summary;},
 };
 const directory={
  async list(){return [{email:'jesse@a2z.example',status:'active'},{email:'crew@a2z.example',status:'active'},{email:'gone@a2z.example',status:'offboarded'}];},
  async credential(email){return email==='jesse@a2z.example'?'pw':null;},
 };
 const seen=[];
 const makeMailbox=config=>({mail:async()=>{seen.push(config);return {mail:[{id:'INBOX:1:5',date:'2026-11-24T10:00:00Z'}],aiLabels:{'INBOX:1:5':'Bid Invitations'}};}});
 const summary=await runScheduledSort({GROQ_API_KEY:'k'},{directory,admin:{keywords:async()=>[{term:'pricing due',category:'Bid Invitations'}]},labels,makeMailbox});
 assert.deepEqual(summary.results.map(({email,status})=>[email,status]),[['jesse@a2z.example','ok'],['crew@a2z.example','skipped']]);
 assert.equal(seen[0].keywords[0].term,'pricing due');
 assert.equal(seen[0].groqDeadline,90000);
 assert.deepEqual(saved.get('jesse@a2z.example'),{'INBOX:1:5':'Bid Invitations'});
 assert.equal(run.trigger,'schedule');
});

test('saved AI labels apply on load and only new mail goes to the model', async () => {
 const rows=[1,2].map(uid=>({uid,size:500,flags:new Set(),internalDate:new Date(Date.UTC(2026,10,uid)),
  envelope:{subject:'Weekly update '+uid,from:[{address:'pm@gc.example'}]},bodyStructure:{type:'text/plain',part:'1'}}));
 class FakeImap {
  on(){} async connect(){} close(){}
  async list(){return [{path:'INBOX',flags:new Set()}];}
  async getMailboxLock(){this.mailbox={exists:2,uidValidity:4n};return {release(){}};}
  async fetchAll(range,query){
   if (query.source) return rows.map(row=>({uid:row.uid,source:Buffer.from('Subject: x\r\n\r\nPlease see the update for this week.')}));
   return rows;
  }
 }
 const sent=[];
 const fetchGroq=async(_url,{body})=>{
  const items=JSON.parse(JSON.parse(body).messages[1].content);
  sent.push(items.map(item=>item.subject));
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({results:items.map(item=>({index:item.index,category:'Dispatch'}))})}}]});
 };
 const config={...ionosConfig({A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'jesse@a2z.example',IONOS_PASSWORD:'x',GROQ_API_KEY:'k'}),
  storedLabels:new Map([['INBOX:4:1','Estimating']]),returnAiLabels:true};
 const {mail,aiLabels}=await createIonosMailbox(config,{Imap:FakeImap,transport:()=>({}),fetchGroq}).mail();
 assert.deepEqual(sent,[['Weekly update 2']]);
 assert.equal(mail.find(row=>row.id==='INBOX:4:1').category,'Estimating');
 assert.equal(mail.find(row=>row.id==='INBOX:4:2').category,'Dispatch');
 assert.deepEqual(aiLabels,{'INBOX:4:2':'Dispatch'});
});

test('files without a name still show as attachments', async () => {
 const structure={type:'multipart/mixed',childNodes:[{type:'text/plain',part:'1'},{type:'application/pdf',part:'2',size:900},
  {type:'application/pkcs7-signature',part:'3'}]};
 class FakeImap {
  on(){} async connect(){} close(){}
  async list(){return [{path:'Sent',specialUse:'\\Sent',flags:new Set()}];}
  async getMailboxLock(){this.mailbox={exists:1,uidValidity:2n};return {release(){}};}
  async fetchAll(){return [{uid:9,size:2000,flags:new Set(['\\Seen']),internalDate:new Date(),envelope:{subject:'A2Z Proposal'},bodyStructure:structure}];}
 }
 const config=ionosConfig({A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'artjr@a2z.example',IONOS_PASSWORD:'x'});
 const {mail}=await createIonosMailbox(config,{Imap:FakeImap,transport:()=>({})}).mail();
 assert.deepEqual(mail[0].attachments.map(file=>[file.part,file.name]),[['2','Attachment.pdf']]);
});
