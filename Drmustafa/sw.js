/* =====================================================================
   Service Worker — عيادة الدكتور مصطفى واثق
   الوظيفة:
   1) تخزين "هيكل" التطبيق (index.html + مكتبات CDN) للعمل بدون إنترنت.
   2) تخزين آخر نتائج القراءة (GET) من Supabase كي تظهر البيانات القديمة
      عند انقطاع الإنترنت بدل شاشة فارغة.
   3) عند فقدان الإنترنت: أي عملية حفظ/تعديل/حذف (POST/PATCH/DELETE) تُحفظ
      بطابور محلي (IndexedDB) بدل أن تفشل، ويُبلَّغ التطبيق بنجاح مؤقت.
      عند عودة الإنترنت تتم إعادة إرسالها تلقائيًا بنفس الترتيب، ثم يُبلَّغ
      التطبيق كي يعيد تحميل البيانات من الخادم.
   ملاحظة مهمة: هذا لا يعطي مُعرّف (id) حقيقي فور الإنشاء أثناء الانقطاع —
   السجل الجديد يظهر بالواجهة فقط بعد اكتمال المزامنة وإعادة التحميل.
   ===================================================================== */

const SW_VERSION   = 'clinic-v1';
const SHELL_CACHE   = SW_VERSION + '-shell';
const RUNTIME_CACHE  = SW_VERSION + '-runtime';
const DB_NAME     = 'clinic-offline-queue';
const STORE_NAME   = 'pending-requests';

/* الملفات الأساسية لتشغيل الواجهة دون إنترنت.
   نضيف صفحة التطبيق نفسها ومكتبات الـCDN التي يعتمد عليها. */
const SHELL_URLS = [
  './',
  './index.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&display=swap'
];

/* ===================== IndexedDB: طابور الطلبات المعلّقة ===================== */
function openQueueDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)){
        db.createObjectStore(STORE_NAME, {keyPath:'id', autoIncrement:true});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}
async function queueAdd(entry){
  const db = await openQueueDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror  = () => reject(tx.error);
  });
}
async function queueGetAll(){
  const db = await openQueueDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror  = () => reject(req.error);
  });
}
async function queueDelete(id){
  const db = await openQueueDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror  = () => reject(tx.error);
  });
}
async function queueCount(){
  const db = await openQueueDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror  = () => reject(req.error);
  });
}

/* ===================== أدوات مساعدة ===================== */
function isSupabaseUrl(url){
  try{ return new URL(url).hostname.endsWith('.supabase.co'); }catch(e){ return false; }
}
function isMutating(method){
  return ['POST','PATCH','PUT','DELETE'].includes(method.toUpperCase());
}
async function notifyClients(type, payload){
  const clientsList = await self.clients.matchAll({includeUncontrolled:true});
  clientsList.forEach(c => c.postMessage(Object.assign({type}, payload||{})));
}

/* ===================== التنصيب والتفعيل ===================== */
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_URLS.map(u => cache.add(new Request(u, {mode:'no-cors'})).catch(()=>{})));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
    trySyncQueue(); // حاول مزامنة أي طلبات علقت من جلسة سابقة
  })());
});

/* ===================== اعتراض الطلبات ===================== */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;

  // 1) طلبات Supabase
  if(isSupabaseUrl(url)){
    if(isMutating(req.method)){
      event.respondWith(handleMutatingRequest(req));
    }else{
      event.respondWith(handleReadRequest(req));
    }
    return;
  }

  // 2) باقي الملفات (الصفحة نفسها، الخطوط، مكتبات الـCDN): شبكة أولًا ثم كاش
  if(req.method === 'GET'){
    event.respondWith(handleShellRequest(req));
  }
});

async function handleReadRequest(req){
  const cache = await caches.open(RUNTIME_CACHE);
  try{
    const res = await fetch(req.clone());
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }catch(err){
    const cached = await cache.match(req);
    if(cached) return cached;
    // لا يوجد اتصال ولا نسخة محفوظة سابقة: مرّر الخطأ كما هو (بدون اختراع نتيجة فارغة) —
    // فبعض القراءات حسّاسة (مثل التحقق من صلاحية الحساب عند الدخول)، واختراع نتيجة فارغة
    // هناك يجعل النظام يظن أن الحساب غير موجود بدل أن يُظهر خطأ اتصال حقيقي.
    // كود التطبيق أصلاً يتعامل مع أخطاء الاتصال هذه بشكل صحيح (isNetworkError).
    throw err;
  }
}

async function handleMutatingRequest(req){
  try{
    const res = await fetch(req.clone());
    return res;
  }catch(err){
    // فشل الاتصال (وليس خطأ من الخادم) => خزّن الطلب بالطابور
    const body = ['GET','HEAD'].includes(req.method) ? null : await req.clone().text();
    const headers = {};
    req.headers.forEach((v,k)=>{ headers[k]=v; });
    await queueAdd({
      url: req.url,
      method: req.method,
      headers,
      body,
      queuedAt: Date.now()
    });
    scheduleBackgroundSync();
    await notifyClients('sw-queued', {count: await queueCount()});
    // استجابة "نجاح مؤقت" حتى لا يتوقف كود الصفحة عند خطأ شبكة
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: {'Content-Type':'application/json', 'X-Offline-Queued':'1'}
    });
  }
}

async function handleShellRequest(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const res = await fetch(req);
    if(res && res.ok && req.method === 'GET') cache.put(req, res.clone());
    return res;
  }catch(err){
    const cached = await cache.match(req, {ignoreSearch:true});
    if(cached) return cached;
    if(req.mode === 'navigate'){
      const fallback = await cache.match('./index.html') || await cache.match('./');
      if(fallback) return fallback;
    }
    throw err;
  }
}

/* ===================== مزامنة الطابور عند عودة الإنترنت ===================== */
function scheduleBackgroundSync(){
  if('sync' in self.registration){
    self.registration.sync.register('clinic-sync').catch(()=>{});
  }
}
self.addEventListener('sync', event => {
  if(event.tag === 'clinic-sync') event.waitUntil(trySyncQueue());
});
// بعض المتصفحات (وiOS بشكل خاص) لا تدعم Background Sync API،
// لذا نستمع أيضًا لحدث online مباشرة على الـService Worker،
// ونستقبل رسالة يدوية من الصفحة تطلب المزامنة فورًا.
self.addEventListener('online', () => trySyncQueue());
self.addEventListener('message', event => {
  if(event.data && event.data.type === 'sw-try-sync') trySyncQueue();
});

let isSyncing = false;
async function trySyncQueue(){
  if(isSyncing) return;
  isSyncing = true;
  try{
    let items = await queueGetAll();
    if(!items.length) return;
    items.sort((a,b)=> a.queuedAt - b.queuedAt);
    let syncedCount = 0, failed = false;
    for(const item of items){
      try{
        const res = await fetch(item.url, {
          method: item.headers ? item.method : item.method,
          headers: item.headers,
          body: item.body
        });
        if(!res.ok && res.status >= 500){
          // خطأ خادم مؤقت: أوقف وحاول لاحقًا، أبقِ الطلب بالطابور
          failed = true;
          break;
        }
        await queueDelete(item.id);
        syncedCount++;
      }catch(err){
        // ما زلنا دون إنترنت: أوقف المحاولة وانتظر الحدث التالي
        failed = true;
        break;
      }
    }
    if(syncedCount > 0){
      await notifyClients('sw-sync-progress', {synced: syncedCount});
    }
    const remaining = await queueCount();
    if(remaining === 0){
      await notifyClients('sw-sync-complete', {});
    }else{
      await notifyClients('sw-queued', {count: remaining});
      if(!failed) scheduleBackgroundSync();
    }
  } finally {
    isSyncing = false;
  }
}
