import {scanBearerMatches} from '../../server/bid-scan-session.mjs';
import {runScheduledSort} from '../../server/ai-sort.mjs';
import {teamDirectory} from '../../server/team-directory.mjs';
import {adminConsole} from '../../server/admin-console.mjs';

// Background function (up to 15 minutes) so every mailbox can be sorted in one run.
export function createSortHandler(env,{run=runScheduledSort,directoryFactory=teamDirectory,adminFactory=adminConsole}={}) {
 return async request=>{
  if (request.method!=='POST') return new Response(null,{status:405});
  if (env.A2Z_MODE!=='live'||!scanBearerMatches(env,request)) return new Response(null,{status:401});
  const input=await request.json().catch(()=>({}));
  try {
   await run(env,{directory:directoryFactory(env),admin:adminFactory(),trigger:input?.trigger==='manual'?'manual':'schedule'});
  } catch (error) {
   console.warn('[AI sort] Run failed',String(error?.message||error).slice(0,200));
   return new Response(null,{status:502});
  }
  return new Response(null,{status:204});
 };
}

export default createSortHandler(process.env);
export const config={background:true};
