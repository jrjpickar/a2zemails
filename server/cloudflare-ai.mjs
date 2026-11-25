// Cloudflare Workers AI fallback for JSON jobs (sorting and HighLevel summaries) when Groq is rate limited.
// Uses the same variables as the A2Z MCP: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN, optional CLOUDFLARE_AI_MODEL.
import {cloudflareSettings} from './ask-ai.mjs';

export function cloudflareConfig(env) {
 const settings=cloudflareSettings(env||{});
 return settings.cloudflare?{account:settings.cloudflareAccount,token:settings.cloudflare,model:settings.cloudflareModel}:null;
}

export async function cloudflareJson(config,{system,user,maxTokens=2000,signal},fetcher=fetch) {
 if (!config) return null;
 const response=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+config.account+'/ai/v1/chat/completions',{
  method:'POST',signal:signal||AbortSignal.timeout(20000),
  headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
  body:JSON.stringify({model:config.model,temperature:0,max_tokens:maxTokens,response_format:{type:'json_object'},
   messages:[{role:'system',content:system+'\nReturn only valid JSON.'},{role:'user',content:user}]}),
 });
 if (!response.ok) return null;
 const data=await response.json();
 const text=data?.choices?.[0]?.message?.content;
 if (typeof text!=='string') return null;
 try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,'')); } catch { return null; }
}
