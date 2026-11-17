import {mcpMailboxLogin} from '../../server/mcp-mail-auth.mjs';
import {createIonosMailbox,ionosConfig} from '../../server/ionos.mjs';
import {commandCenterStats} from '../../src/model.mjs';

const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export function createCommandCenterHandler(env,makeMailbox=createIonosMailbox) {
 return async request=>{
  if (request.method!=='GET') return reply({error:'Method not allowed'},405);
  const login=mcpMailboxLogin(env,request,'MCP_COMMAND_CENTER_TOKEN');
  if (login.status) return reply({error:login.status===401?'Unauthorized':'Command Center integration is unavailable.'},login.status);
  const {email,password}=login;
  try {
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
