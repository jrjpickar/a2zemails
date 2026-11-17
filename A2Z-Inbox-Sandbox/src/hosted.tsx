import {useState,type FormEvent} from 'react';

export const hostedEndpoint='/.netlify/functions/ionos';

export async function hostedRequest(action:string, body?:object, token?:string) {
 const response = await fetch(hostedEndpoint+'?action='+action,{
  method:body?'POST':'GET',cache:'no-store',
  headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,
 });
 const data = await response.json();
 if (!response.ok||data.error) {
  const error=new Error(data.error||'IONOS request failed.');
  Object.assign(error,{status:response.status});
  throw error;
 }
 return data;
}

export function MailboxLogin({ready,onLogin}:{ready:boolean;onLogin:(token:string)=>void}) {
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 async function signIn(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (busy||!ready) return;
  const form=event.currentTarget;
  const fields=new FormData(form);
  setBusy(true);
  setError('');
  try {
   const data=await hostedRequest('login',{email:fields.get('email'),password:fields.get('password')});
   onLogin(data.token);
  } catch (error) {
   setError(error instanceof Error?error.message:'Unable to sign in.');
  } finally {
   const password=form.elements.namedItem('password') as HTMLInputElement;
   password.value='';
   setBusy(false);
  }
 }
 return <div className="login-page"><form className="signature-settings" onSubmit={signIn}>
  <header><b>A2Z Construction</b><span>IONOS Mail</span></header>
  <div className="signature-fields">
   <h1>Sign in to your mailbox</h1>
   <label>IONOS email address<input name="email" type="email" autoComplete="username" required disabled={!ready||busy}/></label>
   <label>Mailbox password<input name="password" type="password" autoComplete="current-password" required disabled={!ready||busy}/></label>
   {(!ready||error)&&<p role="alert">{error||'This deployment needs a session secret and allowed mailbox addresses.'}</p>}
   <button className="send" disabled={!ready||busy}>{busy?'Signing in…':'Sign in'}</button>
  </div>
 </form></div>;
}
