/**
 * HELSINKI TRAM TRACKER PWA - SERVICE WORKER
 * Caches static shell assets with Network-First strategy for live code updates.
 */

const CACHE_NAME = 'helsinki-tram-v1.1.3';

// Assets to pre-cache on service worker installation
const STATIC_ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'routes.json',
  'routes.json?v=1.1.3',
  'stops.json',
  'favicon.ico',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

// Install Event - Force immediate activation
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching v1.1.3 application shell');
      return cache.addAll(STATIC_ASSETS).catch(err => console.warn('[SW] Pre-cache warning:', err));
    })
  );
});

// Activate Event - Purge all old caches immediately & claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Network-First for JS/CSS/HTML/JSON so updates are instantaneous
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Bypass cache for WebSockets and HSL Live Data endpoints
  if (url.hostname.includes('mqtt.hsl.fi') || 
      url.hostname.includes('mqtt.digitransit.fi') || 
      url.hostname.includes('realtime.hsl.fi') ||
      url.protocol === 'wss:' || 
      url.protocol === 'ws:') {
    return;
  }

  // 2. Network-First Strategy for App Shell (HTML, JS, CSS, JSON)
  if (event.request.mode === 'navigate' || 
      url.pathname.endsWith('.js') || 
      url.pathname.endsWith('.css') || 
      url.pathname.endsWith('.json') || 
      url.pathname.includes('routes.json') ||
      url.pathname.endsWith('index.html') || 
      url.pathname === '/' || 
      url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // 3. Cache-First Strategy for Static CDN assets & icons
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return networkResponse;
      }).catch(() => caches.match('index.html'));
    })
  );
});
