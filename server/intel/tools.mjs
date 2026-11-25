import {getStore} from '@netlify/blobs';
import {createHash,randomUUID} from 'node:crypto';
import {dayOf} from './service.mjs';
import {llmStatus,providerUsage} from './llm.mjs';

// Allowlisted tool registry. Ask AI and the MCP server call the same entries.
// Each tool: strict input schema, kind (read or write), where it is exposed, and run(ctx,args).
// Write tools never run straight from a model: Ask AI turns them into previews the user confirms,
// and MCP needs the separate write key with MCP_READ_ONLY=false.

const string = (maxLength=200,extra={}) => ({type:'string',maxLength,...extra});
const day = {type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'Pacific date YYYY-MM-DD'};
const limit = (max=50) => ({type:'integer',minimum:1,maximum:max});
const offset = {type:'integer',minimum:0,maximum:5000};
const id = string(2048,{description:'Email ID from a previous result (folder:uidValidity:uid)'});
const categories = ['Bid Invitations','Estimating','RFIs & Change Orders','Dispatch','Invoices','General'];
const schema = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false});
const range = {dateFrom:day,dateTo:day};

// Minimal JSON Schema validation for tool arguments (types, enums, bounds, patterns, required, no extras).
export function validate(spec,value,path='arguments') {
 if (spec.type==='object') {
  if (!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(path+' must be an object.');
  const out = {};
  for (const key of Object.keys(value)) if (!spec.properties[key]) throw new TypeError('Unknown argument '+key+'.');
  for (const key of spec.required||[]) if (value[key]===undefined||value[key]===null||value[key]==='') throw new TypeError('Missing '+key+'.');
  for (const [key,child] of Object.entries(spec.properties)) if (value[key]!==undefined&&value[key]!==null) out[key] = validate(child,value[key],key);
  return out;
 }
 if (spec.type==='string') {
  if (typeof value!=='string') throw new TypeError(path+' must be text.');
  if (value.length>(spec.maxLength||2000)) throw new TypeError(path+' is too long.');
  if (spec.enum&&!spec.enum.includes(value)) throw new TypeError(path+' must be one of: '+spec.enum.join(', ')+'.');
  if (spec.pattern&&!new RegExp(spec.pattern).test(value)) throw new TypeError(path+' has the wrong format.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new TypeError(path+' has invalid characters.');
  return value;
 }
 if (spec.type==='integer') {
  if (!Number.isSafeInteger(value)||value<(spec.minimum??-Infinity)||value>(spec.maximum??Infinity)) throw new TypeError(path+' is out of range.');
  return value;
 }
 if (spec.type==='boolean') {
  if (typeof value!=='boolean') throw new TypeError(path+' must be true or false.');
  return value;
 }
 if (spec.type==='array') {
  if (!Array.isArray(value)||value.length>(spec.maxItems||50)||value.length<(spec.minItems||0)) throw new TypeError(path+' must be a list of up to '+(spec.maxItems||50)+' items.');
  return value.map((item,index)=>validate(spec.items,item,path+'['+index+']'));
 }
 throw new TypeError('Unsupported schema.');
}

const reminderStore = () => getStore({name:'ai-reminders',consistency:'strong'});
const key = email => createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0,32);

// Attachment text: Cloudflare Markdown Conversion first (no extra provider), Gemini only if it is already configured.
async function attachmentText(ctx,file) {
 let cache = null;
 try {cache = ctx.cacheStore?.()||null;} catch {}
 const cacheKey = 'att/'+createHash('sha256').update(ctx.email+'|'+file.id+'|'+file.part).digest('hex');
 const cached = cache ? await cache.get(cacheKey,{type:'json'}).catch(()=>null) : null;
 if (cached?.text) return cached;
 let text = null, via = null;
 if (/^text\//.test(file.type)) {text = file.content.toString('utf8');via = 'text';}
 if (!text&&ctx.llm&&/pdf|image\/|officedocument|msword|excel|csv/.test(file.type+' '+file.name)) {
  try {
   const form = new FormData();
   form.append('files',new Blob([file.content],{type:file.type||'application/octet-stream'}),file.name||'attachment');
   const response = await ctx.fetcher('https://api.cloudflare.com/client/v4/accounts/'+ctx.llm.account+'/ai/tomarkdown',
    {method:'POST',headers:{Authorization:'Bearer '+ctx.llm.token},body:form,signal:AbortSignal.timeout(25000)});
   if (response.ok) {
    const data = await response.json();
    const first = Array.isArray(data?.result)?data.result[0]:data?.result;
    if (typeof first?.data==='string'&&first.data.trim()) {text = first.data;via = 'cloudflare-markdown';}
   }
  } catch {}
 }
 if (!text&&ctx.env?.GEMINI_API_KEY&&/pdf|image\//.test(file.type)) {
  try {
   const response = await ctx.fetcher('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',{method:'POST',signal:AbortSignal.timeout(30000),
    headers:{'x-goog-api-key':ctx.env.GEMINI_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:'Extract all text from this file as plain text. Keep tables as lines. Do not summarize.'},{inlineData:{mimeType:file.type,data:file.content.toString('base64')}}]}],
     generationConfig:{temperature:0,maxOutputTokens:8192}})});
   if (response.ok) {
    const data = await response.json();
    const value = data?.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('');
    if (value?.trim()) {text = value;via = 'gemini';}
   }
  } catch {}
 }
 const result = {text:text?text.slice(0,40000):null,via,truncated:Boolean(text&&text.length>40000)};
 if (text&&cache) await cache.setJSON(cacheKey,result).catch(()=>{});
 return result;
}

const readTool = (name,description,inputSchema,run,extra={}) => ({name,description,inputSchema,kind:'read',ai:true,mcp:true,...extra,run});

export const tools = [
 readTool('email_search','Search the mailbox index by words, sender, recipient, domain, folder, category, date range, attachments, unread or starred. Returns cited results.',
  schema({query:string(300),from:string(),to:string(),domain:string(),folder:string(100),category:{type:'string',enum:categories},...range,
   hasAttachment:{type:'boolean'},unread:{type:'boolean'},starred:{type:'boolean'},limit:limit(50),offset}),
  async (ctx,args)=>(await ctx.intel()).search(args)),
 readTool('email_get_thread','Get every message in the thread of one email, with message text for the latest messages.',schema({id},['id']),
  async (ctx,args)=>{
   const intel = await ctx.intel();
   const thread = intel.thread(args);
   if (!thread) throw new TypeError('That email is not in the index. Refresh or search again.');
   const recent = thread.messages.slice(-8).map(item=>item.id);
   const texts = typeof ctx.mailbox.textExcerpts==='function' ? await ctx.mailbox.textExcerpts(recent,4000).catch(()=>new Map()) : new Map();
   return {...thread,messages:thread.messages.map(item=>texts.has(item.id)?{...item,text:texts.get(item.id)}:item)};
  }),
 readTool('email_get_attachment','Read an attachment of one email as text (PDF, image, Office or text). Optional part; defaults to the first attachment.',
  schema({id,part:string(64,{pattern:'^\\d+(?:\\.\\d+)*$'}),includeBinary:{type:'boolean'}},['id']),
  async (ctx,args)=>{
   const row = (await ctx.intel()).byId.get(args.id);
   const files = row?.attachments||[];
   const meta = args.part?files.find(file=>file.part===args.part):files[0];
   if (!meta) return {id:args.id,attachments:files,text:null,note:'No matching attachment.'};
   const file = await ctx.mailbox.attachment(args.id,meta.part,15*1024*1024);
   if (!file) throw new TypeError('The attachment is no longer available.');
   const extracted = await attachmentText(ctx,{id:args.id,part:meta.part,name:file.name,type:file.type||meta.type,content:file.content});
   return {id:args.id,part:meta.part,name:file.name,type:file.type,size:file.content.length,...extracted,
    ...(args.includeBinary&&file.content.length<=4*1024*1024?{base64:file.content.toString('base64')}:{}),
    note:extracted.text?null:'Text could not be extracted from this file type.'};
  },{ai:true}),
 readTool('email_get_metrics','Email KPIs for a Pacific date range, calculated from records. Unavailable values are null.',schema({...range}),
  async (ctx,args)=>{
   const intel = await ctx.intel();
   const metrics = intel.metrics(args,{coverageStart:ctx.indexStatus?.coverageStart});
   const usage = ctx.usage ? await ctx.usage.range(metrics.range.from,metrics.range.to).catch(()=>null) : null;
   return {...metrics,aiRequests:usage?.requests??null,estimatedNeurons:usage?.neurons??null,
    syncStatus:ctx.indexStatus?.syncErrors?.length?'degraded':'ok',lastSuccessfulSync:ctx.indexStatus?.lastSync||null,
    cloudflareAi:llmStatus(ctx.llm).available};
  },{ai:false}),
 readTool('email_get_unanswered','Actionable received emails with no reply from us.',schema({...range,limit:limit(50),offset}),async (ctx,args)=>(await ctx.intel()).unanswered(args)),
 readTool('email_get_opportunities','Bid invitations and opportunities, with due dates and whether we responded. status not_responded finds ones we have not answered.',
  schema({...range,status:{type:'string',enum:['all','not_responded']},limit:limit(50),offset}),async (ctx,args)=>(await ctx.intel()).opportunities(args)),
 readTool('email_get_deadlines','Bid and proposal deadlines in a date range (default next 7 days) plus recently missed ones.',
  schema({...range,includeMissed:{type:'boolean'},limit:limit(50)}),async (ctx,args)=>(await ctx.intel()).deadlines(args)),
 readTool('email_get_followups','Proposals and quotes we sent that have no response yet.',schema({olderThanDays:{type:'integer',minimum:0,maximum:60},limit:limit(50),offset}),
  async (ctx,args)=>(await ctx.intel()).followups(args)),
 readTool('email_get_project_history','Complete communication history for a project name, address or keyword, oldest first.',schema({project:string(200),limit:limit(100),offset},['project']),
  async (ctx,args)=>(await ctx.intel()).projectHistory(args)),
 readTool('email_get_contact_history','Communication history with a GC, customer, person, email address or domain.',schema({contact:string(200),limit:limit(100),offset},['contact']),
  async (ctx,args)=>(await ctx.intel()).contactHistory(args)),
 readTool('email_get_payment_commitments','Payment commitments, amounts and payment dates found in email text.',schema({...range,limit:limit(50),offset}),
  async (ctx,args)=>(await ctx.intel()).paymentCommitments(args)),
 readTool('email_get_risks','Possible disputes, complaints, delays, payment issues, damage and safety items.',schema({...range,limit:limit(50),offset}),
  async (ctx,args)=>(await ctx.intel()).risks(args)),
 readTool('email_get_briefing','Operational briefing: most important emails, deadlines, unanswered mail, follow-ups, risks and alerts for a date (default today).',
  schema({...range}),async (ctx,args)=>(await ctx.intel()).briefing(args)),
 readTool('email_get_relationships','GC and customer relationships by sender domain: volume, bid invites, last contact, and active, cooling or cold status.',
  schema({status:{type:'string',enum:['active','cooling','cold']},sort:{type:'string',enum:['recent','volume']},limit:limit(100)}),
  async (ctx,args)=>(await ctx.intel()).relationships(args)),
 readTool('email_get_volume','Count emails per day, week or month, optionally by category and direction, for comparisons.',
  schema({...range,category:{type:'string',enum:categories},groupBy:{type:'string',enum:['day','week','month']},direction:{type:'string',enum:['received','sent']}}),
  async (ctx,args)=>(await ctx.intel()).volume(args)),
 readTool('email_get_commitments','Things we promised customers in sent mail (we will, I will, by Friday).',schema({...range,limit:limit(50),offset}),
  async (ctx,args)=>(await ctx.intel()).commitments(args)),
 readTool('email_get_alerts','Proactive alerts from rules: deadlines, missed bids, unanswered mail, follow-ups, overdue payments, addenda, complaints, schedule conflicts, dormant GCs.',
  schema({}),async ctx=>({alerts:(await ctx.intel()).alerts()})),
 readTool('email_get_health','Integration and service health. No AI inference.',schema({}),async ctx=>({
  mailbox:ctx.email,index:ctx.indexStatus||null,cloudflareAi:llmStatus(ctx.llm),checkedAt:new Date().toISOString()}),{ai:false}),
 readTool('email_get_ai_usage','AI usage today: requests and estimated neurons against the daily budget, plus Cloudflare reported neurons when available.',schema({}),
  async ctx=>{
   const today = ctx.usage ? await ctx.usage.day() : null;
   const reported = ctx.llm ? await providerUsage(ctx.llm,ctx.fetcher) : null;
   return {date:new Date().toISOString().slice(0,10),timezone:'UTC',requests:today?.requests??null,estimatedNeurons:today?.neurons??null,
    providerReportedNeurons:reported,dailyBudget:ctx.llm?.budget??null,remainingEstimated:today&&ctx.llm?Math.max(0,ctx.llm.budget-today.neurons):null,
    byModel:today?.byModel||{},note:'Estimated from token usage. Cloudflare free allowance is 10,000 neurons per day.'};
  },{ai:false}),
 readTool('reminders_list','List open reminders and tasks.',schema({}),async ctx=>{
  const data = await reminderStore().get(key(ctx.email),{type:'json'}).catch(()=>null);
  return {items:(data?.items||[]).filter(item=>!item.done)};
 },{mcp:false}),
 readTool('crm_lookup_contact','Look up a contact in HighLevel by name or email (read only).',schema({query:string(100)},['query']),
  async (ctx,args)=>({contacts:await ctx.integrations.searchContacts(args.query)}),{mcp:false,enabled:ctx=>Boolean(ctx.integrations?.searchContacts),requirement:'GHL_CONTACTS_PIT_TOKEN and a location ID'}),
 readTool('estimating_desk_report','Latest Bid Lead Finder report: qualified leads, review items and leads already on the Estimating Desk.',schema({}),
  async ctx=>({report:await ctx.integrations.bidReport()}),{mcp:false,enabled:ctx=>Boolean(ctx.integrations?.bidReport),requirement:'Bid scan configuration'}),
 readTool('dispatch_board_schedule','Dispatch Board schedules.',schema({...range}),async ()=>({}),
  {mcp:false,enabled:()=>false,requirement:'A Dispatch Board API URL and key. No Dispatch Board API is configured for this app yet.'}),
 readTool('financial_ledger_records','Financial Ledger records.',schema({...range}),async ()=>({}),
  {mcp:false,enabled:()=>false,requirement:'A Financial Ledger API URL and key. No Ledger API is configured for this app yet.'}),

 // Write tools. Ask AI shows a preview first; MCP needs the write key and MCP_READ_ONLY=false.
 {name:'email_create_draft',kind:'write',ai:true,mcp:true,confirm:false,
  description:'Save an email draft in A2Z Inbox Drafts. Never sends.',
  inputSchema:schema({to:string(2048),cc:string(2048),subject:string(500),body:string(10000),replyToId:id},['body']),
  preview:args=>({title:'Save draft'+(args.to?' to '+args.to:''),detail:(args.subject?'Subject: '+args.subject+'\n\n':'')+args.body}),
  async run(ctx,args) {
   const draftId = randomUUID();
   const original = args.replyToId ? (await ctx.intel()).byId.get(args.replyToId) : null;
   await ctx.preferences.saveDraft({id:draftId,to:args.to||'',cc:args.cc||'',bcc:'',subject:args.subject||(original?'Re: '+original.subject.replace(/^(re:\s*)+/i,''):''),
    body:args.body,attachments:[],...(original?{thread:original.messageId||original.id,parent:{project:'',headers:{messageId:original.messageId||'<'+original.id+'>',references:(original.refs||[]).slice(-5)}}}:{})},{createOnly:true});
   return {draftId,saved:true,sent:false};
  }},
 {name:'email_mark',kind:'write',ai:true,mcp:false,
  description:'Mark emails read or unread, or star or unstar them.',
  inputSchema:schema({ids:{type:'array',items:id,minItems:1,maxItems:50},action:{type:'string',enum:['read','unread','star','unstar']}},['ids','action']),
  preview:(args,ctx)=>({title:args.action[0].toUpperCase()+args.action.slice(1)+' '+args.ids.length+' email'+(args.ids.length===1?'':'s'),detail:ctx.describe(args.ids)}),
  async run(ctx,args) {
   let done = 0;
   for (const target of args.ids) {await ctx.mailbox.update({id:target,action:args.action});done++;}
   return {updated:done};
  }},
 {name:'email_move',kind:'write',ai:true,mcp:false,
  description:'Move emails to Archive or Inbox. Deleting is not available to the AI.',
  inputSchema:schema({ids:{type:'array',items:id,minItems:1,maxItems:50},folder:{type:'string',enum:['Archive','Inbox']}},['ids','folder']),
  preview:(args,ctx)=>({title:'Move '+args.ids.length+' email'+(args.ids.length===1?'':'s')+' to '+args.folder,detail:ctx.describe(args.ids)}),
  async run(ctx,args) {
   for (const target of args.ids) await ctx.mailbox.update({id:target,action:'move',destination:args.folder});
   return {moved:args.ids.length};
  }},
 {name:'reminder_create',kind:'write',ai:true,mcp:false,
  description:'Create a reminder or task, optionally linked to an email and a due date.',
  inputSchema:schema({title:string(200),due:day,emailId:id},['title']),
  preview:args=>({title:'Create reminder',detail:args.title+(args.due?' (due '+args.due+')':'')}),
  async run(ctx,args) {
   const store = reminderStore();
   const current = await store.get(key(ctx.email),{type:'json'}).catch(()=>null);
   const items = (current?.items||[]).slice(-199);
   const item = {id:randomUUID(),title:args.title,due:args.due||null,emailId:args.emailId||null,createdAt:new Date().toISOString(),done:false};
   await store.setJSON(key(ctx.email),{items:[...items,item]});
   return {reminder:item};
  }},
];

export const toolNamed = name => tools.find(tool=>tool.name===name)||null;
export const enabled = (tool,ctx) => tool.enabled ? tool.enabled(ctx) : true;

// Runs a read tool with validated arguments and a time limit.
export async function runTool(ctx,name,rawArgs,{timeout=20000}={}) {
 const tool = toolNamed(name);
 if (!tool) throw new TypeError('Unknown tool '+name+'.');
 if (!enabled(tool,ctx)) throw Object.assign(new TypeError(name+' is not available. Needs: '+tool.requirement),{code:'tool_disabled'});
 const args = validate(tool.inputSchema,rawArgs??{});
 let timer;
 try {
  return await Promise.race([tool.run(ctx,args),new Promise((_,reject)=>{timer = setTimeout(()=>reject(Object.assign(new Error(name+' timed out.'),{code:'timeout'})),timeout);})]);
 } finally {clearTimeout(timer);}
}

export const describeTools = (ctx,{kind}={}) => tools.filter(tool=>tool.ai&&enabled(tool,ctx)&&(!kind||tool.kind===kind))
 .map(tool=>({name:tool.name,kind:tool.kind,description:tool.description,args:Object.fromEntries(Object.entries(tool.inputSchema.properties)
  .map(([name,spec])=>[name,spec.enum?spec.enum.join('|'):spec.type+(spec.pattern?' YYYY-MM-DD':'')])),required:tool.inputSchema.required}));

export const today = () => dayOf(Date.now());
