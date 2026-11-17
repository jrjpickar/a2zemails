import {useId,useState} from 'react';

export type Contact = {address:string;name:string};

export function RecipientInput({label,value,onChange,contacts,autoFocus}:{
 label:string;value:string;onChange:(value:string)=>void;contacts:Contact[];autoFocus?:boolean;
}) {
 const id=useId();
 const [focused,setFocused]=useState(false);
 const [active,setActive]=useState(0);
 const delimiter=Math.max(value.lastIndexOf(','),value.lastIndexOf(';'));
 const prefix=value.slice(0,delimiter+1);
 const fragment=value.slice(delimiter+1).trim().toLowerCase();
 const matches=focused&&fragment ? contacts.filter(contact=>
  contact.address.toLowerCase()!==fragment && (contact.address.toLowerCase().includes(fragment)||
   contact.name.toLowerCase().includes(fragment))).slice(0,8) : [];
 const selected=Math.min(active,matches.length-1);
 function choose(contact:Contact) {
  onChange(prefix+(prefix?' ':'')+contact.address);
  setActive(0);
 }
 return <label className="recipient-label">{label}
  <span className="recipient-control">
   <input autoFocus={autoFocus} role="combobox" aria-label={label} inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-autocomplete="list" aria-expanded={matches.length>0}
    aria-controls={matches.length?id:undefined} aria-activedescendant={selected>=0?id+'-'+selected:undefined}
    value={value} onChange={event=>{onChange(event.target.value);setActive(0);setFocused(true)}}
    onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
    onKeyDown={event=>{
     if (!matches.length) return;
     if (event.key==='ArrowDown'||event.key==='ArrowUp') {
      event.preventDefault();
      setActive((selected+(event.key==='ArrowDown'?1:matches.length-1))%matches.length);
     }
     if (event.key==='Enter') {
      event.preventDefault();
      choose(matches[selected]);
     }
     if (event.key==='Escape') {
      event.stopPropagation();
      setFocused(false);
     }
    }} placeholder={label==='To'?'recipient@example.com':undefined}/>
   {matches.length>0&&<span className="recipient-options" id={id} role="listbox">
    {matches.map((contact,index)=><span key={contact.address} role="option" id={id+'-'+index} aria-selected={selected===index}
     onMouseDown={event=>event.preventDefault()} onClick={()=>choose(contact)}>
     {contact.name&&<strong>{contact.name}</strong>}<span>{contact.address}</span>
    </span>)}
   </span>}
  </span>
 </label>;
}
