import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mailCsvHeader,mailCsvRows} from '../src/mail-csv.mjs';
import {askEmail} from '../server/ask-ai.mjs';
import {createIonosMailbox,ionosConfig} from '../server/ionos.mjs';

test('CSV quotes email text and protects spreadsheet cells',()=>{
 const row=mailCsvRows([{folder:'Inbox',subject:'=SUM(1,2)',body:'Hello, "reader"\nLine two',
  files:['plans.pdf'],attachments:[{name:'plans.pdf'}],bodyStatus:'Truncated by mailbox body limit'}]);
 assert.equal(mailCsvHeader.charCodeAt(0),0xfeff);
 assert.match(row,/"'=SUM\(1,2\)"/);
 assert.match(row,/"Hello, ""reader""\nLine two"/);
 assert.match(row,/plans\.pdf/);
 assert.match(row,/Truncated by mailbox body limit/);
});

test('Live export pages past the recent window and uses read-only folders',async ()=>{
 let latest;
 class Imap {
  async connect(){}
  async list(){return [{path:'INBOX',flags:new Set()}];}
  async getMailboxLock(path,options){
   assert.equal(path,'INBOX');assert.equal(options.readOnly,true);
   this.mailbox={uidNext:901,uidValidity:11n};return {release(){}};
  }
  async search(query){
   const upper=Number(query.uid.split(':')[1]);
   return Array.from({length:13},(_,index)=>index+1).filter(uid=>uid<=upper);
  }
  async fetchAll(uids){
   latest=uids;
   return uids.map(uid=>({uid,flags:new Set(),size:300,envelope:{subject:'Old mail '+uid}}));
  }
  async fetchOne(){return {bodyStructure:{type:'text/plain',part:'1'}};}
  async download(){return {content:(async function*(){yield Buffer.from('Old message body');})()};}
  close(){}
 }
 const mailbox=createIonosMailbox(ionosConfig({A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'demo@example.test',IONOS_PASSWORD:'fixture'}),
  {Imap,transport:()=>({})});
 const first=await mailbox.exportPage({path:'INBOX',query:''});
 assert.equal(first.mail[0].body,'Old message body');
 assert.equal(first.mail[0].bodyStatus,'Complete');
 assert.equal(latest.length,12);
 const last=await mailbox.exportPage({path:'INBOX',query:'',positions:first.next});
 assert.deepEqual(last.mail.map(item=>item.id),['INBOX:11:1']);
 assert.deepEqual(last.next,[]);
});

test('Resilient Ask AI tries Groq after Gemini and returns local evidence if every provider times out',async ()=>{
 const mailbox={body:async()=>({subject:'Fixture',body:'Bid due Tuesday.'}),send:()=>assert.fail('Ask AI sent email')};
 const config={gemini:'fixture',groq:'fixture'};
 const request={id:'INBOX:1:1',question:'When is it due?'};
 const models=[];
 const response=await askEmail(config,mailbox,request,async (url,options)=>{
  if (url.includes('googleapis')) throw new DOMException('fixture','TimeoutError');
  const payload=JSON.parse(options.body);
  assert.deepEqual(payload.tools,[{type:'browser_search'}]);
  models.push(payload.model);
  if (models.length===1) throw new DOMException('fixture','TimeoutError');
  return Response.json({choices:[{message:{content:'Tuesday.'}}]});
 },{resilient:true});
 assert.equal(response.data.provider,'Groq');
 assert.deepEqual(models,['openai/gpt-oss-120b','openai/gpt-oss-20b']);
 const fallback=await askEmail(config,mailbox,request,async()=>{throw new DOMException('fixture','TimeoutError');},{resilient:true});
 assert.equal(fallback.data.excerptsOnly,true);
 assert.match(fallback.data.answer,/Bid due Tuesday/);
});

test('High-volume search uses bounded UID windows and saves successful results when a folder fails',async ()=>{
 const windows=[];
 class Imap {
  async connect(){}
  async list() {return ['Sent','Archive','INBOX','Another'].map(path=>({path,flags:new Set()}));}
  async getMailboxLock(path,options){
   assert.equal(options.readOnly,true);
   this.folder=path;this.mailbox={uidNext:12001,uidValidity:3n};return {release(){}};
  }
  async search({uid,text}){
   assert.equal(text,'retail project');
   windows.push([this.folder,uid]);
   const [low,high]=uid.split(':').map(Number);
   assert.ok(high-low<4096);
   if (this.folder==='Sent') return false;
   return (this.folder==='INBOX'?[7000]:[9999]).filter(id=>id>=low&&id<=high);
  }
  async fetchAll(uids){return uids.map(uid=>({uid,flags:new Set(),envelope:{subject:'Retail project'}}));}
  close(){}
 }
 const mailbox=createIonosMailbox(ionosConfig({A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'demo@example.test',IONOS_PASSWORD:'fixture'}),
  {Imap,transport:()=>({})});
 const first=await mailbox.searchMailboxPage({query:'"retail project"'});
 assert.ok(first.mail.some(item=>item.id==='Archive:3:9999'));
 assert.deepEqual(first.failed,['Sent']);
 assert.equal(first.deferred,true);
 assert.equal(windows.length,3);
 assert.equal(first.next[0].path,'Another');
 const second=await mailbox.searchMailboxPage({query:'"retail project"',positions:first.next});
 assert.ok(second.mail.some(item=>item.id==='INBOX:3:7000'));
 assert.ok(second.mail.some(item=>item.id==='Another:3:9999'));
 assert.ok(windows.some(([path,range])=>path==='INBOX'&&range.endsWith(':7904')));
});

test('Folder, inclusive dates and selected field are applied by IONOS search and CSV export',async ()=>{
 const opened=[];
 const criteria=[];
 class Imap {
  async connect(){}
  async list(){return ['INBOX','Archive'].map(path=>({path,flags:new Set()}));}
  async getMailboxLock(path,options){
   assert.equal(options.readOnly,true);
   opened.push(path);
   this.mailbox={uidNext:11,uidValidity:1n};
   return {release(){}};
  }
  async search(query){criteria.push(query);return [9];}
  async fetchAll(uids){return uids.map(uid=>({uid,flags:new Set(),envelope:{subject:'Fixture'}}));}
  async fetchOne(){return {bodyStructure:{type:'text/plain',part:'1'}};}
  async download(){return {content:(async function*(){yield Buffer.from('Fixture body');})()};}
  close(){}
 }
 const mailbox=createIonosMailbox(ionosConfig({A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:'demo@example.test',IONOS_PASSWORD:'fixture'}),
  {Imap,transport:()=>({})});
 const scope={folder:'Archive',field:'subject',fromDate:'2026-11-13',toDate:'2026-11-20'};
 const search=await mailbox.searchMailboxPage({query:'Fixture',scope});
 const csv=await mailbox.exportPage({path:'Archive',query:'Fixture',scope});
 assert.deepEqual(opened,['Archive','Archive','Archive']);
 assert.deepEqual(search.mail.map(item=>item.id),csv.mail.map(item=>item.id));
 for (const query of criteria) {
  assert.equal(query.subject,'Fixture');
  assert.equal(query.text,undefined);
  assert.equal(query.since.toISOString().slice(0,10),'2026-11-13');
  assert.equal(query.before.toISOString().slice(0,10),'2026-11-21');
 }
 await assert.rejects(mailbox.searchMailboxPage({query:'fixture',scope:{fromDate:'2026-02-31'}}),/valid date range/);
 assert.equal((await mailbox.searchMailboxPage({query:'fixture',scope:{...scope,folder:'Unknown'}})).mail.length,0);
});
