/// <reference types="vite/client" />
import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LayoutDashboard,ClipboardList,FolderKanban,Calculator,FileQuestion,HardHat,Receipt,Inbox,Send,FileText,Archive,Trash2,ShieldAlert,Plus,Search,SlidersHorizontal,PanelLeft,ChevronDown,ChevronLeft,Star,Paperclip,Reply,ReplyAll,Forward,MoreHorizontal,ArrowUpRight,Mail,Clock3,X,Check,Download,RotateCcw,MailOpen,Menu,ArrowRight,Moon,Palette,Settings2} from 'lucide-react';
import {categories,projects,seed,classify,matchProject,searchMail,initialState,threadFor,rowActions,appendSignature,dashboardQueues} from './model.mjs';
import {RecipientInput,type Contact} from './recipient-input';
import {hostedRequest,MailboxLogin} from './hosted';
import './style.css';
import './theme.css';
type Message={id:string;thread:string;name:string;company:string;subject:string;date:string;body:string;files:string[];due?:string;from:string;to:string;cc:string;category:string;project:string;folder:string;unread:boolean;star:boolean;previousFolder?:string;headers:{messageId:string;references:string[]}};
type Draft={id:string;to:string;cc:string;subject:string;body:string;files:string[];thread?:string;parent?:Message;identity:string;includeSignature?:boolean};
type State={mail:Message[];rules:Record<string,string>;drafts:Draft[];signatures?:Record<string,string>};
const samples=seed as Message[];
const demo='operations@a2z.example';
const identities=[demo,'estimating@a2z.example'];
const groups=[
 {label:'WORKSPACE', links:[['Command Center',LayoutDashboard],['Bid Invitations',ClipboardList],['Active Projects',FolderKanban],['Estimating',Calculator],['RFIs & Change Orders',FileQuestion],['Dispatch',HardHat],['Invoices',Receipt]]},
 {label:'MAILBOX',links:[['Inbox',Inbox],['Sent',Send],['Drafts',FileText],['Archive',Archive],['Trash',Trash2],['Spam',ShieldAlert]]}
] as const;
const tags:Record<string,string>={'Bid Invitations':'Bid Invitation','Estimating':'Estimating','RFIs & Change Orders':'RFI / Change Order','Dispatch':'Dispatch','Invoices':'Invoices','General':'General'};
const tones:Record<string,string>={'Bid Invitations':'gold','Estimating':'purple','RFIs & Change Orders':'blue','Dispatch':'green','Invoices':'rose','General':'gray'};
const storageKey='a2z-sandbox-v1';
const liveSignatureKey = 'a2z-ionos-signatures';
const localToken = document.querySelector<HTMLMetaElement>('meta[name="a2z-live-token"]')?.content;
const defaultSignature = 'A2Z Construction Services';

function getState(liveToken?:string):State {
 if (liveToken) {
  let signatures;
  try { signatures = JSON.parse(localStorage.getItem(liveSignatureKey)||'{}'); } catch {}
  return {mail:[],rules:{},drafts:[],signatures};
 }
 try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
   const saved: State = JSON.parse(raw);
   saved.mail = saved.mail.map(message => message.category === 'Billing' ? {...message, category:'Invoices'} : message);
   saved.rules = Object.fromEntries(Object.entries(saved.rules).map(([domain, category]) =>
    [domain, category === 'Billing' ? 'Invoices' : category]));
   return saved;
  }
 } catch {}
 return initialState() as State;
}
async function localRequest(path:string, body?:object) {
 const response = await fetch('/api/ionos/'+path, {
  method:body?'POST':'GET',
  headers:{'X-A2Z-Session':localToken||'', ...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,
  cache:'no-store'
 });
 const data = await response.json();
 if (!response.ok||data.error) throw new Error(data.error || 'Unable to reach IONOS.');
 return data;
}
const day=(v:string)=>new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
const time=(v:string)=>v.slice(0,10)==='2026-11-17'?new Date(v).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric'});
const initials=(name:string)=>name.split(' ').slice(0,2).map(s=>s[0]).join('');
const avatarColors=['sand','lavender','sage','peach','sky'];
function App({liveToken,onSignOut}:{liveToken?:string;onSignOut?:()=>void}){
 const [knownContacts,setKnownContacts]=useState<Contact[]>([]);
 async function liveRequest(path:string, body?:object) {
  if (!onSignOut) return localRequest(path,body);
  try { return await hostedRequest(path,body,liveToken); }
  catch (error) {
   if ((error as {status?:number}).status===401) onSignOut();
   throw error;
  }
 }
 const [state,setState]=useState<State>(()=>getState(liveToken)),[nav,setNav]=useState('Inbox'),[selected,setSelected]=useState('mail-0'),[query,setQuery]=useState(''),[filter,setFilter]=useState('All mail'),[projectFilter,setProjectFilter]=useState(''),[marked,setMarked]=useState<string[]>([]),[compose,setCompose]=useState<string|null>(null),[preview,setPreview]=useState<string|null>(null),[toast,setToast]=useState(''),[menu,setMenu]=useState(''),[mobileRead,setMobileRead]=useState(false),[side,setSide]=useState(false),[help,setHelp]=useState(false),[limit,setLimit]=useState(60);
 const [theme,setTheme]=useState(() => {
  try { return localStorage.getItem('a2z-theme')==='color'?'color':'dark'; }
  catch { return 'dark'; }
 });
 const [signatureForm,setSignatureForm]=useState<Record<string,string>|null>(null);
 const [account,setAccount]=useState('');
 const [connection,setConnection]=useState(liveToken?'Connecting to IONOS…':'');
 const [sending,setSending]=useState(false);
 const sendingRef=React.useRef(false);
 const senderIdentities=liveToken?(account?[account]:[]):identities;
 const signatureFor=(identity:string)=>state.signatures?.[identity] ?? defaultSignature;
 const draftSignature=(d:Draft)=>d.includeSignature===false?'':signatureFor(d.identity);

 useEffect(() => {
  document.documentElement.dataset.theme=theme;
  try { localStorage.setItem('a2z-theme',theme); } catch {}
 },[theme]);

 const refreshing = React.useRef(false);
 async function refreshMailbox() {
  if (refreshing.current) return;
  refreshing.current=true;
  setConnection('Connecting to IONOS…');
  try {
   const data: {email:string;mail:Message[];contacts:Contact[]} = await liveRequest('mail');
   setKnownContacts(data.contacts||[]);
   setAccount(data.email);
   setState(previous=>({...previous,mail:[
    ...data.mail,
    ...previous.mail.filter(message=>message.folder==='Sent' && message.id.startsWith('out-') &&
      !data.mail.some(fetched=>fetched.headers.messageId===message.headers.messageId))
   ]}));
   setSelected(current=>data.mail.some(message=>message.id===current)?current:data.mail[0]?.id||'');
   setConnection('IONOS connected');
  } catch (error) {
   setConnection(error instanceof Error ? error.message : 'Unable to connect to IONOS.');
  } finally {refreshing.current=false;}
 }
 useEffect(()=>{if(liveToken)void refreshMailbox()},[]);
 const mail=state.mail;
 const row=mail.find(m=>m.id===selected);
 const draft=state.drafts.find(d=>d.id===compose);
 const inbox=mail.filter(m=>m.folder==='Inbox');
 const unread=mail.filter(m=>m.unread).length;
 const unreadIncoming=inbox.filter(m=>m.unread).length;
 const queues=dashboardQueues(mail) as Record<'bids'|'urgent'|'unanswered'|'invoices',Message[]>;
 const contacts=liveToken?knownContacts:samples.map(m=>({address:m.from,name:m.name}));
 useEffect(()=>{if(liveToken)return;try{localStorage.setItem(storageKey,JSON.stringify(state))}catch{setToast('Browser storage is full. Changes are available until you reload.')}},[state]);
 useEffect(()=>{if(!toast)return;let id=setTimeout(()=>setToast(''),3200);return()=>clearTimeout(id)},[toast]);
 const list=useMemo(()=>mail.filter(m=>{
  if(query.trim())return searchMail(m,query);
  const inView=nav==='Inbox'||(nav==='Active Projects'
   ? !!m.project && !['Trash','Spam'].includes(m.folder)
   : categories.includes(nav)
    ? m.category===nav && !['Trash','Spam'].includes(m.folder)
    : m.folder===nav);
  return inView&&(!projectFilter||m.project===projectFilter)&&(filter==='All mail'||(filter==='Unread'&&m.unread)||(filter==='Starred'&&m.star)||(filter==='Attachments'&&m.files.length>0)||(filter==='Incoming'&&m.folder==='Inbox'&&m.unread)||(filter==='Urgent'&&queues.urgent.some(item=>item.id===m.id)));
 }).sort((a,b)=>b.date.localeCompare(a.date)),[mail,nav,query,projectFilter,filter]);
 const currentRow=row&&list.some(m=>m.id===row.id)?row:undefined;
 const related=currentRow?threadFor(mail,currentRow) as Message[]:[];
 const newest=related.filter(m=>m.id!==currentRow?.id);
 function go(next:string){setNav(next);setQuery('');setFilter('All mail');setProjectFilter('');setMarked([]);setMenu('');setMobileRead(false);setSide(false);setLimit(60)}
 async function change(ids:string[],patch:Partial<Message>) {
  if (liveToken) {
   const action=patch.folder?'move':patch.unread!==undefined?(patch.unread?'unread':'read'):(patch.star?'star':'unstar');
   try {
    for (const id of ids) await liveRequest('update',{id,action,destination:patch.folder});
    if (patch.folder) await refreshMailbox();
   } catch(error) {
    setToast(error instanceof Error?error.message:'Mailbox action failed.');
    return false;
   }
  }
  setState(s=>({...s,mail:s.mail.map(m=>ids.includes(m.id)?rowActions(m,patch) as Message:m)}));
  return true;
 }
 function open(m:Message){setSelected(m.id);setMobileRead(true);setMenu('');if(m.unread&&filter==='All mail')void change([m.id],{unread:false})}
 async function move(ids:string[],folder:string) {
  setMenu('');
  if (!await change(ids,{folder})) return;
  setMarked([]);setMobileRead(false);
  setToast(folder==='Archive'?'Conversation archived':folder==='Trash'?'Moved to Trash':'Moved to '+folder);
 }
 function start(mode='new',m?:Message){
  if(liveToken&&!account)return;
  const d:Draft={id:crypto.randomUUID(),to:m&&mode!=='Forward'?m.from:'',cc:mode==='Reply all'&&m?[m.to,m.cc].join(', ').split(',').map(s=>s.trim()).filter(s=>s&&!senderIdentities.includes(s)&&s!==m.from).join(', '):'',subject:m?(mode==='Forward'?'Fwd: ':'Re: ')+m.subject.replace(/^(Re: |Fwd: )+/i,''):'',body:mode==='Forward'&&m?'\n\n---------- Forwarded message ----------\nFrom: '+m.from+'\nSubject: '+m.subject+'\n\n'+m.body:'',files:!liveToken&&mode==='Forward'&&m?[...m.files]:[],thread:mode==='Forward'?undefined:m?.thread,parent:mode==='Forward'?undefined:m,identity:account||demo,includeSignature:true};
  setState(s=>({...s,drafts:[...s.drafts,d]}));setCompose(d.id);setMenu('');
 }
 function edit(patch:Partial<Draft>){setState(s=>({...s,drafts:s.drafts.map(d=>d.id===compose?{...d,...patch}:d)}))}
 function discard(id:string){setState(s=>({...s,drafts:s.drafts.filter(d=>d.id!==id)}));setCompose(null);setToast('Draft discarded')}
 async function sendDraft(e:React.FormEvent){
  e.preventDefault();if(!draft||sendingRef.current)return;
  if(!draft.to.split(/[,;]/).some(s=>s.trim())||[draft.to,draft.cc].flatMap(s=>s.split(/[,;]/)).map(s=>s.trim()).filter(Boolean).some(s=>!/^\S+@[^@\s]+\.[^@\s]+$/.test(s))||!draft.subject.trim()||!draft.body.trim()){setToast('Enter valid recipients, a subject, and a message.');return}
  const id='out-'+draft.id;
  const body=appendSignature(draft.body,draftSignature(draft));
  const references=draft.parent?[...draft.parent.headers.references,draft.parent.headers.messageId]:[];
  let messageId='<'+id+'@a2z.example>';
  let rejected: string[] = [];
  let sentSaved=true;
  if(liveToken){
   sendingRef.current=true;
   setSending(true);
   try {
    const result=await liveRequest('send',{to:draft.to,cc:draft.cc,subject:draft.subject,body,references,id});
    messageId=result.messageId;
    rejected=result.rejected;
    sentSaved=result.sentSaved;
   } catch(error){
    setToast(error instanceof Error?error.message:'IONOS could not send this message.');
    return;
   } finally {
    sendingRef.current=false;
    setSending(false);
   }
  }
  const m:Message={id,thread:draft.thread||id,name:'A2Z Construction Services',company:'A2Z',subject:draft.subject,date:new Date().toISOString(),body,files:draft.files,from:draft.identity,to:draft.to,cc:draft.cc,category:classify(draft.subject,draft.body,draft.identity,state.rules),project:draft.parent?.project||matchProject(draft.subject+' '+draft.body),folder:'Sent',unread:false,star:false,headers:{messageId,references}};
  setState(s=>({...s,mail:[m,...s.mail],drafts:s.drafts.filter(d=>d.id!==draft.id)}));setCompose(null);setToast(rejected.length?'IONOS rejected: '+rejected.join(', '):liveToken?(sentSaved?'Message accepted by IONOS':'Message sent. IONOS could not save a copy to Sent.'):'Message sent in sandbox');
  if(!draft.thread){go('Sent');setSelected(id);setMobileRead(true)}
 }
 function receive(){const id=crypto.randomUUID(),s=samples[2];const subject='NTP — Riverside Warehouse field mobilization';const m:Message={...s,id,thread:id,subject,date:new Date().toISOString(),body:'Notice to proceed is approved. Please confirm the mobilization window with field operations.',category:classify(subject,'',s.from,state.rules),project:matchProject(subject),unread:true,star:false,files:[],headers:{messageId:'<'+id+'@a2z.example>',references:[]}};setState(s=>({...s,mail:[m,...s.mail]}));go('Inbox');setToast('Sample email received')}
 useEffect(()=>{function key(e:KeyboardEvent){if(e.key==='Escape'){if(preview)setPreview(null);else if(signatureForm)setSignatureForm(null);else if(compose&&!sending)setCompose(null);else if(help)setHelp(false);else {setMenu('');setMobileRead(false)}return}const editable=(e.target instanceof HTMLElement ? e.target : document.body).closest('input,textarea,select,[contenteditable="true"]');
  if(e.metaKey&&!e.ctrlKey&&!e.altKey){
   const letter=e.key.toLowerCase();
   if(letter==='r'&&e.shiftKey){
    e.preventDefault();
    if(liveToken)void refreshMailbox();
    else {setState(getState());setToast('Sandbox inbox refreshed');}
    return;
   }
   if(!e.shiftKey&&!editable&&!compose&&!preview&&!help&&!signatureForm&&currentRow&&['r','f'].includes(letter)){
    e.preventDefault();
    start(letter==='r'?'Reply':'Forward',currentRow);
   }
   return;
  }
  if((e.target instanceof HTMLElement ? e.target : document.body).matches('input,textarea,select,button')||e.metaKey||e.ctrlKey||e.altKey||compose||preview||help||signatureForm)return;
 if(e.key==='c'){e.preventDefault();start()}if(e.key==='/'){e.preventDefault();document.getElementById('search')?.focus()}if(e.key==='?')setHelp(true);if(e.key==='e'&&currentRow)move([currentRow.id],'Archive');
 }document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)});
 const tag=(m:Message)=><span className={'tag '+tones[m.category]}>{tags[m.category]}</span>;
 const project=projects.find(p=>p.id===currentRow?.project);
 return <div className={'app '+(mobileRead?'reading ':'')+(side?'sidebar-open':'')}>
 {side&&<button className="scrim" aria-label="Close navigation" onClick={()=>setSide(false)}/>}
 <aside className="sidebar">
 <div className="brand"><div className="mark">A<span>2</span>Z</div><div><strong>A2Z Construction</strong><small>OPERATIONS MAIL</small></div></div>
 <button className="compose" disabled={!!liveToken&&!account} onClick={()=>start()}><Plus size={19}/> Compose <kbd>C</kbd></button>
 <div className="nav">{groups.map(g=><section key={g.label}><h2>{g.label}</h2>{g.links.map(([label,Icon])=><button key={label} className={nav===label&&!query?'active':''} onClick={()=>go(label)}><Icon size={16}/><span>{label}</span>{label==='Inbox'&&unread>0&&<b>{unread}</b>}{label==='Drafts'&&state.drafts.length>0&&<b>{state.drafts.length}</b>}</button>)}</section>)}</div>
 <div className="sidebar-end"><div className="env"><i/> {liveToken ? connection : 'Sandbox workspace'}</div><div className="profile"><div className="profile-avatar">OP</div><div><b>Operations</b><small>A2Z Construction</small></div><button title="Keyboard shortcuts" onClick={()=>setHelp(true)}><MoreHorizontal size={17}/></button></div></div>
 </aside>
 <main>
 <header className="topbar"><button className="icon nav-toggle" aria-label="Toggle navigation" onClick={()=>setSide(!side)}><Menu size={20}/></button><div className="crumb"><PanelLeft size={16}/> <span>Workspace</span><span className="slash">/</span><b>{query?'Search':nav}</b></div><div className="search"><Search size={17}/><input id="search" placeholder="Search mail, projects, attachments…" value={query} onChange={e=>{setQuery(e.target.value);setMobileRead(false);setLimit(60)}}/>{query?<button className="icon" title="Clear search" onClick={()=>setQuery('')}><X size={14}/></button>:<kbd>/</kbd>}</div><button className="theme-toggle" aria-label={theme==='dark'?'Switch to color mode':'Switch to dark mode'} onClick={()=>setTheme(theme==='dark'?'color':'dark')}>{theme==='dark'?<Moon size={15}/>:<Palette size={15}/>}<span>{theme==='dark'?'Dark mode':'Color mode'}</span></button><button className="demo-pill" onClick={()=>setMenu(menu==='sandbox'?'':'sandbox')}><i/> {liveToken?'IONOS':'Sandbox'} <ChevronDown size={12}/></button>
 {menu==='sandbox'&&<div className="popover sandbox-menu"><b>{liveToken?'IONOS Mail':'Sandbox mode'}</b><p>{liveToken?(account||connection):'Changes stay in this browser.'}</p>{liveToken?<button onClick={()=>void refreshMailbox()}>Refresh mailbox <kbd>⌘⇧R</kbd></button>:<button onClick={receive}><Inbox size={15}/> Simulate incoming mail</button>}<button disabled={!senderIdentities.length} onClick={()=>{setSignatureForm(Object.fromEntries(senderIdentities.map(identity=>[identity,signatureFor(identity)])));setMenu('')}}><Settings2 size={15}/> Email signatures</button><button onClick={()=>{setHelp(true);setMenu('')}}>Keyboard shortcuts</button>{onSignOut&&<button onClick={onSignOut}>Sign out</button>}</div>}</header>
 {nav==='Command Center'&&!query?<div className="dashboard">
 <h1>Command Center</h1>
 <div className="metrics">{([
  [Mail,'Unread incoming',unreadIncoming,'Incoming'],
  [ClipboardList,'Bid invitations',queues.bids.length,'Bid Invitations'],
  [FileQuestion,'Urgent & unread',queues.urgent.length,'Urgent'],
  [Receipt,'Unread invoice mail',queues.invoices.length,'Invoices'],
 ] as const).map(([Icon,label,n,dest])=><button key={label} onClick={()=>{go(dest==='Incoming'||dest==='Urgent'?'Inbox':dest);if(dest==='Incoming'||dest==='Urgent')setFilter(dest);if(dest==='Invoices')setFilter('Unread')}}><Icon size={20}/><strong>{n}</strong><span>{label}</span><ArrowUpRight size={16}/></button>)}</div>
 <div className="queues">{([
  [Clock3,'Bid deadlines',queues.bids,'No bid invitations in the inbox.'],
  [FileQuestion,'Urgent correspondence',queues.urgent,'No urgent unread mail.'],
  [Reply,'Awaiting a reply',queues.unanswered,'No open requests found.'],
  [Receipt,'Unread invoice mail',queues.invoices,'No unread invoice mail.'],
 ] as const).map(([Icon,label,items,empty])=><section className="queue" key={label}>
  <header><Icon size={17}/><h2>{label}</h2></header>
  {items.length ? items.slice(0,5).map(message=><button className="queue-row" key={message.id} onClick={()=>{go('Inbox');open(message)}}>
   <b>{message.subject}</b><small>{message.company||message.name}{message.due&&<> · <time dateTime={message.due}>Due {day(message.due+'T12:00:00')}</time></>}</small>
  </button>) : <p>{empty}</p>}
 </section>)}</div>
 <section className="activity"><h2>Recent activity</h2>{[...mail].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6).map(m=><button key={m.id} onClick={()=>{go('Inbox');open(m)}}>{tag(m)}<b>{m.subject}</b><span>{m.name}</span><ArrowRight size={16}/></button>)}</section></div>:
 <div className="workspace">
 <section className="message-list">
 <div className="list-head"><div className="eyebrow">{query?'GLOBAL SEARCH':'OPERATIONS MAIL'}</div><h1>{query?'Search results':nav}</h1><p>{nav==='Inbox'&&!query?'All messages across folders and categories.':nav==='Drafts'&&!query?'Pick up where you left off.':query?'Search across all mail folders.':nav==='Invoices'?'Invoices, payments, receipts, and purchase orders.':'Manage your construction correspondence.'}</p>
 {nav==='Active Projects'&&!query&&<select aria-label="Filter by project" value={projectFilter} onChange={e=>setProjectFilter(e.target.value)}><option value="">All projects</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}</div>
 <div className="list-toolbar">{marked.length?<><button onClick={()=>setMarked([])}>{marked.length} selected ×</button><button title="Archive selected" className="icon" onClick={()=>move(marked,'Archive')}><Archive size={16}/></button><button title="Delete selected" className="icon" onClick={()=>move(marked,'Trash')}><Trash2 size={16}/></button></>:<><div className="tabs">{['All mail','Unread'].map(f=><button key={f} className={filter===f?'on':''} onClick={()=>{setFilter(f);setLimit(60)}} disabled={!!query}>{f}{f==='Unread'&&nav==='Inbox'&&<span>{unread}</span>}</button>)}</div><button className={'icon '+(!['All mail','Unread'].includes(filter)?'accent':'')} title="Filter messages" onClick={()=>setMenu(menu==='filters'?'':'filters')}><SlidersHorizontal size={17}/></button></>}
 {menu==='filters'&&<div className="popover filters">{['All mail','Unread','Starred','Attachments','Incoming','Urgent'].map(f=><button key={f} onClick={()=>{setFilter(f);setMenu('')}}>{f}{filter===f&&<Check size={14}/>}</button>)}</div>}</div>
 <div className="rows">
 {nav==='Drafts'&&!query?state.drafts.length?state.drafts.map(d=><button className="draft-row" key={d.id} onClick={()=>setCompose(d.id)}><span className="tag rose">Draft</span><b>{d.subject||'(No subject)'}</b><span>{d.to||'No recipient'}</span></button>):<div className="empty">No drafts yet.</div>:list.length?list.slice(0,limit).map((m,i)=><div key={m.id} className={'mail-row '+(m.id===currentRow?.id?'selected ':'')+(m.unread?'unread':'')}>
 <div className="row-side"><input type="checkbox" disabled={!!liveToken} aria-label={'Select '+m.subject} checked={marked.includes(m.id)} onChange={e=>setMarked(e.target.checked?[...marked,m.id]:marked.filter(x=>x!==m.id))}/><button className={'star '+(m.star?'starred':'')} disabled={!!liveToken&&m.id.startsWith('out-')} title={m.star?'Remove star':'Star message'} onClick={()=>change([m.id],{star:!m.star})}><Star size={14}/></button></div>
 <button className="row-content" onClick={()=>open(m)}><div className="row-top"><span className={'avatar mini '+avatarColors[i%5]}>{initials(m.name)}</span><b>{m.folder==='Sent'?'To: '+m.to:m.name}</b><time>{time(m.date)}</time></div><strong>{m.subject}</strong><p>{m.body.replace(/\s+/g,' ')}</p><div className="row-foot">{tag(m)}{m.folder!=='Inbox'&&<span className="tag gray">{m.folder}</span>}{m.files.length>0&&<span className="paper-count"><Paperclip size={13}/>{m.files.length}</span>}{m.unread&&<i className="unread-dot"/>}</div></button></div>):<div className="empty">No messages match this view.</div>}
 {list.length>limit&&<button className="load" onClick={()=>setLimit(limit+60)}>Load more messages</button>}</div>
 <footer className="list-footer">{nav==='Drafts'&&!query?state.drafts.length+' drafts':list.length+' messages'} <span>•</span> {liveToken?connection:'Local sandbox'}</footer>
 </section>
 <section className="reader">{currentRow?<><div className="reader-tools"><button className="icon back" title="Back to messages" onClick={()=>setMobileRead(false)}><ChevronLeft size={19}/></button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Archive" onClick={()=>move([currentRow.id],'Archive')}><Archive size={18}/></button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Trash" onClick={()=>move([currentRow.id],'Trash')}><Trash2 size={18}/></button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title={currentRow.unread?'Mark read':'Mark unread'} onClick={()=>change([currentRow.id],{unread:!currentRow.unread})}>{currentRow.unread?<MailOpen size={18}/>:<Mail size={18}/>}</button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Move message" onClick={()=>setMenu(menu==='move'?'':'move')}><MoreHorizontal size={20}/></button>{currentRow.folder!=='Inbox'&&currentRow.folder!=='Sent'&&<button className="icon" title="Restore message" onClick={()=>move([currentRow.id],currentRow.previousFolder==='Sent'?'Sent':'Inbox')}><RotateCcw size={17}/></button>}{menu==='move'&&<div className="popover move">{['Inbox','Archive','Trash','Spam'].map(f=><button key={f} onClick={()=>move([currentRow.id],f)}>Move to {f}</button>)}</div>}<span className="tool-space"/><span className="position">{list.findIndex(m=>m.id===currentRow.id)+1} of {list.length}</span><button className="icon next" title="Previous message" disabled={list[0]===currentRow} onClick={()=>{const p=list[list.indexOf(currentRow)-1];if(p)open(p)}}><ChevronLeft size={18}/></button><button className="icon next next-right" title="Next message" disabled={list.at(-1)===currentRow} onClick={()=>{const p=list[list.indexOf(currentRow)+1];if(p)open(p)}}><ChevronLeft size={18}/></button></div>
 <div className="reader-scroll"><div className="reader-content"><div className="subject-line"><h2>{currentRow.subject}</h2><button className={'star '+(currentRow.star?'starred':'')} disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Toggle message star" onClick={()=>change([currentRow.id],{star:!currentRow.star})}><Star size={20}/></button></div><div className="reader-tags">{tag(currentRow)}{project&&<button className="project-tag" onClick={()=>{go('Active Projects');setProjectFilter(project.id)}}><FolderKanban size={13}/>{project.name}</button>}</div>
 <div className="sender"><span className="avatar sand">{initials(currentRow.name)}</span><div><b>{currentRow.name}</b><span className="from"> &lt;{currentRow.from}&gt;</span><small>To: {currentRow.to}{currentRow.cc&&' · Cc: '+currentRow.cc}</small></div><time>{time(currentRow.date)}</time></div>
 {currentRow.due&&<div className="deadline"><div className="deadline-icon"><Clock3 size={19}/></div><div><b>Bid submission deadline</b><span>{day(currentRow.due+'T12:00:00')}</span></div><span className="tag gold">Open bid</span></div>}
 <div className="body">{currentRow.body}</div>
 {!liveToken&&currentRow.files.length>0&&<div className="attachments"><h3><Paperclip size={15}/> Attachments <span>{currentRow.files.length}</span></h3><div>{currentRow.files.map((f,i)=><button key={i} onClick={()=>setPreview(f)}><span className="file-icon"><FileText size={19}/></span><span><b>{f}</b><small>Sandbox attachment</small></span><Download size={16}/></button>)}</div></div>}
 <div className="reply-actions">{([[Reply,'Reply'],[ReplyAll,'Reply all'],[Forward,'Forward']] as const).map(([Icon,label])=><button key={label} onClick={()=>start(label,currentRow)}><Icon size={16}/>{label}</button>)}</div>
 {newest.length>0&&<section className="thread"><h3>Conversation · {related.length} messages</h3>{newest.map(m=><details key={m.id}><summary>{m.name} · {time(m.date)}</summary><p>{m.body}</p>{!liveToken&&m.files.map(f=><button key={f} onClick={()=>setPreview(f)}>{f}</button>)}</details>)}</section>}
 <div className="metadata" hidden={!!liveToken}><label>Project<select value={currentRow.project} onChange={e=>{change([currentRow.id],{project:e.target.value});setToast('Project assignment saved')}}><option value="">Unassigned</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Category<select value={currentRow.category} onChange={e=>{change([currentRow.id],{category:e.target.value});setToast('Category corrected')}}>{categories.map(c=><option key={c}>{c}</option>)}</select></label><button onClick={()=>{const domain=currentRow.from.split('@')[1];setState(s=>({...s,rules:{...s.rules,[domain]:currentRow.category}}));setToast('Rule saved for future messages from '+domain)}}>Remember sender domain rule</button></div>
 </div></div></>:<div className="reader-empty"><Inbox size={29}/><h2>Select a message</h2><p>Open a conversation to read it here.</p></div>}</section>
 </div>}
 </main>
 {draft&&<div className="modal-back" onClick={()=>{if(!sending)setCompose(null)}}><form className="compose-panel" onClick={e=>e.stopPropagation()} onSubmit={sendDraft}><header><b>New message</b><button type="button" className="icon" title="Save and close draft" disabled={sending} onClick={()=>setCompose(null)}><X size={19}/></button></header><label>From<select value={draft.identity} onChange={e=>edit({identity:e.target.value})}>{senderIdentities.map(i=><option key={i}>{i}</option>)}</select></label><RecipientInput label="To" autoFocus value={draft.to} onChange={to=>edit({to})} contacts={contacts}/><RecipientInput label="Cc" value={draft.cc} onChange={cc=>edit({cc})} contacts={contacts}/><label>Subject<input value={draft.subject} onChange={e=>edit({subject:e.target.value})}/></label><textarea aria-label="Message body" placeholder="Write your message…" value={draft.body} onChange={e=>edit({body:e.target.value})}/><div className="signature"><label><input type="checkbox" checked={draft.includeSignature!==false} onChange={e=>edit({includeSignature:e.target.checked})}/> Include signature</label><div>{draftSignature(draft)}</div></div>{draft.files.length>0&&<div className="chips">{draft.files.map((f,i)=><button type="button" key={i} onClick={()=>edit({files:draft.files.filter((_,j)=>j!==i)})}>{f} ×</button>)}</div>}<footer><button className="send" type="submit" disabled={sending}><Send size={16}/> {sending?'Sending…':liveToken?'Send email':'Send test email'}</button>{!liveToken&&<button type="button" className="icon" title="Attach sample plan set" onClick={()=>{if(!draft.files.includes('Demo Plan Set.pdf'))edit({files:[...draft.files,'Demo Plan Set.pdf']})}}><Paperclip size={18}/></button>}<span>{liveToken?'Draft kept for this session':'Draft saved locally'}</span><button type="button" className="icon" title="Discard draft" disabled={sending} onClick={()=>discard(draft.id)}><Trash2 size={18}/></button></footer></form></div>}
 {signatureForm&&<div className="modal-back centered" onClick={()=>setSignatureForm(null)}>
 <form className="signature-settings" role="dialog" aria-label="Email signatures" onClick={e=>e.stopPropagation()} onSubmit={e=>{
  e.preventDefault();
  const signatures={...state.signatures,...signatureForm};
  setState(previous=>({...previous,signatures}));
  if(liveToken)try {localStorage.setItem(liveSignatureKey,JSON.stringify(signatures));}catch{}
  setSignatureForm(null);
  setToast('Email signatures saved');
 }}>
  <header><b>Email signatures</b><button type="button" className="icon" title="Close signatures" onClick={()=>setSignatureForm(null)}><X size={19}/></button></header>
  <div className="signature-fields"><p>Set a plain text signature for each sender. Leave it blank to omit it.</p>
   {senderIdentities.map(identity=><label key={identity}>{identity}<textarea maxLength={2000} value={signatureForm[identity]} onChange={e=>setSignatureForm({...signatureForm,[identity]:e.target.value})}/></label>)}
   <button type="submit" className="send">Save signatures</button>
  </div>
 </form></div>}
 {preview&&<div className="modal-back centered" onClick={()=>setPreview(null)}><section className="attachment-preview" role="dialog" aria-label="Attachment preview" onClick={e=>e.stopPropagation()}><header><b>{preview}</b><button className="icon" title="Close preview" onClick={()=>setPreview(null)}><X size={19}/></button></header><div className="preview-sheet"><div className="eyebrow">A2Z CONSTRUCTION SERVICES / DEMO DOCUMENT</div><FileText size={42}/><h2>{preview.replace(/\.pdf$/i,'')}</h2><p>This is a simulated attachment for the sandbox.</p></div><footer><a href="/samples/demo.pdf" download={preview}><Download size={16}/> Download sample PDF</a></footer></section></div>}
 {help&&<div className="modal-back centered" onClick={()=>setHelp(false)}><section className="shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={e=>e.stopPropagation()}><header><b>Keyboard shortcuts</b><button className="icon" title="Close shortcuts" onClick={()=>setHelp(false)}><X size={19}/></button></header>{[['C','Compose'],['/','Search'],['⌘R','Reply'],['⌘⇧R','Refresh mailbox'],['⌘F','Forward'],['E','Archive selected message'],['Esc','Close dialog or message'],['?','Show shortcuts']].map(([k,l])=><p key={k}><kbd>{k}</kbd> {l}</p>)}</section></div>}
 {toast&&<div className="toast" role="status"><Check size={17}/>{toast}</div>}
 </div>
}
function HostedInbox({ready}:{ready:boolean}) {
 const [token,setToken]=useState('');
 return token ? <App liveToken={token} onSignOut={()=>setToken('')}/> : <MailboxLogin ready={ready} onLogin={setToken}/>;
}

const root=createRoot(document.getElementById('root')!);
if (localToken) root.render(<App liveToken={localToken}/>);
else if (import.meta.env.PROD && !['127.0.0.1','localhost','[::1]'].includes(location.hostname)) {
 hostedRequest('status').then(status=>{
  root.render(status.live?<HostedInbox ready={status.ready}/>:<App/>);
 }).catch(()=>root.render(<div className="login-page" role="alert">The mailbox service is unavailable. Reload to try again.</div>));
} else root.render(<App/>);
