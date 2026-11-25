import {getStore} from '@netlify/blobs';
import {createHash} from 'node:crypto';
import {createIonosMailbox,ionosConfig} from './ionos.mjs';
import {noteStore,postEmailNotes} from './ghl-notes.mjs';
import {mailIndex} from './intel/index.mjs';

// Scheduled AI sorting. Runs at 9 AM and 3 PM Pacific for every active mailbox with a saved password,
// stores the AI's categories in Netlify Blobs, and the inbox applies them on load without asking the AI again.

const maxLabels = 2000;
const lastRunKey = 'last-run';
export const sortHours = [9,15];

const mailboxKey = email => 'labels/'+createHash('sha256').update(String(email).toLowerCase()).digest('hex');

export function pacificTime(now=new Date()) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',hourCycle:'h23',
  year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));
 return {hour:Number(parts.hour),day:parts.year+'-'+parts.month+'-'+parts.day};
}

export function aiLabelStore({storeFactory=()=>getStore({name:'ai-labels',consistency:'strong'})}={}) {
 let store;
 const blobs = () => (store ||= storeFactory());
 return {
  async load(email) {
   try {
    const data = await blobs().get(mailboxKey(email),{type:'json'});
    return new Map(Object.entries(data?.labels||{}).map(([id,entry])=>[id,entry.category]));
   } catch { return new Map(); }
  },
  async save(email,labels,dates) {
   const current = await blobs().get(mailboxKey(email),{type:'json'}).catch(()=>null);
   const merged = {...(current?.labels||{})};
   const stamp = new Date().toISOString();
   for (const [id,category] of labels) merged[id] = {category,date:dates.get(id)||stamp};
   const kept = Object.entries(merged).sort(([,a],[,b])=>String(b.date).localeCompare(String(a.date))).slice(0,maxLabels);
   await blobs().setJSON(mailboxKey(email),{sortedAt:stamp,labels:Object.fromEntries(kept)});
   return kept.length;
  },
  async lastRun() {
   try { return await blobs().get(lastRunKey,{type:'json'}); } catch { return null; }
  },
  async saveRun(summary) {
   await blobs().setJSON(lastRunKey,summary);
  },
 };
}

function envPasswords(env) {
 try {
  const mapping = JSON.parse(env.GHL_IONOS_MAILBOX_PASSWORDS||'{}');
  return new Map(Object.entries(mapping||{}).filter(([,value])=>typeof value==='string'&&value).map(([email,value])=>[email.trim().toLowerCase(),value]));
 } catch { return new Map(); }
}

export async function runScheduledSort(env,{directory,admin,labels=aiLabelStore(),notes=noteStore(),makeMailbox=createIonosMailbox,fetcher=fetch,trigger='schedule'}={}) {
 const started = new Date();
 const passwords = envPasswords(env);
 const mcp = env.MCP_IONOS_EMAIL?.trim().toLowerCase();
 if (mcp && env.MCP_IONOS_PASSWORD) passwords.set(mcp,env.MCP_IONOS_PASSWORD);
 const users = (await directory.list()).filter(user=>user.status==='active');
 const keywords = await admin.keywords(true);
 const noteSettings = await notes.settings();
 const noteResults = [];
 const results = [];
 for (const user of users) {
  const password = await directory.credential(user.email) || passwords.get(user.email);
  if (!password) {results.push({email:user.email,status:'skipped',detail:'No saved password. Set one in Admin console > Team.'});continue;}
  const began = Date.now();
  try {
   const config = {...ionosConfig({...env,A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:user.email,IONOS_PASSWORD:password}),
    keywords,storedLabels:await labels.load(user.email),groqDeadline:90_000,returnAiLabels:true};
   if (!config.cloudflare) throw new Error('Cloudflare Workers AI is not configured');
   const mailbox = makeMailbox(config);
   const data = await mailbox.mail({includeTrash:false});
   const fresh = new Map(Object.entries(data.aiLabels||{}));
   const dates = new Map(data.mail.map(row=>[row.id,row.date]));
   const stored = await labels.save(user.email,fresh,dates);
   // Refresh the Ask AI / MCP index and backfill older mail while the background function has time.
   if (typeof mailbox.indexFolder==='function') await mailIndex({email:user.email,mailbox,force:true,timeBudget:90_000,backfillLimit:1500}).catch(()=>{});
   results.push({email:user.email,status:'ok',sorted:fresh.size,stored,ms:Date.now()-began});
   if (noteSettings.enabled) {
    // data.mail already carries the final categories (keywords, rules and AI), so skipped categories are respected.
    try { noteResults.push({email:user.email,...await postEmailNotes({env,email:user.email,mail:data.mail,settings:noteSettings,store:notes,fetcher})}); }
    catch (error) { noteResults.push({email:user.email,status:'failed',detail:String(error?.message||'HighLevel notes failed').slice(0,160)}); }
   }
  } catch (error) {
   const auth = error?.authenticationFailed||error?.code==='EAUTH'||error?.serverResponseCode==='AUTHENTICATIONFAILED';
   results.push({email:user.email,status:'failed',detail:auth?'IONOS rejected the saved password':String(error?.message||'Mailbox read failed').slice(0,160),ms:Date.now()-began});
  }
 }
 const summary = {trigger,startedAt:started.toISOString(),finishedAt:new Date().toISOString(),results};
 await labels.saveRun(summary);
 if (noteSettings.enabled) await notes.saveRun({finishedAt:summary.finishedAt,trigger,results:noteResults}).catch(()=>{});
 console.info('[AI sort]',JSON.stringify({trigger,results:results.map(({email,status,sorted})=>({email,status,sorted}))}));
 return summary;
}
