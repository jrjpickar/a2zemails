// A2Z Inbox service worker: keeps the app shell available offline. Mail and API calls always go to the network.
const shellCache='a2z-shell-v1';
const assetCache='a2z-assets-v1';
const assetLimit=40;

// Saves the page plus every build file it references, so the first visit already works offline.
async function saveShell(response) {
 const html=await response.clone().text();
 await (await caches.open(shellCache)).put('/',response);
 const files=[...new Set(html.match(/\/assets\/[^"'\s>]+/g)||[])];
 const cache=await caches.open(assetCache);
 await Promise.all(files.map(async file=>{if (!(await cache.match(file))) await cache.add(file).catch(()=>{});}));
 await trim(cache);
}

self.addEventListener('install',event=>{
 event.waitUntil(fetch('/',{cache:'no-store'}).then(response=>response.ok?saveShell(response):null).catch(()=>{}));
 self.skipWaiting();
});

self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys()
  .then(keys=>Promise.all(keys.filter(key=>key!==shellCache&&key!==assetCache).map(key=>caches.delete(key))))
  .then(()=>self.clients.claim()));
});

async function trim(cache) {
 const keys=await cache.keys();
 await Promise.all(keys.slice(0,Math.max(0,keys.length-assetLimit)).map(key=>cache.delete(key)));
}

self.addEventListener('fetch',event=>{
 const request=event.request;
 if (request.method!=='GET') return;
 const url=new URL(request.url);
 if (url.origin!==self.location.origin) return;
 if (request.mode==='navigate') {
  // Network first so a new deploy always wins. The cached shell is only the offline fallback.
  event.respondWith(fetch(request).then(response=>{
   if (url.pathname==='/'&&response.ok&&!response.redirected) event.waitUntil(saveShell(response.clone()).catch(()=>{}));
   return response;
  }).catch(async()=>(await caches.match('/'))||Response.error()));
  return;
 }
 if (url.pathname.startsWith('/assets/')||url.pathname.startsWith('/icons/')) {
  // Hashed build files never change, so cache first.
  event.respondWith(caches.open(assetCache).then(async cache=>{
   const cached=await cache.match(request);
   if (cached) return cached;
   const response=await fetch(request);
   if (response.ok) event.waitUntil(cache.put(request,response.clone()).then(()=>trim(cache)));
   return response;
  }));
 }
});
