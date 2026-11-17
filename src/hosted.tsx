import {useState,type FormEvent} from 'react';

export const hostedEndpoint='/.netlify/functions/ionos';

export async function hostedRequest(action:string, body?:object, token?:string) {
 const response = await fetch(hostedEndpoint+'?action='+action,{
  method:body?'POST':'GET',cache:'no-store',
  headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,
 });
 const data = await response.json().catch(()=>({}));
 if (!response.ok||data.error) {
  const error=new Error(data.error||'IONOS request failed.');
  Object.assign(error,{status:response.status,reason:data.reason,requestId:response.headers.get('x-nf-request-id')});
  throw error;
 }
 return data;
}

export function MailboxLogin({ready,onLogin,notice,retry}:{ready:boolean;onLogin:(token:string)=>void;notice?:string;retry?:()=>void}) {
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [showPassword,setShowPassword]=useState(false);
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
   setShowPassword(false);
   setBusy(false);
  }
 }
 return <div className="login-page"><form className="signature-settings" onSubmit={signIn}>
  <header><b>A2Z Construction</b><span>IONOS Mail</span></header>
  <div className="signature-fields">
   <h1>Sign in to your mailbox</h1>
   {notice&&<p role="status">{notice}</p>}
   {retry&&<button type="button" className="project-tag" onClick={retry}>Try HighLevel sign-in again</button>}
   <label>IONOS email address<input name="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={!ready||busy}/></label>
   <label htmlFor="mailbox-password">Mailbox password</label>
   <div className="mailbox-password-field">
    <input id="mailbox-password" name="password" type={showPassword?'text':'password'} autoComplete="current-password"
     autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={!ready||busy}/>
    <button type="button" className="project-tag" aria-pressed={showPassword} disabled={!ready||busy}
     onClick={()=>setShowPassword(value=>!value)}>{showPassword?'Hide password':'Show password'}</button>
   </div>
   {(!ready||error)&&<p role="alert">{error||'This deployment needs a session secret and allowed mailbox addresses.'}</p>}
   <button className="send" disabled={!ready||busy}>{busy?'Signing in…':'Sign in'}</button>
  </div>
 </form></div>;
}

const highLevelNotices:Record<string,string> = {
 ghl_origin:'This HighLevel host isn’t enabled for auto sign-in. Check GHL_PARENT_ORIGINS.',
 ghl_context:'Inbox couldn’t read the HighLevel session. Check the Shared Secret for this exact Marketplace app.',
 ghl_agency:'This HighLevel agency doesn’t match GHL_COMPANY_ID.',
 ghl_location:'Open Inbox inside an approved HighLevel sub-account. Check GHL_LOCATION_IDS.',
 ghl_ionos_auth:'HighLevel verified your account, but IONOS rejected the saved mailbox credential.',
 ghl_ionos_unavailable:'HighLevel verified your account, but Inbox could not open the IONOS mailbox.',
 session_expired:'Your mailbox session expired.',
 ghl_mailbox:'This HighLevel user has no matching IONOS mailbox configured for auto sign-in.',
 ghl_setup:'HighLevel auto sign-in is not configured on this deployment.',
 ghl_timeout:'HighLevel did not send a user session. Open Inbox from the installed Marketplace Custom Page and check the portal hostname.',
};

export function highLevelSignInNotice(error:unknown) {
 const reason=(error as {reason?:string}|null)?.reason;
 const detail=reason && Object.hasOwn(highLevelNotices,reason) ? highLevelNotices[reason] : 'Inbox couldn’t complete HighLevel sign-in.';
 const requestId=(error as {requestId?:string}|null)?.requestId;
 return detail+' You can still sign in with your IONOS mailbox.'+(requestId?' Reference: '+requestId:'');
}

export function requestHighLevelContext(origins:string[],signal:AbortSignal) {
 return new Promise<{encryptedData:string;parentOrigin:string}>((resolve,reject)=>{
  const frames=new Set([window.parent,window.top].filter(Boolean));
  const retryTimers:number[]=[];
  function cleanup() {
   window.clearTimeout(timer);
   retryTimers.forEach(id=>window.clearTimeout(id));
   window.removeEventListener('message',receive);
   signal.removeEventListener('abort',abort);
  }
  function abort() {cleanup();reject(new Error('HighLevel sign-in was interrupted.'));}
  function receive(event:MessageEvent) {
   if (!frames.has(event.source as Window) || !origins.includes(event.origin) ||
       event.data?.message!=='REQUEST_USER_DATA_RESPONSE' || typeof event.data.payload!=='string') return;
   cleanup();
   resolve({encryptedData:event.data.payload,parentOrigin:event.origin});
  }
  function send() {
   for (const frame of frames) {
    if (!frame || frame===window) continue;
    for (const origin of origins) frame.postMessage({message:'REQUEST_USER_DATA'},origin);
   }
  }
  const timer=window.setTimeout(()=>{
   cleanup();
   reject(Object.assign(new Error('HighLevel did not provide a sign-in session.'),{reason:'ghl_timeout'}));
  },6000);
  if (signal.aborted) {abort();return;}
  window.addEventListener('message',receive);
  signal.addEventListener('abort',abort,{once:true});
  send();
  for (const delay of [400,1500,3000]) retryTimers.push(window.setTimeout(send,delay));
 });
}
