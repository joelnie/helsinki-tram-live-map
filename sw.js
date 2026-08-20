/**
 * HELSINKI TRAM TRACKER PWA - SERVICE WORKER
 * Caches static shell assets and CDN dependencies for fast loading & offline capability.
 */

const CACHE_NAME = 'helsinki-tram-v1.0.0';

// Assets to pre-cache on service worker installation
const STATIC_ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'favicon.ico',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/protobufjs@7.2.5/dist/protobuf.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

// Install Event
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching application shell assets');
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Pre-cache warning:', err);
      });
    })
  );
});

// Activate Event - Cache Cleanup
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

// Fetch Event - Routing & Caching Strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Bypass cache for WebSockets and HSL Live Data endpoints
  if (url.hostname.includes('mqtt.hsl.fi') || 
      url.hostname.includes('mqtt.digitransit.fi') || 
      url.hostname.includes('realtime.hsl.fi') ||
      url.protocol === 'wss:' || 
      url.protocol === 'ws:') {
    return; // Pass through to network
  }

  // 2. Stale-while-revalidate for Map Tiles (CartoDB / OpenStreetMap)
  if (url.hostname.includes('basemaps.cartocdn.com') || url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open('map-tiles-cache').then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          const fetchPromise = fetch(event.request).then((networkResponse) => {
            if (networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // 3. Cache-First Strategy for App Shell & Static CDNs
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Cache valid responses
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Offline fallback
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('index.html');
        }
      });
    })
  );
});
