import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanNoteSettings,noteStore,postEmailNotes} from '../server/ghl-notes.mjs';

function stores() {
 const all=new Map();
 return name=>{
  if (!all.has(name)) {
   const data=new Map();
   all.set(name,{async get(key){return data.has(key)?structuredClone(data.get(key)):null;},
    async setJSON(key,value){data.set(key,structuredClone(value));},async set(key,value){data.set(key,value);}});
  }
  return all.get(name);
 };
}

const env={GHL_CONVERSATIONS_PIT_TOKEN:'write-token',GHL_CONTACTS_PIT_TOKEN:'read-token',GHL_CONTACTS_LOCATION_ID:'loc1',CLOUDFLARE_ACCOUNT_ID:'e'.repeat(32),CLOUDFLARE_API_TOKEN:'cf'};
const now=Date.parse('2026-11-24T23:00:00Z');
const mail=[
 {id:'INBOX:1:10',folder:'Inbox',category:'Bid Invitations',subject:'ITB Fleming\'s',from:'Ryan <ryan@rescon.example>',to:'artjr@a2zcs.net',cc:'',
  date:'2026-11-24T20:00:00Z',body:'Please price the demo. Budget is $48,500. Bids due 12/4.',headers:{messageId:'<a@x>'}},
 {id:'INBOX:1:11',folder:'Inbox',category:'Invoices',subject:'Invoice 22',from:'ap@rescon.example',to:'',cc:'',date:'2026-11-24T21:00:00Z',body:'Pay',headers:{messageId:'<b@x>'}},
 {id:'INBOX:1:12',folder:'Inbox',category:'General',subject:'Hello',from:'stranger@nowhere.example',to:'',cc:'',date:'2026-11-24T21:30:00Z',body:'Hi',headers:{messageId:'<c@x>'}},
 {id:'Sent:2:5',folder:'Sent',category:'Estimating',subject:'A2Z Proposal',from:'artjr@a2zcs.net',to:'terri@mcguire.example, zeth@a2zcs.net',cc:'',
  date:'2026-11-24T21:25:00Z',body:'Proposal attached. Total $112,000.',headers:{messageId:'<d@x>'}},
 {id:'INBOX:1:2',folder:'Inbox',category:'Bid Invitations',subject:'Old',from:'ryan@rescon.example',to:'',cc:'',date:'2026-11-20T20:00:00Z',body:'old',headers:{messageId:'<e@x>'}},
];

function fakeGhl(calls,savedAs='TYPE_INTERNAL_COMMENT') {
 return async (url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;
  calls.push({url:String(url),method:options.method||'GET',auth:options.headers?.Authorization,body});
  if (url.includes('/ai/v1/chat/completions')) {
   const items=JSON.parse(body.messages[1].content);
   return Response.json({choices:[{message:{content:JSON.stringify({results:items.map(item=>({index:item.index,summary:'Summary of '+item.subject+'. '+(item.text.match(/\$[\d,]+/)?.[0]||'')}))})}}]});
  }
  if (url.endsWith('/contacts/search')) {
   const wanted=body.filters[0].filters.map(filter=>filter.value);
   return Response.json({contacts:[{id:'c-ryan',email:'Ryan@ResCon.example',firstName:'Ryan',lastName:'Stillion'},{id:'c-terri',email:'terri@mcguire.example',firstName:'Terri'}]
    .filter(person=>wanted.includes(person.email.toLowerCase()))});
  }
  if (url.includes('/conversations/search')) return Response.json({conversations:url.includes('c-ryan')?[{id:'conv-ryan'}]:[]});
  if (url.endsWith('/conversations/')) return Response.json({conversation:{id:'conv-new'}});
  if (url.endsWith('/conversations/messages')) return Response.json({messageId:'m1',conversationId:body.conversationId});
  if (url.includes('/conversations/messages/m1')) return savedAs?Response.json({message:{id:'m1',messageType:savedAs}}):new Response(null,{status:403});
  return new Response(null,{status:404});
 };
}

test('settings are cleaned', () => {
 assert.deepEqual(cleanNoteSettings({enabled:true,direction:'weird',skipCategories:['Invoices','Nope','Invoices']}),
  {enabled:true,direction:'both',skipCategories:['Invoices'],lookbackHours:24,testContact:''});
});

test('summaries post once to existing contacts only, with prices and no attachments', async () => {
 const store=noteStore({storeFactory:stores()});
 const settings={enabled:true,direction:'both',skipCategories:['Invoices'],lookbackHours:24};
 const calls=[];
 const result=await postEmailNotes({env,email:'artjr@a2zcs.net',mail,settings,store,fetcher:fakeGhl(calls),now});
 assert.deepEqual([result.status,result.posted,result.matched,result.lookups],['ok',2,2,1]);
 const posts=calls.filter(call=>call.url.endsWith('/conversations/messages'));
 assert.deepEqual(posts.map(call=>[call.body.type,call.body.contactId,call.body.conversationId]),[['InternalComment','c-ryan','conv-ryan'],['InternalComment','c-terri','conv-new']]);
 assert.ok(posts.every(call=>call.auth==='Bearer write-token'));
 assert.ok(calls.filter(call=>call.url.endsWith('/contacts/search')).every(call=>call.auth==='Bearer read-token'));
 assert.match(posts[0].body.message,/\$48,500/);
 assert.match(posts[0].body.message,/^Email from Ryan Stillion <ryan@rescon.example>/);
 assert.match(posts[1].body.message,/\$112,000/);
 assert.doesNotMatch(posts.map(call=>call.body.message).join('\n'),/attach/i);
 assert.equal(calls.some(call=>call.method==='POST'&&call.url.includes('/contacts/')&&!call.url.endsWith('/search')),false,'never creates contacts');

 // Second run: checkpoint and cache mean no new lookups or posts.
 const again=[];
 const second=await postEmailNotes({env,email:'artjr@a2zcs.net',mail,settings,store,fetcher:fakeGhl(again),now:now+60000});
 assert.deepEqual([second.posted,second.lookups],[0,0]);
 assert.equal(again.length,0);

 // Another mailbox with the same email: contact cache hit and no duplicate post.
 const other=[];
 const third=await postEmailNotes({env,email:'zeth@a2zcs.net',mail:[mail[0]],settings,store,fetcher:fakeGhl(other),now});
 assert.deepEqual([third.posted,third.lookups],[0,0]);
});

test('notes stay off until enabled and report missing tokens', async () => {
 const store=noteStore({storeFactory:stores()});
 assert.equal((await postEmailNotes({env,email:'a@b.example',mail,settings:{enabled:false},store})).status,'off');
 const missing=await postEmailNotes({env:{GROQ_API_KEY:'x'},email:'a@b.example',mail,settings:{enabled:true,direction:'both',skipCategories:[],lookbackHours:24},store});
 assert.equal(missing.status,'skipped');
 assert.match(missing.detail,/GHL_CONVERSATIONS_PIT_TOKEN/);
});

test('notes stop and turn off if HighLevel saves anything other than an internal comment', async () => {
 for (const savedAs of ['TYPE_SMS',null]) {
  const store=noteStore({storeFactory:stores()});
  await store.saveSettings({enabled:true,direction:'both',skipCategories:[]},'jesse@a2zcs.net');
  const calls=[];
  const result=await postEmailNotes({env,email:'artjr@a2zcs.net',mail,settings:await store.settings(),store,fetcher:fakeGhl(calls,savedAs),now});
  assert.equal(result.status,'failed');
  assert.match(result.detail,/Stopped and turned off/);
  assert.equal(calls.filter(call=>call.url.endsWith('/conversations/messages')).length,1,'only the first note is sent');
  const settings=await store.settings();
  assert.equal(settings.enabled,false);
  assert.match(settings.disabledReason,savedAs?/TYPE_SMS/:/message.readonly/);
 }
});

test('test contact mode posts to one contact only', async () => {
 const store=noteStore({storeFactory:stores()});
 const calls=[];
 const result=await postEmailNotes({env,email:'artjr@a2zcs.net',mail,
  settings:{enabled:true,direction:'both',skipCategories:[],lookbackHours:24,testContact:'terri@mcguire.example'},store,fetcher:fakeGhl(calls),now});
 assert.equal(result.posted,1);
 assert.deepEqual(calls.filter(call=>call.url.endsWith('/conversations/messages')).map(call=>call.body.contactId),['c-terri']);
});
