import {getStore} from '@netlify/blobs';
import {createHash} from 'node:crypto';

// Cloudflare Workers AI client. The only text model provider for Ask AI, sorting, summaries and writing.
// - Primary CLOUDFLARE_AI_MODEL (default @cf/openai/gpt-oss-120b), fallback CLOUDFLARE_AI_FALLBACK_MODEL (default @cf/openai/gpt-oss-20b).
// - Timeouts, one bounded retry per model, 429 cooldown, in-flight de-duplication.
// - Daily neuron budget (estimated from token usage) so inference stops before the free allowance is used up.

export const defaultModel = '@cf/openai/gpt-oss-120b';
export const defaultFallback = '@cf/openai/gpt-oss-20b';
const modelPattern = /^@cf\/[a-z0-9._\/-]{3,100}$/i;

// Estimated neurons per 1,000 tokens, from Workers AI list prices ($0.011 per 1,000 neurons).
// Override with CLOUDFLARE_NEURON_RATES as JSON {"model":[input,output]} if Cloudflare changes pricing.
const rates = {
 '@cf/openai/gpt-oss-120b':[31.8,68.2],
 '@cf/openai/gpt-oss-20b':[18.2,27.3],
 '@cf/meta/llama-3.3-70b-instruct-fp8-fast':[26.4,204.5],
};

export function llmConfig(env={}) {
 const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
 const token = (env.CLOUDFLARE_API_TOKEN||env.CLOUDFLARE_AI_TOKEN)?.trim();
 if (!account||!token||!/^[a-f0-9]{32}$/i.test(account)) return null;
 const model = modelPattern.test(env.CLOUDFLARE_AI_MODEL?.trim()||'') ? env.CLOUDFLARE_AI_MODEL.trim() : defaultModel;
 const fallback = modelPattern.test(env.CLOUDFLARE_AI_FALLBACK_MODEL?.trim()||'') ? env.CLOUDFLARE_AI_FALLBACK_MODEL.trim() : defaultFallback;
 let custom = {};
 try { custom = JSON.parse(env.CLOUDFLARE_NEURON_RATES||'{}')||{}; } catch {}
 const budget = Number(env.CLOUDFLARE_DAILY_NEURON_BUDGET);
 return {account,token,model,fallback:fallback===model?null:fallback,
  budget:Number.isFinite(budget)&&budget>0?budget:9000,rates:{...rates,...custom}};
}

export const estimateTokens = text => Math.ceil(String(text||'').length/4);
export function estimateNeurons(config,model,input,output) {
 const [inRate,outRate] = config?.rates?.[model] || rates[defaultModel];
 return Math.round((input/1000)*inRate + (output/1000)*outRate);
}

const utcDay = (time=Date.now()) => new Date(time).toISOString().slice(0,10);

// Per-day usage in Blobs: requests, tokens and estimated neurons, by model and by feature.
export function usageStore({storeFactory=()=>getStore({name:'ai-usage',consistency:'strong'})}={}) {
 let store;
 const blobs = () => (store ||= storeFactory());
 const memory = new Map();
 return {
  async day(day=utcDay()) {
   try { return (await blobs().get('day/'+day,{type:'json'}))||memory.get(day)||{requests:0,neurons:0,input:0,output:0,byModel:{},byFeature:{},failures:0}; }
   catch { return memory.get(day)||{requests:0,neurons:0,input:0,output:0,byModel:{},byFeature:{},failures:0}; }
  },
  async add({model,feature='other',input=0,output=0,neurons=0,failed=false}) {
   const day = utcDay();
   for (let attempt=0;attempt<3;attempt++) {
    try {
     const current = await blobs().getWithMetadata('day/'+day,{type:'json'});
     const data = current?.data || {requests:0,neurons:0,input:0,output:0,byModel:{},byFeature:{},failures:0};
     data.requests += failed?0:1; data.failures += failed?1:0;
     data.neurons += neurons; data.input += input; data.output += output;
     data.byModel[model] = (data.byModel[model]||0)+neurons;
     data.byFeature[feature] = (data.byFeature[feature]||0)+(failed?0:1);
     const result = await blobs().setJSON('day/'+day,data,current?.etag?{onlyIfMatch:current.etag}:{onlyIfNew:true});
     if (result?.modified!==false) {memory.set(day,data);return data;}
    } catch {
     const data = memory.get(day)||{requests:0,neurons:0,input:0,output:0,byModel:{},byFeature:{},failures:0};
     data.requests += failed?0:1; data.neurons += neurons; memory.set(day,data);
     return data;
    }
   }
   return null;
  },
  async range(from,to) {
   const days = [];
   for (let time=Date.parse(from+'T00:00:00Z');time<=Date.parse(to+'T00:00:00Z')&&days.length<400;time+=86400000) days.push(utcDay(time));
   const rows = await Promise.all(days.map(day=>this.day(day)));
   return rows.reduce((sum,row)=>({requests:sum.requests+row.requests,neurons:sum.neurons+row.neurons}),{requests:0,neurons:0});
  },
 };
}

export class QuotaError extends Error {
 constructor(message='The daily Cloudflare AI allowance is used up. Search and reports still work.') {super(message);this.code='ai_quota';}
}
export class UnavailableError extends Error {
 constructor(message='Cloudflare Workers AI is not available right now.') {super(message);this.code='ai_unavailable';}
}

const cooldowns = new Map();
const inflight = new Map();
export function resetLlmState() {cooldowns.clear();inflight.clear();}

function payloadFor(model,{messages,json=false,maxTokens=2048,temperature=0.2,reasoning=null,stream=false}) {
 return {model,messages,temperature,max_tokens:maxTokens,stream,
  ...(reasoning&&/gpt-oss/.test(model)?{reasoning_effort:reasoning}:{}),
  ...(json?{response_format:{type:'json_object'}}:{})};
}

function textFrom(data) {
 const choice = data?.choices?.[0];
 const text = choice?.message?.content ?? data?.result?.response ?? data?.response;
 return typeof text==='string' ? text : null;
}

// One model call with bounded retry. Throws {status,retry} errors for the caller's fallback logic.
async function callModel(config,model,options,fetcher) {
 const url = 'https://api.cloudflare.com/client/v4/accounts/'+config.account+'/ai/v1/chat/completions';
 let body = payloadFor(model,options);
 for (let attempt=0;attempt<2;attempt++) {
  const signal = options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeout||25000)]) : AbortSignal.timeout(options.timeout||25000);
  let response;
  try {
   response = await fetcher(url,{method:'POST',signal,redirect:'error',
    headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  } catch (error) {
   if (options.signal?.aborted) throw Object.assign(new Error('Stopped'),{code:'aborted'});
   if (attempt===0) continue;
   throw Object.assign(new Error('Cloudflare request timed out'),{status:0,retry:true});
  }
  if (response.ok) return response;
  await response.body?.cancel?.();
  // Some models reject reasoning or JSON settings; retry once without them.
  if (response.status===400&&(body.reasoning_effort||body.response_format)&&attempt===0) {
   body = payloadFor(model,{...options,reasoning:null,json:false});
   continue;
  }
  if (response.status>=500&&attempt===0) continue;
  throw Object.assign(new Error('Cloudflare returned '+response.status),{status:response.status,retry:response.status===429||response.status>=500||response.status===408});
 }
 throw Object.assign(new Error('Cloudflare request failed'),{status:0,retry:true});
}

// Non-streaming chat with fallback. Returns {text, model, usage}.
export async function chat(config,options,{fetcher=fetch,usage=null,feature='other'}={}) {
 if (!config) throw new UnavailableError('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to turn on AI.');
 if (usage) {
  const today = await usage.day();
  if (today.neurons>=config.budget) throw new QuotaError();
 }
 const key = createHash('sha256').update(JSON.stringify([options.messages,options.json,options.maxTokens])).digest('hex');
 if (inflight.has(key)) return inflight.get(key);
 const run = (async()=>{
  let lastError;
  for (const model of [config.model,config.fallback].filter(Boolean)) {
   if ((cooldowns.get(model)||0)>Date.now()) continue;
   try {
    const response = await callModel(config,model,{...options,stream:false},fetcher);
    const data = await response.json();
    const text = textFrom(data);
    if (!text?.trim()) throw Object.assign(new Error('Empty answer'),{retry:true});
    const input = data?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(options.messages));
    const output = data?.usage?.completion_tokens ?? estimateTokens(text);
    const neurons = estimateNeurons(config,model,input,output);
    await usage?.add({model,feature,input,output,neurons});
    return {text,model,usage:{input,output,neurons,reported:Boolean(data?.usage)}};
   } catch (error) {
    if (error.code==='aborted') throw error;
    lastError = error;
    if (error.status===429) cooldowns.set(model,Date.now()+30000);
    await usage?.add({model,feature,failed:true});
    if (!error.retry&&error.status&&error.status!==404) break;
   }
  }
  if (lastError?.status===429) throw new QuotaError('Cloudflare is rate limiting AI requests. Try again in a minute. Search and reports still work.');
  throw new UnavailableError();
 })();
 inflight.set(key,run);
 try { return await run; } finally { inflight.delete(key); }
}

export async function chatJson(config,options,context) {
 const result = await chat(config,{...options,json:true,temperature:0},context);
 const cleaned = result.text.replace(/^```(?:json)?\s*|\s*```$/g,'').trim();
 const start = cleaned.indexOf('{');
 try { return {...result,data:JSON.parse(start>0?cleaned.slice(start):cleaned)}; }
 catch { throw Object.assign(new UnavailableError('The AI returned an unreadable plan.'),{code:'ai_bad_json'}); }
}

// Streaming chat. Calls onDelta(text) as tokens arrive. Falls back to the next model only before the first token.
export async function chatStream(config,options,{fetcher=fetch,usage=null,feature='other',onDelta}={}) {
 if (!config) throw new UnavailableError('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to turn on AI.');
 if (usage&&(await usage.day()).neurons>=config.budget) throw new QuotaError();
 let lastError;
 for (const model of [config.model,config.fallback].filter(Boolean)) {
  if ((cooldowns.get(model)||0)>Date.now()) continue;
  let started = false, text = '', reportedUsage = null;
  try {
   const response = await callModel(config,model,{...options,stream:true},fetcher);
   const type = response.headers.get('content-type')||'';
   if (!type.includes('event-stream')||!response.body) {
    const data = await response.json();
    text = textFrom(data)||'';
    if (!text.trim()) throw Object.assign(new Error('Empty answer'),{retry:true});
    started = true; onDelta?.(text); reportedUsage = data?.usage||null;
   } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
     const {value,done} = await reader.read();
     if (done) break;
     buffer += decoder.decode(value,{stream:true});
     let index;
     while ((index=buffer.indexOf('\n'))>=0) {
      const line = buffer.slice(0,index).trim(); buffer = buffer.slice(index+1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload||payload==='[DONE]') continue;
      let event; try { event = JSON.parse(payload); } catch { continue; }
      const delta = event?.choices?.[0]?.delta?.content ?? event?.response ?? '';
      if (event?.usage) reportedUsage = event.usage;
      if (typeof delta==='string'&&delta) {started = true;text += delta;onDelta?.(delta);}
     }
    }
    if (!text.trim()) throw Object.assign(new Error('Empty answer'),{retry:true});
   }
   const input = reportedUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(options.messages));
   const output = reportedUsage?.completion_tokens ?? estimateTokens(text);
   const neurons = estimateNeurons(config,model,input,output);
   await usage?.add({model,feature,input,output,neurons});
   return {text,model,usage:{input,output,neurons,reported:Boolean(reportedUsage)}};
  } catch (error) {
   if (error.code==='aborted'||options.signal?.aborted) throw Object.assign(new Error('Stopped'),{code:'aborted',partial:text});
   lastError = error;
   if (error.status===429) cooldowns.set(model,Date.now()+30000);
   await usage?.add({model,feature,failed:true});
   if (started) throw Object.assign(new UnavailableError('The answer was interrupted. Retry to continue.'),{partial:text});
  }
 }
 if (lastError?.status===429) throw new QuotaError('Cloudflare is rate limiting AI requests. Try again in a minute. Search and reports still work.');
 throw new UnavailableError();
}

export function llmStatus(config) {
 if (!config) return {configured:false,available:false,detail:'Cloudflare credentials are not set'};
 const now = Date.now();
 const resting = [config.model,config.fallback].filter(model=>model&&(cooldowns.get(model)||0)>now);
 return {configured:true,available:resting.length<[config.model,config.fallback].filter(Boolean).length,model:config.model,fallback:config.fallback,
  coolingDown:resting,budget:config.budget};
}

// Optional: Cloudflare's own neuron count via the GraphQL Analytics API. Needs Account Analytics read on the token.
export async function providerUsage(config,fetcher=fetch,day=utcDay()) {
 if (!config) return null;
 try {
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql',{method:'POST',signal:AbortSignal.timeout(6000),
   headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
   body:JSON.stringify({query:'query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:1,filter:{date:$d}){sum{totalNeurons}}}}}',
    variables:{a:config.account,d:day}})});
  if (!response.ok) return null;
  const data = await response.json();
  const value = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups?.[0]?.sum?.totalNeurons;
  return Number.isFinite(value) ? Math.round(value) : null;
 } catch { return null; }
}
