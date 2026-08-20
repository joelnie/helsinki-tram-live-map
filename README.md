# 🚃 Spora-Live — Live Tram Tracker PWA

A high-performance Progressive Web App (PWA) displaying live vehicle positions, route track geometries, and real-time HSL service detours for Helsinki trams and Light Rail Line 15 (Raide-Jokeri) on an interactive vector map.

Designed for mobile **"Add to Home Screen"** usage, complete with offline service worker caching, safe-area inset handling, smooth position interpolation, and zero-backend client-side execution.

![Spora-Live App Icon](icons/icon-512.png)

---

## ✨ Key Features

- **⚡ Real-Time Positioning**: Powered by HSL's HFP v2 (High-Frequency Positioning) MQTT stream over WebSockets (`wss://mqtt.hsl.fi:443/`).
- **🔄 GTFS-RT Fallback**: Automatic fallback to GTFS-RT HTTP Protobuf feeds if WebSockets are delayed or restricted by network firewalls.
- **🚨 Poikkeustiedotteet (Service Detours & Alerts)**: Lower-left pop-up card parsing official GTFS-RT service alerts, event detours (*Taiteiden yö*, *Pasila rail work*, etc.), and 7-day active/upcoming disruptions.
- **🎛️ 3-State Tram Line Widget**:
  - **State 1 (Both)**: Solid badge showing moving vehicles and route lines.
  - **State 2 (Tracks Only)**: Dashed badge hiding vehicles while keeping route lines visible.
  - **State 3 (Hidden)**: Dimmed badge hiding both vehicles and route lines.
- **🎨 Dark & Light Theme System**:
  - Seamless full-viewport Dark and Light themes with dynamic `<meta name="theme-color">` and status bar color adaptation.
  - Multiple color palettes: *Default*, *Rainbow*, *Pale*, *HSL*, and *Black*.
  - High-contrast light gray styling for unselected line buttons in Light Theme mode.
- **📱 Standalone Native App Mode**:
  - iOS Safari & Android Chrome fullscreen PWA support (`apple-mobile-web-app-capable`).
  - Notch & Safe Area support via `viewport-fit=cover` and CSS `env(safe-area-inset-top)`.
  - Custom **SPORA-LIVE** Home Screen app icon set.
- **📊 Detailed Vehicle Inspector**: Tap any tram marker to inspect real-time speed (km/h), schedule delay (on-time / delay / early), unit number, compass heading, and live camera follow mode.

---

## 📡 Data Source & Architecture

The application connects directly to official open APIs operated by **HSL (Helsingin seudun liikenne) / Digitransit**:

1. **Primary Vehicle Feed (MQTT over WebSockets)**:
   - **Broker**: `mqtt.hsl.fi:443` (WSS / Secure WebSockets)
   - **Topic Pattern**: `/hfp/v2/journey/ongoing/vp/tram/#`
   - **Payload**: JSON (`VP` payload containing `lat`, `long`, `hdg`, `spd`, `desi`, `dl`, `veh`, `dir`)
2. **Service Alerts Feed (GTFS-RT Protobuf)**:
   - **URL**: `https://realtime.hsl.fi/realtime/service-alerts/v2/hsl`
   - **Payload**: GTFS-RT Protobuf decoded client-side via `protobuf.js`.
3. **Route Track Geometries**:
   - **URL**: Digitransit GraphQL API (`https://api.digitransit.fi/routing/v2/hsl/gtfs/v1`)

> 💡 **Zero API Key Required**: HSL open data feeds are free and open to the public without authentication keys.

---

## 🚀 Publishing on GitHub Pages

Since the app is built entirely with client-side HTML, CSS, JavaScript, and Service Workers, it requires **no build step** or backend server.

1. Push this repository to GitHub (`https://github.com/joelnie/helsinki-tram-live-map`).
2. Go to **Settings** $\rightarrow$ **Pages** in your GitHub repository.
3. Under **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main`
   - **Folder**: `/ (root)`
4. Click **Save**. Your app will be live at `https://<your-username>.github.io/helsinki-tram-live-map/`.

---

## 📲 Installing as a Standalone Mobile App

### 📱 iPhone / iPad (iOS Safari)
1. Open `https://joelnie.github.io/helsinki-tram-live-map/` in **Safari**.
2. Tap the **Share** button `⎋` (bottom toolbar).
3. Scroll down and tap **Add to Home Screen** (*Lisää kotivalikkoon*).
4. Tap **Add**. The **SPORA-LIVE** icon appears on your home screen and launches in full-screen standalone mode.

### 🤖 Android (Google Chrome)
1. Open `https://joelnie.github.io/helsinki-tram-live-map/` in **Google Chrome**.
2. Tap the **Three Dots Menu `⋮`** (top right) or the bottom install banner.
3. Tap **Install App** / **Add to Home screen**.

---

## 💻 Local Development

To run and test the app locally:

1. Clone the repository:
   ```bash
   git clone https://github.com/joelnie/helsinki-tram-live-map.git
   cd helsinki-tram-live-map
   ```

2. Start a local HTTP server (Service Workers require an HTTP/HTTPS origin):

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

## 🛠️ Repository Structure

```
helsinki-tram-live-map/
├── index.html            # App shell, glassmorphic header, Poikkeustiedotteet card, modals
├── styles.css            # CSS tokens, HSL colors, Dark/Light theme, 3-state buttons, safe areas
├── app.js                # Map engine, Leaflet logic, MQTT client, GTFS-RT parser, filters, theme system
├── sw.js                 # Service worker for offline asset and tile caching
├── manifest.json         # PWA web manifest metadata
├── favicon.ico           # Browser favicon
├── icons/                # PWA app icon set with SPORA-LIVE typography
└── README.md             # Documentation & deployment guide
```

---

## 📜 License & Attributions

- Real-time transit data provided by **HSL / Digitransit Open Data** under CC BY 4.0 license.
- Map vector tiles by **CARTO** / **OpenStreetMap**.
- Built with [Leaflet.js](https://leafletjs.com/), [MQTT.js](https://github.com/mqttjs/MQTT.js), and [Protobuf.js](https://github.com/protobufjs/protobuf.js).

