import {getStore} from '@netlify/blobs';
import {createHash} from 'node:crypto';

// Mailbox index for Ask AI and MCP. One blob per mailbox folder with compact metadata and a short text preview.
// Synced incrementally by IMAP UID: new mail first, then older mail in bounded backfill pages, plus flag refresh.
// Queries run on this index in code; the AI never receives the whole mailbox.

const skipFolders = new Set(['Trash','Spam','Drafts','A2Z Delivery Reports']);
const maxRows = 4000;
const staleMs = 5*60*1000;
const memoryMs = 60*1000;
const hash = value => createHash('sha256').update(String(value).toLowerCase()).digest('hex').slice(0,32);

export function indexStore({storeFactory=()=>getStore({name:'mail-index',consistency:'strong'})}={}) {
 let store;
 const blobs = () => (store ||= storeFactory());
 // Storage failures never break a request; the index is rebuilt from IMAP when Blobs is unavailable.
 const safe = async (run,fallback) => {try {return await run();} catch {return fallback;}};
 return {
  read:(email,path)=>safe(()=>blobs().getWithMetadata('idx/'+hash(email)+'/'+hash(path),{type:'json'}),null),
  write:(email,path,data,etag)=>safe(()=>blobs().setJSON('idx/'+hash(email)+'/'+hash(path),data,etag?{onlyIfMatch:etag}:{onlyIfNew:true}),{modified:false}),
  folders:email=>safe(()=>blobs().get('folders/'+hash(email),{type:'json'}),null),
  saveFolders:(email,list)=>safe(()=>blobs().setJSON('folders/'+hash(email),{list,at:new Date().toISOString()}),null),
 };
}

const cache = new Map();
export function clearIndexCache() {cache.clear();}

// Sync then return all rows. timeBudget bounds interactive requests; background runs pass a larger one.
export async function mailIndex({email,mailbox,store=indexStore(),force=false,timeBudget=7000,backfillLimit=150,newLimit=300,now=Date.now}) {
 const hit = cache.get(email);
 if (!force&&hit&&now()-hit.at<memoryMs) return hit.value;
 const started = now();
 let folders = await store.folders(email);
 if (!folders||now()-Date.parse(folders.at)>6*3600000) {
  try {
   const list = (await mailbox.indexFolders()).filter(entry=>!skipFolders.has(entry.folder));
   await store.saveFolders(email,list);
   folders = {list,at:new Date().toISOString()};
  } catch (error) {
   if (!folders) throw error;
  }
 }
 const status = {folders:[],syncErrors:[]};
 const rows = [];
 for (const entry of folders.list.slice(0,20)) {
  const saved = await store.read(email,entry.path);
  let data = saved?.data || {path:entry.path,folder:entry.folder,uidValidity:null,highUid:0,lowUid:0,complete:false,syncedAt:null,rows:[]};
  const stale = !data.syncedAt||now()-Date.parse(data.syncedAt)>staleMs;
  if ((stale||force)&&now()-started<timeBudget) {
   try {
    const recent = data.rows.slice(0,400).map(row=>row.uid);
    const delta = await mailbox.indexFolder(entry.path,{uidValidity:data.uidValidity,highUid:data.highUid,lowUid:data.lowUid,
     newLimit,backfillLimit:data.complete?0:backfillLimit,flagUids:recent});
    if (delta.reset) data = {...data,rows:[],complete:false};
    const byId = new Map(data.rows.map(row=>[row.id,row]));
    for (const row of delta.rows) byId.set(row.id,{...row,folder:entry.folder});
    if (delta.flags) {
     const byUid = new Map([...byId.values()].map(row=>[row.uid,row]));
     for (const uid of recent) {
      const row = byUid.get(uid);
      if (!row) continue;
      if (!(uid in delta.flags)) byId.delete(row.id);
      else row.flags = delta.flags[uid];
     }
    }
    const merged = [...byId.values()].sort((a,b)=>b.uid-a.uid).slice(0,maxRows);
    data = {...data,uidValidity:delta.uidValidity,highUid:delta.newHigh,lowUid:Number.isFinite(delta.newLow)?delta.newLow:data.lowUid,
     complete:delta.reachedStart||merged.length>=maxRows,syncedAt:new Date(now()).toISOString(),rows:merged};
    await store.write(email,entry.path,data,saved?.etag);
   } catch (error) {
    status.syncErrors.push({folder:entry.folder,error:String(error?.message||'sync failed').slice(0,120)});
   }
  }
  status.folders.push({folder:entry.folder,count:data.rows.length,complete:data.complete,syncedAt:data.syncedAt,
   oldest:data.rows.at(-1)?.date||null});
  rows.push(...data.rows);
 }
 rows.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
 const syncedTimes = status.folders.map(item=>item.syncedAt).filter(Boolean).sort();
 const value = {rows,status:{...status,lastSync:syncedTimes.at(-1)||null,
  coverageStart:status.folders.every(item=>item.complete)?null:status.folders.map(item=>item.oldest).filter(Boolean).sort().at(-1)||null}};
 cache.set(email,{at:now(),value});
 return value;
}
