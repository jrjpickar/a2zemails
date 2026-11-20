import {createHash} from 'node:crypto';
import {bidLeadConfig,bidReportStore,readDesk,dayInCalifornia,qualify,dryRunBidLeads} from './bid-leads.mjs';

export const bidHeaders=[
 'Project Name','Job Address','PlanHub Link','Photos Link','Due Date','Company Name','First Name','Last Name','Email',
 'Client Phone Number','Temperature','Assigned User','Multiple GCs Bidding','Contact Type','Lead Type','Distance (mi)',
 'Size (SF)','Demo Scope Evidence','Source','Notes',
];
const hash=value=>createHash('sha256').update(value).digest('hex');
const leadId=entry=>hash(JSON.stringify([entry.project,entry.gc]));
export const bidAddress=lead=>[
 lead.street,lead.city,[lead.state,lead.zip].filter(Boolean).join(' '),
].filter(Boolean).join(', ');
const deskName=lead=>lead.contact_type==='general_contractor'?'General Contractor':lead.contact_type==='homeowner'?'Homeowner':'';
const source=entry=>/(^|@|\.)planhub\.com$/i.test(entry.sender||'')?'PlanHub':
 ['Email',entry.sender||'',entry.subject||''].filter(Boolean).join(' · ');

function quote(value) {
 let str=String(value??'');
 // Protect CSV importers that open exported files as spreadsheets.
 if (/^[\t\r\n]|^\s*[=+\-@]/.test(str)&&!/^\+1?\d{10}$/.test(str)) str="'"+str;
 return /["\r\n,]/.test(str)?'"'+str.replaceAll('"','""')+'"':str;
}

export function qualifiedBidCsv(entries) {
 const rows=entries.map(entry=>{
  const {lead}=entry;
  const [year,month,day]=lead.due_date.split('-');
  return [lead.project_name,bidAddress(lead),lead.planhub_link,lead.photos_link,
   month+'/'+day+'/'+year,lead.gc_company,lead.first_name,lead.last_name,lead.email,lead.phone,'','',
   entry.multipleGcsBidding?'Yes':'No',deskName(lead),lead.lead_type==='commercial_ti'?'Commercial TI':'Residential',
   entry.distance?.toFixed(1),lead.size_sf,lead.demo_scope_evidence,source(entry),''];
 });
 return '\uFEFF'+[bidHeaders,...rows].map(row=>row.map(quote).join(',')).join('\r\n')+'\r\n';
}

export async function qualifiedBids(email,store=bidReportStore(),date=new Date()) {
 const state=await store.get(hash(email.toLowerCase())+'/report',{type:'json'});
 if (!state?.complete) return null;
 const today=dayInCalifornia(date);
 return state.summary.leads.filter(entry=>entry.status==='qualified'&&entry.lead&&entry.project&&entry.gc&&
  qualify(entry.lead,today,entry.distance)[0]==='qualified');
}

export function bidImportSettings(env) {
 try {
  const url=new URL('/.netlify/functions/inbox-lead-booking',env.ESTIMATING_DESK_URL);
  const secret=env.ESTIMATING_DESK_IMPORT_SECRET?.trim();
  return url.protocol==='https:'&&!url.username&&!url.password&&secret?.length>=32?{url:url.href,secret}:null;
 } catch {return null;}
}

const singleKey=(email,id)=>'single/'+hash(JSON.stringify([email.toLowerCase(),id]));
const validMailId=id=>typeof id==='string'&&/^INBOX:\d{1,20}:[1-9]\d{0,9}$/i.test(id);
export async function oneEmailBids(email,id,store=bidReportStore(),date=new Date()) {
 if (!validMailId(id)) return null;
 const stored=await store.get(singleKey(email,id),{type:'json'});
 const batch=await qualifiedBids(email,store,date);
 const leads=new Map([...batch?.filter(entry=>entry.sourceMessageId===id)||[],...stored?.leads||[]]
  .filter(entry=>entry.status==='qualified'&&entry.project&&entry.gc&&qualify(entry.lead,dayInCalifornia(date),entry.distance)[0]==='qualified')
  .map(entry=>[leadId(entry),entry]));
 return batch||stored?[...leads.values()]:null;
}

export async function inspectBidEmail({email,id,mailbox,env,store=bidReportStore(),fetcher=fetch}) {
 if (!validMailId(id)) return {status:400,error:'Select an Inbox email.'};
 const metadata=await mailbox.messageInfo(id);
 if (!metadata||metadata.flags?.includes('\\Deleted')) return {status:404,error:'This email is no longer in the Inbox.'};
 if (!metadata.date||Date.parse(metadata.date)<Date.now()-30*86400000) {
  return {status:400,error:'This email is outside the 30-day bid scan window.'};
 }
 let state,version=0;
 const probe={
  async getWithMetadata(){return state?{data:state,etag:String(version)}:null;},
  async setJSON(_key,data){state=data;return {modified:true,etag:String(++version)};},
 };
 const summary=await dryRunBidLeads({
  email,mailbox:{recentInbox:async()=>[metadata],body:(...args)=>mailbox.body(...args)},
  config:bidLeadConfig(env),store:probe,fetcher,
 });
 await store.setJSON(singleKey(email,id),{leads:summary.leads,counts:summary.counts,reasons:summary.reasons});
 return {status:200,counts:summary.counts,reasons:summary.reasons};
}

export async function currentQualifiedBids(email,env,store=bidReportStore(),fetcher=fetch) {
 const entries=await qualifiedBids(email,store);
 if (!entries?.length) return entries;
 const {desk}=bidLeadConfig(env);
 if (!desk) throw new Error('Estimating Desk lookup is unavailable.');
 const {records}=await readDesk(desk,fetcher);
 const direct=new Set(records.map(item=>JSON.stringify([item.project,item.gc])));
 const groups=new Map();
 for (const {project,gc} of records) {
  if (!groups.has(project)) groups.set(project,new Set());
  if (gc) groups.get(project).add(gc);
 }
 return entries.filter(entry=>!direct.has(JSON.stringify([entry.project,entry.gc])))
  .map(entry=>({...entry,multipleGcsBidding:entry.multipleGcsBidding||
   [...(groups.get(entry.project)||[])].some(gc=>gc!==entry.gc)}));
}

export function bidPreview(entry) {
 const {lead}=entry;
 return {id:leadId(entry),project:lead.project_name||bidAddress(lead),address:bidAddress(lead),
  company:lead.gc_company,date:lead.due_date,contact:[lead.first_name,lead.last_name].filter(Boolean).join(' '),
  email:lead.email,phone:lead.phone,multipleGcs:entry.multipleGcsBidding};
}

export async function bookQualifiedBid({email,id,message,env,store=bidReportStore(),fetcher=fetch}) {
 const settings=bidImportSettings(env);
 const {desk}=bidLeadConfig(env);
 if (!settings||!desk) return {status:503,error:'Estimating Desk booking is not configured.'};
 if (typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)) return {status:400,error:'Invalid lead selection.'};
 const entries=message ? await oneEmailBids(email,message,store) : await qualifiedBids(email,store);
 const entry=entries?.find(value=>leadId(value)===id);
 if (!entry) return {status:404,error:'This lead is no longer qualified. Refresh the report.'};
 const {records}=await readDesk(desk,fetcher);
 if (records.some(item=>item.project===entry.project&&item.gc===entry.gc)) {
  return {status:409,error:'This project and GC are already on the Estimating Desk.'};
 }
 const key='booking/'+hash(desk.locationId+':'+id);
 const reserved=await store.setJSON(key,{status:'pending',at:new Date().toISOString()},{onlyIfNew:true});
 if (!reserved.modified) return {status:409,error:'A booking was already attempted. Check the Estimating Desk before trying again.'};
 const {lead}=entry;
 try {
  const result=await fetcher(settings.url,{
   method:'POST',headers:{Authorization:'Bearer '+settings.secret,'Content-Type':'application/json'},
   signal:AbortSignal.timeout(18000),
   body:JSON.stringify({
    requestedBy:email,id,locationId:desk.locationId,address:bidAddress(lead),projectName:lead.project_name||'',
    dueDate:lead.due_date,companyName:lead.gc_company,firstName:lead.first_name||'',lastName:lead.last_name||'',
    email:lead.email||'',phone:lead.phone||'',contactType:deskName(lead),planhubLink:lead.planhub_link||'',
    photosLink:lead.photos_link||'',multipleGcs:Boolean(entry.multipleGcsBidding||records.some(item=>item.project===entry.project&&item.gc&&item.gc!==entry.gc)),
   }),
  });
  if ([400,401,403,404].includes(result.status)) {
   // The booking bridge performs these checks before dispatching any write.
   await store.delete(key);
   return {status:result.status===403?403:502,error:result.status===403?'This mailbox user has no Estimating Desk access.':'Estimating Desk booking could not be authorized. Check its configuration.'};
  }
  if (!result.ok||(await result.json()).ok!==true) throw new Error('Booking not confirmed');
  await store.setJSON(key,{status:'accepted',at:new Date().toISOString()},{onlyIfMatch:reserved.etag});
  return {status:202,accepted:true};
 } catch {
  // Keep the reservation if the remote side might already have acted.
  return {status:502,error:'Booking was not confirmed. Check the Estimating Desk before attempting another import.'};
 }
}
