const CACHE_NAME = 'linkey-v4.4.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  // 带版本参数的 URL 须与 index.html 中的实际引用一致，否则缓存键永不命中
  '/css/style.css?v=4.3.2-scrollable',
  '/js/qr.js?v=4.3.6-localqr',
  '/js/app.js?v=4.3.5-dynpoll',
  '/js/api.js',
  '/js/audio.js',
  '/js/socket.js',
  '/js/effects.js',
  '/manifest.json',
  '/app-icon-192.png',
  '/app-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 逐个缓存，单个资源失败不阻断整体安装
      return Promise.all(STATIC_ASSETS.map((url) => {
        return cache.add(url).catch((err) => console.warn('[SW] 预缓存失败:', url, err.message));
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Do not cache API or WebSocket requests
  if (event.request.url.includes('/api/') || event.request.url.includes('/ws')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
