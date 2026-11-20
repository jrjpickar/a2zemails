import {createHash} from 'node:crypto';
import {getStore} from '@netlify/blobs';
import {aiConfig,aiEnabled,runAiChain} from './ask-ai.mjs';
import {bidLeadPrompt} from './bid-lead-prompt.mjs';
import {contactsConfig} from './ghl-contacts.mjs';
import {currentMessageText} from '../src/model.mjs';

const fields='project_name street city state zip due_date gc_company first_name last_name email phone scope_text demo_scope_evidence owner_name planhub_link photos_link'.split(' ');
const enums={
 owner_type:['private','public','unknown'],lead_type:['commercial_ti','residential','other'],
 contact_type:['general_contractor','homeowner',null],
};
const switches=['is_addendum_or_reminder','is_bid_results','contact_locked'];
const flags=['prevailing_wage','DIR','certified_payroll','public_works_bond','DVBE/SBE'];
const expectedSize=fields.length+switches.length+Object.keys(enums).length+2;
const defaultTerms=['invitation to bid','itb','rfq','bid request','request for proposal','demo','demolition'];
const defaultDomains=['buildingconnected.com','planhub.com','procore.com','smartbidnet.com','smartbid.co','constructconnect.com'];
const aliases={street:'st',avenue:'ave',boulevard:'blvd',drive:'dr',road:'rd',place:'pl',parkway:'pkwy'};
const gh='https://services.leadconnectorhq.com';
const dayMs=86400000;

const keyFor=email=>createHash('sha256').update(email.toLowerCase()).digest('hex');
const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const csv=(value,defaults)=>value?value.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean):defaults;

export function bidLeadConfig(env) {
 const contacts=contactsConfig(env);
 const desk=contacts&&{...contacts,projectNameId:env.GHL_PROJECT_NAME_FIELD_ID?.trim()};
 const ai=aiConfig(env);
 return {
  desk,ai,geoKey:env.BID_GEOCODING_API_KEY?.trim(),
  terms:csv(env.BID_LEAD_TERMS,defaultTerms),domains:csv(env.BID_LEAD_DOMAINS,defaultDomains),
  scope:env.DEDUPE_SCOPE==='per_user'?'per_user':'global',
 };
}

export function projectKey(street,name,city) {
 const plain=normalize(String(street||'').split(',')[0].replace(/\s+(?:(?:suite|ste|unit|spc)\.?\s+|#\s*).*$/i,''));
 const suffix=plain.replace(/\b(street|avenue|boulevard|drive|road|place|parkway)\b/g,word=>aliases[word]);
 return /^\d+\s+/.test(suffix)?suffix:normalize(name)&&normalize(city)?normalize(name)+'|'+normalize(city):'';
}

function similarStreet(first,second) {
 const a=first.match(/^(\d+) (.{4,})$/), b=second.match(/^(\d+) (.{4,})$/);
 if (!a||!b||a[1]!==b[1]||first===second||Math.abs(a[2].length-b[2].length)>2) return false;
 let row=Array.from({length:b[2].length+1},(_,index)=>index);
 for (const [index,char] of [...a[2]].entries()) {
  const next=[index+1];
  for (const [other,value] of [...b[2]].entries()) {
   next.push(Math.min(row[other+1]+1,next[other]+1,row[other]+Number(char!==value)));
  }
  row=next;
 }
 return row.at(-1)<=2;
}

export function gcKey(company) {
 return normalize(company).replace(/\b(?:inc|llc|co|corp|construction|builders|contracting|group)\b/g,'').replace(/\s+/g,' ').trim();
}

export function validateInvites(answer) {
 const data=JSON.parse(answer);
 if (!data||Object.keys(data).length!==1||!Array.isArray(data.invites)||data.invites.length>30) throw new Error('Invalid extraction');
 for (const item of data.invites) {
  if (!item||Object.keys(item).length!==expectedSize||
      !fields.every(key=>item[key]===null||typeof item[key]==='string'&&item[key].length<=5000)||
      !Object.entries(enums).every(([key,values])=>values.includes(item[key]))||
      !switches.every(key=>typeof item[key]==='boolean')||
      !(item.size_sf===null||Number.isFinite(item.size_sf)&&item.size_sf>0)||
      !Array.isArray(item.public_work_flags)||!item.public_work_flags.every(flag=>flags.includes(flag))) {
   throw new Error('Invalid extraction');
  }
 }
 return data.invites;
}

const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(value))&&
 new Date(value).toISOString().slice(0,10)===value;

function dateInText(date,source) {
 if (!validDate(date)) return false;
 const [year,month,day]=date.split('-');
 const m=Number(month),d=Number(day);
 const monthName=new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(new Date(date));
 const seasonal='(?:'+monthName+'|'+monthName.slice(0,3)+'\\.?)';
 return source.includes(date)||new RegExp('\\b(?:0?'+m+'[/-]0?'+d+'[/-](?:'+year+'|'+year.slice(2)+')|'+
  seasonal+'\\s+0?'+d+'(?:st|nd|rd|th)?[,]?\\s+'+year+')\\b','i').test(source);
}

export function verifyEvidence(input,source) {
 const item={...input};
 const flat=source.toLowerCase().replace(/\s+/g,' ');
 const phones=source.match(/(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?[2-9]\d{2}[ .-]?\d{4}(?!\d)/g)||[];
 if (item.email&&!flat.includes(item.email.toLowerCase())) item.email=null;
 const phone=item.phone?.replace(/^\+?1(?=\D|\d{10}$)/,'').replace(/\D/g,'');
 if (!phone||!(/^[2-9]\d{2}[2-9]\d{6}$/).test(phone)||!phones.some(value=>value.replace(/\D/g,'').slice(-10)===phone)) item.phone=null;
 const number=item.street?.match(/^\s*(\d+)\b/)?.[1];
 if (number&&!new RegExp('\\b'+number+'\\b').test(source)) item.street=null;
 if (item.size_sf!==null&&!new RegExp('(?<![\\d.])'+String(item.size_sf).replace('.','\\.')+'(?![\\d.])').test(source.replace(/,(?=\d{3}\b)/g,''))) item.size_sf=null;
 if (!dateInText(item.due_date,source)) item.due_date=null;
 if (!item.demo_scope_evidence||!flat.includes(item.demo_scope_evidence.toLowerCase().trim().replace(/\s+/g,' '))) item.demo_scope_evidence=null;
 for (const name of ['planhub_link','photos_link']) {
  try {
   const url=new URL(item[name]);
   const allowed=name==='planhub_link'?/(^|\.)planhub\.com$/i:/^(drive\.google\.com|(?:www\.)?dropbox\.com|[\w.-]+\.box\.com|[\w.-]+\.companycam\.com)$/i;
   if (url.protocol!=='https:'||url.username||url.password||!allowed.test(url.hostname)||!source.includes(item[name])) item[name]=null;
  } catch {item[name]=null;}
 }
 return item;
}

async function ghlGet(config,path,params,fetcher) {
 const url=new URL(path,gh);
 url.search=new URLSearchParams(params).toString();
 const response=await fetcher(url.href,{
  method:'GET',headers:{Authorization:'Bearer '+config.token,Version:'v3',Accept:'application/json'},
  signal:AbortSignal.timeout(12000),
 });
 if (!response.ok) throw new Error('highlevel_http_'+response.status);
 return response.json();
}

export async function readDesk(config,fetcher=fetch) {
 const {locationId}=config;
 const {pipelines}=await ghlGet(config,'/opportunities/pipelines',{locationId},fetcher);
 if (!Array.isArray(pipelines)||!pipelines.length||pipelines.some(item=>!item?.id)) throw new Error('highlevel_invalid_pipelines');
 let projectNameId=config.projectNameId;
 if (!projectNameId) {
  const fields=await ghlGet(config,'/locations/'+encodeURIComponent(locationId)+'/customFields',{model:'opportunity'},fetcher);
  if (!Array.isArray(fields.customFields)) throw new Error('highlevel_invalid_custom_fields');
  projectNameId=fields.customFields.find(field=>field.fieldKey==='opportunity.project_name')?.id;
 }
 const records=[];
 const companies=new Map();
 for (const {id} of pipelines) {
  const params={locationId,pipelineId:id,status:'all',limit:'100'};
  const seen=new Set();
  for (;;) {
   const data=await ghlGet(config,'/opportunities/search',params,fetcher);
   if (!Array.isArray(data.opportunities)) throw new Error('highlevel_invalid_opportunities');
   const missing=[...new Set(data.opportunities.filter(row=>!row?.contact?.companyName)
    .map(row=>row?.contactId||row?.contact?.id).filter(id=>typeof id==='string'&&!companies.has(id)))];
   for (let start=0;start<missing.length;start+=6) {
    await Promise.all(missing.slice(start,start+6).map(async id=>{
     const details=await ghlGet(config,'/contacts/'+encodeURIComponent(id),{},fetcher);
     if (!details.contact) throw new Error('highlevel_invalid_contact');
     companies.set(id,details.contact.companyName||details.contact.name||'');
    }));
   }
   for (const row of data.opportunities) {
    if (!row?.id||seen.has(row.id)||row.pipelineId!==id) throw new Error('highlevel_inconsistent_pagination');
    seen.add(row.id);
    const contact=row.contact||{};
    const contactId=row.contactId||contact.id;
    const company=contact.companyName||companies.get(contactId);
    const projectName=row.customFields?.find(field=>field.id===projectNameId);
    const name=projectName?.fieldValue||projectName?.field_value||projectName?.value||row.name;
    const address=/^\s*\d+\s/.test(row.name||'')?row.name:row.address||contact.address1||contact.address;
    const project=projectKey(address,name,contact.city);
    if (project) records.push({project,gc:gcKey(company||contact.name),owner:row.assignedTo||null});
   }
   const {startAfterId,startAfter}=data.meta||{};
   if (data.opportunities.length<100) break;
   if (!startAfterId||startAfterId===params.startAfterId||startAfter==null) throw new Error('highlevel_incomplete_pagination');
   Object.assign(params,{startAfterId,startAfter:String(startAfter)});
  }
 }
 return {records,pipelineCount:pipelines.length};
}

function isCandidate(message,body,config) {
 const content=' '+normalize(message.subject+' '+body)+' ';
 const domain=(message.from||'').toLowerCase().split('@').at(-1);
 return config.terms.some(term=>content.includes(' '+normalize(term)+' '))||
  config.domains.some(value=>domain===value||domain.endsWith('.'+value));
}

async function coordinates(address,key,fetcher) {
 const query=new URLSearchParams({address,components:'country:US',key});
 const response=await fetcher('https://maps.googleapis.com/maps/api/geocode/json?'+query,{signal:AbortSignal.timeout(8000)});
 if (!response.ok) throw new Error('geocode_unavailable');
 const result=await response.json();
 if (result.status!=='OK'&&result.status!=='ZERO_RESULTS') throw new Error('geocode_unavailable');
 const match=result.results?.[0];
 return match&&!match.partial_match?match.geometry?.location:null;
}

function miles(a,b) {
 const rad=Math.PI/180;
 const hav=Math.sin((a.lat-b.lat)*rad/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((a.lng-b.lng)*rad/2)**2;
 return Math.round(3958.76*2*Math.asin(Math.sqrt(Math.min(1,hav)))*10)/10;
}

export function qualify(lead,today,distance) {
 if (lead.owner_type==='public'||lead.public_work_flags.length) return ['skipped','public_work'];
 if (!lead.demo_scope_evidence) return ['skipped','no_demo_scope'];
 if (!lead.due_date||Date.parse(lead.due_date)-Date.parse(today)<2*dayMs) return ['skipped','past_or_near_due'];
 if (lead.contact_locked) return ['skipped','contact_locked'];
 if (lead.lead_type==='other') return ['skipped','wrong_lead_type'];
 if (lead.lead_type==='commercial_ti'&&lead.size_sf>=10000) return ['skipped','ti_too_large'];
 if (distance!==null&&distance>30) return ['skipped','out_of_radius'];
 if (lead.owner_type!=='private') return ['needs_review','owner_unverified'];
 if (!lead.gc_company) return ['needs_review','gc_missing'];
 if (lead.lead_type==='commercial_ti'&&lead.size_sf===null) return ['needs_review','size_unknown'];
 if (distance===null) return ['needs_review','distance_unverified'];
 return ['qualified',null];
}

export const bidReportStore=()=>getStore({name:'bid-lead-reports',consistency:'strong'});
export async function readBidReport(email,store=bidReportStore()) {
 const state=await store.get(keyFor(email)+'/report',{type:'json'});
 if (!state?.summary) return null;
 const {complete,runDate,asOf,totalMessages,pipelines,dedupeScope,counts,providers,reasons,skipped}=state.summary;
 return {complete,runDate,asOf,totalMessages,pipelines,dedupeScope,counts,providers,reasons,skipped};
}

const offsetFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
export const dayInCalifornia=date=>{
 const parts=offsetFormatter.formatToParts(date);
 // Use numeric components to avoid locale-specific separators.
 const get=type=>parts.find(part=>part.type===type).value;
 const year=get('year');
 return (year.length===2?'20'+year:year)+'-'+get('month').padStart(2,'0')+'-'+get('day').padStart(2,'0');
};

export async function dryRunBidLeads({email,mailbox,config,store=bidReportStore(),fetcher=fetch,now=new Date(),budgetMs=11*60000,fresh=false}) {
 if (!config.desk||!aiEnabled(config.ai)) throw new Error('bid_lead_credentials_missing');
 const key=keyFor(email)+'/report';
 const loaded=await store.getWithMetadata(key,{type:'json'});
 const existing=loaded?.data;
 if (existing?.complete&&!fresh) return existing.summary;
 const state=existing?.complete?null:existing;
 const started=Date.now();
 const runDate=state?.runDate||now.toISOString();
 const runNow=new Date(runDate);
 const since=new Date(runNow.getTime()-30*dayMs);
 const [desk,mail]=await Promise.all([readDesk(config.desk,fetcher),mailbox.recentInbox(since)]);
 const messages=mail.filter(message=>message.date&&Date.parse(message.date)<=runNow.getTime());
 const expectedGeneration=messages[0]?.id.split(':')[1]||null;
 if (state&&state.generation!==expectedGeneration) throw new Error('bid_lead_mailbox_changed');
 let etag=loaded?.etag;
 const processed=state?.processed||{};
 const geocoded=new Map();
 const origin=config.geoKey?await coordinates('Costa Mesa, CA 92626',config.geoKey,fetcher):null;
 if (config.geoKey&&!origin) throw new Error('geocode_origin_unavailable');

 function summarize(complete) {
  const records=Object.values(processed);
  const leads=[];
  const latest=new Map();
  const updates=[];
  const companies=new Map();
  const opportunities=new Map();
  for (const item of desk.records) {
   if (!opportunities.has(item.project)) opportunities.set(item.project,[]);
   opportunities.get(item.project).push(item);
   if (!companies.has(item.project)) companies.set(item.project,new Set());
   if (item.gc) companies.get(item.project).add(item.gc);
  }
  for (const record of records) {
   for (const entry of record.entries) {
    const {lead}=entry;
    if (!lead) {leads.push(entry);continue;}
    const {project,gc}=entry;
    const existing=opportunities.get(project)||[];
    const owners=[...new Set(existing.map(item=>item.owner).filter(Boolean))];
    entry.assignedUser=owners.length===1?owners[0]:null;
    if (owners.length>1&&entry.status==='qualified') Object.assign(entry,{status:'needs_review',reason:'ambiguous_owner'});
    if (project&&gc&&existing.some(item=>item.gc===gc&&(config.scope==='global'||item.owner===entry.assignedUser))) {
     leads.push({...entry,status:'skipped',reason:'already_on_desk'});
     continue;
    }
    const match=project&&gc?JSON.stringify([project,gc]):null;
    if (lead.is_addendum_or_reminder||lead.is_bid_results) {updates.push({...entry,match});continue;}
    if (entry.status==='qualified'&&!match) Object.assign(entry,{status:'needs_review',reason:'incomplete_dedupe_key'});
    if (match&&entry.status==='qualified'&&(
     [...opportunities.keys()].some(candidate=>similarStreet(project,candidate))||
     [...latest.values()].some(candidate=>similarStreet(project,candidate.project))
    )) Object.assign(entry,{status:'needs_review',reason:'possible_address_match'});
    if (!match||entry.status==='skipped') {leads.push(entry);continue;}
    const previous=latest.get(match);
    if (previous) {
     const fields=['first_name','last_name','email','phone'];
     const chosen=fields.filter(field=>lead[field]).length>fields.filter(field=>previous.lead[field]).length;
     const contact=chosen?lead:previous.lead;
     latest.set(match,{...entry,lead:{...lead,...Object.fromEntries(fields.map(field=>[field,contact[field]]))}});
    } else latest.set(match,entry);
   }
  }
  for (const entry of updates) {
   const previous=latest.get(entry.match);
   if (!previous) {leads.push({...entry,status:'skipped',reason:'no_existing_lead'});continue;}
   if (!entry.lead.is_bid_results&&entry.lead.due_date&&entry.uid>previous.uid&&
       !['ambiguous_owner','possible_address_match'].includes(previous.reason)) {
    previous.lead={...previous.lead,due_date:entry.lead.due_date};
    [previous.status,previous.reason]=qualify(previous.lead,dayInCalifornia(runNow),previous.distance);
   }
  }
  for (const entry of latest.values()) {
   if (!companies.has(entry.project)) companies.set(entry.project,new Set());
   companies.get(entry.project).add(entry.gc);
   leads.push(entry);
  }
  const counts={messagesScanned:records.length,candidates:0,qualified:0,needsReview:0,skipped:0};
  const providers={};
  for (const record of records) {
   if (record.candidate) counts.candidates++;
   if (record.provider) providers[record.provider]=(providers[record.provider]||0)+1;
  }
  const reasons={};
  for (const lead of leads) {
   if (lead.status==='qualified') counts.qualified++;
   else {
    counts[lead.status==='needs_review'?'needsReview':'skipped']++;
    if (lead.status==='skipped') reasons[lead.reason]=(reasons[lead.reason]||0)+1;
   }
  }
  return {complete,runDate,asOf:new Date().toISOString(),totalMessages:messages.length,
   pipelines:desk.pipelineCount,dedupeScope:config.scope,counts,providers,reasons,
   skipped:leads.filter(item=>item.status==='skipped').reverse().slice(0,100)
    .map(({uid,subject,reason})=>({uid,subject,reason})),
   leads:leads.filter(item=>item.lead&&item.status!=='skipped').map(item=>({
    ...item,multipleGcsBidding:(companies.get(item.project)?.size||0)>1,
   })),
  };
 }

 async function checkpoint(complete=false) {
  const summary=summarize(complete);
  const result=await store.setJSON(key,{runDate,generation:expectedGeneration,processed,summary,complete},
   etag?{onlyIfMatch:etag}:{onlyIfNew:true});
  if (!result.modified||!result.etag) throw new Error('bid_lead_run_concurrent');
  etag=result.etag;
  return summary;
 }

 // Reserve the report before the first provider request. A conflicting writer
 // cannot overwrite a checkpoint, even when two background calls overlap.
 await checkpoint();
 for (const message of messages) {
  if (processed[message.id]) continue;
  if (Date.now()-started>budgetMs) return checkpoint();
  const emailBody=await mailbox.body(message.id,{includeHtml:false,includeImages:false});
  if (!emailBody) continue;
  const body=currentMessageText(emailBody.body||'');
  const record={candidate:isCandidate(message,body,config),entries:[]};
  if (record.candidate) {
   const source=[message.subject,message.from,body.slice(0,30000)].join('\n');
   const aiStarted=performance.now();
   const result=await runAiChain(config.ai,[{role:'user',content:JSON.stringify({email:source})}],{
    prompt:bidLeadPrompt,temp:0,json:true,validate:validateInvites,fetcher,
   });
   console.info('[Bid extraction]',JSON.stringify({provider:result.provider||null,
    fallbackReason:result.fallbackReason||result.reason||null,latencyMs:Math.round(performance.now()-aiStarted)}));
   if (!result.provider) throw new Error(result.stop?'bid_lead_provider_configuration':'bid_lead_provider_unavailable');
   record.provider=result.provider;
   const entry={uid:message.uid,sourceMessageId:message.id,sender:(message.from||'').slice(0,320),subject:message.subject.slice(0,300)};
   if (!result.answer.length) record.entries.push({...entry,status:'skipped',reason:'no_bid_invite'});
   for (const raw of result.answer) {
    const lead=verifyEvidence(raw,source);
    const project=projectKey(lead.street,lead.project_name,lead.city);
    const gc=gcKey(lead.gc_company);
    const address=[lead.street,lead.city,lead.state,lead.zip].filter(Boolean).join(', ');
    const [initialStatus,initialReason]=qualify(lead,dayInCalifornia(runNow),null);
    let distance=null;
    if (initialStatus==='needs_review'&&initialReason==='distance_unverified'&&origin&&lead.street&&lead.city) {
     if (!geocoded.has(address)) geocoded.set(address,await coordinates(address,config.geoKey,fetcher));
     const match=geocoded.get(address);
     if (match) distance=miles(origin,match);
    }
    const [status,reason]=qualify(lead,dayInCalifornia(runNow),distance);
    record.entries.push({...entry,lead,project,gc,distance,status,reason});
   }
  }
  processed[message.id]=record;
  await checkpoint();
 }
 return checkpoint(true);
}
