import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aiConfig,askEmail,resetCooldowns} from '../server/ask-ai.mjs';
import {askAiPrompt} from '../server/ask-ai-prompt.mjs';
import {mailboxTemperatures,temperatureConfig} from '../server/ghl-contacts.mjs';
import {createHostedHandler} from '../netlify/functions/ionos.mjs';

const question={id:'INBOX:3:9',question:'What is due?'};
const mailbox={async body(id,options) {
 assert.equal(id,question.id);
 assert.deepEqual(options,{includeHtml:false,includeImages:false,includeSubject:true});
 return {subject:'Demo bid',body:'Bid due Friday.',html:'<img src="external">',images:{fixture:'attachment'}};
}};

const cf={...aiConfig({CLOUDFLARE_ACCOUNT_ID:'f'.repeat(32),CLOUDFLARE_API_TOKEN:'fake-cf'})};
const cfReply=text=>Response.json({choices:[{message:{content:text}}]});

test('Local-mode Ask AI uses the Cloudflare primary model, then the fallback model',async ()=>{
 for (const failure of ['none','http','timeout','empty']) {
  resetCooldowns();
  const models=[];
  const result=await askEmail(cf,mailbox,question,async (url,options)=>{
   assert.match(url,/api\.cloudflare\.com\/client\/v4\/accounts\/f{32}\/ai\/v1\/chat\/completions/);
   assert.equal(options.headers.Authorization,'Bearer fake-cf');
   const body=JSON.parse(options.body);
   models.push(body.model);
   assert.equal(body.messages[0].content,askAiPrompt);
   const {today,...context}=JSON.parse(body.messages.at(-1).content);
   assert.match(today,/\d{4}/);
   assert.deepEqual(context,{question:question.question,subject:'Demo bid',email:'Bid due Friday.',excerptIncomplete:false});
   if (body.model==='@cf/openai/gpt-oss-20b'||failure==='none') return cfReply('Friday');
   if (failure==='http') return new Response(null,{status:429});
   if (failure==='timeout') throw new DOMException('Timeout','TimeoutError');
   return Response.json({});
  });
  assert.equal(result.status,200);
  assert.equal(result.data.answer,'Friday');
  assert.equal(result.data.model,failure==='none'?'@cf/openai/gpt-oss-120b':'@cf/openai/gpt-oss-20b');
  assert.equal(models.at(-1),failure==='none'?'@cf/openai/gpt-oss-120b':'@cf/openai/gpt-oss-20b');
 }
 assert.equal((await askEmail(cf,{body:async()=>null},question,()=>assert.fail('Provider called'))).status,404);
});

test('Provider request and authentication errors stop fallback',async ()=>{
 for (const status of [401,403]) {
  resetCooldowns();
  let count=0;
  const result=await askEmail(cf,mailbox,question,async ()=>{count++;return new Response('private provider response',{status});});
  assert.equal(count,1);
  assert.equal(result.status,502);
  assert.match(result.data.error,/authenticate/);
  assert.doesNotMatch(result.data.error,/private provider response/);
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

test('Ask AI saves work: deep reasoning only for analysis and no mailbox search for open-email questions',async ()=>{
 const {reasoningFor,needsMailboxSearch}=await import('../server/ask-ai.mjs');
 assert.equal(reasoningFor('When is it due?'),'medium');
 assert.equal(reasoningFor('Compare the two bids and tell me which one we should prioritize'),'high');
 assert.equal(needsMailboxSearch('When is it due?',true),false);
 assert.equal(needsMailboxSearch('Did we bid this GC before?',true),true);
 assert.equal(needsMailboxSearch('When is it due?',false),true);
 resetCooldowns();
 let searched=false;
 const result=await askEmail(cf,{...mailbox,mailSearch:async()=>{searched=true;return {mail:[]};}},question,async()=>cfReply('Friday'));
 assert.equal(result.data.answer,'Friday');
 assert.equal(searched,false);
});
