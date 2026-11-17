import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify,matchProject,searchMail,seed,projects,threadFor,rowActions} from '../src/model.mjs';
import {createMockAdapters} from '../src/adapters.mjs';
import sandbox from '../netlify/functions/sandbox.mjs';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

test('construction categories favor subject and honor explicit domain corrections',()=>{
 assert.equal(classify('RFI #018','Attached invoice'),'RFIs & Change Orders');
 assert.equal(classify('Addendum 2'),'Estimating');
 assert.equal(classify('PO-432'),'Invoices');
 assert.equal(classify('NTP — Riverside'),'Dispatch');
 assert.equal(classify('RFP — demo'),'Bid Invitations');
 assert.equal(classify('RFI','', 'gc@example.test',{'example.test':'Estimating'}),'Estimating');
});
test('one project match is required',()=>{
 assert.equal(matchProject('See EST-241 and 1400 Harbor Blvd'),'P-241');
 assert.equal(matchProject('Harbor Point and Westfield'),'');
 assert.equal(matchProject('Unrelated job'),'');
});
test('field-specific search combines quoted terms and attachment names',()=>{
 assert.deepEqual(seed.filter(m=>searchMail(m,'project:"Harbor Point" attachment:"Plan Set"')).map(m=>m.id),['mail-0']);
 assert.equal(searchMail(seed[0],'from:marcus date:2026-11-17 subject:redevelopment'),true);
 assert.equal(searchMail(seed[0],'to:marcus'),false);
});
test('thread membership survives archive and separates unrelated subjects',()=>{
 const original=seed[0];
 const reply={...original,id:'reply',date:'2026-11-17T10:02:00',folder:'Sent',headers:{messageId:'<reply@example>',references:[original.headers.messageId]}};
 const archived=rowActions(original,{folder:'Archive'});
 assert.equal(archived.previousFolder,'Inbox');
 assert.deepEqual(threadFor([{...original,id:'different',thread:'other'},reply,archived],archived).map(m=>m.id),[original.id,'reply']);
});
test('mock adapters read the same project data without external calls',()=>{
 const adapters=createMockAdapters(()=>({mail:seed}),projects);
 assert.equal(adapters.estimating.forEstimate('EST-241').length,2);
 assert.equal(adapters.dispatch.forJob('P-263').length,1);
 assert.equal(adapters.crm.findExisting('unknown@example.test'),null);
 assert.equal(adapters.assistant.attachments('mail-0').length,2);
});
test('Netlify sandbox handler serves filtered fixtures and rejects writes',async()=>{
 const url='http://localhost/.netlify/functions/sandbox?q=attachment%3Asketch';
 const reply=sandbox(new Request(url));
 assert.equal(reply.status,200);
 assert.equal(reply.headers.get('cache-control'),'no-store');
 assert.equal((await reply.json()).mail[0].id,'mail-1');
 assert.equal(sandbox(new Request(url,{method:'POST'})).status,405);
});
test('sample attachment has a PDF header and trailer',async()=>{
 const pdf=await readFile(new URL('../public/samples/demo.pdf',import.meta.url),'utf8');
 assert.match(pdf,/^%PDF-1\.4/); assert.match(pdf,/%%EOF\n$/);
});
test('worker stays offline unless both live gates are enabled',()=>{
 const r=spawnSync(process.execPath,['worker/sync.mjs'],{encoding:'utf8',env:{...process.env,A2Z_MODE:'live',A2Z_ENABLE_LIVE:'false'}});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/connections are disabled/);
});
