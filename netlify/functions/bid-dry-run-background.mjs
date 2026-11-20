import {mcpMailboxLogin} from '../../server/mcp-mail-auth.mjs';
import {createIonosMailbox,ionosConfig} from '../../server/ionos.mjs';
import {bidLeadConfig,dryRunBidLeads} from '../../server/bid-leads.mjs';

export function createBidDryRunHandler(env,makeMailbox=createIonosMailbox,run=dryRunBidLeads) {
 return async request=>{
  if (request.method!=='POST') return new Response(null,{status:405});
  const login=mcpMailboxLogin(env,request,'BID_DRY_RUN_TOKEN');
  if (login.status) return new Response(null,{status:login.status});
  try {
   const config=bidLeadConfig(env);
   const mailbox=makeMailbox(ionosConfig({
    ...env,A2Z_ENABLE_LIVE:'true',IONOS_EMAIL:login.email,IONOS_PASSWORD:login.password,
   }));
   const summary=await run({email:login.email,mailbox,config});
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
