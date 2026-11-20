const contactAddress=/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
const emailKey=value=>typeof value==='string'?value.trim().toLowerCase():'';
const nameKey=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const contactName=person=>nameKey(person.name||[person.firstName,person.lastName].filter(Boolean).join(' '));
const locationPattern=/^[a-zA-Z0-9_-]{1,100}$/;

export function contactsConfig(env) {
 const token=env.GHL_CONTACTS_PIT_TOKEN?.trim();
 const locations=(env.GHL_LOCATION_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
 const locationId=env.GHL_CONTACTS_LOCATION_ID?.trim()||(locations.length===1?locations[0]:'');
 return token&&locationPattern.test(locationId)?{token,locationId}:null;
}

async function contactSearch(config,criteria,fetchImpl,signal=AbortSignal.timeout(4000)) {
 const result=await fetchImpl('https://services.leadconnectorhq.com/contacts/search',{
  method:'POST',
  headers:{Authorization:'Bearer '+config.token,Version:'v3',Accept:'application/json','Content-Type':'application/json'},
  body:JSON.stringify({locationId:config.locationId,page:1,...criteria}),
  signal,
 });
 if (!result.ok) throw new Error('HighLevel contacts request failed.');
 return result.json();
}

export async function searchContacts(config,query,fetchImpl=fetch) {
 if (typeof query!=='string'||query.length>100||/[\x00-\x1f\x7f]/.test(query)) throw new TypeError('Invalid contact search.');
 const trimmed=query.trim();
 if (trimmed.length<2) return [];
 const data=await contactSearch(config,{query:trimmed,pageLimit:12},fetchImpl);
 const contacts=[];
 const seen=new Set();
 for (const person of Array.isArray(data.contacts)?data.contacts:[]) {
  const address=typeof person.email==='string'?person.email.trim():'';
  const key=address.toLowerCase();
  if ((person.locationId&&person.locationId!==config.locationId)||!contactAddress.test(address)||seen.has(key)) continue;
  seen.add(key);
  const name=[person.firstName,person.lastName].filter(value=>typeof value==='string').join(' ').trim();
  contacts.push({address,name:(name||String(person.name||'')).slice(0,180),source:'HighLevel'});
  if (contacts.length>=8) break;
 }
 return contacts;
}

export function temperatureConfig(env,contacts=contactsConfig(env)) {
 const fieldId=env.GHL_TEMPERATURE_FIELD_ID?.trim();
 return fieldId&&contacts&&locationPattern.test(fieldId)?{...contacts,fieldId}:null;
}

export async function mailboxTemperatures(mail,config,fetchImpl=fetch) {
 if (!config) return mail;
 const inbox=mail.mail.filter(row=>row.folder==='Inbox');
 const addresses=[...new Set(inbox.map(row=>emailKey(row.from)).filter(address=>contactAddress.test(address)))];
 const labels=new Map();
 try {
  const batches=[];
  for (let start=0;start<addresses.length;start+=20) batches.push(addresses.slice(start,start+20));
  const results=await Promise.all(batches.map(async batch=>{
   const data=await contactSearch(config,{
    pageLimit:500,
    filters:[{group:'OR',filters:batch.map(value=>({field:'email',operator:'eq',value}))}],
   },fetchImpl);
   if (!Array.isArray(data.contacts)||data.contacts.length>=500) throw new Error('Incomplete HighLevel results.');
   return data.contacts.filter(person=>batch.includes(person.email?.trim().toLowerCase())&&
    (!person.locationId||person.locationId===config.locationId));
  }));
  const matchedAddresses=new Set();
  function addLabel(address,person) {
   matchedAddresses.add(address);
   const value=person.customFields?.find(field=>field.id===config.fieldId)?.value;
   const label=typeof value==='string'?value.trim().toLowerCase():'';
   if (!['cold','warm','hot','vip'].includes(label)) return;
   labels.set(address,labels.has(address)&&labels.get(address)!==label ? null : label);
  }
  for (const person of results.flat()) addLabel(emailKey(person.email),person);
  const peopleByName=new Map();
  for (const row of inbox) {
   const address=emailKey(row.from);
   const name=nameKey(row.name);
   if (matchedAddresses.has(address)||!contactAddress.test(address)||name===address||name.length>75||name.split(' ').length<2) continue;
   if (!peopleByName.has(name)) peopleByName.set(name,new Set());
   peopleByName.get(name).add(address);
  }
  // Bound concurrent fallback calls and look up each unresolved name once.
  const names=[...peopleByName];
  const nameMatches=new Map();
  const nameBudget=AbortSignal.timeout(3500);
  for (let offset=0;offset<names.length&&!nameBudget.aborted;offset+=8) {
   await Promise.all(names.slice(offset,offset+8).map(async ([name,senders])=>{
    try {
     const data=await contactSearch(config,{query:name,pageLimit:25},fetchImpl,nameBudget);
     if (!Array.isArray(data.contacts)||data.contacts.length>=25) return;
     const exact=data.contacts.filter(person=>(!person.locationId||person.locationId===config.locationId)&&contactName(person)===name);
     for (const address of senders) {
      const aliases=exact.filter(person=>Array.isArray(person.additionalEmails)&&person.additionalEmails.some(alias=>emailKey(alias?.email)===address));
      const person=aliases.length===1?aliases[0]:senders.size===1&&exact.length===1?exact[0]:null;
      if (!person?.id) continue;
      if (!nameMatches.has(address)) nameMatches.set(address,new Map());
      nameMatches.get(address).set(person.id,person);
     }
    } catch { /* Preserve verified email matches when a fallback lookup fails. */ }
   }));
  }
  for (const [address,matches] of nameMatches) {
   if (matches.size===1) addLabel(address,matches.values().next().value);
  }
 } catch {
  return {...mail,temperatureFolders:true,temperatureUnavailable:true};
 }
 return {...mail,temperatureFolders:true,mail:mail.mail.map(row=>{
  const temperature=row.folder==='Inbox'&&labels.get(emailKey(row.from));
  return temperature?{...row,temperature}:row;
 })};
}
