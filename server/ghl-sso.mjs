import {createDecipheriv,createHash} from 'node:crypto';

export function highLevelContext(payload, secret) {
 if (typeof payload !== 'string' || payload.length>24000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
 try {
  // HighLevel's passphrase format is OpenSSL salted AES-256-CBC, as used by CryptoJS.
  const bytes=Buffer.from(payload,'base64');
  if (bytes.subarray(0,8).toString()!=='Salted__' || bytes.length<32 || bytes.length%16!==0) return null;
  const salt=bytes.subarray(8,16);
  const password=Buffer.from(secret);
  const blocks=[];
  let previous=Buffer.alloc(0);
  for (let index=0;index<3;index++) {
   previous=createHash('md5').update(previous).update(password).update(salt).digest();
   blocks.push(previous);
  }
  const material=Buffer.concat(blocks);
  const decipher=createDecipheriv('aes-256-cbc',material.subarray(0,32),material.subarray(32));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]).toString('utf8'));
 } catch { return null; }
}

export function createHighLevelLogin(env, allowed) {
 const secret=env.GHL_APP_SHARED_SECRET?.trim();
 const companyId=env.GHL_COMPANY_ID?.trim();
 const locations=new Set((env.GHL_LOCATION_IDS||'').split(',').map(value=>value.trim()).filter(Boolean));
 const origins=new Set(['https://app.gohighlevel.com']);
 for (const value of (env.GHL_PARENT_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean)) {
  try {
   const url=new URL(value);
   if (url.protocol==='https:' && url.origin===value) origins.add(value);
  } catch {}
 }
 const issues=[];
 if (!secret) issues.push('GHL_APP_SHARED_SECRET is missing or blank');
 if (!companyId) issues.push('GHL_COMPANY_ID is missing or blank');
 if (!locations.size) issues.push('GHL_LOCATION_IDS is missing or blank');

 const mailboxes=new Map();
 const raw=env.GHL_IONOS_MAILBOX_PASSWORDS?.trim();
 if (!raw) issues.push('GHL_IONOS_MAILBOX_PASSWORDS is missing or blank');
 else {
  try {
   const mapping=JSON.parse(raw);
   if (!mapping || typeof mapping!=='object' || Array.isArray(mapping)) {
    issues.push('GHL_IONOS_MAILBOX_PASSWORDS must be a JSON object');
   } else {
    for (const [email,password] of Object.entries(mapping)) {
     const address=email.trim().toLowerCase();
     if (allowed.has(address) && typeof password==='string' && password.trim() && password.length<=1024) {
      mailboxes.set(address,password);
     }
    }
    if (!mailboxes.size) issues.push('No mailbox in GHL_IONOS_MAILBOX_PASSWORDS has a password and matches IONOS_ALLOWED_MAILBOXES');
   }
  } catch {
   issues.push('GHL_IONOS_MAILBOX_PASSWORDS is not valid JSON');
  }
 }
 if (issues.length) return {login:null,issues};

 function getCredentials(identity) {
  if (!identity || typeof identity.email!=='string' || typeof identity.userId!=='string' ||
      !identity.userId || identity.companyId!==companyId || !locations.has(identity.activeLocation)) return null;
  const email=identity.email.trim().toLowerCase();
  const password=mailboxes.get(email);
  return password ? {email,password} : null;
 }
 return {issues,login:{
  origins:[...origins],
  verify(payload,origin) {
   if (!origins.has(origin)) return {failure:'ghl_origin'};
   const context=highLevelContext(payload,secret);
   if (!context || typeof context.userId!=='string' || !context.userId) return {failure:'ghl_context'};
   if (context.companyId!==companyId) return {failure:'ghl_agency'};
   if (!locations.has(context.activeLocation)) return {failure:'ghl_location'};
   const credentials=getCredentials(context);
   if (!credentials) return {failure:'ghl_mailbox'};
   return {identity:{email:credentials.email,userId:context.userId,companyId:context.companyId,activeLocation:context.activeLocation}};
  },
  getCredentials,
 }};
}
