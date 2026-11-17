import {createHash,timingSafeEqual} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest();

export function mcpMailboxLogin(env,request,tokenName) {
 const token=env[tokenName];
 const email=env.MCP_IONOS_EMAIL?.trim().toLowerCase();
 const allowed=(env.IONOS_ALLOWED_MAILBOXES||'').split(',').map(value=>value.trim().toLowerCase());
 if (env.A2Z_MODE!=='live'||!token||token.length<32||!email||!allowed.includes(email)) return {status:503};
 const authorization=request.headers.get('authorization')||'';
 if (!timingSafeEqual(digest(authorization),digest('Bearer '+token))) return {status:401};
 let password=env.MCP_IONOS_PASSWORD;
 if (!password) {
  try {
   const mapping=JSON.parse(env.GHL_IONOS_MAILBOX_PASSWORDS||'{}');
   password=Object.entries(mapping).find(([key])=>key.trim().toLowerCase()===email)?.[1];
  } catch {}
 }
 return typeof password==='string'&&password?{email,password}:{status:503};
}
