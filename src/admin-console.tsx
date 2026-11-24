import {useEffect,useState,type FormEvent} from 'react';
import {RotateCcw,X} from 'lucide-react';
import {TeamAccess} from './team-access';
import {categories} from './model.mjs';

type Request=(path:string,body?:object)=>Promise<any>;
type Keyword={id:string;term:string;category:string;field:'subject'|'any';addedBy:string;addedAt:string};
type Counts=Record<string,number>;
type Activity={days:number;events:{at:string;action:string;email:string}[];users:{email:string;lastSeen:string;counts:Counts}[];
 daily:({date:string}&Counts)[];team:{email:string;name:string;status:string;admin:boolean}[]};
type Health={checkedAt:string;checks:{name:string;status:'ok'|'warn'|'fail';detail:string;ms:number}[]};
type Tab='team'|'keywords'|'activity'|'health';

const actionLabels:Record<string,string>={'sign-in':'Signed in','sign-in-failed':'Failed sign-in','ghl-sign-in':'HighLevel sign-in',
 open:'Opened inbox',send:'Sent email','ask-ai':'Asked AI',export:'Exported CSV','bid-scan':'Started bid scan',team:'Changed team access',
 keywords:'Changed sorting keywords',error:'Server error'};
const when=(value:string)=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const errorText=(error:unknown,fallback:string)=>error instanceof Error?error.message:fallback;

function Keywords({request}:{request:Request}) {
 const [keywords,setKeywords]=useState<Keyword[]|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 useEffect(()=>{request('admin-keywords').then(data=>setKeywords(data.keywords)).catch(failure=>setError(errorText(failure,'Could not load keywords.')));},[]);
 async function change(body:object) {
  setBusy(true);setError('');
  try {setKeywords((await request('admin-keywords',body)).keywords);return true;}
  catch(failure) {setError(errorText(failure,'Keywords did not save.'));return false;}
  finally {setBusy(false);}
 }
 async function add(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form=event.currentTarget;
  const fields=new FormData(form);
  if (await change({op:'add',term:fields.get('term'),category:fields.get('category'),field:fields.get('field')})) form.reset();
 }
 const grouped=categories.map(category=>[category,(keywords||[]).filter(item=>item.category===category)] as const).filter(([,items])=>items.length);
 return <div className="signature-fields">
  <form className="team-onboard" onSubmit={add}>
   <b>Add a sorting keyword</b>
   <p>Keywords run before the built-in rules and the AI sorter, for every mailbox. Use General to keep a phrase out of the other categories. New mail uses them within 30 seconds. Refresh the inbox to re-sort loaded mail.</p>
   <label>Keyword or phrase<input name="term" required minLength={2} maxLength={80} placeholder="e.g. pricing due, planhub, Swinerton" disabled={busy}/></label>
   <label>Sort into<select name="category" defaultValue="Bid Invitations" disabled={busy}>{categories.map(category=><option key={category}>{category}</option>)}</select></label>
   <label>Match in<select name="field" defaultValue="subject" disabled={busy}><option value="subject">Subject only</option><option value="any">Subject or message text</option></select></label>
   <button className="send" disabled={busy}>{busy?'Saving…':'Add keyword'}</button>
  </form>
  {error&&<p role="alert">{error}</p>}
  {!keywords&&!error&&<p role="status">Loading keywords…</p>}
  {keywords&&!keywords.length&&<p>No custom keywords yet.</p>}
  {grouped.map(([category,items])=><section key={category} className="keyword-group"><b>{category} ({items.length})</b>
   <ul className="keyword-list">{items.map(item=><li key={item.id}>
    <span><b>{item.term}</b> <small>{item.field==='any'?'subject or text':'subject'} · added by {item.addedBy}</small></span>
    <button type="button" className="project-tag" disabled={busy} aria-label={'Remove '+item.term} onClick={()=>void change({op:'remove',id:item.id})}>Remove</button>
   </li>)}</ul>
  </section>)}
 </div>;
}

function ActivityView({request}:{request:Request}) {
 const [data,setData]=useState<Activity|null>(null);
 const [days,setDays]=useState(7);
 const [error,setError]=useState('');
 function load(span=days) {
  setError('');
  request('admin-activity&days='+span).then(setData).catch(failure=>setError(errorText(failure,'Could not load activity.')));
 }
 useEffect(()=>load(days),[days]);
 const total=(key:string)=>(data?.daily||[]).reduce((sum,row)=>sum+(row[key]||0),0);
 const name=(email:string)=>data?.team.find(user=>user.email===email)?.name||email;
 const idle=(data?.team||[]).filter(user=>user.status==='active'&&!data?.users.some(item=>item.email===user.email));
 return <div className="signature-fields">
  <div className="admin-toolbar">
   <label>Period<select value={days} onChange={event=>setDays(Number(event.target.value))}>{[1,7,14,30].map(value=><option key={value} value={value}>{value===1?'Today':'Last '+value+' days'}</option>)}</select></label>
   <button type="button" className="project-tag" onClick={()=>load()}><RotateCcw size={14}/> Refresh</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  {!data&&!error&&<p role="status">Loading activity…</p>}
  {data&&<>
   <div className="admin-stats">
    {[['Active users',String(data.users.filter(user=>user.counts.open||user.counts['sign-in']||user.counts['ghl-sign-in']).length)],
      ['Emails sent',String(total('send'))],['AI questions',String(total('ask-ai'))],['CSV exports',String(total('export'))],
      ['Failed sign-ins',String(total('sign-in-failed'))],['Server errors',String(total('error'))]].map(([label,value])=>
     <div key={label} className={label==='Server errors'&&value!=='0'||label==='Failed sign-ins'&&Number(value)>4?'admin-stat warn':'admin-stat'}><b>{value}</b><small>{label}</small></div>)}
   </div>
   <b>Users</b>
   <table className="admin-table"><thead><tr><th>User</th><th>Last active</th><th>Opens</th><th>Sent</th><th>AI</th><th>Exports</th></tr></thead>
    <tbody>{data.users.map(user=><tr key={user.email}><td title={user.email}>{name(user.email)}</td><td>{when(user.lastSeen)}</td>
     <td>{user.counts.open}</td><td>{user.counts.send}</td><td>{user.counts['ask-ai']}</td><td>{user.counts.export}</td></tr>)}
     {idle.map(user=><tr key={user.email} className="admin-idle"><td title={user.email}>{user.name}</td><td>No activity</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>)}</tbody></table>
   <b>By day</b>
   <table className="admin-table"><thead><tr><th>Date</th><th>Sign-ins</th><th>Opens</th><th>Sent</th><th>AI</th><th>Errors</th></tr></thead>
    <tbody>{data.daily.map(row=><tr key={row.date}><td>{row.date}</td><td>{(row['sign-in']||0)+(row['ghl-sign-in']||0)}</td><td>{row.open}</td><td>{row.send}</td><td>{row['ask-ai']}</td><td>{row.error}</td></tr>)}</tbody></table>
   <b>Recent events</b>
   <ul className="admin-events">{data.events.slice(0,60).map((event,index)=><li key={index} className={event.action==='error'||event.action==='sign-in-failed'?'warn':''}>
    <small>{when(event.at)}</small> {name(event.email)||'Unknown'} · {actionLabels[event.action]||event.action}</li>)}</ul>
   <small>Opens are counted at most once per 10 minutes per user. Activity is kept for 30 days.</small>
  </>}
 </div>;
}

function HealthView({request}:{request:Request}) {
 const [data,setData]=useState<Health|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 async function run() {
  setBusy(true);setError('');
  try {setData(await request('admin-health'));}
  catch(failure) {setError(errorText(failure,'Health checks could not run.'));}
  finally {setBusy(false);}
 }
 const [sortNote,setSortNote]=useState('');
 async function sortNow() {
  setSortNote('Starting…');
  try {await request('admin-sort-now',{});setSortNote('AI sorting started for every mailbox. Run checks again in a few minutes to see the result.');}
  catch(failure) {setSortNote(errorText(failure,'AI sorting could not start.'));}
 }
 useEffect(()=>{void run();},[]);
 const summary=data?(['fail','warn','ok'] as const).map(status=>[status,data.checks.filter(check=>check.status===status).length] as const):[];
 return <div className="signature-fields">
  <div className="admin-toolbar">
   <span>{data?summary.map(([status,count])=>count+' '+(status==='ok'?'passing':status==='warn'?(count===1?'warning':'warnings'):'failing')).join(' · '):''}</span>
   <span className="admin-actions">
    <button type="button" className="project-tag" onClick={()=>void sortNow()}>Run AI sorting now</button>
    <button type="button" className="project-tag" disabled={busy} onClick={()=>void run()}><RotateCcw size={14}/> {busy?'Checking…':'Run checks'}</button>
   </span>
  </div>
  {sortNote&&<p role="status">{sortNote}</p>}
  <small>AI sorting runs automatically at 9 AM and 3 PM Pacific for every active mailbox with a saved password.</small>
  {error&&<p role="alert">{error}</p>}
  {busy&&!data&&<p role="status">Running health checks…</p>}
  {data&&<ul className="admin-health">{data.checks.map(check=><li key={check.name} className={'health-'+check.status}>
   <span className="health-dot" aria-hidden="true"/><div><b>{check.name}</b><small>{check.detail}</small></div>
   <small>{check.status==='ok'?'OK':check.status==='warn'?'Warning':'Failing'} · {check.ms} ms</small></li>)}</ul>}
  {data&&<small>Checked {when(data.checkedAt)}. Checks use your mailbox and the server keys. No secrets are shown.</small>}
 </div>;
}

export function AdminConsole({request,self,onClose,onChanged}:{request:Request;self:string;onClose:()=>void;onChanged?:()=>void}) {
 const [tab,setTab]=useState<Tab>('team');
 const tabs:[Tab,string][]=[['team','Team'],['keywords','Sorting keywords'],['activity','Activity and stats'],['health','Health checks']];
 return <div className="modal-back centered" onClick={onClose}>
  <section className="signature-settings admin-console" role="dialog" aria-modal="true" aria-label="Admin console" onClick={event=>event.stopPropagation()}
   onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
   <header><b>Admin console</b><button type="button" className="icon" title="Close admin console" onClick={onClose}><X size={19}/></button></header>
   <div className="team-tabs admin-tabs" role="tablist">{tabs.map(([value,label])=><button key={value} type="button" role="tab" aria-selected={tab===value}
    className={'project-tag'+(tab===value?' active':'')} onClick={()=>setTab(value)}>{label}</button>)}</div>
   {tab==='team'&&<TeamAccess embedded request={request} self={self} onClose={onClose} onChanged={onChanged}/>}
   {tab==='keywords'&&<Keywords request={request}/>}
   {tab==='activity'&&<ActivityView request={request}/>}
   {tab==='health'&&<HealthView request={request}/>}
  </section>
 </div>;
}
