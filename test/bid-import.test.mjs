import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bidHeaders,bidPreview,bookQualifiedBid,qualifiedBidCsv} from '../server/bid-import.mjs';
import {createIonosMailbox,ionosConfig} from '../server/ionos.mjs';

const due=new Date(Date.now()+10*86400000).toISOString().slice(0,10);
const entry={project:'100 main st',gc:'alpha',status:'qualified',distance:14.5,multipleGcsBidding:true,
 sender:'notify@planhub.com',lead:{
  project_name:'Retail "A", Phase 1',street:'100 Main St',city:'Orange',state:'CA',zip:'92866',due_date:due,
  gc_company:'Alpha Builders',first_name:'Alex',last_name:'Rivera',email:'alex@example.test',phone:'+17145551234',
  lead_type:'commercial_ti',contact_type:'general_contractor',demo_scope_evidence:'Remove partitions and flooring',
  public_work_flags:[],owner_type:'private',size_sf:8010,
 },
};

test('Qualified CSV has the Desk header order, BOM, quoted fields and an empty export',()=>{
 const csv=qualifiedBidCsv([entry]);
 assert.equal(csv.charCodeAt(0),0xfeff);
 assert.equal(csv.split('\r\n')[0].slice(1),bidHeaders.join(','));
 assert.match(csv,/"Retail ""A"", Phase 1","100 Main St, Orange, CA 92866"/);
 assert.match(csv,/\+17145551234,,,Yes,General Contractor,Commercial TI,14\.5,8010/);
 assert.match(csv,/,PlanHub,\r\n$/);
 assert.equal(qualifiedBidCsv([]),'\uFEFF'+bidHeaders.join(',')+'\r\n');
});

test('Manual booking checks all Desk pipelines and will not retry an uncertain write',async ()=>{
 const reservations=new Set();
 const store={
  async get(){return {complete:true,summary:{leads:[entry]}};},
  async setJSON(key,_data,options){
   if (options.onlyIfNew&&reservations.has(key)) return {modified:false};
   reservations.add(key);return {modified:true,etag:'fixture'};
  },
 };
 const env={ESTIMATING_DESK_URL:'https://desk.example.test',ESTIMATING_DESK_IMPORT_SECRET:'x'.repeat(32),
  GHL_CONTACTS_PIT_TOKEN:'fixture',GHL_CONTACTS_LOCATION_ID:'loc',GHL_PROJECT_NAME_FIELD_ID:'project'};
 let duplicate=true,writes=0;
 const fetcher=async (url,options)=>{
  const parsed=new URL(url);
  if (parsed.hostname==='desk.example.test') {writes++;throw new Error('simulated network loss after dispatch');}
  if (parsed.pathname.endsWith('/pipelines')) return Response.json({pipelines:[{id:'a'},{id:'b'}]});
  return Response.json({opportunities:duplicate&&parsed.searchParams.get('pipelineId')==='b'?
   [{id:'123',pipelineId:'b',name:'100 Main Street',contact:{companyName:'Alpha Builders'}}]:[]});
 };
 const input={email:'mail@example.test',id:bidPreview(entry).id,env,store,fetcher};
 assert.equal((await bookQualifiedBid(input)).status,409);
 assert.equal(writes,0);
 duplicate=false;
 assert.equal((await bookQualifiedBid(input)).status,502);
 assert.equal((await bookQualifiedBid(input)).status,409);
 assert.equal(writes,1);
});

test('Mailbox search finds messages below the recent window in all folders and pages by UID',async ()=>{
 const visited=[];
 class Imap {
  async connect(){}
  async list(){return ['INBOX','Archive'].map(path=>({path,flags:new Set()}));}
  async getMailboxLock(folder,options){
   assert.equal(options.readOnly,true);visited.push(folder);this.folder=folder;
   this.mailbox={uidValidity:20n,uidNext:251};return {release(){}};
  }
  async search({text,uid,deleted}){
   assert.equal(text,'ancient project');assert.equal(deleted,false);
   const upper=Number(uid.split(':')[1]);
   return (this.folder==='INBOX'?[2,88]:[6,9]).filter(value=>value<=upper);
  }
  async fetchAll(uids,options){
   assert.equal(options.source,undefined);
   return uids.map(uid=>({uid,flags:new Set(),envelope:{subject:'Ancient project '+uid}}));
  }
  close(){}
 }
 const mailbox=createIonosMailbox(ionosConfig({
  A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'mail@example.test',IONOS_PASSWORD:'fixture',
 }),{Imap,transport:()=>({})});
 const first=await mailbox.mailSearch({query:'"ancient project"'},1);
 assert.deepEqual(visited,['INBOX','Archive']);
 assert.deepEqual(first.mail.map(item=>item.id),['INBOX:20:88','Archive:20:9']);
 assert.equal(first.mail[0].needsBody,true);
 const second=await mailbox.mailSearch({query:'"ancient project"',positions:first.next},1);
 assert.deepEqual(second.mail.map(item=>item.id),['INBOX:20:2','Archive:20:6']);
 assert.deepEqual(second.next,[]);
});

test('Ask AI includes old mailbox excerpts even with no selected message',async ()=>{
 const {askEmail}=await import('../server/ask-ai.mjs');
 const old={id:'Archive:20:2',subject:'Hollister demo proposal',date:'2025-03-12T10:00:00Z',from:'gc@example.test',folder:'Archive'};
 const mailbox={
  async mailSearch({query}) {assert.match(query,/hollister/);return {mail:[old]};},
  async body(id,opts) {assert.equal(id,old.id);assert.equal(opts.includeImages,false);return {body:'Submittals due Friday.'};},
 };
 const {aiConfig,resetCooldowns}=await import('../server/ask-ai.mjs');
 resetCooldowns();
 const result=await askEmail(aiConfig({CLOUDFLARE_ACCOUNT_ID:'6'.repeat(32),CLOUDFLARE_API_TOKEN:'fixture'}),mailbox,{question:'Find the old Hollister proposal'},async (_url,{body})=>{
  const prompt=JSON.parse(JSON.parse(body).messages.at(-1).content);
  assert.deepEqual(prompt.mailboxMatches.excerpts,[{
   subject:old.subject,from:old.from,date:old.date,folder:old.folder,excerpt:'Submittals due Friday.',
  }]);
  return Response.json({choices:[{message:{content:'Friday.'}}]});
 });
 assert.equal(result.status,200);
});
