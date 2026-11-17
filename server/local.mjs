import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createIonosMailbox, ionosConfig } from './ionos.mjs';

const host = '127.0.0.1:4174';
const origin = 'http://'+host;
const token = randomBytes(32).toString('hex');
const html = await readFile(new URL('../dist/index.html',import.meta.url),'utf8').catch(()=>{
 throw new Error('Build the app with pnpm build before starting the local IONOS server.');
});
const mailbox = createIonosMailbox(ionosConfig(process.env));
const deliveries = new Map();
const types = {js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
const json = (res,code,data) => {
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});
 res.end(JSON.stringify(data));
};
async function readJson(req) {
 const chunks = [];
 let bytes = 0;
 for await (const chunk of req) {
  bytes += chunk.length;
  if (bytes > 256000) throw new TypeError('Message is too large.');
  chunks.push(chunk);
 }
 try { return JSON.parse(Buffer.concat(chunks).toString()); }
 catch { throw new TypeError('Invalid message format.'); }
}
function authorized(req) {
 const provided = req.headers['x-a2z-session'];
 return typeof provided==='string' && /^[a-f0-9]{64}$/.test(provided) &&
  timingSafeEqual(Buffer.from(provided),Buffer.from(token));
}

const server = createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 if (req.headers.host!==host || (req.headers.origin && req.headers.origin!==origin)) {
  return json(res,403,{error:'The IONOS server is available on this computer only.'});
 }
 const path = (req.url || '/').split('?')[0];
 try {
  if (path.startsWith('/api/ionos/')) {
   if (!authorized(req)) return json(res,403,{error:'Reload the local IONOS app to start a session.'});
   if (path==='/api/ionos/mail' && req.method==='GET') return json(res,200,await mailbox.mail());
   if (path==='/api/ionos/update' && req.method==='POST' && req.headers['content-type']==='application/json') {
    return json(res,200,await mailbox.update(await readJson(req)));
   }
   if (path==='/api/ionos/send' && req.method==='POST' && req.headers['content-type']==='application/json') {
    const input = await readJson(req);
    if (!input || typeof input.id!=='string') return json(res,400,{error:'Invalid message.'});
    if (!deliveries.has(input.id)) {
     if (deliveries.size>=500) return json(res,429,{error:'Restart the local server to begin a new sending session.'});
     const delivery = mailbox.send(input).catch(error=>{deliveries.delete(input.id);throw error});
     deliveries.set(input.id,delivery);
    }
    return json(res,200,await deliveries.get(input.id));
   }
   return json(res,404,{error:'Unknown mailbox action.'});
  }
  if (path==='/' && req.method==='GET') {
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   return res.end(html.replace('</head>','<meta name="a2z-live-token" content="'+token+'"></head>'));
  }
  if (req.method==='GET' && /^\/assets\/[\w-]+\.(?:js|css)$/.test(path)) {
   const content = await readFile(new URL('../dist'+path,import.meta.url));
   res.writeHead(200,{'Content-Type':types[path.split('.').at(-1)]});
   return res.end(content);
  }
  return json(res,404,{error:'Page not found.'});
 } catch(error) {
  if (error instanceof TypeError) return json(res,400,{error:error.message});
  if (error.code==='ENOENT') return json(res,404,{error:'File not found.'});
  const authenticationFailed = error.authenticationFailed || error.code==='EAUTH' || error.serverResponseCode==='AUTHENTICATIONFAILED';
  return json(res,502,{error:authenticationFailed
   ? 'IONOS rejected the mailbox login. Check the mailbox email and password.'
   : path.endsWith('/send')
    ? 'IONOS did not confirm delivery. Check the recipient or sent mail before retrying.'
    : 'Could not load IONOS mail. Check your connection and mailbox settings.'});
 }
});
server.listen(4174,'127.0.0.1',()=>console.log('Local IONOS inbox: '+origin));
