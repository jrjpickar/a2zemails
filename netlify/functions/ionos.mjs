import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { createIonosMailbox, ionosConfig } from '../../server/ionos.mjs';

const lifetime = 2 * 60 * 60 * 1000;
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply = (body,status=200) => Response.json(body,{status,headers});

function encrypt(key, login) {
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm',key,iv);
 const encrypted = Buffer.concat([cipher.update(JSON.stringify({...login,expires:Date.now()+lifetime}),'utf8'),cipher.final()]);
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

export function createHostedHandler(env, {Imap=ImapFlow, mailboxFactory=createIonosMailbox}={}) {
 const enabled = env.A2Z_MODE==='live';
 const allowed = new Set((env.IONOS_ALLOWED_MAILBOXES||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));
 const ready = enabled && allowed.size>0 && (env.SESSION_SECRET||'').length>=32;
 const key = ready ? createHash('sha256').update(env.SESSION_SECRET).digest() : null;
 const configFor = ({email,password}) => ionosConfig({
  A2Z_MODE:'live', A2Z_ENABLE_LIVE:'true', IONOS_EMAIL:email, IONOS_PASSWORD:password,
  IONOS_SMTP_PORT:env.IONOS_SMTP_PORT,
 });
 return async function handler(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action==='status' && request.method==='GET') return reply({live:enabled,ready});
  if (!ready) return reply({error:'Hosted IONOS is unavailable. Check the deployment settings.'},503);
  const origin = request.headers.get('origin');
  if (origin && origin!==url.origin) return reply({error:'Invalid request origin.'},403);
  if (request.method==='POST' && request.headers.get('content-type')!=='application/json') {
   return reply({error:'Expected a JSON request.'},415);
  }
  try {
   if (action==='login' && request.method==='POST') {
    const input = await readInput(request,4096);
    const email = typeof input?.email==='string' ? input.email.trim().toLowerCase() : '';
    const password = input?.password;
    if (!allowed.has(email) || typeof password!=='string' || !password || password.length>1024) {
     return reply({error:'IONOS sign-in failed. Check your mailbox credentials and account access.'},401);
    }
    const client = new Imap(configFor({email,password}).imap);
    client.on('error',()=>{});
    try { await client.connect(); }
    finally { client.close(); }
    return reply({token:encrypt(key,{email,password}),email});
   }
   const login = decrypt(key,request.headers.get('authorization'));
   if (!login || !allowed.has(login.email)) return reply({error:'Sign in to your IONOS mailbox again.'},401);
   const mailbox = mailboxFactory(configFor(login));
   if (action==='mail' && request.method==='GET') return reply(await mailbox.mail());
   if (action==='body' && request.method==='POST') {
    const input = await readInput(request,8192);
    const result = await mailbox.body(input?.id);
    return result ? reply(result) : reply({error:'The message is no longer in this folder. Refresh the mailbox and try again.'},404);
   }
   if (action==='send' && request.method==='POST') return reply(await mailbox.send(await readInput(request,256000)));
   if (action==='update' && request.method==='POST') return reply(await mailbox.update(await readInput(request,4096)));
   return reply({error:'Unknown mailbox action.'},404);
  } catch(error) {
   if (error instanceof TypeError) return reply({error:'Check your mailbox settings or message fields.'},400);
   if (error.authenticationFailed || error.code==='EAUTH' || error.serverResponseCode==='AUTHENTICATIONFAILED') {
    return reply({error:'IONOS sign-in failed. Check your mailbox credentials and account access.'},401);
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
