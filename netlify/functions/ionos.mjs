import {sealBidScan} from '../../server/bid-scan-session.mjs';
import {bidImportSettings,bidPreview,bookQualifiedBid,currentQualifiedBids,inspectBidEmail,oneEmailBids,qualifiedBids,qualifiedBidCsv} from '../../server/bid-import.mjs';
import {dayInCalifornia,readBidReport,readBidScanActivity} from '../../server/bid-leads.mjs';
import {contactsConfig,searchContacts,mailboxTemperatures,temperatureConfig} from '../../server/ghl-contacts.mjs';
import {aiConfig,aiEnabled,aiModels,aiReplies,aiWrite,askEmail} from '../../server/ask-ai.mjs';
import {adminConsole,healthChecks} from '../../server/admin-console.mjs';
import {aiLabelStore,pacificTime,sortHours} from '../../server/ai-sort.mjs';
import {noteStore,notesConfig} from '../../server/ghl-notes.mjs';
import {deliveryStatus,deliveryStore,sendIdFor} from '../../server/deliveries.mjs';
import nodemailer from 'nodemailer';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { stagedAttachments, stagedFiles, CHUNK_BYTES, MAX_DOWNLOAD_BYTES, UPLOAD_REQUEST_LIMIT } from '../../server/staged-attachments.mjs';
import { largeFileLinks,largeFileRefs,largeFilesEnabled } from '../../server/large-file-links.mjs';
import { REQUEST_LIMIT } from '../../server/mail-attachments.mjs';
import { mailboxPreferences } from '../../server/mail-preferences.mjs';
import { createHighLevelLogin } from '../../server/ghl-sso.mjs';
import { ImapFlow } from 'imapflow';
import { createIonosMailbox, ionosConfig } from '../../server/ionos.mjs';
import { seniorAdmins, teamDirectory } from '../../server/team-directory.mjs';

const mailboxSignInError = 'Could not sign in. Use your full IONOS mailbox address and mailbox password. A2Z must also enable the mailbox for direct sign-in.';
const lifetime = 2 * 60 * 60 * 1000;
const rememberedSeconds = 7 * 24 * 60 * 60;
const rememberedCookie = '__Host-a2z-mail';
const cookieAuthorization = 'MailboxCookie';
const sessionCookie = (value, age) =>
 `${rememberedCookie}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`;
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply = (body,status=200,cookie) => Response.json(body,{status,headers:cookie?{...headers,'Set-Cookie':cookie}:headers});

function encrypt(key, login, duration=lifetime) {
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm',key,iv);
 const encrypted = Buffer.concat([cipher.update(JSON.stringify({...login,issued:Date.now(),expires:Date.now()+duration}),'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}

function decrypt(key, authorization) {
 const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,8192})$/)?.[1];
 if (!token) return null;
 try {
  const bytes = Buffer.from(token,'base64url');
  const cipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(12,28));
  const login = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
  return login.expires > Date.now() ? login : null;
 } catch { return null; }
}

async function readInput(request, limit) {
 const chunks=[];
 let size=0;
 if (!request.body) throw new TypeError('Missing request body.');
 for await (const chunk of request.body) {
  size += chunk.length;
  if (size>limit) throw new TypeError('Request is too large.');
  chunks.push(chunk);
 }
 try { return JSON.parse(Buffer.concat(chunks).toString()); }
 catch { throw new TypeError('Invalid request body.'); }
}

export function createHostedHandler(env, {Imap=ImapFlow, mailboxFactory=createIonosMailbox,preferencesFactory=mailboxPreferences,uploadsFactory=stagedAttachments,lookupContacts=searchContacts,directoryFactory=teamDirectory,adminFactory=adminConsole,fetcher=fetch,smtpFactory=nodemailer.createTransport,labelsFactory=aiLabelStore,notesFactory=noteStore,deliveriesFactory=deliveryStore}={}) {
 const enabled = env.A2Z_MODE==='live';
 const allowed = new Set((env.IONOS_ALLOWED_MAILBOXES||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));
 const admins = seniorAdmins(env);
 for (const email of admins) allowed.add(email);
 const ready = enabled && allowed.size>0 && (env.SESSION_SECRET||'').length>=32;
 const directory = ready ? directoryFactory(env) : null;
 const admin = ready ? adminFactory() : null;
 const aiLabels = ready ? labelsFactory() : null;
 const notes = ready ? notesFactory() : null;
 const deliveries = ready ? deliveriesFactory() : null;
 const notesSetup = notesConfig(env);
 const highLevelSetup = ready ? createHighLevelLogin(env,allowed,{lookup:email=>directory.credential(email)}) : null;
 const highLevel=highLevelSetup?.login;
 const contacts=ready?contactsConfig(env):null;
 const temperature=temperatureConfig(env,contacts);
 const ai=aiConfig(env);
 const key = ready ? createHash('sha256').update(env.SESSION_SECRET).digest() : null;
 const configFor = ({email,password}) => ionosConfig({
  A2Z_MODE:'live', A2Z_ENABLE_LIVE:'true', IONOS_EMAIL:email, IONOS_PASSWORD:password,
  IONOS_SMTP_PORT:env.IONOS_SMTP_PORT,
  GROQ_API_KEY:env.GROQ_API_KEY,
  CLOUDFLARE_ACCOUNT_ID:env.CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_AI_TOKEN:env.CLOUDFLARE_AI_TOKEN,CLOUDFLARE_AI_MODEL:env.CLOUDFLARE_AI_MODEL,
 });
 // Senior admin health checks. Each returns ok, warn or fail with safe detail only (no secrets).
 function healthFor(login) {
  const timed=async(url,options={})=>{
   const response=await fetcher(url,{...options,signal:AbortSignal.timeout(6000)});
   if (!response.ok) throw new Error('HTTP '+response.status);
   return response;
  };
  const missing=[
   (env.SESSION_SECRET||'').length<32&&'SESSION_SECRET',
   !admins.size&&'SENIOR_ADMIN_EMAILS',
   !(env.BID_DRY_RUN_TOKEN||'').trim()&&'BID_DRY_RUN_TOKEN',
   !env.URL&&'URL (Netlify site URL)',
  ].filter(Boolean);
  return {
   'IONOS mailbox (IMAP)':async()=>{
    const client=new Imap(configFor(login).imap);
    client.on('error',()=>{});
    try {await client.connect();return {detail:'Signed in as '+login.email};}
    finally {client.close();}
   },
   'IONOS sending (SMTP)':async()=>{
    const transport=smtpFactory(configFor(login).smtp);
    try {await transport.verify();return {detail:'SMTP accepted the mailbox login'};}
    finally {transport.close?.();}
   },
   'Netlify Blobs storage':async()=>{
    await admin.keywords(true);
    const users=await directory.list();
    return {detail:users.length+' mailboxes in the team directory'};
   },
   'Groq (Ask AI and sorting)':async()=>{
    if (!ai.groq) return {status:'warn',detail:'GROQ_API_KEY is not set'};
    const data=await (await timed('https://api.groq.com/openai/v1/models',{headers:{Authorization:'Bearer '+ai.groq}})).json();
    const model=ai.askGroqModel||aiModels.groq;
    const found=(data?.data||[]).some(item=>item.id===model);
    return found?{detail:model+' available. Web search '+(ai.webSearch?'on':'off')}:{status:'warn',detail:model+' is not listed for this key'};
   },
   'Cloudflare Workers AI (backup)':async()=>{
    if (!ai.cloudflare) return {status:'warn',detail:'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN to add the Cloudflare backup'};
    const response=await timed('https://api.cloudflare.com/client/v4/accounts/'+ai.cloudflareAccount+'/ai/v1/chat/completions',{method:'POST',
     headers:{Authorization:'Bearer '+ai.cloudflare,'Content-Type':'application/json'},
     body:JSON.stringify({model:ai.cloudflareModel,max_tokens:1,messages:[{role:'user',content:'ok'}]})});
    await response.body?.cancel();
    return {detail:ai.cloudflareModel+' responded'};
   },
   'Gemini (Ask AI backup)':async()=>{
    if (!ai.gemini) return {status:'warn',detail:'GEMINI_API_KEY is not set'};
    const model=ai.askModel||aiModels.gemini;
    await timed('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model),{headers:{'x-goog-api-key':ai.gemini}});
    return {detail:model+' available'};
   },
   'HighLevel auto sign-in':async()=>{
    const issues=highLevelSetup?.issues||[];
    return issues.length?{status:'warn',detail:issues.join('. ')}:{detail:'Configured'};
   },
   'HighLevel contacts':async()=>{
    if (!contacts) return {status:'warn',detail:'GHL_CONTACTS_PIT_TOKEN or location is not set'};
    await lookupContacts(contacts,'a2z');
    return {detail:'Contact search responded'};
   },
   'Estimating Desk':async()=>{
    const settings=bidImportSettings(env);
    if (!settings) return {status:'warn',detail:'ESTIMATING_DESK_URL or ESTIMATING_DESK_IMPORT_SECRET is not set'};
    await timed(new URL('/',settings.url).href,{method:'GET'});
    return {detail:'Desk site responded'};
   },
   'Bid scan':async()=>{
    const activity=await readBidScanActivity(login.email);
    if (!activity) return {status:'warn',detail:'No scan has run for '+login.email};
    const status=activity.status==='failed'?'fail':activity.status==='complete'||activity.status==='running'?'ok':'warn';
    return {status,detail:activity.status+(activity.reason?' ('+activity.reason+')':'')+' at '+activity.at};
   },
   'Scheduled AI sorting (9 AM and 3 PM)':async()=>{
    if (!ai.groq) return {status:'warn',detail:'GROQ_API_KEY is not set'};
    const run=await aiLabels.lastRun();
    if (!run) return {status:'warn',detail:'No run yet. Next run at '+(pacificTime().hour<sortHours[0]?'9 AM':pacificTime().hour<sortHours[1]?'3 PM':'9 AM tomorrow')};
    const failed=run.results.filter(item=>item.status==='failed');
    const skipped=run.results.filter(item=>item.status==='skipped');
    const sorted=run.results.filter(item=>item.status==='ok').reduce((sum,item)=>sum+item.sorted,0);
    const ageHours=(Date.now()-Date.parse(run.finishedAt))/3600000;
    const detail='Last '+run.trigger+' run '+new Date(run.finishedAt).toLocaleString('en-US',{timeZone:'America/Los_Angeles',dateStyle:'medium',timeStyle:'short'})+
     ': '+sorted+' newly sorted'+(failed.length?'. Failed: '+failed.map(item=>item.email+' ('+item.detail+')').join(', '):'')+
     (skipped.length?'. Skipped (no saved password): '+skipped.map(item=>item.email).join(', '):'');
    return {status:failed.length||ageHours>20?'fail':skipped.length?'warn':'ok',detail};
   },
   'HighLevel email notes':async()=>{
    const settings=await notes.settings();
    if (!settings.enabled) return settings.disabledReason?{status:'fail',detail:'Turned off by the safety check: '+settings.disabledReason}:{status:'ok',detail:'Turned off in Admin console > HighLevel notes'};
    if (!notesSetup) return {status:'fail',detail:'Set GHL_CONVERSATIONS_PIT_TOKEN, GHL_CONTACTS_PIT_TOKEN and GHL_CONTACTS_LOCATION_ID'};
    // Read-only probe with the write token. Confirms the token and its conversations.readonly scope.
    await timed('https://services.leadconnectorhq.com/conversations/search?locationId='+encodeURIComponent(notesSetup.locationId)+'&limit=1',
     {headers:{Authorization:'Bearer '+notesSetup.token,Version:'2021-04-15',Accept:'application/json'}});
    const run=await notes.lastRun();
    if (!run) return {status:'warn',detail:'Token works. No notes posted yet. Next run at 9 AM or 3 PM Pacific.'};
    const posted=run.results.reduce((sum,item)=>sum+(item.posted||0),0);
    const problems=run.results.filter(item=>item.status==='failed'||item.status==='partial');
    return {status:problems.length?'warn':'ok',detail:'Last run posted '+posted+' notes'+(problems.length?'. Issues: '+problems.map(item=>item.email+' ('+(item.detail||item.status)+')').join(', '):'')};
   },
   'Configuration':async()=>missing.length?{status:'warn',detail:'Missing: '+missing.join(', ')}:
    {detail:allowed.size+' allowed mailboxes, '+admins.size+' senior admin(s)'},
  };
 }
 return async function handler(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action==='status' && request.method==='GET') return reply({live:enabled,ready,highLevelOrigins:highLevel?.origins||[],highLevelIssues:highLevelSetup?.issues||[],largeFiles:enabled&&largeFilesEnabled(env),contactLookup:Boolean(contacts)});
  if (!ready) return reply({error:'Hosted IONOS is unavailable. Check the deployment settings.'},503);
  const origin = request.headers.get('origin');
  if (origin && origin!==url.origin) return reply({error:'Invalid request origin.'},403);
  if (request.method==='POST' && request.headers.get('content-type')!=='application/json') {
   return reply({error:'Expected a JSON request.'},415);
  }
  let session;
  try {
   if (action==='login' && request.method==='POST') {
    const input = await readInput(request,4096);
    const email = typeof input?.email==='string' ? input.email.trim().toLowerCase() : '';
    const password = input?.password;
    if (typeof password!=='string' || !password || password.length>1024 || !(await directory.access(email)).allowed) {
     console.warn('[IONOS] Direct sign-in rejected by mailbox access or input checks.');
     if (/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)) await admin.record(email,'sign-in-failed');
     return reply({error:mailboxSignInError},401);
    }
    const client = new Imap(configFor({email,password}).imap);
    client.on('error',()=>{});
    try { await client.connect(); }
    catch (error) { await admin.record(email,'sign-in-failed'); throw error; }
    finally { client.close(); }
    await admin.record(email,'sign-in');
    if (input.remember===true) {
     const token=encrypt(key,{email,password},rememberedSeconds*1000);
     if (token.length<=3800) return reply({token:cookieAuthorization,email},200,sessionCookie(token,rememberedSeconds));
    }
    return reply({token:encrypt(key,{email,password}),email},200,sessionCookie('',0));
   }
   if (action==='ghl-login' && request.method==='POST') {
    const input=await readInput(request,26000);
    const result=await highLevel?.verify(input?.encryptedData,input?.parentOrigin);
    if (!result?.identity) return reply({
     error:'Automatic sign-in is unavailable for this HighLevel account.',
     reason:result?.failure||'ghl_setup',
    },401);
    await admin.record(result.identity.email,'ghl-sign-in');
    return reply({token:encrypt(key,{highLevel:result.identity}),email:result.identity.email});
   }
   const authorization=request.headers.get('authorization');
   const usesCookie=authorization===cookieAuthorization;
   if (usesCookie && action==='logout' && request.method==='POST') {
    return reply({ok:true},200,sessionCookie('',0));
   }
   const cookie=usesCookie && request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-a2z-mail=([A-Za-z0-9_-]+)(?=;|$)/)?.[1];
   session=decrypt(key,usesCookie?(cookie?'Bearer '+cookie:null):authorization);
   const login = session?.highLevel ? await highLevel?.getCredentials(session.highLevel) : session;
   const access = login ? await directory.access(login.email,session.issued) : null;
   if (!login || !access.allowed) return reply({
    error:'Sign in to your IONOS mailbox again.',
    reason:session?.highLevel?'ghl_mailbox':'session_expired',
   },401,usesCookie?sessionCookie('',0):undefined);
   const profile = {email:login.email,admin:access.admin,
    name:access.namedByAdmin?access.name:(session.highLevel?.name||access.name)};
   if (usesCookie && action==='session' && request.method==='GET') return reply({email:login.email,profile});
   if (action==='profile' && request.method==='GET') return reply({profile});
   if (action==='team' && request.method==='GET') {
    if (!access.admin) return reply({error:'Only a senior admin can manage team access.'},403);
    return reply({users:await directory.list()});
   }
   if (action==='team' && request.method==='POST') {
    if (!access.admin) return reply({error:'Only a senior admin can manage team access.'},403);
    const input=await readInput(request,4096);
    if (input?.op==='set-ghl-password') {
     const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
     if (typeof input.password!=='string'||!input.password||input.password.length>1024) throw new TypeError('Enter the mailbox password.');
     // Save only a password IONOS accepts, so HighLevel sign-in does not fail later.
     const client=new Imap(configFor({email,password:input.password}).imap);
     client.on('error',()=>{});
     try { await client.connect(); }
     catch (error) {
      if (error.authenticationFailed||error.code==='EAUTH'||error.serverResponseCode==='AUTHENTICATIONFAILED') {
       throw new TypeError('IONOS rejected that password for '+email+'. Nothing was saved.');
      }
      throw new TypeError('Could not reach IONOS to check the password. Try again.');
     } finally { client.close(); }
    }
    const users=await directory.update(login.email,input);
    console.info('[Team] '+login.email+' ran '+input.op+' for '+String(input.email).toLowerCase());
    await admin.record(login.email,'team');
    return reply({users});
   }
   if (action?.startsWith('admin-') && !access.admin) return reply({error:'Only a senior admin can open the admin console.'},403);
   if (action==='admin-keywords' && request.method==='GET') return reply({keywords:await admin.keywords(true)});
   if (action==='admin-keywords' && request.method==='POST') {
    const keywords=await admin.updateKeywords(login.email,await readInput(request,2048));
    await admin.record(login.email,'keywords');
    return reply({keywords});
   }
   if (action==='admin-activity' && request.method==='GET') {
    const [activity,users]=await Promise.all([admin.activity({days:url.searchParams.get('days')}),directory.list()]);
    return reply({...activity,team:users.map(({email,name,status,admin:isAdmin})=>({email,name,status,admin:isAdmin}))});
   }
   if (action==='admin-health' && request.method==='GET') return reply(await healthChecks(healthFor(login)));
   if (action==='admin-notes' && request.method==='GET') {
    return reply({settings:await notes.settings(),lastRun:await notes.lastRun(),
     setup:{writeToken:Boolean(env.GHL_CONVERSATIONS_PIT_TOKEN?.trim()),readToken:Boolean(env.GHL_CONTACTS_PIT_TOKEN?.trim()),ready:Boolean(notesSetup)}});
   }
   if (action==='admin-notes' && request.method==='POST') {
    const settings=await notes.saveSettings(await readInput(request,2048),login.email);
    await admin.record(login.email,'settings');
    return reply({settings});
   }
   if (action==='admin-sort-now' && request.method==='POST') {
    const token=env.BID_DRY_RUN_TOKEN?.trim();
    if (!env.URL||!token||token.length<32) return reply({error:'Set URL and BID_DRY_RUN_TOKEN to run AI sorting.'},503);
    const response=await fetcher(new URL('/.netlify/functions/ai-sort-background',env.URL),{method:'POST',
     headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({trigger:'manual'}),signal:AbortSignal.timeout(5000)});
    if (!response.ok&&response.status!==202) return reply({error:'AI sorting could not start.'},502);
    return reply({accepted:true},202);
   }
   if (action==='bid-import-report' && request.method==='GET') {
    const [report,activity]=await Promise.all([readBidReport(login.email),readBidScanActivity(login.email)]);
    return reply({report,activity});
   }
   if (action==='bid-scan' && request.method==='POST') {
    const key=env.BID_DRY_RUN_TOKEN?.trim();
    const site=env.URL;
    if (!site||!key||key.length<32) return reply({error:'Bid scanning is not configured on this deployment.'},503);
    const input=await readInput(request,256);
    const endpoint=new URL('/.netlify/functions/bid-dry-run-background',site);
    if (endpoint.protocol!=='https:') return reply({error:'Bid scanning needs the deployed HTTPS site URL.'},503);
    const ticket=sealBidScan(env.SESSION_SECRET,login,input?.fresh===true);
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
     body:JSON.stringify({ticket}),signal:AbortSignal.timeout(5000)});
    if (response.status===202||response.ok) await admin.record(login.email,'bid-scan');
    return response.status===202||response.ok ? reply({accepted:true},202) :
     reply({error:'The bid scan could not be queued.'},502);
   }
   if (action==='bid-qualified' && request.method==='GET') {
    const source=url.searchParams.get('message');
    const entries=source?await oneEmailBids(login.email,source):await qualifiedBids(login.email);
    const rows=entries;
    const page=Number(url.searchParams.get('page')||0);
    if (!Number.isSafeInteger(page)||page<0||page>10000) return reply({error:'Invalid lead page.'},400);
    return reply({complete:entries!==null,bookingEnabled:Boolean(bidImportSettings(env)),total:rows?.length||0,
     leads:(rows||[]).slice(page*25,(page+1)*25).map(bidPreview)});
   }
   if (action==='bid-qualified-csv' && request.method==='GET') {
    const entries=await currentQualifiedBids(login.email,env);
    if (!entries) return reply({error:'Finish the bid scan before exporting.'},409);
    const filename='a2z-leads-'+dayInCalifornia(new Date())+'.csv';
    return new Response(qualifiedBidCsv(entries),{headers:{
     'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+filename+'"',
     'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    }});
   }
   if (action==='bid-book' && request.method==='POST') {
    const input=await readInput(request,2048);
    const {status,...result}=await bookQualifiedBid({email:login.email,id:input?.id,message:input?.message,env});
    return reply(result,status);
   }
   if (action==='contacts' && request.method==='POST') {
    if (!contacts || (session?.highLevel && session.highLevel.activeLocation!==contacts.locationId)) return reply({contacts:[]});
    const input=await readInput(request,2048);
    return reply({contacts:await lookupContacts(contacts,input?.query)});
   }
   if (['large-start','large-finish','large-abort','large-download'].includes(action)&&request.method==='POST') {
    const input=await readInput(request,16000);
    const storage=largeFileLinks(env,login.email);
    if (action==='large-start') return reply(await storage.begin(input));
    if (action==='large-download') {
     const [file]=await storage.links(input?.draftId,[input?.file],{expiresIn:300});
     return reply(file);
    }
    if (action==='large-finish') await storage.complete(input);
    else await storage.abort(input);
    return reply({ok:true});
   }
   if (action==='upload' && request.method==='POST') {
    await uploadsFactory(login.email).upload(await readInput(request,UPLOAD_REQUEST_LIMIT));
    return reply({ok:true});
   }
   if (action==='draft-attachment-chunk' && request.method==='POST') {
    const input=await readInput(request,4096);
    const [file]=stagedFiles([input?.file]);
    const {index,draftId}=input;
    if (!Number.isInteger(index)||index<0||index>=Math.ceil(file.size/CHUNK_BYTES)) {
     throw new TypeError('Invalid attachment chunk.');
    }
    const chunk=await uploadsFactory(login.email).readChunk(draftId,file.id,index);
    const expected=Math.min(CHUNK_BYTES,file.size-index*CHUNK_BYTES);
    return chunk?.length===expected ? reply({data:chunk.toString('base64')}) :
     reply({error:'This attachment is incomplete or no longer available.'},404);
   }
   if (action==='preferences' && request.method==='GET') return reply(await preferencesFactory(login.email).load());
   if (action==='draft' && request.method==='GET') {
    const draft=await preferencesFactory(login.email).loadDraft(url.searchParams.get('id'));
    return draft ? reply(draft) : reply({error:'This draft is no longer available.'},404);
   }
   if (action==='draft' && request.method==='POST') {
    const input=await readInput(request,REQUEST_LIMIT);
    const preferences=preferencesFactory(login.email);
    if (input?.discard===true) {
     await preferences.discard(input.id);
     try { await uploadsFactory(login.email).clean(input.id); } catch { /* Draft deletion is already complete. */ }
    } else await preferences.saveDraft(input);
    return reply({ok:true});
   }
   if (action==='signature' && request.method==='POST') {
    const input=await readInput(request,370000);
    await preferencesFactory(login.email).saveSignature(input?.signature,input?.image);
    return reply({ok:true});
   }
   const mailbox = mailboxFactory({...configFor(login),keywords:await admin.keywords(),
    ...(action==='mail'?{storedLabels:await aiLabels.load(login.email)}:{})});
   if (action==='bid-inspect' && request.method==='POST') {
    const input=await readInput(request,2048);
    const {status,...result}=await inspectBidEmail({email:login.email,id:input?.id,mailbox,env});
    return reply(result,status);
   }
   if (action==='mail-export-folders' && request.method==='GET') {
    const folders=await mailbox.exportFolders();
    await admin.record(login.email,'export');
    return reply({folders});
   }
   if (action==='mail-export-page' && request.method==='POST') {
    const input=await readInput(request,8192);
    const data=await mailbox.exportPage(input);
    if (data.resetRequired) return reply({error:'An IONOS folder changed during the export. Restart the export.'},409);
    const sameLocation=temperature&&(!session.highLevel||session.highLevel.activeLocation===temperature.locationId);
    return reply(await mailboxTemperatures(data,input?.temperature===true&&sameLocation?temperature:null));
   }
   if (action==='mail-older' && request.method==='POST') {
    const result=await mailbox.olderMail(await readInput(request,4096));
    if (result.resetRequired) return reply({error:'This folder changed. Refresh the mailbox, then load older mail again.'},409);
    return reply(result);
   }
   if (action==='mail-search' && request.method==='POST') {
    const input=await readInput(request,512000);
    const result=await mailbox.searchMailboxPage(input);
    if (result.resetRequired) return reply({error:'This folder changed. Start a new search.'},409);
    return reply(result);
   }
   if (action==='mail' && request.method==='GET') {
    const canReadTemperature=temperature&&(!session.highLevel||session.highLevel.activeLocation===temperature.locationId);
    const loaded=await mailbox.mail();
    const {reports=[],...rest}=loaded;
    let shown=rest.mail;
    if (reports.length) {
     try {
      await deliveries.merge(login.email,reports);
      // Success reports are noise once recorded: file them away and hide them. Bounces stay in Inbox.
      const filed=reports.filter(report=>report.successOnly).map(report=>report.messageId);
      if (filed.length&&typeof mailbox.archiveReports==='function') {
       await mailbox.archiveReports(filed).catch(()=>0);
       shown=shown.filter(row=>!filed.includes(row.id));
      }
     } catch { /* Delivery status is optional; the mailbox still loads. */ }
    }
    const statuses=await deliveries.load(login.email);
    shown=shown.map(row=>{
     const sendId=row.folder==='Sent'?sendIdFor(row):'';
     return sendId?{...row,delivery:deliveryStatus(row,statuses[sendId])}:row;
    });
    const data=await mailboxTemperatures({...rest,mail:shown},canReadTemperature?temperature:null);
    await admin.record(login.email,'open',{throttle:true});
    return reply({...data,askAi:aiEnabled(ai),profile});
   }
   if ((action==='ai-write'||action==='ai-replies') && request.method==='POST') {
    const input=await readInput(request,64000);
    const {status,data}=action==='ai-write'?await aiWrite(ai,mailbox,input,fetch):await aiReplies(ai,mailbox,input,fetch);
    await admin.record(login.email,'ask-ai');
    return reply(data,status);
   }
   if (action==='ask-ai' && request.method==='POST') {
    const {status,data}=await askEmail(ai,mailbox,await readInput(request,96000),fetch,{resilient:true});
    await admin.record(login.email,'ask-ai');
    return reply(data,status);
   }
   if (action==='body' && request.method==='POST') {
    const input = await readInput(request,8192);
    const result = await mailbox.body(input?.id);
    return result ? reply(result) : reply({error:'The message is no longer in this folder. Refresh the mailbox and try again.'},404);
   }
   if (action==='attachment' && request.method==='POST') {
    const input=await readInput(request,8192);
    const file=await mailbox.attachment(input?.id,input?.part,MAX_DOWNLOAD_BYTES);
    if (!file) return reply({error:'This attachment is no longer available. Refresh the mailbox.'},404);
    const ticket=randomUUID();
    const fileId=randomUUID();
    const cache=uploadsFactory(login.email);
    try {
     const chunks=await cache.saveFile(ticket,fileId,file.content);
     return reply({ticket,fileId,chunks,name:file.name,type:file.type});
    } catch(error) {
     try {await cache.clean(ticket);} catch {}
     throw error;
    }
   }
   if (action==='attachment-chunk' && request.method==='POST') {
    const input=await readInput(request,4096);
    const chunk=await uploadsFactory(login.email).readChunk(input?.ticket,input?.fileId,input?.index,MAX_DOWNLOAD_BYTES);
    return chunk ? reply({data:chunk.toString('base64')}) : reply({error:'Attachment download expired. Reopen the file.'},404);
   }
   if (action==='attachment-release' && request.method==='POST') {
    const input=await readInput(request,4096);
    await uploadsFactory(login.email).clean(input?.ticket);
    return reply({ok:true});
   }
   if (action==='send' && request.method==='POST') {
    const input=await readInput(request,REQUEST_LIMIT);
    const staged=stagedFiles(input?.stagedAttachments);
    if (staged.length && input.attachments?.length) throw new TypeError('Use one attachment upload method per message.');
    const uploaded=staged.length ? await uploadsFactory(login.email).resolve(input.id?.slice(4),staged) : [];
    const large=largeFileRefs(input?.largeFiles);
    const links=large.length ? await largeFileLinks(env,login.email).links(input.id?.slice(4),large) : [];
    const result=await mailbox.send(input,uploaded,links);
    await admin.record(login.email,'send');
    let draftCleanupFailed=false;
    if (input.savedDraft===true) {
     try { await preferencesFactory(login.email).discard(input.id.slice(4)); }
     catch { draftCleanupFailed=true; }
    }
    if (!draftCleanupFailed && (staged.length || input.savedDraft===true)) {
     try { await uploadsFactory(login.email).clean(input.id.slice(4)); } catch { /* SMTP has already accepted the message. */ }
    }
    return reply({...result,draftCleanupFailed});
   }
   if (action==='update' && request.method==='POST') return reply(await mailbox.update(await readInput(request,4096)));
   return reply({error:'Unknown mailbox action.'},404);
  } catch(error) {
   if (admin&&!(error instanceof TypeError)&&!error?.authenticationFailed&&error?.code!=='EAUTH') {
    await admin.record(session?.email||session?.highLevel?.email||'','error');
   }
   if (action?.startsWith('admin-')) return reply({error:error instanceof TypeError?error.message:'The admin console request failed. Try again.'},error instanceof TypeError?400:502);
   if (['bid-qualified','bid-qualified-csv','bid-book','bid-scan','bid-inspect'].includes(action)) return reply({
    error:'The Estimating Desk request could not complete. Check the server setup and try again.',
   },502);
   if (action==='bid-import-report') return reply({error:'Could not load the bid import report. Try again.'},502);
   if (action==='team') return reply({error:error instanceof TypeError?error.message:'The team directory could not update. Try again.'},error instanceof TypeError?400:502);
   if (action==='mail-older'&&error instanceof TypeError) return reply({error:error.message},400);
   if (action==='mail-older'&&!(error.authenticationFailed||error.code==='EAUTH'||error.serverResponseCode==='AUTHENTICATIONFAILED')) {
    return reply({error:'IONOS did not return older mail. Try again.'},503);
   }
   if (action==='contacts') return reply({
    error:error instanceof TypeError?'Invalid contact search.':'HighLevel contacts are temporarily unavailable.',
   },error instanceof TypeError?400:502);
   if (action?.startsWith('large-')) {
    return reply({error:error instanceof TypeError?error.message:action==='large-download'?'Could not open the download link. Try again.':'Large file storage could not complete the upload. Try again.'},error instanceof TypeError?400:502);
   }
   if (action?.startsWith('attachment')||action==='draft-attachment-chunk') {
    return reply({error:error instanceof TypeError?error.message:'Could not load the attachment. Try again.'},error instanceof TypeError?400:502);
   }
   if (['preferences','draft','signature','upload'].includes(action)) {
    if (error instanceof TypeError) return reply({error:error.message},400);
    return reply({error:action==='upload'?'The file could not upload. Try attaching it again.':'Mailbox drafts or signatures could not sync. Try again.'},502);
   }
   if (action==='mail-search'&&error instanceof TypeError) return reply({error:error.message},400);
   if (error instanceof TypeError) return reply({error:action==='send'?error.message:'Check your mailbox settings or message fields.'},400);
   if (error.authenticationFailed || error.code==='EAUTH' || error.serverResponseCode==='AUTHENTICATIONFAILED') {
    if (session?.highLevel) {
     console.warn('[IONOS] HighLevel session accepted; IMAP rejected the configured mailbox credential.');
     return reply({error:'HighLevel signed you in, but IONOS rejected the saved mailbox credential.',reason:'ghl_ionos_auth'},401);
    }
    if (action==='login') console.warn('[IONOS] Direct sign-in credentials rejected by the mail server.');
    return reply({error:mailboxSignInError},401);
   }
   if (action==='mail-search') return reply({error:'IONOS search could not connect. Recent matches are still available. Retry the mailbox search.'},503);
   if (session?.highLevel && action==='mail') {
    console.warn('[IONOS] HighLevel session accepted; mailbox connection failed.');
    return reply({error:'HighLevel signed you in, but Inbox could not open the IONOS mailbox.',reason:'ghl_ionos_unavailable'},502);
   }
   return reply({error:action==='send'
    ? 'IONOS did not confirm delivery. Check Sent before retrying.'
    : 'IONOS could not complete the request. Try again.'},502);
  }
 };
}

export default createHostedHandler(process.env);

export const config = {
 rateLimit:{windowLimit:60,windowSize:60,aggregateBy:['ip','domain']},
};
