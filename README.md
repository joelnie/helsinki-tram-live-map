# 🚃 Helsinki Live Tram Tracker PWA

A lightweight, high-performance Progressive Web App (PWA) displaying live vehicle positions of Helsinki trams and Light Rail Line 15 (Raide-Jokeri) on an interactive vector map.

Designed for iPhone Safari **"Add to Home Screen"** usage, complete with offline service worker caching, safe-area inset handling, smooth position interpolation, and zero-backend client-side execution.

![Helsinki Tram Tracker Preview](icons/icon-512.png)

---

## ✨ Features

- **⚡ Real-Time Positioning**: Powered by HSL's HFP v2 (High-Frequency Positioning) MQTT stream over WebSockets (`wss://mqtt.hsl.fi:443/`).
- **🔄 GTFS-RT Fallback**: Automatic fallback to GTFS-RT HTTP protobuf polling if WebSockets are delayed or restricted by network firewalls.
- **📱 iPhone Safari PWA Optimized**:
  - Full-screen standalone display (`apple-mobile-web-app-capable`).
  - Notch & Safe Area support via `viewport-fit=cover` and CSS `env(safe-area-inset-top)`.
  - Native iOS share sheet installation prompt banner.
- **🎨 HSL Visual Design**:
  - City Tram Green (`#00985f`) and Raide-Jokeri Teal (`#007ac9`) line badges.
  - Directional vehicle pointer arrow rotating smoothly according to compass heading (`hdg`).
- **🎛️ Tram Line Filtering**: Toggle specific routes (Lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, and Light Rail Line 15). Preferences are saved in `localStorage`.
- **📊 Detailed Vehicle Inspector**: Tap any vehicle marker to inspect real-time speed (km/h), schedule delay (on-time / delay / early), unit number, and follow the vehicle in real-time.
- **🌐 Offline Support**: Service Worker (`sw.js`) caches app shell and vector map tiles for rapid loading.

---

## 📡 Data Source & API Architecture

The application connects directly to official open APIs operated by **HSL (Helsingin seudun liikenne) / Digitransit**:

1. **Primary Feed (MQTT over WebSockets)**:
   - **Broker**: `mqtt.hsl.fi`
   - **Port**: `443` (WSS / Secure WebSockets)
   - **Topic Pattern**: `/hfp/v2/journey/ongoing/vp/tram/#`
   - **Format**: JSON (`VP` payload containing `lat`, `long`, `hdg`, `spd`, `desi`, `dl`, `veh`, `dir`)
2. **Fallback Feed (GTFS-RT HTTP)**:
   - **URL**: `https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl`
   - **Format**: Protobuf GTFS-RT feed decoded in browser using `protobuf.js`.

> 💡 **Zero API Key Required**: HSL open data feeds are free and open to the public without authentication keys.

---

## 🚀 Deployment to GitHub Pages

Since the app is built entirely with client-side HTML, CSS, JavaScript, and Service Workers, it requires **no build step** or backend server.

### Option A: Standard Repository Root Deployment
1. Push this repository to GitHub.
2. Go to **Settings** \(\rightarrow\) **Pages** in your GitHub repository.
3. Under **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` (or `master`)
   - **Folder**: `/ (root)`
4. Click **Save**. Your site will be published at `https://<your-username>.github.io/<repo-name>/`.

### Option B: Deploying via `/docs` Folder
If you prefer publishing from `/docs`:
1. Move `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.json`, `favicon.ico`, and `icons/` into a `docs/` subfolder.
2. Update GitHub Pages settings to use `/docs` as source.

---

## 💻 Local Development

To run and test the app on your local machine:

1. Clone or navigate to the repository directory:
   ```bash
   cd helsinki-tram-live-map
   ```

2. Start a simple HTTP server (Service Workers require an HTTP/HTTPS server):

   **Using Python**:
   ```bash
   python3 -m http.server 8000
   ```

   **Using Node `npx serve`**:
   ```bash
   npx serve .
   ```

3. Open your browser and visit: `http://localhost:8000`

---

## 📲 Installing on iPhone (iOS Safari)

1. Open the deployed website link in **Safari** on your iPhone.
2. Tap the **Share** icon \(\uparrow\) at the bottom of the screen.
3. Scroll down and tap **Add to Home Screen** \(\mathbf{+}\).
4. Tap **Add**. The Helsinki Tram Tracker icon will appear on your home screen and open in full-screen standalone mode.

---

## 🛠️ Repository Structure

```
helsinki-tram-live-map/
├── index.html            # App shell, glassmorphic header, modals, script imports
├── styles.css            # CSS tokens, HSL colors, dark theme, marker animations, safe area insets
├── app.js                # Map engine, Leaflet logic, MQTT client, GTFS-RT parser, filters
├── sw.js                 # Service worker for offline asset and tile caching
├── manifest.json         # PWA web manifest metadata
├── favicon.ico           # Browser favicon
├── icons/                # PWA app icons (192x192, 512x512, maskable, apple-touch-icon)
└── README.md             # Documentation & deployment guide
```

---

## 🔮 Extending to Buses or Metro

To extend the app to display buses or Metro trains:
1. In `app.js`, change or expand the MQTT topic subscription:
   - Buses: `/hfp/v2/journey/ongoing/vp/bus/#`
   - Metro: `/hfp/v2/journey/ongoing/vp/metro/#`
2. Add corresponding line metadata to `LINE_META` and UI filter pills in `index.html`.

---

## 📜 License & Attributions

- Data provided by **HSL / Digitransit Open Real-time Data** under CC BY 4.0 license.
- Map tiles by **CARTO** / **OpenStreetMap**.
- Built with [Leaflet.js](https://leafletjs.com/), [MQTT.js](https://github.com/mqttjs/MQTT.js), and [Protobuf.js](https://github.com/protobufjs/protobuf.js).
