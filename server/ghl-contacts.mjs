const contactAddress=/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
const locationPattern=/^[a-zA-Z0-9_-]{1,100}$/;

export function contactsConfig(env) {
 const token=env.GHL_CONTACTS_PIT_TOKEN?.trim();
 const locations=(env.GHL_LOCATION_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
 const locationId=env.GHL_CONTACTS_LOCATION_ID?.trim()||(locations.length===1?locations[0]:'');
 return token&&locationPattern.test(locationId)?{token,locationId}:null;
}

async function contactSearch(config,criteria,fetchImpl) {
 const result=await fetchImpl('https://services.leadconnectorhq.com/contacts/search',{
  method:'POST',
  headers:{Authorization:'Bearer '+config.token,Version:'v3',Accept:'application/json','Content-Type':'application/json'},
  body:JSON.stringify({locationId:config.locationId,page:1,...criteria}),
  signal:AbortSignal.timeout(4000),
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
 const addresses=[...new Set(mail.mail.filter(row=>row.folder==='Inbox')
  .map(row=>row.from.trim().toLowerCase()).filter(address=>contactAddress.test(address)))];
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
  for (const person of results.flat()) {
   const address=person.email.trim().toLowerCase();
   const value=person.customFields?.find(field=>field.id===config.fieldId)?.value;
   const label=typeof value==='string'?value.trim().toLowerCase():'';
   if (!['cold','warm','hot','vip'].includes(label)) continue;
   labels.set(address,labels.has(address)&&labels.get(address)!==label ? null : label);
  }
 } catch {
  return {...mail,temperatureFolders:true,temperatureUnavailable:true};
 }
 return {...mail,temperatureFolders:true,mail:mail.mail.map(row=>{
  const temperature=row.folder==='Inbox'&&labels.get(row.from.trim().toLowerCase());
  return temperature?{...row,temperature}:row;
 })};
}
