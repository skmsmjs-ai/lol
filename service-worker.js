const CACHE = 'naejun-matchmaker-v6-cloud-20261001';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./role-model.js','./shared-store.js','./cloud-config.js','./matcher-worker.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('naejun-matchmaker-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url=new URL(event.request.url);
  if(event.request.method !== 'GET'||url.origin!==self.location.origin||url.pathname.includes('/api/')) return;
  // Network-first keeps installed clients current. Never cache protected API responses or
  // return an HTML page as a failed JavaScript/API request.
  event.respondWith(fetch(event.request).then(resp=>{
    if(resp.ok){const copy=resp.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}return resp;
  }).catch(async()=>{
    const cached=await caches.match(event.request);if(cached)return cached;
    if(event.request.mode==='navigate')return (await caches.match('./index.html'))||Response.error();
    return Response.error();
  }));
});
