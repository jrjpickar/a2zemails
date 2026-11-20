import {useEffect,useRef,useState} from 'react';
import {Download} from 'lucide-react';
import {hostedEndpoint,hostedRequest,rememberedSession} from './hosted';

type Lead={id:string;project:string;address:string;company:string;date:string;contact:string;email:string;phone:string;multipleGcs:boolean};
type Data={complete:boolean;bookingEnabled:boolean;total:number;leads:Lead[]};

export function QualifiedBids({token,message,reportVersion=0}:{token:string;message?:string;reportVersion?:number}) {
 const [open,setOpen]=useState(!message);
 const [page,setPage]=useState(0);
 const [data,setData]=useState<Data>();
 const [error,setError]=useState('');
 const [inspection,setInspection]=useState('');
 const [revision,setRevision]=useState(0);
 const [pending,setPending]=useState(false);
 const [booked,setBooked]=useState<Set<string>>(new Set());
 const [selected,setSelected]=useState<Lead>();
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  if (!open) return;
  const controller=new AbortController();
  setError('');
  const action='bid-qualified&page='+page+(message?'&message='+encodeURIComponent(message):'');
  void hostedRequest(action,undefined,token,controller.signal).then(setData).catch(error=>{
   if (!controller.signal.aborted) setError(error.message);
  });
  return ()=>controller.abort();
 },[token,open,message,page,reportVersion,revision]);

 async function exportCsv() {
  setPending(true);setError('');
  try {
   const response=await fetch(hostedEndpoint+'?action=bid-qualified-csv',{
    cache:'no-store',headers:{Authorization:token===rememberedSession?token:'Bearer '+token},
   });
   if (!response.ok) throw new Error((await response.json().catch(()=>null))?.error||'Could not export the CSV.');
   const url=URL.createObjectURL(await response.blob());
   const link=document.createElement('a');
   link.href=url;
   link.download=response.headers.get('content-disposition')?.match(/filename="(a2z-leads-[\d-]+\.csv)"/)?.[1]||'a2z-leads.csv';
   document.body.append(link);
   link.click();
   link.remove();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch(error) {setError(error instanceof Error?error.message:'Could not export the CSV.');}
  finally {setPending(false);}
 }

 async function inspect() {
  if (!message||pending) return;
  setPending(true);setError('');setInspection('');
  try {
   const result=await hostedRequest('bid-inspect',{id:message},token);
   setInspection(result.counts.qualified?'Qualified lead found.':result.counts.needsReview?
    'The lead needs review before it can be imported.':
    (Object.keys(result.reasons).map(reason=>reason.replaceAll('_',' ')).join(', ')||'This email did not match the bid filters.'));
   setRevision(value=>value+1);
  } catch(error) {setError(error instanceof Error?error.message:'The email scan could not complete.');}
  finally {setPending(false);}
 }

 async function confirm() {
  if (!selected||pending) return;
  setPending(true);setError('');
  try {
   await hostedRequest('bid-book',{id:selected.id,message},token);
   setBooked(previous=>new Set([...previous,selected.id]));
   dialog.current?.close();
  } catch(error) {setError(error instanceof Error?error.message:'Booking was not confirmed.');}
  finally {setPending(false);}
 }

 return <section className={message?'qualified-bids':'queue qualified-bids'}>
  {message?<button type="button" className="project-tag" onClick={()=>setOpen(value=>!value)} aria-expanded={open}>Add to Estimating Desk</button>:
   <header><h2>Qualified bid leads</h2>{data?.complete&&<button type="button" className="project-tag" disabled={pending} onClick={()=>void exportCsv()}><Download size={15}/> Download CSV</button>}</header>}
  {open&&<>
   {!data&&!error&&<p role="status">Loading qualified leads…</p>}
   {message&&<button type="button" className="project-tag" disabled={pending} onClick={()=>void inspect()}>{pending?'Working…':'Qualify this email'}</button>}
   {inspection&&<p role="status">{inspection}</p>}
   {data&&!data.complete&&!message&&<p>Complete a bid scan from Command Center first.</p>}
   {data?.complete&&data.total===0&&<p>{message?'No qualified lead from this email is in the completed scan.':'No qualified leads in the completed scan.'}</p>}
   {data?.leads.map(lead=><div key={lead.id} className="qualified-bid-row">
    <div><strong>{lead.project}</strong><small>{lead.company} · {lead.address} · Due {lead.date}</small></div>
    {booked.has(lead.id)?<span role="status">Booking accepted</span>:data.bookingEnabled&&
     <button type="button" className="project-tag" disabled={pending} onClick={()=>{setError('');setSelected(lead);dialog.current?.showModal();}}>Review and add</button>}
   </div>)}
   {data?.complete&&data.total>25&&<div className="qualified-bid-pages">
    <button type="button" className="project-tag" disabled={page===0} onClick={()=>setPage(value=>value-1)}>Previous</button>
    <span>Page {page+1} of {Math.ceil(data.total/25)}</span>
    <button type="button" className="project-tag" disabled={(page+1)*25>=data.total} onClick={()=>setPage(value=>value+1)}>Next</button>
   </div>}
  </>}
  {error&&<p role="alert">{error}</p>}
  <dialog ref={dialog} className="ask-ai-dialog" aria-label="Review Estimating Desk booking">
   <header><strong>Add to Estimating Desk</strong></header>
   {selected&&<dl>
    <dt>Project</dt><dd>{selected.project}</dd><dt>Job address</dt><dd>{selected.address}</dd>
    <dt>GC</dt><dd>{selected.company}</dd><dt>Bid due</dt><dd>{selected.date}</dd>
    <dt>Contact</dt><dd>{[selected.contact,selected.email,selected.phone].filter(Boolean).join(' · ')||'No contact details found'}</dd>
   </dl>}
   {error&&<p role="alert">{error}</p>}
   <div className="qualified-bid-pages">
    <button type="button" className="project-tag" disabled={pending} onClick={()=>dialog.current?.close()}>Cancel</button>
    <button type="button" className="send" disabled={pending} onClick={()=>void confirm()}>{pending?'Booking…':'Confirm and add'}</button>
   </div>
  </dialog>
 </section>;
}
