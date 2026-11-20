import {useState,type FormEvent} from 'react';
import {Sparkles} from 'lucide-react';

type Answer = {answer:string;provider:'Gemini'|'Groq'};

export function AskAi({ask}:{ask:(question:string)=>Promise<Answer>}) {
 const [open,setOpen]=useState(false);
 const [question,setQuestion]=useState('');
 const [answer,setAnswer]=useState<Answer>();
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');

 async function submit(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (busy||!question.trim()) return;
  setBusy(true);
  setError('');
  setAnswer(undefined);
  try {
   setAnswer(await ask(question.trim()));
  } catch (error) {
   setError(error instanceof Error?error.message:'Ask AI is temporarily unavailable.');
  } finally {
   setBusy(false);
  }
 }

 return <section className="ask-ai">
  <button type="button" className="project-tag" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
   <Sparkles size={14}/> Ask AI
  </button>
  {open&&<form className="ask-ai-form" onSubmit={submit}>
   <label>Question about this email
    <textarea value={question} onChange={event=>setQuestion(event.target.value)} maxLength={2000}
     rows={2} placeholder="What do I need to reply to?" required/>
   </label>
   <button type="submit" className="send" disabled={busy||!question.trim()}>{busy?'Asking…':'Ask'}</button>
   {error&&<p role="alert">{error}</p>}
   {answer&&<div role="status" className="ask-ai-answer"><small>{answer.provider}</small><p>{answer.answer}</p></div>}
  </form>}
 </section>;
}
