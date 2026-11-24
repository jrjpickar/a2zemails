import {pacificTime,sortHours} from '../../server/ai-sort.mjs';

// Netlify schedules run in UTC. 9 AM and 3 PM Pacific fall at 16/17 and 22/23 UTC depending on daylight
// saving time, so this runs at all four hours and starts the sort only when it is 9 or 3 in Pacific time.
export function createScheduledSort(env,{fetcher=fetch,now=()=>new Date()}={}) {
 return async () => {
  const {hour}=pacificTime(now());
  if (!sortHours.includes(hour)) return new Response(null,{status:204});
  const token=env.BID_DRY_RUN_TOKEN?.trim();
  if (!env.URL||!token||token.length<32) {
   console.warn('[AI sort] Set URL and BID_DRY_RUN_TOKEN to run scheduled sorting.');
   return new Response(null,{status:503});
  }
  const response=await fetcher(new URL('/.netlify/functions/ai-sort-background',env.URL),{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({trigger:'schedule'}),
   signal:AbortSignal.timeout(8000),
  });
  console.info('[AI sort] Scheduled run queued',response.status);
  return new Response(null,{status:response.ok||response.status===202?202:502});
 };
}

export default createScheduledSort(process.env);
export const config={schedule:'0 16,17,22,23 * * *'};
