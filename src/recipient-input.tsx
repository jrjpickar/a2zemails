import {useEffect,useId,useRef,useState} from 'react';

export type Contact = {address:string;name:string;source?:string};

const emailPattern=/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;

export function RecipientInput({label,value,onChange,contacts,autoFocus,lookup}:{
 label:string;value:string;onChange:(value:string)=>void;contacts:Contact[];autoFocus?:boolean;
 lookup?:(query:string,signal:AbortSignal)=>Promise<Contact[]>;
}) {
 const id=useId();
 const input=useRef<HTMLInputElement>(null);
 const [focused,setFocused]=useState(false);
 const [active,setActive]=useState(0);
 const [remote,setRemote]=useState<{query:string;contacts:Contact[]}>({query:'',contacts:[]});
 const pieces=value.split(/[,;\r\n]/);
 const pending=pieces.pop()||'';
 const recipients=pieces.map(piece=>piece.trim()).filter(Boolean);
 const picked=new Set(recipients.map(address=>address.toLowerCase()));
 const fragment=pending.trim().toLowerCase();

 useEffect(()=>{
  if (!lookup||!focused||fragment.length<2||fragment.length>100) return;
  const controller=new AbortController();
  const timer=window.setTimeout(()=>{
   void lookup(fragment,controller.signal).then(results=>{
    if (!controller.signal.aborted) setRemote({query:fragment,contacts:results});
   }).catch(()=>{});
  },300);
  return ()=>{window.clearTimeout(timer);controller.abort()};
 },[lookup,focused,fragment]);

 const eligible=(contact:Contact)=>!picked.has(contact.address.toLowerCase())&&contact.address.toLowerCase()!==fragment;
 const local=focused&&fragment ? contacts.filter(contact=>eligible(contact)&&
  (contact.address.toLowerCase().includes(fragment)||contact.name.toLowerCase().includes(fragment))) : [];
 const online=focused&&remote.query===fragment ? remote.contacts.filter(eligible) : [];
 const matches=[...new Map([...local.slice(0,online.length?4:8),...online].map(
  contact=>[contact.address.toLowerCase(),contact])).values()].slice(0,8);
 const selected=Math.min(active,matches.length-1);

 function write(addresses:string[],text:string) {
  onChange(addresses.length?addresses.join(', ')+', '+text:text);
 }

 function choose(address:string) {
  write(picked.has(address.toLowerCase())?recipients:[...recipients,address],'');
  setActive(0);
  input.current?.focus();
 }

 return <div className="recipient-label">
  <label htmlFor={id+'-input'}>{label}</label>
  <div className="recipient-control">
   <div className="recipient-tokens">
    {recipients.map((address,index)=><button type="button" className="recipient-token"
     key={address+':'+index} title={address} aria-label={'Remove '+address+' from '+label}
     onClick={()=>{write(recipients.filter((_,position)=>position!==index),pending);input.current?.focus()}}>
     <span>{address}</span><span aria-hidden="true">×</span>
    </button>)}
    <input ref={input} id={id+'-input'} autoFocus={autoFocus} role="combobox" aria-label={label} inputMode="email"
     autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-autocomplete="list" aria-expanded={matches.length>0}
     aria-controls={matches.length?id:undefined} aria-activedescendant={selected>=0?id+'-'+selected:undefined}
     value={pending.trimStart()} onChange={event=>{write(recipients,event.target.value);setActive(0);setFocused(true)}}
     onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
     onPaste={event=>{
      const text=event.clipboardData.getData('text');
      if (!/[,;\r\n]/.test(text)) return;
      const pasted=text.split(/[,;\r\n]+/).map(item=>item.trim()).filter(Boolean);
      if (!pasted.length||!pasted.every(address=>emailPattern.test(address))) return;
      event.preventDefault();
      const next=new Map(recipients.map(address=>[address.toLowerCase(),address]));
      if (emailPattern.test(pending.trim())) next.set(pending.trim().toLowerCase(),pending.trim());
      for (const address of pasted) next.set(address.toLowerCase(),address);
      write([...next.values()],'');
     }}
     onKeyDown={event=>{
      if (event.nativeEvent.isComposing) return;
      if (matches.length&&(event.key==='ArrowDown'||event.key==='ArrowUp')) {
       event.preventDefault();
       setActive((selected+(event.key==='ArrowDown'?1:matches.length-1))%matches.length);
      }
      if (event.key==='Enter'||event.key===','||event.key===';') {
       event.preventDefault();
       const address=pending.trim();
       if (emailPattern.test(address)) choose(address);
       else if (event.key==='Enter'&&selected>=0) choose(matches[selected].address);
      }
      if (event.key==='Escape'&&matches.length) {
       event.stopPropagation();
       setFocused(false);
      }
      if (event.key==='Backspace'&&!pending&&recipients.length) write(recipients.slice(0,-1),'');
     }}
     placeholder={recipients.length?'Add another':label==='To'?'Name or email address':'Email address'}/>
   </div>
   {matches.length>0&&<div className="recipient-options" id={id} role="listbox">
    {matches.map((contact,index)=><div key={contact.address} role="option" id={id+'-'+index} aria-selected={selected===index}
     onMouseDown={event=>event.preventDefault()} onClick={()=>choose(contact.address)}>
     {contact.name&&<strong>{contact.name}</strong>}<span>{contact.address}{contact.source&&<small className="contact-source"> · {contact.source}</small>}</span>
    </div>)}
   </div>}
  </div>
 </div>;
}
