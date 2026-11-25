import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {AlertTriangle,Check,ChevronDown,ChevronRight,Copy,History,Mail,Plus,RotateCcw,Send,Sparkles,Square,Trash2,X} from 'lucide-react';

export type AskSource={ref:string;id:string;folder:string;subject:string;from:string;fromName?:string;date:string|null;excerpt?:string;cited?:boolean};
export type AskAction={id:string;tool:string;preview:{title:string;detail?:string};status:string;result?:any};
export type AskContext={openId?:string;openSubject?:string;openCategory?:string;view?:string;folder?:string};
type Turn={question:string;answer:string;sources:AskSource[];actions:AskAction[];model?:string|null;usage?:{neurons?:number}|null;degraded?:string|null;error?:string;stage?:string;done:boolean};
type Alert={type:string;severity:string;message:string;source?:AskSource|null};
export type AskRunner=(body:object,signal:AbortSignal,onEvent:(event:string,data:any)=>void)=>Promise<void>;
type Request=(action:string,body?:object)=>Promise<any>;

const suggestionsFor=(context:AskContext)=>{
 if (!context.openId) return ['What needs my attention today?','What bids are due this week?','Which proposals have not received responses?',
  'Find emails with unanswered questions','Which GC relationships have gone cold?','Give me an operational briefing for today'];
 const base=['Summarize this thread','What do they need from us and by when?'];
 if (context.openCategory==='Bid Invitations') return ['Extract the scope and deadline from this bid invitation','What is missing for us to estimate it?','Draft a reply confirming our intent to bid',...base];
 if (context.openCategory==='Invoices') return ['What are the payment terms and amounts?','Is anything overdue with this customer?',...base];
 if (context.openCategory==='RFIs & Change Orders') return ['What exactly are they asking and what changes for us?','Draft a reply to this RFI',...base];
 return [...base,'Give me the complete communication history for this project','Draft a reply'];
};

// Plain text to blocks: paragraphs, bullets, pipe tables, labels, links and clickable [S#] citations. No HTML is injected.
function Inline({text,onCite}:{text:string;onCite:(ref:string)=>void}) {
 const parts:ReactNode[]=[];
 const pattern=/\[(S\d+(?:\s*,\s*S\d+)*)\]|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
 let last=0;
 for (const match of text.matchAll(pattern)) {
  parts.push(text.slice(last,match.index));
  if (match[1]) parts.push(<span key={match.index} className="ask-cites">{match[1].split(/\s*,\s*/).map(ref=>
   <button type="button" key={ref} className="ask-cite" onClick={()=>onCite(ref)} title={'Open source '+ref}>{ref.slice(1)}</button>)}</span>);
  else parts.push(<a key={match.index} href={match[0]} target="_blank" rel="noopener noreferrer">{match[0].replace(/^https?:\/\/(www\.)?/,'').slice(0,48)}</a>);
  last=(match.index||0)+match[0].length;
 }
 parts.push(text.slice(last));
 return <>{parts}</>;
}
function Formatted({text,onCite}:{text:string;onCite:(ref:string)=>void}) {
 const lines=text.split('\n');
 const blocks:ReactNode[]=[];
 for (let index=0;index<lines.length;index++) {
  const line=lines[index];
  if (/^\s*\|.*\|\s*$/.test(line)) {
   const rows:string[][]=[];
   while (index<lines.length&&/^\s*\|.*\|\s*$/.test(lines[index])) {
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[index])) rows.push(lines[index].trim().slice(1,-1).split('|').map(cell=>cell.trim()));
    index++;
   }
   index--;
   const [head,...body]=rows;
   blocks.push(<div className="ask-table-wrap" key={'t'+index}><table className="ask-table"><thead><tr>{head.map((cell,i)=><th key={i}><Inline text={cell} onCite={onCite}/></th>)}</tr></thead>
    <tbody>{body.map((row,r)=><tr key={r}>{row.map((cell,i)=><td key={i}><Inline text={cell} onCite={onCite}/></td>)}</tr>)}</tbody></table></div>);
   continue;
  }
  const items:string[]=[];
  while (index<lines.length&&/^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[index])) {items.push(lines[index].replace(/^\s*(?:[-*•]|\d+[.)])\s+/,''));index++;}
  if (items.length) {
   index--;
   blocks.push(<ul key={'u'+index}>{items.map((item,i)=><li key={i}><Inline text={item} onCite={onCite}/></li>)}</ul>);
   continue;
  }
  if (!line.trim()) continue;
  const label=line.match(/^(Facts|Interpretation|Recommended next steps|Recommendations?|Summary|Next steps):\s*(.*)$/i);
  if (label) blocks.push(<p key={'p'+index} className="ask-label"><b>{label[1]}</b>{label[2]&&<> <Inline text={label[2]} onCite={onCite}/></>}</p>);
  else blocks.push(<p key={'p'+index}><Inline text={line.replace(/\*\*/g,'')} onCite={onCite}/></p>);
 }
 return <div className="ask-ai-text">{blocks}</div>;
}

const when=(value:string|null)=>value?new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'';
const modelName=(model?:string|null)=>model?model.replace(/^@cf\/(?:openai|meta)\//,''):'';

export function AskAi({run,request,context,toolbar=false,prefill='',onOpenSource,onUseReply,live}:{
 run:AskRunner;request?:Request;context:AskContext;toolbar?:boolean;prefill?:string;
 onOpenSource:(source:AskSource)=>void;onUseReply?:(text:string)=>void;live:boolean;
}) {
 const button=useRef<HTMLButtonElement>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 const log=useRef<HTMLDivElement>(null);
 const abort=useRef<AbortController|null>(null);
 const [question,setQuestion]=useState('');
 const [turns,setTurns]=useState<Turn[]>([]);
 const [conversationId,setConversationId]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [aboutEmail,setAboutEmail]=useState(true);
 const [history,setHistory]=useState<{id:string;title:string;updatedAt:string}[]|null>(null);
 const [showHistory,setShowHistory]=useState(false);
 const [alerts,setAlerts]=useState<Alert[]|null>(null);
 const [usage,setUsage]=useState<{estimatedNeurons:number|null;dailyBudget:number|null;remainingEstimated:number|null;providerReportedNeurons:number|null}|null>(null);
 const [copied,setCopied]=useState(-1);
 const [evidence,setEvidence]=useState<Record<number,boolean>>({});
 const useEmail=Boolean(context.openId)&&aboutEmail;

 useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight});},[turns]);

 async function open() {
  if (prefill.trim()&&!question) setQuestion(prefill.slice(0,2000));
  setAboutEmail(true);
  dialog.current?.showModal();
  if (live&&request&&alerts===null) {
   request('ai-alerts').then(data=>{setAlerts(data.alerts||[]);setUsage(data.usage||null);}).catch(()=>setAlerts([]));
  }
 }
 async function loadHistory() {
  if (!request) return;
  setShowHistory(!showHistory);
  if (!showHistory) request('ai-conversations').then(data=>setHistory(data.items||[])).catch(()=>setHistory([]));
 }
 async function openConversation(id:string) {
  if (!request) return;
  const data=await request('ai-conversations&id='+encodeURIComponent(id)).catch(()=>null);
  const saved=data?.conversation?.turns||[];
  const rebuilt:Turn[]=[];
  for (let index=0;index<saved.length;index+=2) {
   const user=saved[index],assistant=saved[index+1];
   if (user?.role==='user'&&assistant) rebuilt.push({question:user.content,answer:assistant.content,sources:assistant.sources||[],actions:assistant.actions||[],
    model:assistant.model,usage:assistant.usage,degraded:assistant.degraded,done:true});
  }
  setTurns(rebuilt);setConversationId(id);setShowHistory(false);
 }
 async function removeConversation(id:string) {
  if (!request) return;
  const data=await request('ai-conversations',{op:'delete',id}).catch(()=>null);
  if (data) setHistory(data.items);
  if (id===conversationId) {setTurns([]);setConversationId(null);}
 }

 async function send(text:string) {
  const asked=text.trim();
  if (busy||!asked) return;
  const controller=new AbortController();
  abort.current=controller;
  setBusy(true);
  setQuestion('');
  const index=turns.length;
  setTurns(previous=>[...previous,{question:asked,answer:'',sources:[],actions:[],done:false,stage:'Starting'}]);
  const patch=(update:(turn:Turn)=>Turn)=>setTurns(previous=>previous.map((turn,i)=>i===index?update(turn):turn));
  try {
   await run({question:asked,conversationId,...(useEmail?{openId:context.openId}:{}),view:context.view,folder:context.folder},controller.signal,(event,data)=>{
    if (event==='status') patch(turn=>({...turn,stage:data.stage}));
    else if (event==='sources') patch(turn=>({...turn,sources:data}));
    else if (event==='delta') patch(turn=>({...turn,answer:turn.answer+data.text,stage:undefined}));
    else if (event==='replace') patch(turn=>({...turn,answer:data.text,stage:undefined}));
    else if (event==='actions') patch(turn=>({...turn,actions:data}));
    else if (event==='done') {
     if (data.conversationId) setConversationId(data.conversationId);
     patch(turn=>({...turn,answer:data.content??turn.answer,sources:data.sources||turn.sources,actions:data.actions||turn.actions,model:data.model,usage:data.usage,degraded:data.degraded,done:true,stage:undefined}));
     if (data.usage?.neurons&&usage) setUsage({...usage,estimatedNeurons:(usage.estimatedNeurons||0)+data.usage.neurons,
      remainingEstimated:usage.remainingEstimated===null?null:Math.max(0,usage.remainingEstimated-data.usage.neurons)});
    }
    else if (event==='error') patch(turn=>({...turn,error:data.message,done:true,stage:undefined}));
   });
   patch(turn=>turn.done?turn:{...turn,done:true,stage:undefined});
  } catch (error) {
   const stopped=controller.signal.aborted;
   patch(turn=>({...turn,done:true,stage:undefined,error:stopped?'Stopped.':error instanceof Error?error.message:'Ask AI is unavailable.'}));
  } finally {
   setBusy(false);
   abort.current=null;
  }
 }
 function citeFor(turn:Turn) {
  return (ref:string)=>{const source=turn.sources.find(item=>item.ref===ref);if (source){onOpenSource(source);dialog.current?.close();}};
 }
 async function decide(turnIndex:number,action:AskAction,decision:'confirm'|'cancel') {
  if (!request) return;
  const update=(status:string,result?:any)=>setTurns(previous=>previous.map((turn,i)=>i!==turnIndex?turn:{...turn,actions:turn.actions.map(item=>item.id===action.id?{...item,status,result}:item)}));
  update('running');
  try {const data=await request('ai-action',{id:action.id,decision});update(data.status,data.result);}
  catch (error) {update('failed',{error:error instanceof Error?error.message:'Failed'});}
 }
 async function copy(index:number,text:string) {
  try {await navigator.clipboard.writeText(text.replace(/\s*\[S\d+(?:,\s*S\d+)*\]/g,''));setCopied(index);window.setTimeout(()=>setCopied(-1),1500);} catch {}
 }
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();void send(question);};

 return <div className={toolbar?'ask-ai-toolbar':'ask-ai'}>
  <button ref={button} type="button" className="project-tag ask-ai-trigger" aria-label="Ask AI" aria-haspopup="dialog" onClick={()=>void open()}>
   <Sparkles size={16} aria-hidden="true"/><span>Ask AI</span>
  </button>
  <dialog ref={dialog} className="ask-ai-dialog" aria-label="Ask AI" onClose={()=>button.current?.focus()} onKeyDown={event=>{if(event.key==='Escape') event.stopPropagation()}}>
   <header className="ask-ai-header">
    <span className="ask-ai-mark" aria-hidden="true"><Sparkles size={16}/></span>
    <div><strong>Ask AI</strong><small>{usage?.dailyBudget?'About '+(usage.remainingEstimated??'?')+' of '+usage.dailyBudget+' AI units left today (estimate)':'Searches your mailbox, cites every email it uses'}</small></div>
    {live&&request&&<button type="button" className="icon" title="Conversation history" aria-label="Conversation history" onClick={()=>void loadHistory()}><History size={16}/></button>}
    <button type="button" className="icon" title="New conversation" aria-label="New conversation" disabled={busy} onClick={()=>{setTurns([]);setConversationId(null);}}><Plus size={16}/></button>
    <button type="button" className="icon" aria-label="Close Ask AI" onClick={()=>dialog.current?.close()}><X size={18}/></button>
   </header>
   {showHistory&&<div className="ask-history">{history===null?<p>Loading…</p>:!history.length?<p>No saved conversations yet.</p>:
    history.map(item=><div key={item.id} className="ask-history-row"><button type="button" onClick={()=>void openConversation(item.id)}>{item.title}<small>{when(item.updatedAt)}</small></button>
     <button type="button" className="icon" aria-label={'Delete '+item.title} onClick={()=>void removeConversation(item.id)}><Trash2 size={14}/></button></div>)}</div>}
   {context.openId?<div className="ask-ai-scope" role="group" aria-label="What to ask about">
    <button type="button" aria-pressed={useEmail} onClick={()=>setAboutEmail(true)}><Mail size={14}/> <span>{context.openSubject||'Open email'}</span></button>
    <button type="button" aria-pressed={!useEmail} onClick={()=>setAboutEmail(false)}>Whole mailbox</button>
   </div>:<p className="ask-ai-context">Asking across your whole mailbox{context.view?' · viewing '+context.view:''}.</p>}
   <div className="ask-ai-conversation" ref={log} role="log" aria-label="Conversation" aria-live="polite">
    {!turns.length&&<div className="ask-ai-empty">
     {alerts&&alerts.length>0&&<div className="ask-alerts"><p>Needs attention</p>{alerts.slice(0,5).map((alert,index)=>
      <button type="button" key={index} className={'ask-alert '+alert.severity} onClick={()=>{if(alert.source){onOpenSource(alert.source as AskSource);dialog.current?.close();}}}>
       <AlertTriangle size={13}/><span><b>{alert.type}</b> {alert.message}</span></button>)}</div>}
     <p>Try one of these</p>
     <div className="ask-ai-chips">{suggestionsFor(useEmail?context:{...context,openId:undefined}).map(item=><button key={item} type="button" onClick={()=>void send(item)}>{item}</button>)}</div>
    </div>}
    {turns.map((turn,index)=><div key={index} className="ask-ai-exchange">
     <div className="ask-ai-question">{turn.question}</div>
     <div className={'ask-ai-answer'+(turn.degraded?' ask-ai-fallback':'')}>
      {turn.degraded&&<p className="ask-degraded"><AlertTriangle size={13}/> {turn.degraded==='quota'?'AI allowance or rate limit reached. These are search results without AI analysis.':'AI is unavailable. These are search results without AI analysis.'}</p>}
      {turn.answer?<Formatted text={turn.answer} onCite={citeFor(turn)}/>:!turn.error&&<div className="ask-ai-thinking" role="status"><span className="ask-ai-dots" aria-hidden="true"><i/><i/><i/></span>{turn.stage||'Thinking'}…</div>}
      {turn.stage&&turn.answer&&<small className="ask-stage">{turn.stage}…</small>}
      {turn.error&&<p className="ask-ai-error" role="alert">{turn.error}</p>}
      {turn.actions.length>0&&<div className="ask-actions">{turn.actions.map(action=><div key={action.id} className={'ask-action '+action.status}>
       <b>{action.preview.title}</b>
       {action.preview.detail&&<pre>{action.preview.detail}</pre>}
       {action.status==='pending'?<div className="ask-action-buttons"><button type="button" className="send" onClick={()=>void decide(index,action,'confirm')}>Confirm</button>
        <button type="button" className="project-tag" onClick={()=>void decide(index,action,'cancel')}>Cancel</button></div>
        :<small>{action.status==='done'?(action.result?.duplicate?'Already done earlier':'Done'+(action.tool==='email_create_draft'?'. Saved in Drafts.':'')):action.status==='running'?'Working…':action.status==='cancelled'?'Cancelled':'Failed: '+(action.result?.error||'')}</small>}
      </div>)}</div>}
      {turn.sources.length>0&&<div className="ask-evidence">
       <button type="button" className="ask-evidence-toggle" onClick={()=>setEvidence(previous=>({...previous,[index]:!previous[index]}))}>
        {evidence[index]?<ChevronDown size={13}/>:<ChevronRight size={13}/>} Sources ({turn.sources.filter(source=>source.cited).length} cited, {turn.sources.length} checked)</button>
       {evidence[index]&&<ul>{turn.sources.slice(0,25).map(source=><li key={source.ref} className={source.cited?'cited':''}>
        <button type="button" onClick={()=>{onOpenSource(source);dialog.current?.close();}}>
         <span className="ask-cite">{source.ref.slice(1)}</span><span><b>{source.subject}</b><small>{source.fromName||source.from} · {when(source.date)} · {source.folder}</small>
         {source.excerpt&&<em>{source.excerpt}</em>}</span></button></li>)}</ul>}
      </div>}
      {turn.done&&<footer><small>{turn.model?modelName(turn.model)+(turn.usage?.neurons?' · ~'+turn.usage.neurons+' units':''):turn.degraded?'Search only':''}</small>
       <span>{context.openId&&onUseReply&&turn.answer&&!turn.degraded&&<button type="button" className="ask-ai-use" onClick={()=>{onUseReply(turn.answer.replace(/\s*\[S\d+(?:,\s*S\d+)*\]/g,''));dialog.current?.close();}}>Use in reply</button>}
        {(turn.error||turn.degraded)&&<button type="button" className="ask-ai-use" disabled={busy} onClick={()=>void send(turn.question)}><RotateCcw size={12}/> Retry</button>}
        <button type="button" className="icon" title="Copy answer" aria-label="Copy answer" onClick={()=>void copy(index,turn.answer)}>{copied===index?<Check size={14}/>:<Copy size={14}/>}</button></span></footer>}
     </div>
    </div>)}
   </div>
   <form className="ask-ai-form" onSubmit={submit}>
    <textarea autoFocus value={question} onChange={event=>setQuestion(event.target.value)} maxLength={2000} rows={2}
     aria-label="Question" placeholder={useEmail?'Ask about this email or anything in your mailbox…':'Ask about your mailbox…'} disabled={busy}
     onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send(question);}}}/>
    {busy?<button type="button" className="ask-ai-send stop" aria-label="Stop" onClick={()=>abort.current?.abort()}><Square size={14}/></button>
     :<button type="submit" className="ask-ai-send" aria-label="Ask" disabled={!question.trim()}><Send size={16}/></button>}
   </form>
   <small className="ask-ai-hint">Enter to ask · Shift+Enter for a new line · Numbers link to the emails used. Actions always ask before they run.</small>
  </dialog>
 </div>;
}

