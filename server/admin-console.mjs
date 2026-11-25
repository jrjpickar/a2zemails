import {getStore} from '@netlify/blobs';
import {randomBytes} from 'node:crypto';
import {categories} from '../src/model.mjs';

// Senior admin console: sorting keywords, user activity and health checks.
// Everything lives in Netlify Blobs. Activity events are encoded in blob keys so a
// day can be summarized with one list call and no per-event reads.

const keywordKey = 'sorting-keywords';
const maxKeywords = 300;
const keywordCacheMs = 30_000;
const activityDays = 30;
const lastSeenThrottleMs = 10 * 60 * 1000;

export const activityActions = ['sign-in','sign-in-failed','ghl-sign-in','open','send','ask-ai','export','bid-scan','team','keywords','settings','ai-action','mcp','error'];

const day = time => new Date(time).toISOString().slice(0,10);
const encode = value => Buffer.from(String(value||'')).toString('base64url');
const decode = value => { try { return Buffer.from(value,'base64url').toString('utf8'); } catch { return ''; } };

export function cleanKeyword(input) {
 const term = typeof input?.term==='string' ? input.term.replace(/\s+/g,' ').trim() : '';
 if (term.length<2 || term.length>80 || /[\x00-\x1f\x7f]/.test(term)) throw new TypeError('Enter a keyword of 2 to 80 characters.');
 if (!categories.includes(input?.category)) throw new TypeError('Choose a category for this keyword.');
 const field = input?.field==='any' ? 'any' : 'subject';
 return {term,category:input.category,field};
}

export function adminConsole({storeFactory=name=>getStore({name,consistency:'strong'}),now=Date.now}={}) {
 const stores = new Map();
 const store = name => {
  if (!stores.has(name)) stores.set(name,storeFactory(name));
  return stores.get(name);
 };
 let keywordCache = null;
 let keywordCachedAt = 0;
 const lastSeen = new Map();

 async function keywords(force=false) {
  if (!force && keywordCache && now()-keywordCachedAt<keywordCacheMs) return keywordCache;
  try {
   const data = await store('admin-settings').get(keywordKey,{type:'json'});
   keywordCache = Array.isArray(data?.keywords) ? data.keywords : [];
   keywordCachedAt = now();
  } catch { keywordCache ||= []; }
  return keywordCache;
 }

 async function updateKeywords(actor,input) {
  const op = input?.op;
  if (!['add','remove'].includes(op)) throw new TypeError('Unknown keyword action.');
  const settings = store('admin-settings');
  for (let attempt=0;attempt<4;attempt++) {
   const current = await settings.getWithMetadata(keywordKey,{type:'json'});
   const list = Array.isArray(current?.data?.keywords) ? [...current.data.keywords] : [];
   if (op==='add') {
    const keyword = cleanKeyword(input);
    const existing = list.findIndex(item=>item.term.toLowerCase()===keyword.term.toLowerCase());
    if (existing<0 && list.length>=maxKeywords) throw new TypeError('Remove a keyword before adding another. The limit is '+maxKeywords+'.');
    const entry = {id:randomBytes(6).toString('hex'),...keyword,addedBy:actor,addedAt:new Date(now()).toISOString()};
    if (existing>=0) list[existing] = entry; else list.push(entry);
   } else {
    const index = list.findIndex(item=>item.id===input?.id);
    if (index<0) throw new TypeError('That keyword was already removed.');
    list.splice(index,1);
   }
   const result = await settings.setJSON(keywordKey,{keywords:list},current?.etag?{onlyIfMatch:current.etag}:{onlyIfNew:true});
   if (result?.modified!==false) {
    keywordCache = list;
    keywordCachedAt = now();
    return list;
   }
  }
  throw new Error('Keywords changed while saving. Try again.');
 }

 // Best effort. Activity logging never blocks or fails a mailbox request.
 async function record(email,action,{throttle=false}={}) {
  if (!activityActions.includes(action)) return;
  const time = now();
  const address = String(email||'').toLowerCase().slice(0,254);
  if (throttle) {
   const key = address+'|'+action;
   if (time-(lastSeen.get(key)||0)<lastSeenThrottleMs) return;
   lastSeen.set(key,time);
  }
  try {
   const key = 'e/'+day(time)+'/'+time.toString(36)+'-'+randomBytes(3).toString('hex')+'~'+action+'~'+encode(address);
   await store('activity').set(key,'1');
  } catch { /* Activity is optional. */ }
 }

 async function activity({days=7}={}) {
  const span = Math.min(Math.max(Number(days)||7,1),activityDays);
  const today = now();
  const events = [];
  const blobs = store('activity');
  for (let offset=0;offset<span;offset++) {
   const prefix = 'e/'+day(today-offset*86400000)+'/';
   const {blobs:list} = await blobs.list({prefix});
   for (const {key} of list) {
    const [stamp,action,email] = key.slice(prefix.length).split('~');
    const time = parseInt(stamp.split('-')[0],36);
    if (Number.isFinite(time) && activityActions.includes(action)) events.push({at:new Date(time).toISOString(),action,email:decode(email)});
   }
  }
  events.sort((a,b)=>b.at.localeCompare(a.at));
  const users = {};
  const daily = {};
  for (const event of events) {
   const date = event.at.slice(0,10);
   daily[date] ||= Object.fromEntries(activityActions.map(action=>[action,0]));
   daily[date][event.action]++;
   if (!event.email) continue;
   const user = users[event.email] ||= {email:event.email,lastSeen:event.at,counts:Object.fromEntries(activityActions.map(action=>[action,0]))};
   user.counts[event.action]++;
  }
  void prune(blobs,today).catch(()=>{});
  return {days:span,events:events.slice(0,150),users:Object.values(users).sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen)),
   daily:Object.entries(daily).sort(([a],[b])=>b.localeCompare(a)).map(([date,counts])=>({date,...counts}))};
 }

 async function prune(blobs,today) {
  // Delete one expired day per view to keep the store small without a scheduled job.
  for (let offset=activityDays+1;offset<activityDays+15;offset++) {
   const prefix = 'e/'+day(today-offset*86400000)+'/';
   const {blobs:list} = await blobs.list({prefix});
   if (!list.length) continue;
   await Promise.all(list.slice(0,500).map(({key})=>blobs.delete(key)));
   return;
  }
 }

 return {keywords,updateKeywords,record,activity};
}

// Health checks run in parallel with a short timeout each. Only status, timing and safe detail are returned.
export async function healthChecks(checks,{timeout=7000}={}) {
 const run = async ([name,check]) => {
  const started = performance.now();
  try {
   const result = await Promise.race([check(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Timed out after '+timeout/1000+' s')),timeout))]);
   return {name,status:result?.status||'ok',detail:result?.detail||'',ms:Math.round(performance.now()-started)};
  } catch (error) {
   return {name,status:'fail',detail:String(error?.message||'Check failed').slice(0,200),ms:Math.round(performance.now()-started)};
  }
 };
 return {checkedAt:new Date().toISOString(),checks:await Promise.all(Object.entries(checks).map(run))};
}
