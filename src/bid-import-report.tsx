import {useEffect,useState} from 'react';
import {ClipboardList,RotateCcw} from 'lucide-react';
import {hostedRequest} from './hosted';
import {QualifiedBids} from './qualified-bids';

type Report={
 complete:boolean;asOf:string;totalMessages:number;counts:{messagesScanned:number;candidates:number;qualified:number;needsReview:number;skipped:number};
 reasons:Record<string,number>;skipped:{uid:number;subject:string;reason:string}[];
};

const descriptions:Record<string,string>={
 already_on_desk:'Already on Estimating Desk',no_existing_lead:'Update had no existing lead',
 public_work:'Public work',no_demo_scope:'Demolition scope missing',past_or_near_due:'Due date missing or too close',
 contact_locked:'Contact locked',wrong_lead_type:'Unsupported lead type',ti_too_large:'TI is 10,000 SF or larger',
 out_of_radius:'More than 30 miles away',no_bid_invite:'No bid invite found',
};
const reasonLabel=(reason:string)=>descriptions[reason]||reason.replaceAll('_',' ');

export function BidImportReport({token}:{token:string}) {
 const [version,setVersion]=useState(0);
 const [report,setReport]=useState<Report|null>(null);
 const [pending,setPending]=useState(true);
 const [failed,setFailed]=useState(false);
 const [scan,setScan]=useState('');
 const [starting,setStarting]=useState(false);
 useEffect(()=>{
  const controller=new AbortController();
  setPending(true);
  setFailed(false);
  void hostedRequest('bid-import-report',undefined,token,controller.signal).then(data=>{
   if (!controller.signal.aborted) setReport(data.report);
  }).catch(()=>{
   if (!controller.signal.aborted) setFailed(true);
  }).finally(()=>{
   if (!controller.signal.aborted) setPending(false);
  });
  return ()=>controller.abort();
 },[token,version]);

 async function runScan() {
  setStarting(true);setScan('');
  try {
   await hostedRequest('bid-scan',{fresh:report?.complete===true},token);
   setScan('Scan queued. Refresh the report to check progress.');
  } catch(error) {setScan(error instanceof Error?error.message:'The scan could not be queued.');}
  finally {setStarting(false);}
 }

 return <><section className="queue bid-import-report">
  <header><ClipboardList size={17}/><h2>Skipped auto import</h2>
   <button type="button" className="icon" aria-label="Refresh bid import report" onClick={()=>setVersion(value=>value+1)} disabled={pending}><RotateCcw size={16}/></button>
  </header>
  <button className="project-tag bid-scan" type="button" disabled={starting||pending} onClick={()=>void runScan()}>{report&&!report.complete?'Resume bid scan':'Scan last 30 days'}</button>
  {scan&&<p role="status">{scan}</p>}
  {pending&&<p role="status">Loading bid import report…</p>}
  {failed&&<p role="alert">Could not load the bid import report.</p>}
  {!pending&&!failed&&!report&&<p>No dry run has been recorded for this mailbox.</p>}
  {report&&<>
   <p>{report.complete?'Dry run complete':'Dry run checkpoint'} · {report.counts.messagesScanned} of {report.totalMessages} messages scanned · {report.counts.skipped} skipped</p>
   <p>{report.counts.candidates} candidates · {report.counts.qualified} qualified · {report.counts.needsReview} need review</p>
   {Object.entries(report.reasons).length>0&&<ul>{Object.entries(report.reasons).map(([reason,count])=><li key={reason}>{reasonLabel(reason)} ({count})</li>)}</ul>}
   {report.skipped.length>0&&<details><summary>Skipped messages ({report.skipped.length})</summary>
    <ul>{report.skipped.map((item,index)=><li key={item.uid+':'+index}><strong>{item.subject}</strong> · {reasonLabel(item.reason)}</li>)}</ul>
   </details>}
  </>}
 </section><QualifiedBids token={token} reportVersion={version}/></>;
}
