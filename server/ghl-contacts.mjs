const contactAddress=/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
const locationPattern=/^[a-zA-Z0-9_-]{1,100}$/;

export function contactsConfig(env) {
 const token=env.GHL_CONTACTS_PIT_TOKEN?.trim();
 const locations=(env.GHL_LOCATION_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
 const locationId=env.GHL_CONTACTS_LOCATION_ID?.trim()||(locations.length===1?locations[0]:'');
 return token&&locationPattern.test(locationId)?{token,locationId}:null;
}

export async function searchContacts(config,query,fetchImpl=fetch) {
 if (typeof query!=='string'||query.length>100||/[\x00-\x1f\x7f]/.test(query)) throw new TypeError('Invalid contact search.');
 const trimmed=query.trim();
 if (trimmed.length<2) return [];
 const result=await fetchImpl('https://services.leadconnectorhq.com/contacts/search',{
  method:'POST',
  headers:{Authorization:'Bearer '+config.token,Version:'v3',Accept:'application/json','Content-Type':'application/json'},
  body:JSON.stringify({locationId:config.locationId,query:trimmed,page:1,pageLimit:12}),
  signal:AbortSignal.timeout(4000),
 });
 if (!result.ok) throw new Error('HighLevel contacts request failed.');
 const data=await result.json();
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
