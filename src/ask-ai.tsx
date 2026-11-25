import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {Check,Copy,Mail,RotateCcw,Send,Sparkles,X} from 'lucide-react';

type Answer = {answer:string;provider:'Gemini'|'Groq'|'Mailbox excerpts'|'Sandbox';model?:string;backup?:boolean;excerptsOnly?:boolean};
type Turn = {role:'user'|'assistant';content:string};
type Exchange = {question:string;answer:Answer;about?:string};

const suggestions = {
 email:['Summarize this email','When is it due and what is the scope?','What is missing for us to estimate it?','Draft a short reply'],
 mailbox:['What bids are due this week?','Which emails still need a reply?','Have we bid with this GC before?','Any new pricing requests today?'],
};

// Plain text answers to readable blocks: paragraphs, "- " bullet lists and clickable https links. No HTML is injected.
function linkify(text:string) {
 const parts:ReactNode[] = [];
 const pattern = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
 let last = 0;
 for (const match of text.matchAll(pattern)) {
  parts.push(text.slice(last,match.index));
  parts.push(<a key={match.index} href={match[0]} target="_blank" rel="noopener noreferrer">{match[0].replace(/^https?:\/\/(www\.)?/,'').slice(0,48)}</a>);
  last = (match.index||0)+match[0].length;
 }
 parts.push(text.slice(last));
 return parts;
}

function FormattedAnswer({text}:{text:string}) {
 const blocks:ReactNode[] = [];
 let list:string[] = [];
 const flush = () => {
  if (list.length) blocks.push(<ul key={'l'+blocks.length}>{list.map((item,index)=><li key={index}>{linkify(item)}</li>)}</ul>);
  list = [];
 };
 for (const line of text.split('\n')) {
  const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
  if (bullet) {list.push(bullet[1]);continue;}
  flush();
  if (line.trim()) blocks.push(<p key={'p'+blocks.length}>{linkify(line)}</p>);
 }
 flush();
 return <div className="ask-ai-text">{blocks}</div>;
}

function source(answer:Answer) {
 if (answer.excerptsOnly) return answer.provider==='Sandbox'?'Sandbox sample':'Mailbox excerpts only';
 const model = answer.model?.replace(/^openai\//,'') || answer.provider;
 return model+(answer.backup?' · backup model':'');
}

export function AskAi({ask,prefill='',toolbar=false,subject}:{
 ask:(question:string,history:Turn[],aboutOpenEmail:boolean)=>Promise<Answer>;
 prefill?:string;
 toolbar?:boolean;
 subject?:string;
}) {
 const button=useRef<HTMLButtonElement>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 const log=useRef<HTMLDivElement>(null);
 const [question,setQuestion]=useState('');
 const [exchanges,setExchanges]=useState<Exchange[]>([]);
 const [busy,setBusy]=useState(false);
 const [elapsed,setElapsed]=useState(0);
 const [error,setError]=useState('');
 const [copied,setCopied]=useState(-1);
 const [aboutEmail,setAboutEmail]=useState(true);
 const useEmail=Boolean(subject)&&aboutEmail;

 useEffect(()=>{
  if (!busy) return;
  setElapsed(0);
  const started=Date.now();
  const timer=window.setInterval(()=>setElapsed(Math.round((Date.now()-started)/1000)),1000);
  return ()=>window.clearInterval(timer);
 },[busy]);
 useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'smooth'});},[exchanges.length,busy]);

 async function send(text:string) {
  if (busy||!text.trim()) return;
  setBusy(true);
  setError('');
  const history=exchanges.slice(-3).flatMap(({question,answer}):Turn[]=>[
   {role:'user',content:question},{role:'assistant',content:answer.answer.slice(0,2000)},
  ]);
  try {
   const answer=await ask(text.trim(),history,useEmail);
   setExchanges(previous=>[...previous,{question:text.trim(),answer,about:useEmail?subject:undefined}]);
   setQuestion('');
  } catch (failure) {
   setError(failure instanceof Error?failure.message:'Ask AI is temporarily unavailable.');
  } finally {
   setBusy(false);
  }
 }
 function submit(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  void send(question);
 }
 async function copy(index:number,text:string) {
  try {await navigator.clipboard.writeText(text);setCopied(index);window.setTimeout(()=>setCopied(-1),1500);} catch {}
 }

 return <div className={toolbar?'ask-ai-toolbar':'ask-ai'}>
  <button ref={button} type="button" className="project-tag ask-ai-trigger" aria-label="Ask AI" aria-haspopup="dialog" onClick={()=>{
   if (prefill.trim()&&!question) setQuestion(prefill.slice(0,2000));
   setAboutEmail(true);
   dialog.current?.showModal();
  }}>
   <Sparkles size={16} aria-hidden="true"/><span>Ask AI</span>
  </button>
  <dialog ref={dialog} className="ask-ai-dialog" aria-label="Ask AI"
   onClose={()=>button.current?.focus()} onKeyDown={event=>{if(event.key==='Escape') event.stopPropagation()}}>
   <header className="ask-ai-header">
    <span className="ask-ai-mark" aria-hidden="true"><Sparkles size={16}/></span>
    <div><strong>Ask AI</strong><small>Reads your mail, reasons it through and can check the web</small></div>
    {exchanges.length>0&&<button type="button" className="icon" title="New conversation" aria-label="New conversation" disabled={busy}
     onClick={()=>{setExchanges([]);setError('');}}><RotateCcw size={16}/></button>}
    <button type="button" className="icon" aria-label="Close Ask AI" onClick={()=>dialog.current?.close()}><X size={18}/></button>
   </header>
   {subject?<div className="ask-ai-scope" role="group" aria-label="What to ask about">
    <button type="button" aria-pressed={useEmail} onClick={()=>setAboutEmail(true)}><Mail size={14}/> <span>{subject}</span></button>
    <button type="button" aria-pressed={!useEmail} onClick={()=>setAboutEmail(false)}>Whole mailbox</button>
   </div>:<p className="ask-ai-context">Asking across your whole mailbox. Open an email to ask about it.</p>}
   <div className="ask-ai-conversation" ref={log} role="log" aria-label="Conversation" aria-live="polite">
    {!exchanges.length&&!busy&&<div className="ask-ai-empty">
     <p>Try one of these</p>
     <div className="ask-ai-chips">{suggestions[useEmail?'email':'mailbox'].map(item=>
      <button key={item} type="button" onClick={()=>void send(item)}>{item}</button>)}</div>
    </div>}
    {exchanges.map(({question,answer,about},index)=><div key={index} className="ask-ai-exchange">
     <div className="ask-ai-question">{question}{about&&<small>About: {about}</small>}</div>
     <div className={'ask-ai-answer'+(answer.excerptsOnly?' ask-ai-fallback':'')}>
      <FormattedAnswer text={answer.answer}/>
      <footer><small>{source(answer)}</small>
       <button type="button" className="icon" title="Copy answer" aria-label="Copy answer" onClick={()=>void copy(index,answer.answer)}>
        {copied===index?<Check size={14}/>:<Copy size={14}/>}</button></footer>
     </div>
    </div>)}
    {busy&&<div className="ask-ai-thinking" role="status"><span className="ask-ai-dots" aria-hidden="true"><i/><i/><i/></span>
     {elapsed<4?'Reading your mail':elapsed<12?'Thinking it through':'Checking details'}… {elapsed>0&&<small>{elapsed}s</small>}</div>}
   </div>
   {error&&<p className="ask-ai-error" role="alert">{error}</p>}
   <form className="ask-ai-form" onSubmit={submit}>
    <textarea autoFocus value={question} onChange={event=>setQuestion(event.target.value)} maxLength={2000} rows={2}
     aria-label="Question" placeholder={useEmail?'Ask about this email…':'Ask about your mailbox…'} disabled={busy}
     onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send(question);}}}/>
    <button type="submit" className="ask-ai-send" aria-label="Ask" disabled={busy||!question.trim()}><Send size={16}/></button>
   </form>
   <small className="ask-ai-hint">Enter to ask · Shift+Enter for a new line · AI can make mistakes, check key numbers.</small>
  </dialog>
 </div>;
}
