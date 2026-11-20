import {useEffect,useState} from 'react';
import {ClipboardList,RotateCcw,Search} from 'lucide-react';
import {hostedRequest} from './hosted';
import {QualifiedBids} from './qualified-bids';

type Report={
 complete:boolean;retryable?:number;asOf:string;totalMessages:number;counts:{messagesScanned:number;candidates:number;qualified:number;needsReview:number;skipped:number};
 review?:{uid:number;subject:string;reason:string}[];reasons:Record<string,number>;skipped:{uid:number;subject:string;reason:string}[];
};

type Activity={status:'running'|'complete'|'failed'|'paused';at:string;reason?:string};
const failures:Record<string,string>={
 bid_lead_credentials_missing:'Configure the HighLevel contact token and at least one AI provider.',
 bid_lead_provider_configuration:'Check the AI provider key and model access.',
 bid_lead_provider_outage:'The AI providers failed on consecutive groups of emails. Progress is saved. Resume to try again.',
 highlevel_http_401:'HighLevel rejected the current PIT.',
 highlevel_http_403:'Check the HighLevel PIT read scopes.',
 geocode_origin_unavailable:'The distance service could not resolve the Costa Mesa starting point.',
 mailbox_read_failed:'IONOS could not complete the read. Resume to retry.',
};
const descriptions:Record<string,string>={
 already_on_desk:'Already on Estimating Desk',no_existing_lead:'Update had no existing lead',
 public_work:'Public work',no_demo_scope:'Demolition scope missing',past_or_near_due:'Due date missing or too close',
 contact_locked:'Contact locked',wrong_lead_type:'Unsupported lead type',ti_too_large:'TI is 10,000 SF or larger',
 out_of_radius:'More than 30 miles away',no_bid_invite:'No bid invite found',
 owner_unverified:'Private owner could not be verified',gc_missing:'GC missing',size_unknown:'Commercial TI size missing',
 distance_unverified:'Distance could not be verified',message_unavailable:'Message was unavailable on IONOS',
 ai_review_unavailable:'AI review could not finish. Retry this item.',message_read_failed:'Message read failed. Retry this item.',
};
const reasonLabel=(reason:string)=>descriptions[reason]||reason.replaceAll('_',' ');

export function BidImportReport({token}:{token:string}) {
 const [version,setVersion]=useState(0);
 const [report,setReport]=useState<Report|null>(null);
 const [pending,setPending]=useState(true);
 const [failed,setFailed]=useState(false);
 const [scan,setScan]=useState('');
 const [activity,setActivity]=useState<Activity|null>(null);
 const [queuedAt,setQueuedAt]=useState(0);
 const [starting,setStarting]=useState(false);
 useEffect(()=>{
  const controller=new AbortController();
  setPending(true);
  setFailed(false);
  void hostedRequest('bid-import-report',undefined,token,controller.signal).then(data=>{
   if (!controller.signal.aborted) {
    setReport(data.report);
    setActivity(data.activity||null);
    if (queuedAt&&data.activity&&Date.parse(data.activity.at)>=queuedAt-1000) {
     setQueuedAt(0);
     setScan('');
    } else if (queuedAt&&Date.now()-queuedAt>60000) {
     setQueuedAt(0);
     setScan('The scan did not start. Try again or check the background function log.');
    }
   }
  }).catch(()=>{
   if (!controller.signal.aborted) setFailed(true);
  }).finally(()=>{
   if (!controller.signal.aborted) setPending(false);
  });
  return ()=>controller.abort();
 },[token,version,queuedAt]);
 const watching=activity?.status==='running'||queuedAt>0;
 useEffect(()=>{
  if (!watching) return;
  const id=window.setInterval(()=>setVersion(value=>value+1),4000);
  return ()=>window.clearInterval(id);
 },[watching]);

 async function runScan() {
  setStarting(true);setScan('');
  try {
   const requested=Date.now();
   await hostedRequest('bid-scan',{fresh:report?.complete===true&&!report.retryable},token);
   setQueuedAt(requested);
   setScan('Scan queued. This report updates automatically.');
  } catch(error) {setScan(error instanceof Error?error.message:'The scan could not be queued.');}
  finally {setStarting(false);}
 }

 return <><section className="queue bid-import-report">
  <header><ClipboardList size={17}/><h2>Skipped auto import</h2>
   <button type="button" className="project-tag bid-action" onClick={()=>setVersion(value=>value+1)} disabled={pending}>
    <RotateCcw size={15} aria-hidden="true"/> Refresh report
   </button>
  </header>
  <div className="bid-scan-actions">
   <button className="send bid-action bid-action-primary" type="button" disabled={starting||pending||watching} onClick={()=>void runScan()}>
    <Search size={16} aria-hidden="true"/>
    {watching?'Scan in progress':starting?'Starting scan…':report&&!report.complete?'Resume bid scan':report?.retryable?'Retry AI reviews':'Find bid leads'}
   </button>
   <span>Last 30 days of Inbox mail</span>
  </div>
  {scan&&<p role="status">{scan}</p>}
  {activity?.status==='running'&&<p role="status">Reviewing likely bid emails, newest first…</p>}
  {activity?.status==='paused'&&<p role="status">Progress saved. Resume bid scan to continue.</p>}
  {activity?.status==='failed'&&<p role="alert">{failures[activity.reason||'']||'The scan stopped. Check the background function log, then resume.'}</p>}
  {pending&&!report&&!watching&&<p role="status">Loading bid import report…</p>}
  {failed&&<p role="alert">Could not load the bid import report.</p>}
  {!pending&&!failed&&!report&&<p>No dry run has been recorded for this mailbox.</p>}
  {report&&<>
   <p>{report.complete?'Scan complete':watching?'Scan in progress':'Progress saved'} · {report.counts.messagesScanned} of {report.totalMessages} messages checked · {report.counts.skipped} skipped</p>
   {!report.complete&&report.totalMessages>0&&<progress className="bid-scan-progress" aria-label="Bid scan progress"
    value={Math.min(report.counts.messagesScanned,report.totalMessages)} max={report.totalMessages}/> }
   <p>{report.counts.candidates} candidates · {report.counts.qualified} qualified · {report.counts.needsReview} need review</p>
   {Object.entries(report.reasons).length>0&&<ul>{Object.entries(report.reasons).map(([reason,count])=><li key={reason}>{reasonLabel(reason)} ({count})</li>)}</ul>}
   {!!report.retryable&&<p>{report.retryable} reviews can be retried. Completed results are kept.</p>}
   {!!report.review?.length&&<details><summary>Needs review ({report.review.length})</summary>
    <ul>{report.review.map((item,index)=><li key={item.uid+':'+index}><strong>{item.subject}</strong> · {reasonLabel(item.reason)}</li>)}</ul>
   </details>}
   {report.skipped.length>0&&<details><summary>Skipped messages ({report.skipped.length})</summary>
    <ul>{report.skipped.map((item,index)=><li key={item.uid+':'+index}><strong>{item.subject}</strong> · {reasonLabel(item.reason)}</li>)}</ul>
   </details>}
  </>}
 </section><QualifiedBids token={token} reportVersion={report?.complete?Date.parse(report.asOf):0}/></>;
}
