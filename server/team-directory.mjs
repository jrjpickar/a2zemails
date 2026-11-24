import {getStore} from '@netlify/blobs';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

// Team access directory. Senior admins (SENIOR_ADMIN_EMAILS) onboard and offboard mailboxes
// from the app without editing IONOS_ALLOWED_MAILBOXES or redeploying.
// Effective access: senior admins, plus env-listed and onboarded mailboxes, minus offboarded mailboxes.

const directoryKey = 'directory';
const mailboxAddress = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
const listFrom = value => (value||'').split(',').map(entry=>entry.trim().toLowerCase()).filter(Boolean);

export function seniorAdmins(env) {
 return new Set([...listFrom(env.SENIOR_ADMIN_EMAILS),...listFrom(env.SENIOR_ADMIN_EMAIL)]);
}

export function displayName(email,name) {
 const given = typeof name==='string' ? name.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,80) : '';
 if (given) return given;
 const local = String(email||'').split('@')[0]||'';
 const words = local.split(/[._\-+]+/).filter(Boolean);
 return words.length ? words.map(word=>word[0].toUpperCase()+word.slice(1).toLowerCase()).join(' ') : 'A2Z user';
}

function cleanName(value) {
 if (value===undefined||value===null) return '';
 if (typeof value!=='string'||value.length>80||/[\x00-\x1f\x7f<>]/.test(value)) throw new TypeError('Enter a name of up to 80 characters.');
 return value.trim();
}

// HighLevel auto sign-in passwords are encrypted with a key derived from SESSION_SECRET.
// They are never returned to the browser. Rotating SESSION_SECRET means re-entering them.
function credentialKey(secret) {
 return secret && secret.length>=32 ? createHash('sha256').update('a2z-ghl-credential:'+secret).digest() : null;
}
function sealPassword(key,email,password) {
 const iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(Buffer.from(email));
 const body=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
}
function openPassword(key,email,sealed) {
 try {
  const bytes=Buffer.from(sealed,'base64url');
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(email));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
 } catch { return null; }
}
function envGhlMailboxes(raw) {
 try {
  const mapping=JSON.parse(raw||'{}');
  return new Set(Object.entries(mapping||{}).filter(([,value])=>typeof value==='string'&&value.trim()).map(([email])=>email.trim().toLowerCase()));
 } catch { return new Set(); }
}

function normalize(data) {
 const users = {};
 if (data && typeof data.users==='object' && !Array.isArray(data.users)) {
  for (const [email,entry] of Object.entries(data.users)) {
   if (mailboxAddress.test(email) && entry && typeof entry==='object') users[email]=entry;
  }
 }
 return {users};
}

export function teamDirectory(env, {storeFactory=()=>getStore({name:'team-directory',consistency:'strong'}),now=Date.now,ttl=10_000}={}) {
 const envAllowed = new Set(listFrom(env.IONOS_ALLOWED_MAILBOXES));
 const admins = seniorAdmins(env);
 const key = credentialKey(env.SESSION_SECRET);
 const envGhl = envGhlMailboxes(env.GHL_IONOS_MAILBOX_PASSWORDS);
 let store;
 let cache = null;
 let cachedAt = 0;
 function blobs() {
  store ||= storeFactory();
  return store;
 }
 async function read(force=false) {
  if (!force && cache && now()-cachedAt<ttl) return cache;
  try {
   cache = normalize(await blobs().get(directoryKey,{type:'json'}));
   cachedAt = now();
  } catch (error) {
   // Without Blobs (tests, local loopback) or during an outage, use the last known directory, else env only.
   if (!cache) console.warn('[Team] Directory unavailable. Using IONOS_ALLOWED_MAILBOXES only.',error?.name||'');
   cache ||= {users:{}};
  }
  return cache;
 }
 function entryAccess(email,entry) {
  if (admins.has(email)) return true;
  if (entry?.status==='offboarded') return false;
  return envAllowed.has(email) || entry?.status==='active';
 }
 async function access(email,issued) {
  const address = String(email||'').trim().toLowerCase();
  const entry = (await read()).users[address];
  const revoked = Boolean(entry?.revokedAt && (!issued || issued<entry.revokedAt));
  return {
   allowed: entryAccess(address,entry) && !revoked,
   admin: admins.has(address),
   name: displayName(address,entry?.name),
   namedByAdmin: Boolean(entry?.name),
  };
 }
 async function credential(email) {
  const address = String(email||'').trim().toLowerCase();
  const entry = (await read()).users[address];
  if (!key || !entry?.ghlCredential || !entryAccess(address,entry)) return null;
  return openPassword(key,address,entry.ghlCredential);
 }
 async function list() {
  const {users} = await read(true);
  const emails = new Set([...admins,...envAllowed,...Object.keys(users)]);
  return [...emails].sort().map(email=>{
   const entry = users[email]||{};
   return {
    email,name:displayName(email,entry.name),customName:entry.name||'',
    status:entryAccess(email,entry)?'active':'offboarded',
    admin:admins.has(email),envListed:envAllowed.has(email),
    addedAt:entry.addedAt||null,addedBy:entry.addedBy||null,
    offboardedAt:entry.status==='offboarded'?entry.offboardedAt||null:null,
    offboardedBy:entry.status==='offboarded'?entry.offboardedBy||null:null,
    revokedAt:entry.revokedAt||null,
    ghlSaved:Boolean(entry.ghlCredential),ghlEnv:envGhl.has(email),
   };
  });
 }
 async function update(actor,input) {
  const op = input?.op;
  const email = typeof input?.email==='string' ? input.email.trim().toLowerCase() : '';
  if (!['onboard','offboard','revoke','rename','set-ghl-password','clear-ghl-password'].includes(op)) throw new TypeError('Unknown team action.');
  if (!mailboxAddress.test(email) || email.length>254) throw new TypeError('Enter a full mailbox address.');
  if (admins.has(email) && ['onboard','offboard','revoke'].includes(op)) throw new TypeError('Senior admins are managed with SENIOR_ADMIN_EMAILS.');
  if (op==='set-ghl-password') {
   if (!key) throw new TypeError('SESSION_SECRET must be set to save HighLevel passwords.');
   if (typeof input.password!=='string' || !input.password || input.password.length>1024) throw new TypeError('Enter the mailbox password.');
  }
  const name = cleanName(input?.name);
  const stamp = new Date(now()).toISOString();
  for (let attempt=0;attempt<4;attempt++) {
   const current = await blobs().getWithMetadata(directoryKey,{type:'json'});
   const data = normalize(current?.data);
   const entry = {...(data.users[email]||{})};
   if (op==='onboard') {
    Object.assign(entry,{status:'active',addedAt:stamp,addedBy:actor});
    delete entry.offboardedAt; delete entry.offboardedBy;
    if (name) entry.name=name;
   } else if (op==='offboard') {
    Object.assign(entry,{status:'offboarded',offboardedAt:stamp,offboardedBy:actor,revokedAt:now()});
    delete entry.ghlCredential;
   } else if (op==='set-ghl-password') {
    if (!entryAccess(email,entry)) throw new TypeError('Give this mailbox access before saving its password.');
    entry.ghlCredential=sealPassword(key,email,input.password);
    entry.ghlUpdatedAt=stamp;
   } else if (op==='clear-ghl-password') {
    delete entry.ghlCredential;
    delete entry.ghlUpdatedAt;
   } else if (op==='revoke') {
    entry.revokedAt=now();
   } else {
    if (name) entry.name=name; else delete entry.name;
   }
   data.users[email]=entry;
   const result = await blobs().setJSON(directoryKey,data,current?.etag?{onlyIfMatch:current.etag}:{onlyIfNew:true});
   if (result?.modified!==false) {
    cache=data;
    cachedAt=now();
    return list();
   }
  }
  throw new Error('The team directory changed. Try again.');
 }
 return {admins,envAllowed,access,credential,list,update};
}
