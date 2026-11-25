// Cloudflare Workers AI for JSON jobs (sorting and HighLevel summaries). Groq is no longer used.
// Variables: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (or CLOUDFLARE_AI_TOKEN), CLOUDFLARE_AI_MODEL, CLOUDFLARE_AI_FALLBACK_MODEL.
import {chatJson,llmConfig} from './intel/llm.mjs';
import {sharedUsage} from './intel/usage.mjs';

export function cloudflareConfig(env) {
 return llmConfig(env||{});
}

// Background jobs may use at most 70% of the daily budget so Ask AI always has room.
export async function cloudflareJson(config,{system,user,maxTokens=2000,signal,feature='background'},fetcher=fetch) {
 if (!config) return null;
 const today = await sharedUsage.day().catch(()=>null);
 if (today&&today.neurons>=config.budget*0.7) return null;
 try {
  const result = await chatJson(config,{maxTokens,reasoning:'low',signal,messages:[{role:'system',content:system+'\nReturn only valid JSON.'},{role:'user',content:user}]},
   {fetcher,usage:sharedUsage,feature});
  return result.data;
 } catch { return null; }
}
