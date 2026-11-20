import assert from 'node:assert/strict';
import {test} from 'node:test';
import {askEmail} from '../server/ask-ai.mjs';
import {askAiPrompt} from '../server/ask-ai-prompt.mjs';
import {mailboxTemperatures,temperatureConfig} from '../server/ghl-contacts.mjs';
import {createHostedHandler} from '../netlify/functions/ionos.mjs';

const question={id:'INBOX:3:9',question:'What is due?'};
const mailbox={async body(id,options) {
 assert.equal(id,question.id);
 assert.deepEqual(options,{includeHtml:false,includeImages:false,includeSubject:true});
 return {subject:'Demo bid',body:'Bid due Friday.',html:'<img src="external">',images:{fixture:'attachment'}};
}};

test('Ask AI uses Gemini first and falls back to Groq for errors and empty answers',async ()=>{
 const config={gemini:'fake-gemini',groq:'fake-groq'};
 for (const failure of ['none','http','timeout','empty']) {
  const calls=[];
  const result=await askEmail(config,mailbox,question,async (url,options)=>{
   calls.push(url);
   const body=JSON.parse(options.body);
   if (url.includes('googleapis.com')) {
    assert.equal(options.headers['x-goog-api-key'],config.gemini);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text),{
     question:question.question,subject:'Demo bid',email:'Bid due Friday.',excerptIncomplete:false,
    });
    if (failure==='http') return new Response(null,{status:429});
    if (failure==='timeout') throw new DOMException('Timeout','TimeoutError');
    return Response.json(failure==='empty'?{}:{candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'Private'},{text:'Friday'}]}}]});
   }
   assert.equal(options.headers.Authorization,'Bearer '+config.groq);
   return Response.json({choices:[{message:{content:'Friday'}}]});
  });
  assert.deepEqual(result,{status:200,data:{answer:'Friday',provider:failure==='none'?'Gemini':'Groq',backup:failure!=='none'}});
  assert.equal(calls.length,{none:1,http:3,timeout:2,empty:2}[failure]);
 }
 assert.equal((await askEmail(config,{body:async()=>null},question,()=>assert.fail('Provider called'))).status,404);
});

test('Gemini retries 503 once before Groq and both receive the same prompt, settings and history',async ()=>{
 const requests=[];
 const history=[{role:'user',content:'What is this?'},{role:'assistant',content:'A demo bid.'}];
 const result=await askEmail({gemini:'fake',groq:'fake'},mailbox,{...question,history},async (url,options)=>{
  const payload=JSON.parse(options.body);
  requests.push(payload);
  if (url.includes('googleapis.com')) return new Response(null,{status:503});
  return Response.json({choices:[{message:{content:'<think>hidden</think> As an AI, Friday'}}]});
 });
 assert.deepEqual(result,{status:200,data:{answer:'Friday',provider:'Groq',backup:true}});
 assert.equal(requests.length,3);
 assert.deepEqual(requests[0],requests[1]);
 const [gemini,,groq]=requests;
 assert.equal(gemini.systemInstruction.parts[0].text,askAiPrompt);
 assert.deepEqual(groq.messages[0],{role:'system',content:askAiPrompt});
 assert.deepEqual(gemini.contents.map(({role,parts})=>({
  role:role==='model'?'assistant':role,content:parts[0].text,
 })),groq.messages.slice(1));
 assert.equal(gemini.generationConfig.temperature,groq.temperature);
 assert.equal(gemini.generationConfig.maxOutputTokens,groq.max_completion_tokens);
});

test('Provider request and authentication errors stop fallback',async ()=>{
 for (const status of [400,401,403]) {
  let count=0;
  const result=await askEmail({gemini:'fake',groq:'fake'},mailbox,question,async ()=>{
   count++;
   return new Response('private provider response',{status});
  });
  assert.equal(count,1);
  assert.equal(result.status,502);
  assert.match(result.data.error,status===400?/submit/:/authenticate/);
  assert.doesNotMatch(result.data.error,/private provider response/);
 }
});

test('Timeouts, malformed results and non-STOP Gemini responses use the next provider',async ()=>{
 for (const failure of ['timeout','malformed','safety','incomplete']) {
  const result=await askEmail({gemini:'fake',groq:'fake'},mailbox,question,async url=>{
   if (!url.includes('googleapis.com')) throw new TypeError('private network detail');
   if (failure==='timeout') throw new DOMException('private timeout detail','TimeoutError');
   if (failure==='malformed') return new Response('broken JSON');
   return Response.json({candidates:[{finishReason:failure==='safety'?'SAFETY':'MAX_TOKENS',
    content:{parts:[{text:'Discard this'}]}}]});
  });
  assert.deepEqual(result,{status:502,data:{error:'Ask AI is temporarily unavailable. Try again.'}});
 }
});

test('Hosted Ask AI requires the mailbox session before accessing email',async ()=>{
 const handler=createHostedHandler({
  A2Z_MODE:'live',IONOS_ALLOWED_MAILBOXES:'mail@example.test',
  SESSION_SECRET:'fixture-session-0000000000000000000',GEMINI_API_KEY:'fake',
 },{mailboxFactory:()=>assert.fail('Mailbox accessed without login')});
 const result=await handler(new Request('https://app.example.test/.netlify/functions/ionos?action=ask-ai',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(question),
 }));
 assert.equal(result.status,401);
});

test('Temperature folders match exact Inbox senders and keep messages in IONOS folders',async ()=>{
 const config=temperatureConfig({GHL_CONTACTS_PIT_TOKEN:'fake',GHL_LOCATION_IDS:'loc',GHL_TEMPERATURE_FIELD_ID:'temp'});
 const mail={mail:[
  {folder:'Inbox',from:'A@example.test',category:'Estimating'},
  {folder:'Inbox',from:'b@example.test'},
  {folder:'Archive',from:'A@example.test'},
  {folder:'Inbox',from:'c@example.test'},
 ]};
 const contact=(email,value,locationId='loc')=>({email,locationId,customFields:[{id:'temp',value}]});
 const result=await mailboxTemperatures(mail,config,async (_url,{body})=>{
  const input=JSON.parse(body);
  assert.equal(input.locationId,'loc');
  assert.deepEqual(input.filters,[{group:'OR',filters:['a','b','c'].map(name=>({
   field:'email',operator:'eq',value:name+'@example.test',
  }))}]);
  return Response.json({contacts:[
   contact('a@example.test',' VIP '),contact('b@example.test','Hot','other'),
   contact('c@example.test','Cold'),contact('c@example.test','Warm'),
  ]});
 });
 assert.deepEqual(result,{temperatureFolders:true,mail:[{...mail.mail[0],temperature:'vip'},...mail.mail.slice(1)]});
 const unavailable=await mailboxTemperatures(mail,config,async()=>new Response(null,{status:503}));
 assert.deepEqual(unavailable,{...mail,temperatureFolders:true,temperatureUnavailable:true});
});

test('Temperature falls back to a unique exact contact name and reads updated values on refresh',async ()=>{
 const config=temperatureConfig({GHL_CONTACTS_PIT_TOKEN:'fake',GHL_LOCATION_IDS:'loc',GHL_TEMPERATURE_FIELD_ID:'temp'});
 const mail={mail:[
  {folder:'Inbox',from:'alias@example.test',name:'Aly Rivera'},
  {folder:'Inbox',from:'other@example.test',name:'Alex Lane'},
 ]};
 let temperature='Cold';
 const fetcher=async (_url,{body})=>{
  const request=JSON.parse(body);
  if (!request.query) return Response.json({contacts:[]});
  const contact=(id,name)=>({id,name,email:id+'@example.test',locationId:'loc',customFields:[{id:'temp',value:temperature}]});
  return Response.json({contacts:request.query==='aly rivera'?[contact('a','Aly Rivera'),contact('b','Aly Rivera Jr')]:
   [contact('c','Alex Lane'),contact('d','Alex Lane')]});
 };
 assert.equal((await mailboxTemperatures(mail,config,fetcher)).mail[0].temperature,'cold');
 temperature='VIP';
 const result=await mailboxTemperatures(mail,config,fetcher);
 assert.equal(result.mail[0].temperature,'vip');
 assert.equal(result.mail[1].temperature,undefined);
});
