import {contactsConfig,searchContacts} from '../../server/ghl-contacts.mjs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { stagedAttachments, stagedFiles, CHUNK_BYTES, UPLOAD_REQUEST_LIMIT } from '../../server/staged-attachments.mjs';
import { largeFileLinks,largeFileRefs,largeFilesEnabled } from '../../server/large-file-links.mjs';
import { REQUEST_LIMIT } from '../../server/mail-attachments.mjs';
import { mailboxPreferences } from '../../server/mail-preferences.mjs';
import { createHighLevelLogin } from '../../server/ghl-sso.mjs';
import { ImapFlow } from 'imapflow';
import { createIonosMailbox, ionosConfig } from '../../server/ionos.mjs';

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
 const encrypted = Buffer.concat([cipher.update(JSON.stringify({...login,expires:Date.now()+duration}),'utf8'),cipher.final()]);
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

export function createHostedHandler(env, {Imap=ImapFlow, mailboxFactory=createIonosMailbox,preferencesFactory=mailboxPreferences,uploadsFactory=stagedAttachments,lookupContacts=searchContacts}={}) {
 const enabled = env.A2Z_MODE==='live';
 const allowed = new Set((env.IONOS_ALLOWED_MAILBOXES||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));
 const ready = enabled && allowed.size>0 && (env.SESSION_SECRET||'').length>=32;
 const highLevelSetup = ready ? createHighLevelLogin(env,allowed) : null;
 const highLevel=highLevelSetup?.login;
 const contacts=ready?contactsConfig(env):null;
 const key = ready ? createHash('sha256').update(env.SESSION_SECRET).digest() : null;
 const configFor = ({email,password}) => ionosConfig({
  A2Z_MODE:'live', A2Z_ENABLE_LIVE:'true', IONOS_EMAIL:email, IONOS_PASSWORD:password,
  IONOS_SMTP_PORT:env.IONOS_SMTP_PORT,
  GROQ_API_KEY:env.GROQ_API_KEY,
 });
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
    if (!allowed.has(email) || typeof password!=='string' || !password || password.length>1024) {
     console.warn('[IONOS] Direct sign-in rejected by mailbox access or input checks.');
     return reply({error:mailboxSignInError},401);
    }
    const client = new Imap(configFor({email,password}).imap);
    client.on('error',()=>{});
    try { await client.connect(); }
    finally { client.close(); }
    if (input.remember===true) {
     const token=encrypt(key,{email,password},rememberedSeconds*1000);
     if (token.length<=3800) return reply({token:cookieAuthorization,email},200,sessionCookie(token,rememberedSeconds));
    }
    return reply({token:encrypt(key,{email,password}),email},200,sessionCookie('',0));
   }
   if (action==='ghl-login' && request.method==='POST') {
    const input=await readInput(request,26000);
    const result=highLevel?.verify(input?.encryptedData,input?.parentOrigin);
    if (!result?.identity) return reply({
     error:'Automatic sign-in is unavailable for this HighLevel account.',
     reason:result?.failure||'ghl_setup',
    },401);
    return reply({token:encrypt(key,{highLevel:result.identity}),email:result.identity.email});
   }
   const authorization=request.headers.get('authorization');
   const usesCookie=authorization===cookieAuthorization;
   if (usesCookie && action==='logout' && request.method==='POST') {
    return reply({ok:true},200,sessionCookie('',0));
   }
   const cookie=usesCookie && request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-a2z-mail=([A-Za-z0-9_-]+)(?=;|$)/)?.[1];
   session=decrypt(key,usesCookie?(cookie?'Bearer '+cookie:null):authorization);
   const login = session?.highLevel ? highLevel?.getCredentials(session.highLevel) : session;
   if (!login || !allowed.has(login.email)) return reply({
    error:'Sign in to your IONOS mailbox again.',
    reason:session?.highLevel?'ghl_mailbox':'session_expired',
   },401,usesCookie?sessionCookie('',0):undefined);
   if (usesCookie && action==='session' && request.method==='GET') return reply({email:login.email});
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
   const mailbox = mailboxFactory(configFor(login));
   if (action==='mail' && request.method==='GET') return reply(await mailbox.mail());
   if (action==='body' && request.method==='POST') {
    const input = await readInput(request,8192);
    const result = await mailbox.body(input?.id);
    return result ? reply(result) : reply({error:'The message is no longer in this folder. Refresh the mailbox and try again.'},404);
   }
   if (action==='attachment' && request.method==='POST') {
    const input=await readInput(request,8192);
    const file=await mailbox.attachment(input?.id,input?.part);
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
    const chunk=await uploadsFactory(login.email).readChunk(input?.ticket,input?.fileId,input?.index);
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
   if (error instanceof TypeError) return reply({error:action==='send'?error.message:'Check your mailbox settings or message fields.'},400);
   if (error.authenticationFailed || error.code==='EAUTH' || error.serverResponseCode==='AUTHENTICATIONFAILED') {
    if (session?.highLevel) {
     console.warn('[IONOS] HighLevel session accepted; IMAP rejected the configured mailbox credential.');
     return reply({error:'HighLevel signed you in, but IONOS rejected the saved mailbox credential.',reason:'ghl_ionos_auth'},401);
    }
    if (action==='login') console.warn('[IONOS] Direct sign-in credentials rejected by the mail server.');
    return reply({error:mailboxSignInError},401);
   }
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
