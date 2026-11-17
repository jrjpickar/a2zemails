import {createHash,timingSafeEqual} from 'node:crypto';
import {createIonosMailbox,ionosConfig} from '../../server/ionos.mjs';
import {commandCenterStats} from '../../src/model.mjs';

const digest=value=>createHash('sha256').update(value).digest();
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export function createCommandCenterHandler(env,makeMailbox=createIonosMailbox) {
 return async request=>{
  if (request.method!=='GET') return reply({error:'Method not allowed'},405);
  const token=env.MCP_COMMAND_CENTER_TOKEN;
  const email=env.MCP_IONOS_EMAIL?.trim().toLowerCase();
  const allowed=(env.IONOS_ALLOWED_MAILBOXES||'').split(',').map(value=>value.trim().toLowerCase());
  if (env.A2Z_MODE!=='live'||!token||token.length<32||!email||!allowed.includes(email)) {
   return reply({error:'Command Center integration is unavailable.'},503);
  }
  const authorization=request.headers.get('authorization')||'';
  if (!timingSafeEqual(digest(authorization),digest('Bearer '+token))) return reply({error:'Unauthorized'},401);
  try {
   let password=env.MCP_IONOS_PASSWORD;
   if (!password) {
    try {
     const mapping=JSON.parse(env.GHL_IONOS_MAILBOX_PASSWORDS||'{}');
     password=Object.entries(mapping).find(([key])=>key.trim().toLowerCase()===email)?.[1];
    } catch {}
   }
   if (typeof password!=='string'||!password) return reply({error:'Command Center mailbox is not configured.'},503);
   const mailbox=makeMailbox(ionosConfig({...env,A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:email,IONOS_PASSWORD:password}));
   const {mail}=await mailbox.mail();
   return reply({stats:commandCenterStats(mail),asOf:new Date().toISOString(),coverage:'recent_mail'});
  } catch {
   console.warn('[MCP] Command Center mailbox could not be read.');
   return reply({error:'Could not load Command Center stats.'},502);
  }
 };
}
export default createCommandCenterHandler(process.env);
export const config={path:'/api/mcp/command-center',rateLimit:{windowLimit:12,windowSize:60,aggregateBy:['ip','domain']}};
