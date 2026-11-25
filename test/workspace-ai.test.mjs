import test from 'node:test';
import assert from 'node:assert/strict';
import {aiConfig,aiReplies,aiWrite,askEmail,resetCooldowns,runAiChain} from '../server/ask-ai.mjs';
import {deliveryReport} from '../server/ionos.mjs';
import {deliveryStatus,deliveryStore,sendIdFor} from '../server/deliveries.mjs';
import {searchMail} from '../src/model.mjs';

const account='a'.repeat(32);
const env={GROQ_API_KEY:'g',GEMINI_API_KEY:'m',CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_AI_TOKEN:'cf'};
const groqOk=text=>Response.json({choices:[{message:{content:text}}]});

test('Cloudflare sits between Groq and Gemini for Ask AI and a Groq 429 benches Groq', async () => {
 resetCooldowns();
 const config=aiConfig(env);
 assert.equal(config.cloudflareModel,'@cf/meta/llama-3.3-70b-instruct-fp8-fast');
 const mailbox={body:async()=>({subject:'Bid',body:'Due Friday'})};
 const calls=[];
 const fetcher=async url=>{
  calls.push(String(url).includes('groq')?'groq':String(url).includes('cloudflare')?'cloudflare':'gemini');
  if (String(url).includes('groq')) return new Response(null,{status:429});
  return groqOk('Friday');
 };
 const first=await askEmail(config,mailbox,{id:'INBOX:1:1',question:'When is it due?'},fetcher);
 assert.deepEqual([first.data.provider,first.data.model],['Cloudflare','@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
 assert.deepEqual(calls,['groq','groq','cloudflare']);
 calls.length=0;
 await askEmail(config,mailbox,{id:'INBOX:1:1',question:'When is it due?'},fetcher);
 assert.deepEqual(calls,['cloudflare'],'Groq is benched after a rate limit');
 resetCooldowns();
});

test('bid scans try Cloudflare between Gemini and Groq', async () => {
 resetCooldowns();
 const order=[];
 const result=await runAiChain(aiConfig(env),[{role:'user',content:'x'}],{bidScan:true,json:true,fetcher:async url=>{
  order.push(String(url).includes('googleapis')?'gemini':String(url).includes('cloudflare')?'cloudflare':'groq');
  return String(url).includes('groq')?groqOk('{"ok":true}'):new Response(null,{status:503});
 }});
 assert.equal(result.provider,'Groq');
 assert.deepEqual(order.filter((item,index)=>order.indexOf(item)===index),['gemini','cloudflare','groq']);
 resetCooldowns();
});

test('Ask AI sends PDF attachments to Gemini first and thread context when asked', async () => {
 resetCooldowns();
 let gemini;
 const mailbox={
  body:async()=>({subject:'Plans',body:'See plans'}),
  messageInfo:async()=>({attachments:[{part:'2',name:'plans.pdf',type:'application/pdf',size:1000}]}),
  attachment:async()=>({name:'plans.pdf',type:'application/pdf',content:Buffer.from('%PDF-1.7')}),
  textExcerpts:async ids=>new Map(ids.map(id=>[id,'Earlier reply about '+id])),
 };
 const result=await askEmail(aiConfig(env),mailbox,{id:'INBOX:1:1',question:'What is in the plans?',includeAttachments:true,
  contextIds:['INBOX:1:0'],contextMeta:{'INBOX:1:0':{subject:'Re: Plans'}},contextKind:'thread'},async(url,options)=>{
  gemini=JSON.parse(options.body);
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'Two floors of demo'}]}}]});
 });
 assert.equal(result.data.provider,'Gemini');
 const parts=gemini.contents.at(-1).parts;
 assert.deepEqual(parts[1],{inlineData:{mimeType:'application/pdf',data:Buffer.from('%PDF-1.7').toString('base64')}});
 const context=JSON.parse(parts[0].text);
 assert.deepEqual(context.attachments,['plans.pdf']);
 assert.equal(context.threadMessages[0].subject,'Re: Plans');
});

test('Help me write, refine and suggested replies', async () => {
 resetCooldowns();
 const mailbox={body:async()=>({subject:'ITB',body:'Can you bid by Friday?'})};
 const bodies=[];
 const fetcher=async(_url,options)=>{bodies.push(JSON.parse(options.body));
  return groqOk(bodies.at(-1).response_format?'{"replies":["Yes, we will bid — thanks.","Please send plans.","We will pass this time."]}':'Hi Terri — we will bid.');};
 const written=await aiWrite(aiConfig({GROQ_API_KEY:'g'}),mailbox,{mode:'write',instruction:'say we will bid',subject:'Re: ITB',body:'',replyToId:'INBOX:1:1'},fetcher);
 assert.equal(written.data.body,'Hi Terri - we will bid.','no em dashes');
 assert.match(bodies[0].messages[0].content,/no signature block/);
 assert.equal(JSON.parse(bodies[0].messages[1].content).emailBeingAnswered.subject,'ITB');
 assert.equal((await aiWrite(aiConfig({GROQ_API_KEY:'g'}),mailbox,{mode:'polish',body:''},fetcher)).status,400);
 const replies=await aiReplies(aiConfig({GROQ_API_KEY:'g'}),mailbox,{id:'INBOX:1:1'},fetcher);
 assert.deepEqual(replies.data.replies,['Yes, we will bid - thanks.','Please send plans.','We will pass this time.']);
});

test('delivery reports map to sent mail and give a status', async () => {
 const id='out-12345678-1234-1234-1234-123456789012';
 const dsn=['Content-Type: multipart/report; report-type=delivery-status; boundary=x','','--x','Content-Type: message/delivery-status','',
  'Original-Envelope-Id: '+id,'','Final-Recipient: rfc822; terri@mcguire.example','Action: delivered','Status: 2.0.0','',
  'Final-Recipient: rfc822; bad@nowhere.example','Action: failed','Status: 5.1.1','Diagnostic-Code: smtp; 550 5.1.1 User unknown',''].join('\r\n');
 const report=deliveryReport(dsn,{from:'mailer-daemon@ionos.com',subject:'Delivery Status Notification'});
 assert.equal(report.id,id);
 assert.deepEqual(report.recipients.map(item=>[item.address,item.action]),[['terri@mcguire.example','delivered'],['bad@nowhere.example','failed']]);
 assert.equal(deliveryReport('Hello there',{from:'pm@gc.example',subject:'Hi'}),null);

 const data=new Map();
 const store=deliveryStore({storeFactory:()=>({async get(key){return data.get(key)??null;},async setJSON(key,value){data.set(key,structuredClone(value));}})});
 await store.merge('artjr@a2zcs.net',[{...report,date:'2026-11-24T21:30:00Z'}]);
 const row={folder:'Sent',to:'terri@mcguire.example, bad@nowhere.example',cc:'',bcc:'',headers:{messageId:'<'+id+'@a2zcs.net>'}};
 const entries=await store.load('artjr@a2zcs.net');
 assert.equal(sendIdFor(row),id);
 assert.equal(deliveryStatus(row,entries[id]).status,'partly bounced');
 assert.equal(deliveryStatus({...row,to:'terri@mcguire.example'},entries[id]).status,'delivered');
 assert.equal(deliveryStatus(row,undefined).status,'sent');
});

test('is:starred search works in the sandbox', () => {
 const row={from:'a@b.example',name:'A',to:'',cc:'',subject:'x',date:'',files:[],body:'',company:'',category:'',project:'',star:true};
 assert.equal(searchMail(row,'is:starred'),true);
 assert.equal(searchMail({...row,star:false},'is:starred'),false);
});
