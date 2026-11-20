import assert from 'node:assert/strict';
import {test} from 'node:test';
import {askEmail} from '../server/ask-ai.mjs';
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
    return Response.json(failure==='empty'?{}:{candidates:[{content:{parts:[{thought:true,text:'Private'},{text:'Friday'}]}}]});
   }
   assert.equal(options.headers.Authorization,'Bearer '+config.groq);
   return Response.json({choices:[{message:{content:'Friday'}}]});
  });
  assert.deepEqual(result,{status:200,data:{answer:'Friday',provider:failure==='none'?'Gemini':'Groq'}});
  assert.equal(calls.length,failure==='none'?1:2);
 }
 assert.equal((await askEmail(config,{body:async()=>null},question,()=>assert.fail('Provider called'))).status,404);
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
