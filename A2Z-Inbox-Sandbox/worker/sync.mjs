import { ImapFlow } from 'imapflow';
import pg from 'pg';
const env = process.env;
if(env.A2Z_MODE!=='live'||env.A2Z_ENABLE_LIVE!=='true'){
 console.log('Sandbox mode: IMAP connections are disabled.'); process.exit(0);
}
for(const key of ['IONOS_EMAIL','IONOS_PASSWORD','DATABASE_URL']) if(!env[key]) throw new Error(key+' is required');
const pool=new pg.Pool({connectionString:env.DATABASE_URL});
const mailbox=(await pool.query('INSERT INTO mailboxes(address) VALUES($1) ON CONFLICT(address) DO UPDATE SET address=excluded.address RETURNING id',[env.IONOS_EMAIL])).rows[0].id;
let running=true, client;
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{running=false;client?.close()});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const poll=Math.max(15,Number(env.IMAP_POLL_SECONDS)||60)*1000;
async function sync(folder){
 const lock=await client.getMailboxLock(folder);
 try {
  const generation=String(client.mailbox.uidValidity);
  const cursor=(await pool.query('SELECT uid_validity,last_uid FROM sync_cursors WHERE mailbox_id=$1 AND folder=$2',[mailbox,folder])).rows[0];
  const last=generation===cursor?.uid_validity?Number(cursor.last_uid):0;
  if(cursor && cursor.uid_validity!==generation) await pool.query('UPDATE mailbox_items SET expunged_at=now() WHERE mailbox_id=$1 AND folder=$2 AND uid_validity<>$3 AND expunged_at IS NULL',[mailbox,folder,generation]);
  const existing=(await client.search({all:true},{uid:true}))||[];
  const maximum=Number(client.mailbox.uidNext)-1;
  const pending=existing.filter(uid=>uid>last && uid<=maximum).sort((a,b)=>a-b);
  for(let offset=0;offset<pending.length;offset+=50){
   const page=pending.slice(offset,offset+50);
   for await(const m of client.fetch(page,{uid:true,envelope:true,internalDate:true,flags:true,source:true},{uid:true})){
    const addresses=a=>(a||[]).map(x=>x.address).filter(Boolean).join(', ');
    await pool.query(`INSERT INTO mailbox_items(mailbox_id,folder,uid_validity,uid,message_id,subject,sender,recipients,received_at,flags,raw)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT(mailbox_id,folder,uid_validity,uid) DO UPDATE SET flags=excluded.flags,expunged_at=NULL`,
 [mailbox,folder,generation,m.uid,m.envelope?.messageId||null,m.envelope?.subject||'',addresses(m.envelope?.from),addresses(m.envelope?.to),m.internalDate||null,[...m.flags],m.source]);
   }
   await pool.query(`INSERT INTO sync_cursors(mailbox_id,folder,uid_validity,last_uid) VALUES($1,$2,$3,$4)
 ON CONFLICT(mailbox_id,folder) DO UPDATE SET uid_validity=excluded.uid_validity,last_uid=excluded.last_uid`,[mailbox,folder,generation,page.at(-1)]);
  }
  await pool.query('UPDATE mailbox_items SET expunged_at=now() WHERE mailbox_id=$1 AND folder=$2 AND uid_validity=$3 AND expunged_at IS NULL AND NOT(uid=ANY($4::bigint[]))',[mailbox,folder,generation,existing]);
 }finally{lock.release()}
}
let delay=1000;
while(running){
 client=new ImapFlow({host:env.IONOS_IMAP_HOST||'imap.ionos.com',port:Number(env.IONOS_IMAP_PORT||993),secure:true,auth:{user:env.IONOS_EMAIL,pass:env.IONOS_PASSWORD},logger:false,disableAutoIdle:true,maxIdleTime:poll,missingIdleCommand:'NOOP'});
 let dirty=true;
 client.on('exists',()=>{dirty=true});client.on('expunge',()=>{dirty=true});client.on('error',()=>{dirty=true});
 try{
  await client.connect();
  let folders=new Set();
  while(running && client.usable){
   if(dirty){dirty=false;const current=new Set((await client.list()).filter(f=>!f.flags.has('\\Noselect')).map(f=>f.path));
    for(const f of folders)if(!current.has(f))await pool.query('UPDATE mailbox_items SET expunged_at=now() WHERE mailbox_id=$1 AND folder=$2 AND expunged_at IS NULL',[mailbox,f]);
    for(const f of current) await sync(f);
    folders=current;delay=1000;
   }
   if(!running)break;
   if(!folders.has('INBOX')||!client.capabilities.has('IDLE')){await sleep(poll);dirty=true;continue}
   await client.mailboxOpen('INBOX');
   let timer, wake;
   const idle=client.idle();
   const signal=new Promise(resolve=>{
    wake=()=>resolve(true);
    timer=setTimeout(wake,poll);
    client.once('exists',wake);client.once('expunge',wake);
   });
   const ended=await Promise.race([idle.then(()=>false),signal]).finally(()=>{
    clearTimeout(timer);client.off('exists',wake);client.off('expunge',wake);
   });
   if(ended&&client.usable)await client.noop();
   dirty=true;
  }
 }catch(e){if(running)console.error('IMAP sync interrupted:',e.code||e.name)}
 finally{client.close()}
 if(running){await sleep(delay);delay=Math.min(delay*2,60000)}
}
await pool.end();
