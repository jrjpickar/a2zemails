import {createIonosMailbox,ionosConfig} from '../../server/ionos.mjs';
import {intelContext} from '../../server/intel/context.mjs';
import {runTool} from '../../server/intel/tools.mjs';
import {mcpAccess,mcpMailbox} from '../../server/intel/mcp-auth.mjs';

// Dashboard metrics: GET /api/mcp/email-metrics?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD with the MCP_API_KEY bearer.
// Calculated from records in code. Unavailable values are null, not zero. Never calls AI.
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

export function createMetricsHandler(env,{makeMailbox=createIonosMailbox,mailbox:resolveMailbox=mcpMailbox,contextFor=intelContext}={}) {
 return async request=>{
  if (request.method!=='GET') return Response.json({error:'GET required'},{status:405,headers:{...headers,Allow:'GET'}});
  const access = mcpAccess(env,request);
  if (access.status) return Response.json({error:access.error},{status:access.status,headers});
  const login = await resolveMailbox(env);
  if (!login) return Response.json({error:'Set MCP_IONOS_EMAIL and its password.'},{status:503,headers});
  const params = new URL(request.url).searchParams;
  const args = Object.fromEntries(['dateFrom','dateTo'].filter(key=>params.get(key)).map(key=>[key,params.get(key)]));
  try {
   const mailbox = makeMailbox(ionosConfig({...env,A2Z_MODE:'live',A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:login.email,IONOS_PASSWORD:login.password}));
   const ctx = contextFor({email:login.email,mailbox,env,timeBudget:6000});
   const metrics = await runTool(ctx,'email_get_metrics',args);
   return Response.json({mailbox:login.email,generatedAt:new Date().toISOString(),...metrics},{headers});
  } catch (error) {
   return Response.json({error:error instanceof TypeError?error.message:'Metrics are unavailable right now.'},{status:error instanceof TypeError?400:502,headers});
  }
 };
}

export default createMetricsHandler(process.env);
export const config = {path:'/api/mcp/email-metrics',rateLimit:{windowLimit:30,windowSize:60,aggregateBy:['ip','domain']}};
