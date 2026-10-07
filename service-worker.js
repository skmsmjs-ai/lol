const CACHE = 'naejun-matchmaker-v8-role-readings-20261007';
const ASSETS = ['./legacy-role-model.js','./match-math.js','./','./index.html','./styles.css?v=8-role-readings-20261007','./app.js?v=8-role-readings-20261007','./role-model.js?v=8-role-readings-20261007','./role-model.js','./room-rules.js','./record-edits.js?v=8-role-readings-20261007','./shared-store.js?v=8-role-readings-20261007','./cloud-config.js?v=8-role-readings-20261007','./entry-input.js?v=8-role-readings-20261007','./matcher-worker.js?v=8-role-readings-20261007','./manifest.webmanifest?v=8-role-readings-20261007','./icon-entry-180.png','./icon-entry-192.png','./icon-entry-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path=>new Request(new URL(path,self.location.href),{cache:'reload'})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('naejun-matchmaker-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url=new URL(event.request.url);
  if(event.request.method !== 'GET'||url.origin!==self.location.origin||url.pathname.includes('/api/')) return;
  // Network-first keeps installed clients current. Never cache protected API responses or
  // return an HTML page as a failed JavaScript/API request.
  event.respondWith(fetch(event.request,{cache:'no-cache'}).then(resp=>{
    if(resp.ok){const copy=resp.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}return resp;
  }).catch(async()=>{
    const cached=await caches.match(event.request);if(cached)return cached;
    if(event.request.mode==='navigate')return (await caches.match('./index.html'))||Response.error();
    return Response.error();
  }));
});
