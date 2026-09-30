/* =========================================================
   sw.js — عيادة د. عماد كريم
   1) يحفظ واجهة النظام والمكتبات على الجهاز ليفتح التطبيق بدون إنترنت.
   2) لا يحفظ أي بيانات مرضى أو ردود قاعدة البيانات إطلاقًا (Supabase / FDA تمر مباشرة للشبكة).
   3) عند رجوع الإنترنت يوقظ الصفحة لتزامن العمليات المعلّقة (Background Sync حيث يدعمه المتصفح).

   العمليات المعلّقة نفسها (حفظ كشف، حجز، مريض...) تُخزَّن داخل الصفحة (localStorage) وتُرسل تلقائيًا
   عند رجوع الاتصال — هذا الملف يضمن فقط أن الصفحة نفسها تُفتح بدون إنترنت وأن المزامنة تُطلق في وقتها.

   ارفع هذا الملف بجانب index.html في نفس المجلد. عند أي تعديل عليه غيّر رقم VERSION.
   ========================================================= */
const VERSION = 'v1';
const SHELL_CACHE = 'obc-shell-' + VERSION;   // صفحة النظام
const LIB_CACHE   = 'obc-libs-' + VERSION;    // مكتبات وخطوط خارجية (ثابتة)
const SYNC_TAG    = 'obc-sync-queue';

/* مكتبات تُحمَّل من الإنترنت: نحفظها مسبقًا عند أول تثبيت */
const PRECACHE_LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Baloo+Bhaijaan+2:wght@500;600;700;800&family=Tajawal:wght@400;500;700;900&display=swap'
];
/* مضيفات المكتبات والخطوط (تُخزَّن عند أول استخدام أيضًا، مثل ملفات الخط نفسها) */
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // صفحة النظام: نجرب المسارات المعتادة، وأي فشل لا يمنع التثبيت (الصفحة تُحفظ أيضًا عند أول تصفح)
    await Promise.all(['./', './index.html'].map(async url => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await shell.put(url, res);
      } catch (e) { /* بدون إنترنت أثناء التثبيت */ }
    }));
    const libs = await caches.open(LIB_CACHE);
    await Promise.all(PRECACHE_LIBS.map(async url => {
      try {
        const res = await fetch(new Request(url, { mode: 'no-cors' }));
        if (res) await libs.put(url, res);
      } catch (e) { /* تُحفظ لاحقًا عند أول استخدام */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, LIB_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('obc-') && !keep.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* شبكة أولًا مع مهلة: إذا الإنترنت ضعيف أو مقطوع نستخدم النسخة المحفوظة */
function networkFirst(request, cacheName, timeoutMs) {
  return (async () => {
    const cache = await caches.open(cacheName);
    try {
      const res = await Promise.race([
        fetch(request),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
      ]);
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    } catch (e) {
      const hit = (await cache.match(request, { ignoreSearch: true }))
               || (await cache.match('./index.html'))
               || (await cache.match('./'));
      if (hit) return hit;
      throw e;
    }
  })();
}

/* مخزن أولًا: للمكتبات والخطوط التي لا تتغير */
function cacheFirst(request, cacheName) {
  return (async () => {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  })();
}

/* قديم أولًا مع تحديث بالخلفية: لملفات الموقع الثابتة الأخرى (أيقونات...) */
function staleWhileRevalidate(request, cacheName) {
  return (async () => {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    const refresh = fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await refresh) || Response.error();
  })();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // الكتابة (حفظ/تعديل/حذف) تمر مباشرة للشبكة
  const url = new URL(req.url);

  // بيانات المرضى والقاعدة وFDA: لا نتدخل ولا نخزّن أي شيء منها
  if (url.hostname.endsWith('.supabase.co') || url.hostname === 'api.fda.gov') return;

  // صفحة النظام نفسها
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, 4000));
    return;
  }
  // مكتبات وخطوط خارجية
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }
  // ملفات ثابتة من نفس الموقع
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});

/* رجع الإنترنت: نوقظ الصفحة المفتوحة لتزامن العمليات المعلّقة */
self.addEventListener('sync', event => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ type: 'SYNC_NOW' }));
    // لا توجد نافذة مفتوحة: تبقى العمليات محفوظة وتُرسل تلقائيًا عند فتح التطبيق
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
