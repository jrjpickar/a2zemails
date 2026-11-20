import {useRef,useState,type FormEvent} from 'react';
import {Sparkles,X} from 'lucide-react';

type Answer = {answer:string;provider:'Gemini'|'Groq';backup?:boolean};
type Turn = {role:'user'|'assistant';content:string};
type Exchange = {question:string;answer:Answer};

export function AskAi({ask,prefill='',toolbar=false,subject}:{
 ask:(question:string,history:Turn[])=>Promise<Answer>;
 prefill?:string;
 toolbar?:boolean;
 subject?:string;
}) {
 const button=useRef<HTMLButtonElement>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 const [question,setQuestion]=useState('');
 const [exchanges,setExchanges]=useState<Exchange[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');

 async function submit(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const text=question.trim();
  if (busy||!text) return;
  setBusy(true);
  setError('');
  const history=exchanges.slice(-3).flatMap(({question,answer}):Turn[]=>[
   {role:'user',content:question},{role:'assistant',content:answer.answer.slice(0,2000)},
  ]);
  try {
   const answer=await ask(text,history);
   setExchanges(previous=>[...previous,{question:text,answer}]);
   setQuestion('');
  } catch (error) {
   setError(error instanceof Error?error.message:'Ask AI is temporarily unavailable.');
  } finally {
   setBusy(false);
  }
 }

 return <div className={toolbar?'ask-ai-toolbar':'ask-ai'}>
  <button ref={button} type="button" className="project-tag ask-ai-trigger" aria-label="Ask AI" aria-haspopup="dialog" onClick={()=>{
   if (prefill.trim()) setQuestion(prefill.slice(0,2000));
   dialog.current?.showModal();
  }}>
   <Sparkles size={16} aria-hidden="true"/><span>Ask AI</span>
  </button>
  <dialog ref={dialog} className="ask-ai-dialog" aria-label="Ask AI"
   onClose={()=>button.current?.focus()} onKeyDown={event=>{if(event.key==='Escape') event.stopPropagation()}}>
   <header><strong>Ask AI</strong><button type="button" className="icon" aria-label="Close Ask AI" onClick={()=>dialog.current?.close()}><X size={18}/></button></header>
   <p className="ask-ai-context">{subject||'Select an email to give Ask AI context.'}</p>
   <form className="ask-ai-form" onSubmit={submit}>
    {exchanges.length>0&&<div className="ask-ai-conversation" role="log" aria-label="Conversation">
     {exchanges.map(({question,answer},index)=><div key={index} className="ask-ai-answer">
      <strong>{question}</strong>
      <p>{answer.answer}</p>
      {answer.backup&&<small>Answered by backup model</small>}
     </div>)}
    </div>}
    <label>Question
     <textarea autoFocus value={question} onChange={event=>setQuestion(event.target.value)} maxLength={2000}
      rows={2} placeholder="What do I need to reply to?" required disabled={busy}/>
    </label>
    <button type="submit" className="send" disabled={busy||!question.trim()}>{busy?'Asking…':'Ask'}</button>
    {error&&<p role="alert">{error}</p>}
   </form>
  </dialog>
 </div>;
}
