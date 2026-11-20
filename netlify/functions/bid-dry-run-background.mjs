import {openBidScan,scanBearerMatches} from '../../server/bid-scan-session.mjs';
import {mcpMailboxLogin} from '../../server/mcp-mail-auth.mjs';
import {createIonosMailbox,ionosConfig} from '../../server/ionos.mjs';
import {bidLeadConfig,dryRunBidLeads,withBidScanActivity} from '../../server/bid-leads.mjs';

export function createBidDryRunHandler(env,makeMailbox=createIonosMailbox,run=dryRunBidLeads,activity=withBidScanActivity) {
 return async request=>{
  if (request.method!=='POST') return new Response(null,{status:405});
  if (!scanBearerMatches(env,request)) return new Response(null,{status:401});
  const fromInbox=request.headers.get('content-type')==='application/json';
  const payload=fromInbox?await request.json().catch(()=>null):null;
  const login=fromInbox?openBidScan(env,payload?.ticket):mcpMailboxLogin(env,request,'BID_DRY_RUN_TOKEN');
  if (!login||login.status) return new Response(null,{status:login?.status||401});
  try {
   const config=bidLeadConfig(env);
   const mailbox=makeMailbox(ionosConfig({
    ...env,A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:login.email,IONOS_PASSWORD:login.password,
   }));
   const fresh=fromInbox?login.fresh===true:new URL(request.url).searchParams.get('fresh')==='1';
   const summary=await activity(login.email,()=>run({email:login.email,mailbox,config,fresh}));
   if (!summary) return new Response(null,{status:204});
   const {complete,counts,pipelines,reasons,providers,dedupeScope}=summary;
   console.info('[Bid dry run]',JSON.stringify({complete,counts,pipelines,reasons,providers,dedupeScope}));
  } catch(error) {
   const code=typeof error?.message==='string'&&/^(?:highlevel_|bid_lead_|geocode_)[a-z0-9_]+$/.test(error.message)
    ?error.message:'read_failed';
   console.warn('[Bid dry run] '+code);
   return new Response(null,{status:502});
  }
  return new Response(null,{status:204});
 };
}

export default createBidDryRunHandler(process.env);
export const config={background:true};
