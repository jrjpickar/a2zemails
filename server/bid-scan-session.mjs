import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const label=Buffer.from('a2z:bid-scan:v1');
const digest=value=>createHash('sha256').update(value).digest();
const derive=secret=>digest('a2z:bid-scan:v1:'+secret);

export function scanBearerMatches(env,request) {
 const token=env.BID_DRY_RUN_TOKEN?.trim();
 return Boolean(token&&token.length>=32&&
  timingSafeEqual(digest(request.headers.get('authorization')||''),digest('Bearer '+token)));
}

export function sealBidScan(secret,{email,password},fresh,now=Date.now()) {
 const iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',derive(secret),iv);
 cipher.setAAD(label);
 const data=Buffer.concat([cipher.update(JSON.stringify({email,password,fresh,expires:now+5*60000})),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');
}

export function openBidScan(env,ticket,now=Date.now()) {
 const secret=env.SESSION_SECRET;
 if (env.A2Z_MODE!=='live'||!secret||secret.length<32||typeof ticket!=='string'||ticket.length>12000) return null;
 try {
  const bytes=Buffer.from(ticket,'base64url');
  const cipher=createDecipheriv('aes-256-gcm',derive(secret),bytes.subarray(0,12));
  cipher.setAAD(label);
  cipher.setAuthTag(bytes.subarray(12,28));
  const login=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
  const allowed=(env.IONOS_ALLOWED_MAILBOXES||'').split(',').map(address=>address.trim().toLowerCase());
  return login.expires>now&&allowed.includes(login.email)&&typeof login.password==='string'&&login.password
   ?login:null;
 } catch {return null;}
}
