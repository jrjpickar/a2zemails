import {setTimeout as delay} from 'node:timers/promises';
import {askAiPrompt} from './ask-ai-prompt.mjs';

const providerTimeout = 15000;
const totalTimeout = 40000;
const temperature = 0.3;
const maxTokens = 4096;

export function aiConfig(env) {
 return {gemini:env.GEMINI_API_KEY?.trim(),groq:env.GROQ_API_KEY?.trim()};
}

export function aiEnabled(config) {
 return Boolean(config.gemini||config.groq);
}

const providers = [
 {
  key:'gemini',name:'Gemini',model:'gemini-3.8-flash',
  url:'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  headers:key=>({'x-goog-api-key':key}),
  payload:(messages,{prompt=askAiPrompt,temp=temperature,json=false,schema})=>({
   systemInstruction:{parts:[{text:prompt}]},
   contents:messages.map(({role,content})=>({role:role==='assistant'?'model':'user',parts:[{text:content}]})),
   generationConfig:{temperature:temp,maxOutputTokens:maxTokens,...(json?{responseMimeType:"application/json",...(schema?{responseJsonSchema:schema}:{})}:{})},
  }),
  answer(data) {
   const candidate=data?.candidates?.[0];
   if (data?.promptFeedback?.blockReason||candidate?.finishReason==='SAFETY') return {reason:'safety_block'};
   if (!candidate) return {reason:'malformed_response'};
   if (candidate.finishReason!=='STOP') return {reason:'incomplete_response'};
   const parts=candidate.content?.parts;
   return Array.isArray(parts) ? {text:parts.filter(part=>!part?.thought).map(part=>part?.text||'').join('')} :
    {reason:'malformed_response'};
  },
 },
 {
  key:'groq',name:'Groq',model:'openai/gpt-oss-120b',
  url:'https://api.groq.com/openai/v1/chat/completions',
  headers:key=>({Authorization:'Bearer '+key}),
  payload:(messages,{prompt=askAiPrompt,temp=temperature,json=false,schema,model:settingsModel})=>({
   model:settingsModel||'openai/gpt-oss-120b',reasoning_effort:'low',temperature:temp,max_completion_tokens:maxTokens,
   ...(json?{response_format:schema?{type:'json_schema',json_schema:{name:'bid_invites',strict:true,schema}}:{type:'json_object'}}:{}),
   messages:[{role:'system',content:prompt},...messages],
  }),
  answer(data) {
   const choice=data?.choices?.[0];
   if (choice?.finish_reason==='content_filter'||choice?.message?.refusal) return {reason:'safety_block'};
   const text=choice?.message?.content;
   return typeof text==='string' ? {text} : {reason:'malformed_response'};
  },
 },
];

const bidProviders=[
 {...providers[0],timeout:11000},
 {...providers[1],timeout:8500},
 {...providers[1],model:'openai/gpt-oss-20b',timeout:7500,optional:true},
 {...providers[1],model:'qwen/qwen3.8-27b',timeout:7500,optional:true},
];

function cleanAnswer(text) {
 return text.replace(/<(think|thinking|analysis)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'').trim()
  .replace(/^(?:as an ai(?: language model| assistant)?)[,:]\s*/i,'').trim();
}

async function attempt(provider,key,messages,signal,fetcher,settings) {
 let response;
 try {
  response=await fetcher(provider.url,{
   method:'POST',headers:{'Content-Type':'application/json',...provider.headers(key)},
   body:JSON.stringify(provider.payload(messages,{...settings,model:provider.model})),signal,
  });
 } catch (error) {
  return {reason:signal.aborted||error?.name==='TimeoutError'?'timeout':'network_error'};
 }
 if (!response.ok) {
  const status=response.status;
  return {reason:'http_'+status,retry:status===429||status>=500,stop:status>=400&&status<500&&status!==408&&status!==429&&!(provider.optional&&status===404)};
 }
 try {
  const result=provider.answer(await response.json());
  if (result.reason) return result;
  const answer=cleanAnswer(result.text);
  if (/^(?:\[?(?:blocked by (?:the )?safety filter|safety block|content filtered)\]?)[.!]?$/i.test(answer)) {
   return {reason:'safety_block'};
  }
  if (!answer) return {reason:'empty_response'};
  return {answer:settings.validate?settings.validate(answer):answer};
 } catch {
  return {reason:signal.aborted?'timeout':'malformed_response'};
 }
}

async function runProvider(provider,key,messages,budget,fetcher,settings) {
 // A retry shares the provider's 15-second allocation, including backoff.
 const signal=AbortSignal.any([budget,AbortSignal.timeout(provider.timeout||providerTimeout)]);
 const first=await attempt(provider,key,messages,signal,fetcher,settings);
 if (!first.retry||signal.aborted) return first;
 try {await delay(1000,undefined,{signal});} catch {return {reason:'timeout'};}
 return attempt(provider,key,messages,signal,fetcher,settings);
}

export async function runAiChain(config,messages,{budget=AbortSignal.timeout(totalTimeout),fetcher=fetch,attempts=[],bidScan=false,cooldowns,...settings}={}) {
 let fallbackReason=null;
 for (const provider of bidScan?bidProviders:providers) {
  const key=config[provider.key];
  if (!key) {
   fallbackReason??=provider.key+'_not_configured';
   continue;
  }
  if (budget.aborted) break;
  if ((cooldowns?.get(provider.model)||0)>Date.now()) {
   fallbackReason??='provider_cooling_down';
   continue;
  }
  const result=await runProvider(provider,key,messages,budget,fetcher,settings);
  if (result.answer!==undefined) return {...result,provider:provider.name,model:provider.model,fallbackReason};
  attempts.push({provider:provider.name,model:provider.model,reason:result.reason});
  if (cooldowns&&(result.reason==='timeout'||result.reason==='http_429'||/^http_5/.test(result.reason))) {
   cooldowns.set(provider.model,Date.now()+(result.reason==='http_429'?30000:10000));
  }
  if (result.stop) return {...result,fallbackReason};
  fallbackReason??=result.reason;
 }
 return {fallbackReason};
}

const unavailable={status:502,data:{error:'Ask AI is temporarily unavailable. Try again.'}};

export async function askEmail(config,mailbox,input,fetcher=fetch) {
 const started=performance.now();
 const question=typeof input?.question==='string'?input.question.trim():'';
 const history=input?.history??[];
 const attempts=[];
 let answeredBy=null;
 let fallbackReason=null;
 try {
  if (!question||question.length>2000||(input.id!==undefined&&typeof input.id!=='string')||
      !Array.isArray(history)||history.length>6||history.length%2!==0||
      history.some((turn,index)=>turn?.role!==(index%2?'assistant':'user')||
       typeof turn.content!=='string'||!turn.content.trim()||turn.content.length>2000)) {
   return {status:400,data:{error:'Enter a question of up to 2,000 characters.'}};
  }
  if (!aiEnabled(config)) return {status:503,data:{error:'Ask AI has no provider configured.'}};
  const budget=AbortSignal.timeout(totalTimeout);
  const message=input.id
   ? await waitForContext(mailbox.body(input.id,{includeHtml:false,includeImages:false,includeSubject:true}),budget)
   : {};
  if (!message) {
   return budget.aborted ? unavailable :
    {status:404,data:{error:'This email is no longer available. Refresh the mailbox and try again.'}};
  }
  const matches=typeof mailbox.mailSearch==='function'
   ? await findRelevantMail(mailbox,question,input.id,budget) : undefined;
  const body=message.body||'';
  const turns=[...history,{role:'user',content:question}];
  const messages=[{role:'user',content:JSON.stringify({
   question:turns[0].content,subject:message.subject?.slice(0,500)||'',
   email:body.slice(0,12000),excerptIncomplete:Boolean(message.truncated||body.length>12000),
   ...(matches?{mailboxMatches:matches}:{}),
  })},...turns.slice(1)];
  const result=await runAiChain(config,messages,{budget,fetcher,attempts});
  answeredBy=result.provider;
  fallbackReason=result.fallbackReason;
  if (result.provider) return {status:200,data:{answer:result.answer,provider:result.provider,backup:result.provider==='Groq'}};
  if (result.stop) {
   const configurationError=result.reason==='http_401'||result.reason==='http_403';
   return {status:502,data:{error:configurationError
    ? 'Ask AI could not authenticate with its provider. Check the server API key and permissions.'
    : 'Ask AI could not submit the request. Check the server provider configuration.'}};
  }
  return unavailable;
 } finally {
  console.info('[Ask AI]',JSON.stringify({provider:answeredBy,fallbackReason,attempts,latencyMs:Math.round(performance.now()-started)}));
 }
}

const commonWords=new Set('does could would should please find look search across through whole mailbox inbox email emails message messages what when where which that this they have with were from about last earlier there these those tell give show need your mine them more help answer summarize summary'.split(' '));

async function findRelevantMail(mailbox,question,selectedId,budget) {
 const keywords=[...new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9@.\-]{2,}/g)||[])]
  .filter(word=>!commonWords.has(word)).slice(0,10);
 if (!keywords.length) return {excerpts:[],coverage:'no_search_terms'};
 const signal=AbortSignal.any([budget,AbortSignal.timeout(10000)]);
 try {
  const result=await waitForContext(mailbox.mailSearch({query:keywords.join(' ')},16,true),signal);
  if (!result) return {excerpts:[],coverage:'search_timed_out'};
  const score=row=>keywords.reduce((sum,word)=>sum+Number((row.subject+' '+row.from).toLowerCase().includes(word)),0);
  const rows=result.mail.filter(row=>row.id!==selectedId)
   .map(row=>({row,score:score(row)})).sort((a,b)=>b.score-a.score).slice(0,6);
  const excerpts=await waitForContext(Promise.all(rows.map(async ({row})=>{
   let body='';
   try {
    const result=await mailbox.body(row.id,{includeHtml:false,includeImages:false});
    body=(result?.body||'').slice(0,2400);
   } catch { /* Still provide authenticated envelope metadata. */ }
   return {subject:row.subject.slice(0,300),from:row.from.slice(0,320),date:row.date,folder:row.folder,excerpt:body};
  })),signal);
  return {excerpts:excerpts||rows.map(({row})=>({subject:row.subject,from:row.from,date:row.date,folder:row.folder,excerpt:''})),
   coverage:'top_keyword_matches_across_all_folders'};
 } catch {return {excerpts:[],coverage:'search_unavailable'};}
}

async function waitForContext(request,signal) {
 if (signal.aborted) {void request.catch(()=>{});return null;}
 let onAbort;
 try {
  return await Promise.race([request,new Promise(resolve=>{
   onAbort=()=>resolve(null);
   signal.addEventListener('abort',onAbort,{once:true});
  })]);
 } finally {
  signal.removeEventListener('abort',onAbort);
 }
}
