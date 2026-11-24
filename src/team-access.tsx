import {useEffect,useState,type FormEvent} from 'react';
import {X} from 'lucide-react';

export type TeamUser={
 email:string;name:string;customName:string;status:'active'|'offboarded';admin:boolean;envListed:boolean;
 addedAt:string|null;addedBy:string|null;offboardedAt:string|null;offboardedBy:string|null;revokedAt:number|null;
 ghlSaved:boolean;ghlEnv:boolean;
};
type Op='onboard'|'offboard'|'revoke'|'rename'|'set-ghl-password'|'clear-ghl-password';
type Request=(path:string,body?:object)=>Promise<{users:TeamUser[]}>;

const shortDate=(value:string|number|null)=>value?new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'';

export function TeamAccess({request,self,onClose,onChanged}:{request:Request;self:string;onClose:()=>void;onChanged?:()=>void}) {
 const [users,setUsers]=useState<TeamUser[]|null>(null);
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [confirm,setConfirm]=useState<TeamUser|null>(null);
 const [filter,setFilter]=useState<'active'|'offboarded'>('active');

 useEffect(()=>{
  request('team').then(data=>setUsers(data.users)).catch(failure=>setError(failure instanceof Error?failure.message:'Could not load team access.'));
 },[]);

 async function run(op:Op,email:string,name?:string,password?:string) {
  setBusy(op+':'+email);
  setError('');
  try {
   const data=await request('team',{op,email,name,password});
   setUsers(data.users);
   setConfirm(null);
   if (op==='rename'&&email===self) onChanged?.();
   return true;
  } catch(failure) {
   setError(failure instanceof Error?failure.message:'Team access did not update.');
   return false;
  } finally { setBusy(''); }
 }
 async function onboard(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form=event.currentTarget;
  const fields=new FormData(form);
  const email=String(fields.get('email')||'');
  const password=String(fields.get('password')||'');
  if (!await run('onboard',email,String(fields.get('name')||''))) return;
  // Optional: save the HighLevel auto sign-in password in the same step.
  if (password&&!await run('set-ghl-password',email,undefined,password)) return;
  form.reset();
  setFilter('active');
 }
 const [editing,setEditing]=useState<{email:string;name:string}|null>(null);
 const [ghlEditing,setGhlEditing]=useState('');
 async function saveGhl(event:FormEvent<HTMLFormElement>,email:string) {
  event.preventDefault();
  const form=event.currentTarget;
  const password=String(new FormData(form).get('password')||'');
  if (await run('set-ghl-password',email,undefined,password)) {form.reset();setGhlEditing('');}
 }
 async function saveName(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (editing&&await run('rename',editing.email,editing.name)) setEditing(null);
 }
 const shown=(users||[]).filter(user=>user.status===filter);
 const counts={active:(users||[]).filter(user=>user.status==='active').length,offboarded:(users||[]).filter(user=>user.status==='offboarded').length};

 return <div className="modal-back centered" onClick={()=>{if(!busy)onClose()}}>
  <section className="signature-settings team-access" role="dialog" aria-modal="true" aria-label="Team access" onClick={event=>event.stopPropagation()}
   onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();if(ghlEditing)setGhlEditing('');else if(editing)setEditing(null);else if(confirm)setConfirm(null);else if(!busy)onClose();}}}>
   <header><b>Team access</b><button type="button" className="icon" title="Close team access" disabled={Boolean(busy)} onClick={onClose}><X size={19}/></button></header>
   <div className="signature-fields">
    <form className="team-onboard" onSubmit={onboard}>
     <b>Onboard a mailbox</b>
     <p>The person signs in with their own IONOS address and mailbox password. Create the mailbox in IONOS first.</p>
     <label>IONOS email address<input name="email" type="email" required autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={Boolean(busy)}/></label>
     <label>Display name<input name="name" maxLength={80} placeholder="First Last" disabled={Boolean(busy)}/></label>
     <label>Mailbox password for HighLevel auto sign-in (optional)<input name="password" type="password" autoComplete="new-password" maxLength={1024} disabled={Boolean(busy)}/></label>
     <button className="send" disabled={Boolean(busy)}>{busy.startsWith('onboard:')?'Adding…':'Give access'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    <div className="team-tabs" role="tablist">
     {(['active','offboarded'] as const).map(value=><button key={value} type="button" role="tab" aria-selected={filter===value}
      className={'project-tag'+(filter===value?' active':'')} onClick={()=>setFilter(value)}>{value==='active'?'Active':'Offboarded'} ({counts[value]})</button>)}
    </div>
    {!users&&!error&&<p role="status">Loading team…</p>}
    {users&&!shown.length&&<p>No {filter} mailboxes.</p>}
    <ul className="team-list">{shown.map(user=><li key={user.email}>
     {editing?.email===user.email?<form className="team-rename" onSubmit={saveName}>
      <label>Display name for {user.email}<input autoFocus maxLength={80} value={editing.name} placeholder="Leave blank to use the mailbox name"
       onChange={event=>setEditing({email:user.email,name:event.target.value})}/></label>
      <div className="team-actions"><button className="send" disabled={Boolean(busy)}>Save name</button>
       <button type="button" className="project-tag" disabled={Boolean(busy)} onClick={()=>setEditing(null)}>Cancel</button></div>
     </form>:<><div><b>{user.name}{user.admin?' · Senior admin':''}</b><small>{user.email}</small>
      <small>{user.status==='offboarded'
       ?'Offboarded '+shortDate(user.offboardedAt)+(user.offboardedBy?' by '+user.offboardedBy:'')
       :user.addedAt?'Added '+shortDate(user.addedAt)+(user.addedBy?' by '+user.addedBy:''):user.admin?'Set by SENIOR_ADMIN_EMAILS':'Listed in IONOS_ALLOWED_MAILBOXES'}</small>
      {user.status==='active'&&<small>HighLevel sign-in: {user.ghlSaved?'On (password saved here)':user.ghlEnv?'On (from GHL_IONOS_MAILBOX_PASSWORDS)':'Off'}</small>}</div>
     {ghlEditing===user.email&&<form className="team-rename" onSubmit={event=>void saveGhl(event,user.email)}>
      <label>IONOS mailbox password for {user.email}<input name="password" type="password" autoFocus required maxLength={1024} autoComplete="new-password" disabled={Boolean(busy)}/></label>
      <small>Checked with IONOS before saving. Stored encrypted and never shown again.</small>
      <div className="team-actions"><button className="send" disabled={Boolean(busy)}>{busy==='set-ghl-password:'+user.email?'Checking…':'Save password'}</button>
       <button type="button" className="project-tag" disabled={Boolean(busy)} onClick={()=>setGhlEditing('')}>Cancel</button></div>
     </form>}
     <div className="team-actions">
      <button type="button" className="project-tag" disabled={Boolean(busy)} onClick={()=>setEditing({email:user.email,name:user.customName})}>Rename</button>
      {user.status==='active'&&<button type="button" className="project-tag" disabled={Boolean(busy)}
       onClick={()=>setGhlEditing(ghlEditing===user.email?'':user.email)}>{user.ghlSaved?'Change HighLevel password':'Set HighLevel password'}</button>}
      {user.status==='active'&&user.ghlSaved&&<button type="button" className="project-tag" disabled={Boolean(busy)}
       onClick={()=>void run('clear-ghl-password',user.email)}>{busy==='clear-ghl-password:'+user.email?'Removing…':'Remove saved password'}</button>}
      {!user.admin&&user.status==='active'&&<>
       <button type="button" className="project-tag" disabled={Boolean(busy)} title="End every saved and open session for this mailbox"
        onClick={()=>void run('revoke',user.email)}>{busy==='revoke:'+user.email?'Signing out…':'Sign out everywhere'}</button>
       <button type="button" className="project-tag danger" disabled={Boolean(busy)} onClick={()=>setConfirm(user)}>Offboard</button>
      </>}
      {!user.admin&&user.status==='offboarded'&&<button type="button" className="project-tag" disabled={Boolean(busy)}
       onClick={()=>void run('onboard',user.email,user.customName)}>{busy==='onboard:'+user.email?'Restoring…':'Restore access'}</button>}
     </div></>}
    </li>)}</ul>
    {confirm&&<div className="team-confirm" role="alertdialog" aria-label={'Offboard '+confirm.email}>
     <p><b>Offboard {confirm.name}?</b> Access ends within 10 seconds on every device, including HighLevel auto sign-in. Their saved HighLevel password is deleted. Drafts and signatures stay saved so you can restore access later.</p>
     <p>Also change the mailbox password or set forwarding in IONOS so mail keeps reaching the team.</p>
     <div className="delete-confirmation-actions">
      <button type="button" className="send" disabled={Boolean(busy)} onClick={()=>void run('offboard',confirm.email)}>{busy?'Offboarding…':'Offboard'}</button>
      <button type="button" className="project-tag" disabled={Boolean(busy)} onClick={()=>setConfirm(null)}>Cancel</button>
     </div>
    </div>}
   </div>
  </section>
 </div>;
}
