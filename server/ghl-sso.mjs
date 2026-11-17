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
 const secret=env.GHL_APP_SHARED_SECRET;
 const companyId=env.GHL_COMPANY_ID?.trim();
 const locations=new Set((env.GHL_LOCATION_IDS||'').split(',').map(value=>value.trim()).filter(Boolean));
 const origins=new Set(['https://app.gohighlevel.com']);
 for (const value of (env.GHL_PARENT_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean)) {
  try {
   const url=new URL(value);
   if (url.protocol==='https:' && url.origin===value) origins.add(value);
  } catch {}
 }
 const mailboxes=new Map();
 try {
  const entries=Object.entries(JSON.parse(env.GHL_IONOS_MAILBOX_PASSWORDS||'{}'));
  for (const [email,password] of entries) {
   const address=email.trim().toLowerCase();
   if (allowed.has(address) && typeof password==='string' && password.length>0 && password.length<=1024) {
    mailboxes.set(address,password);
   }
  }
 } catch {}
 if (!secret || !companyId || !locations.size || !mailboxes.size) return null;

 function getCredentials(identity) {
  if (!identity || typeof identity.email!=='string' || typeof identity.userId!=='string' ||
      !identity.userId || identity.companyId!==companyId || !locations.has(identity.activeLocation)) return null;
  const email=identity.email.trim().toLowerCase();
  const password=mailboxes.get(email);
  return password ? {email,password} : null;
 }
 return {
  origins:[...origins],
  verify(payload,origin) {
   if (!origins.has(origin)) return null;
   const context=highLevelContext(payload,secret);
   const credentials=getCredentials(context);
   if (!credentials) return null;
   return {email:credentials.email,userId:context.userId,companyId:context.companyId,activeLocation:context.activeLocation};
  },
  getCredentials,
 };
}
