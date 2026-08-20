/**
 * HELSINKI TRAM TRACKER PWA - MAIN APPLICATION LOGIC
 * Real-time map displaying Helsinki trams using HSL HFP v2 MQTT & GTFS-RT fallback.
 */

(() => {
  'use strict';

  // =========================================================================
  // APP CONFIGURATION & CONSTANTS
  // =========================================================================
  const CONFIG = {
    HELSINKI_CENTER: [60.1699, 24.9384],
    DEFAULT_ZOOM: 13,
    MQTT_WSS_URL: 'wss://mqtt.hsl.fi:443/',
    MQTT_FALLBACK_URL: 'wss://mqtt.digitransit.fi:443/',
    MQTT_TOPIC: '/hfp/v2/journey/ongoing/vp/tram/#',
    GTFS_RT_HTTP_URL: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    GTFS_RT_POLL_INTERVAL: 7000, // ms
    STALE_THRESHOLD_MS: 180000,   // 3 minutes
    DEFAULT_LINES: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '13', '15']
  };

  // Line Descriptions, Destinations, & Distinct Color Palette for display
  const LINE_META = {
    '1': { name: { fi: 'Eira – Käpylä', en: 'Eira – Käpylä' }, color: '#10b981' },
    '2': { name: { fi: 'Olympiaterminaali – Pasila', en: 'Olympia Terminal – Pasila' }, color: '#2563eb' },
    '3': { name: { fi: 'Olympiaterminaali – Meilahti', en: 'Olympia Terminal – Meilahti' }, color: '#f59e0b' },
    '4': { name: { fi: 'Katajanokka – Munkkiniemi', en: 'Katajanokka – Munkkiniemi' }, color: '#84cc16' },
    '5': { name: { fi: 'Katajanokan terminaali – Rautatientori', en: 'Katajanokka Terminal – Railway Station' }, color: '#f43f5e' },
    '6': { name: { fi: 'Hietalahti – Arabia', en: 'Hietalahti – Arabia' }, color: '#ec4899' },
    '7': { name: { fi: 'Länsiterminaali – Meilahden sairaala', en: 'West Terminal – Meilahti Hospital' }, color: '#a855f7' },
    '8': { name: { fi: 'Jätkäsaari – Arabia', en: 'Jätkäsaari – Arabia' }, color: '#dc2626' },
    '9': { name: { fi: 'Länsiterminaali – Ilmala', en: 'West Terminal – Ilmala' }, color: '#14b8a6' },
    '10': { name: { fi: 'Kirurgi – Pikku Huopalahti', en: 'Surgical Hospital – Pikku Huopalahti' }, color: '#6366f1' },
    '13': { name: { fi: 'Kalasatama – Pasila', en: 'Kalasatama – Pasila' }, color: '#eab308' },
    '15': { name: { fi: 'Raide-Jokeri: Keilaniemi – Itäkeskus', en: 'Light Rail 15: Keilaniemi – Itäkeskus' }, color: '#007ac9', isLightRail: true }
  };

  // State Management
  const state = {
    map: null,
    userMarker: null,
    vehicles: new Map(), // vehicle_key -> vehicle object
    activeFilters: new Set(),
    showRouteTracks: true,
    routeData: null,
    routePolylineGroup: null,
    selectedVehicleId: null,
    isFollowing: false,
    mqttClient: null,
    connectionMode: 'connecting',
    gtfsPollTimer: null,
    mqttTimeoutTimer: null,
    lastMsgTimestamp: null,
    staleCheckTimer: null,
    disturbances: [],
    lineModes: new Map(), // line -> 'both' | 'tracks_only' | 'hidden'
    currentLang: localStorage.getItem('app_lang') || 'fi',
    currentTheme: localStorage.getItem('app_theme') || 'dark',
    currentPalette: localStorage.getItem('tram_palette') || 'default'
  };

  // =========================================================================
  // INITIALIZATION
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    initSettings();
    initFilters();
    initMap();
    initUIEvents();
    checkIosPwaBanner();
    loadRouteData();
    startRealtimeEngine();
    fetchDisturbances();
    
    // Periodically fetch disturbances and clean stale vehicles
    setInterval(fetchDisturbances, 60000);
    state.staleCheckTimer = setInterval(cleanStaleVehicles, 30000);
    // UI timer update
    setInterval(updateLastSeenUI, 2000);
  });

  // =========================================================================
  // LEAFLET MAP INITIALIZATION & ROUTE TRACKS
  // =========================================================================
  function initMap() {
    state.map = L.map('map', {
      center: CONFIG.HELSINKI_CENTER,
      zoom: CONFIG.DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: false
    });

    // CartoDB Positron Tile Layer (crisp, beautiful retina display map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | Data: HSL'
    }).addTo(state.map);

    // Layer group for route track polylines
    state.routePolylineGroup = L.layerGroup().addTo(state.map);

    // Dynamic Zoom Scaling Listener
    state.map.on('zoomend zoom', updateZoomClass);
    updateZoomClass();

    // Map click clears selection
    state.map.on('click', () => {
      deselectVehicle();
    });
  }

  function updateZoomClass() {
    const mapEl = document.getElementById('map');
    if (!mapEl || !state.map) return;
    const zoom = state.map.getZoom();
    mapEl.classList.remove('zoom-low', 'zoom-mid', 'zoom-high');
    if (zoom <= 12) {
      mapEl.classList.add('zoom-low');
    } else if (zoom <= 14) {
      mapEl.classList.add('zoom-mid');
    } else {
      mapEl.classList.add('zoom-high');
    }
  }

  // Load static track geometries from routes.json
  async function loadRouteData() {
    try {
      const response = await fetch('routes.json');
      if (!response.ok) return;
      state.routeData = await response.json();
      renderRouteTracks();
    } catch (e) {
      console.warn('Could not load routes.json:', e);
    }
  }

  // Parallel offset algorithm to render overlapping route tracks side-by-side
  function offsetPolyline(points, offsetDist) {
    if (!offsetDist || !points || points.length < 2) return points;
    const result = [];
    const len = points.length;

    for (let i = 0; i < len; i++) {
      let p1, p2;
      if (i === 0) {
        p1 = points[0];
        p2 = points[1];
      } else if (i === len - 1) {
        p1 = points[len - 2];
        p2 = points[len - 1];
      } else {
        p1 = points[i - 1];
        p2 = points[i + 1];
      }

      const dLat = p2[0] - p1[0];
      const dLng = p2[1] - p1[1];
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);

      if (dist === 0) {
        result.push(points[i]);
      } else {
        // Normal vector perpendicular to segment direction
        const nx = -dLng / dist;
        const ny = dLat / dist;
        // Adjust longitude scaling for Helsinki's ~60.17° latitude
        const newLat = points[i][0] + nx * offsetDist;
        const newLng = points[i][1] + (ny * offsetDist) / 0.5;
        result.push([newLat, newLng]);
      }
    }
    return result;
  }

  function renderRouteTracks() {
    if (!state.routePolylineGroup || !state.routeData) return;
    state.routePolylineGroup.clearLayers();

    const visibleTrackLines = CONFIG.DEFAULT_LINES.filter((line) => {
      const mode = state.lineModes.get(line) || 'both';
      return mode === 'both' || mode === 'tracks_only';
    }).sort((a, b) => (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99));

    const totalActive = visibleTrackLines.length;

    visibleTrackLines.forEach((lineKey, idx) => {
      if (state.routeData[lineKey]) {
        const segments = state.routeData[lineKey];
        const meta = LINE_META[lineKey] || { color: '#10b981' };
        const isLightRail = lineKey === '15';
        const weight = isLightRail ? 4.5 : 3.5;

        const offsetStep = 0.000030;
        const offsetDist = (idx - (totalActive - 1) / 2) * offsetStep;

        segments.forEach((seg) => {
          const shiftedSeg = offsetPolyline(seg, offsetDist);
          const polyline = L.polyline(shiftedSeg, {
            color: meta.color,
            weight: weight,
            opacity: 0.8,
            smoothFactor: 1.2,
            interactive: false
          });
          state.routePolylineGroup.addLayer(polyline);
        });
      }
    });
  }

  // Inline Protobuf JSON Schema for instant 0.01s offline-capable GTFS-RT decoding
  const GTFS_RT_SCHEMA = {
    nested: {
      transit_realtime: {
        nested: {
          FeedMessage: {
            fields: {
              header: { id: 1, type: "FeedHeader" },
              entity: { rule: "repeated", id: 2, type: "FeedEntity" }
            }
          },
          FeedHeader: {
            fields: {
              gtfsRealtimeVersion: { id: 1, type: "string" },
              timestamp: { id: 3, type: "uint64" }
            }
          },
          FeedEntity: {
            fields: {
              id: { id: 1, type: "string" },
              isDeleted: { id: 2, type: "bool" },
              vehicle: { id: 4, type: "VehiclePosition" }
            }
          },
          VehiclePosition: {
            fields: {
              trip: { id: 1, type: "TripDescriptor" },
              position: { id: 2, type: "Position" },
              timestamp: { id: 5, type: "uint64" },
              vehicle: { id: 8, type: "VehicleDescriptor" }
            }
          },
          TripDescriptor: {
            fields: {
              tripId: { id: 1, type: "string" },
              routeId: { id: 5, type: "string" }
            }
          },
          Position: {
            fields: {
              latitude: { id: 1, type: "float" },
              longitude: { id: 2, type: "float" },
              bearing: { id: 3, type: "float" },
              speed: { id: 4, type: "float" }
            }
          },
          VehicleDescriptor: {
            fields: {
              id: { id: 1, type: "string" },
              label: { id: 2, type: "string" }
            }
          }
        }
      }
    }
  };

  let gtfsPbRoot = null;

  // =========================================================================
  // REAL-TIME DATA ENGINE (MQTT & GTFS-RT FALLBACK)
  // =========================================================================
  function startRealtimeEngine() {
    updateConnectionStatus('connecting', 'Yhdistetään...');

    // Immediately fetch initial GTFS-RT positions so map populates trams instantly
    fetchGtfsRtVehicles();

    // Fast 3-second timeout to fall back to GTFS-RT HTTP polling if MQTT is delayed
    state.mqttTimeoutTimer = setTimeout(() => {
      if (!state.lastMsgTimestamp && state.connectionMode !== 'gtfs-rt') {
        initGtfsRtPolling();
      }
    }, 3000);

    initMqttConnection();
  }

  // 1. MQTT Connection over WebSockets
  function initMqttConnection() {
    if (typeof mqtt === 'undefined') {
      initGtfsRtPolling();
      return;
    }

    const clientId = 'tram_pwa_' + Math.random().toString(16).substring(2, 9);
    
    try {
      state.mqttClient = mqtt.connect(CONFIG.MQTT_WSS_URL, {
        clientId: clientId,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 4000,
        connectTimeout: 5000
      });

      state.mqttClient.on('connect', () => {
        updateConnectionStatus('live', 'Live');
        
        state.mqttClient.subscribe(CONFIG.MQTT_TOPIC, (err) => {
          if (err) {
            initGtfsRtPolling();
          }
        });
      });

      state.mqttClient.on('message', (topic, message) => {
        state.lastMsgTimestamp = Date.now();
        updateConnectionStatus('live', 'Live');

        if (state.mqttTimeoutTimer) {
          clearTimeout(state.mqttTimeoutTimer);
          state.mqttTimeoutTimer = null;
        }

        try {
          const payload = JSON.parse(message.toString());
          if (payload && payload.VP) {
            handleHfpVehiclePosition(payload.VP);
          }
        } catch (e) {
          // Ignore invalid JSON format
        }
      });

      state.mqttClient.on('error', (err) => {
        if (!state.lastMsgTimestamp) {
          initGtfsRtPolling();
        }
      });

      state.mqttClient.on('offline', () => {
        if (state.connectionMode === 'live' && !state.lastMsgTimestamp) {
          updateConnectionStatus('offline', 'Ei yhteyttä');
        }
      });

    } catch (err) {
      initGtfsRtPolling();
    }
  }

  // Handle HFP v2 VP (Vehicle Position) payload
  function handleHfpVehiclePosition(vp) {
    if (!vp.lat || !vp.long || !vp.desi) return;

    const rawLine = String(vp.desi).trim();
    const lineKey = normalizeLineKey(rawLine);

    // Vehicle unique ID
    const vehId = String(vp.veh || `${vp.oper || 'veh'}_${rawLine}_${Math.floor(vp.lat*1000)}`);
    const key = `veh_${vehId}`;

    const lat = parseFloat(vp.lat);
    const lng = parseFloat(vp.long);
    const heading = typeof vp.hdg === 'number' ? vp.hdg : 0;
    const speedKmh = typeof vp.spd === 'number' ? Math.round(vp.spd * 3.6) : 0; // m/s to km/h
    const delaySec = typeof vp.dl === 'number' ? vp.dl : 0;
    const dir = vp.dir ? String(vp.dir) : '1';

    const vehicleData = {
      id: vehId,
      key: key,
      line: lineKey,
      rawLine: rawLine,
      lat: lat,
      lng: lng,
      heading: heading,
      speed: speedKmh,
      delay: delaySec,
      dir: dir,
      lastUpdated: Date.now()
    };

    updateVehicleOnMap(vehicleData);
  }

  // Normalize line numbers like "8T" -> "8", "9T" -> "9", "15" -> "15"
  function normalizeLineKey(line) {
    if (!line) return '';
    let normalized = line.replace(/[^0-9]/g, '');
    if (!normalized) normalized = line;
    return normalized;
  }

  // 2. GTFS-RT HTTP Polling Fallback
  function initGtfsRtPolling() {
    state.connectionMode = 'gtfs-rt';
    
    if (state.mqttClient) {
      try { state.mqttClient.end(true); } catch(e){}
    }

    fetchGtfsRtVehicles();

    if (state.gtfsPollTimer) clearInterval(state.gtfsPollTimer);
    state.gtfsPollTimer = setInterval(fetchGtfsRtVehicles, CONFIG.GTFS_RT_POLL_INTERVAL);
  }

  async function fetchGtfsRtVehicles() {
    const urls = [
      'https://api.allorigins.win/raw?url=https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
      CONFIG.GTFS_RT_HTTP_URL
    ];

    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        
        const buffer = await response.arrayBuffer();
        
        if (typeof protobuf !== 'undefined') {
          if (!gtfsPbRoot) {
            gtfsPbRoot = protobuf.Root.fromJSON(GTFS_RT_SCHEMA);
          }
          
          const FeedMessage = gtfsPbRoot.lookupType('transit_realtime.FeedMessage');
          const message = FeedMessage.decode(new Uint8Array(buffer));
          
          state.lastMsgTimestamp = Date.now();
          updateConnectionStatus('live', 'Live');

          if (message.entity) {
            message.entity.forEach((entity) => {
              if (entity.vehicle && entity.vehicle.position) {
                const vp = entity.vehicle;
                const rawLine = vp.trip && vp.trip.routeId ? String(vp.trip.routeId).trim() : '1';
                const lineKey = normalizeLineKey(rawLine);

                if (CONFIG.DEFAULT_LINES.includes(lineKey)) {
                  const vehId = String((vp.vehicle && (vp.vehicle.id || vp.vehicle.label)) || entity.id);
                  
                  updateVehicleOnMap({
                    id: vehId,
                    key: `veh_${vehId}`,
                    line: lineKey,
                    rawLine: rawLine,
                    lat: vp.position.latitude,
                    lng: vp.position.longitude,
                    heading: vp.position.bearing || 0,
                    speed: typeof vp.position.speed === 'number' ? Math.round(vp.position.speed * 3.6) : 0,
                    delay: 0,
                    lastUpdated: Date.now()
                  });
                }
              }
            });
          }
          return;
        }
      } catch (err) {
        console.warn('GTFS-RT fetch error:', url, err);
      }
    }
  }
  // =========================================================================
  // VEHICLE MARKER & MAP RENDERER
  // =========================================================================
  function updateVehicleOnMap(data) {
    const mode = state.lineModes.get(data.line) || 'both';
    const isVehVisible = mode === 'both';
    const existing = state.vehicles.get(data.key);

    if (existing) {
      existing.lat = data.lat;
      existing.lng = data.lng;
      existing.heading = data.heading;
      existing.speed = data.speed;
      existing.delay = data.delay;
      existing.lastUpdated = data.lastUpdated;

      if (existing.marker) {
        existing.marker.setLatLng([data.lat, data.lng]);
        
        const wrapper = document.getElementById(`marker-${data.id}`);
        if (wrapper) {
          const pointer = wrapper.querySelector('.tram-direction-pointer');
          if (pointer) pointer.style.transform = `rotate(${data.heading}deg) translateY(-20px)`;
        }

        if (isVehVisible) {
          if (!state.map.hasLayer(existing.marker)) existing.marker.addTo(state.map);
        } else {
          if (state.map.hasLayer(existing.marker)) state.map.removeLayer(existing.marker);
        }
      }

      if (state.selectedVehicleId === data.id && state.isFollowing) {
        state.map.panTo([data.lat, data.lng], { animate: true });
        updateDrawerStats(existing);
      }

    } else {
      const marker = createTramMarker(data);
      const vehObj = { ...data, marker: marker };

      if (isVehVisible) {
        marker.addTo(state.map);
      }

      state.vehicles.set(data.key, vehObj);
    }

    updateTramCounterUI();
  }

  // Create Custom HTML Leaflet DivIcon for Tram
  function createTramMarker(data) {
    const meta = LINE_META[data.line] || { color: '#10b981' };
    const isSelected = state.selectedVehicleId === data.id;

    const iconHtml = `
      <div class="tram-marker-wrapper ${isSelected ? 'selected' : ''}" id="marker-${data.id}">
        <svg class="tram-direction-pointer" viewBox="0 0 16 16" style="transform: rotate(${data.heading}deg) translateY(-20px)">
          <polygon points="8,1 14,14 8,10 2,14" fill="${meta.color}" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
        <div class="tram-marker-icon" style="background-color: ${meta.color}; box-shadow: 0 4px 12px ${meta.color}77;">${data.rawLine}</div>
      </div>
    `;

    const customIcon = L.divIcon({
      html: iconHtml,
      className: 'tram-leaflet-icon',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    const marker = L.marker([data.lat, data.lng], { icon: customIcon });

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectVehicle(data.id);
    });

    return marker;
  }

  // Remove stale vehicles that haven't emitted signal for > 3 minutes
  function cleanStaleVehicles() {
    const now = Date.now();
    state.vehicles.forEach((veh, key) => {
      if (now - veh.lastUpdated > CONFIG.STALE_THRESHOLD_MS) {
        if (veh.marker && state.map.hasLayer(veh.marker)) {
          state.map.removeLayer(veh.marker);
        }
        state.vehicles.delete(key);
      }
    });
    updateTramCounterUI();
  }

  // =========================================================================
  // VEHICLE DETAIL DRAWER & SELECTION
  // =========================================================================
  function selectVehicle(vehId) {
    let foundVeh = null;
    state.vehicles.forEach((v) => {
      if (v.id === vehId) foundVeh = v;
    });

    if (!foundVeh) return;

    state.selectedVehicleId = vehId;
    state.isFollowing = true;

    document.querySelectorAll('.tram-marker-wrapper').forEach(el => el.classList.remove('selected'));
    const markerEl = document.getElementById(`marker-${vehId}`);
    if (markerEl) markerEl.classList.add('selected');

    state.map.panTo([foundVeh.lat, foundVeh.lng], { animate: true, duration: 0.6 });

    updateDrawerStats(foundVeh);
    document.getElementById('detail-drawer').classList.remove('hidden');
    document.getElementById('quick-line-bar')?.classList.add('hidden');
  }

  function deselectVehicle() {
    state.selectedVehicleId = null;
    state.isFollowing = false;
    document.querySelectorAll('.tram-marker-wrapper').forEach(el => el.classList.remove('selected'));
    document.getElementById('detail-drawer').classList.add('hidden');
    document.getElementById('quick-line-bar')?.classList.remove('hidden');
  }

  function updateDrawerStats(veh) {
    const t = TRANSLATIONS[state.currentLang] || TRANSLATIONS.fi;
    const meta = LINE_META[veh.line] || { name: { fi: `Raitiolinja ${veh.rawLine}`, en: `Tram line ${veh.rawLine}` }, color: '#10b981' };
    const routeName = (typeof meta.name === 'object') ? (meta.name[state.currentLang] || meta.name.fi) : meta.name;
    const badgeEl = document.getElementById('drawer-line-badge');
    const isPale = state.currentPalette === 'pale';
    
    badgeEl.textContent = veh.rawLine;
    badgeEl.style.backgroundColor = meta.color;
    badgeEl.style.color = isPale ? '#1e293b' : '#ffffff';
    badgeEl.style.boxShadow = `0 4px 12px ${meta.color}66`;

    document.getElementById('drawer-title').textContent = `${t.linePrefix} ${veh.rawLine}`;
    document.getElementById('drawer-subtitle').textContent = routeName;
    document.getElementById('stat-speed').innerHTML = `${veh.speed} <small>km/h</small>`;

    // Format Delay
    const delayEl = document.getElementById('stat-delay');
    if (Math.abs(veh.delay) <= 15) {
      delayEl.textContent = t.onTime;
      delayEl.className = 'stat-value status-on-time';
    } else if (veh.delay > 15) {
      const min = Math.round(veh.delay / 60);
      delayEl.textContent = `+${min > 0 ? min + ' min' : veh.delay + 's'} ${t.delayed}`;
      delayEl.className = 'stat-value status-delayed';
    } else {
      const min = Math.abs(Math.round(veh.delay / 60));
      delayEl.textContent = `-${min > 0 ? min + ' min' : Math.abs(veh.delay) + 's'} ${t.early}`;
      delayEl.className = 'stat-value status-early';
    }

    document.getElementById('stat-veh').textContent = `#${veh.id}`;
    document.getElementById('stat-hdg').textContent = `${veh.heading}° ${getCompassHeading(veh.heading)}`;
  }

  function getCompassHeading(deg) {
    const directions = (state.currentLang === 'en') 
        ? ['North (N)', 'North-East (NE)', 'East (E)', 'South-East (SE)', 'South (S)', 'South-West (SW)', 'West (W)', 'North-West (NW)']
        : ['Pohjoinen (P)', 'Koillinen (KO)', 'Itä (I)', 'Kaakko (KA)', 'Etelä (E)', 'Lounas (LO)', 'Länsi (L)', 'Luode (LU)'];
    const idx = Math.round(deg / 45) % 8;
    return directions[idx];
  }

  // =========================================================================
  // TRAM LINE FILTER SYSTEM
  // =========================================================================
  function initFilters() {
    state.lineModes = new Map();
    const savedModes = localStorage.getItem('tram_line_modes');
    if (savedModes) {
      try {
        const parsed = JSON.parse(savedModes);
        CONFIG.DEFAULT_LINES.forEach((line) => {
          state.lineModes.set(line, parsed[line] || 'both');
        });
      } catch (e) {
        CONFIG.DEFAULT_LINES.forEach((line) => state.lineModes.set(line, 'both'));
      }
    } else {
      const savedFilters = localStorage.getItem('tram_active_filters');
      if (savedFilters) {
        try {
          const parsed = JSON.parse(savedFilters);
          const activeSet = new Set(parsed);
          CONFIG.DEFAULT_LINES.forEach((line) => {
            state.lineModes.set(line, activeSet.has(line) ? 'both' : 'hidden');
          });
        } catch (e) {
          CONFIG.DEFAULT_LINES.forEach((line) => state.lineModes.set(line, 'both'));
        }
      } else {
        CONFIG.DEFAULT_LINES.forEach((line) => state.lineModes.set(line, 'both'));
      }
    }

    renderCircleFilterBar();
    renderFilterButtons();
  }

  function toggleLineFilter(line) {
    const currentMode = state.lineModes.get(line) || 'both';
    let newMode = 'both';

    if (currentMode === 'both') {
      newMode = 'tracks_only';
    } else if (currentMode === 'tracks_only') {
      newMode = 'hidden';
    } else {
      newMode = 'both';
    }

    state.lineModes.set(line, newMode);

    const modesObj = {};
    state.lineModes.forEach((v, k) => modesObj[k] = v);
    localStorage.setItem('tram_line_modes', JSON.stringify(modesObj));

    state.vehicles.forEach((veh) => {
      if (veh.line === line && veh.marker) {
        if (newMode === 'both') {
          if (!state.map.hasLayer(veh.marker)) veh.marker.addTo(state.map);
        } else {
          if (state.map.hasLayer(veh.marker)) state.map.removeLayer(veh.marker);
        }
      }
    });

    renderRouteTracks();
    updateTramCounterUI();

    renderCircleFilterBar();
    renderFilterButtons();
  }

  function renderCircleFilterBar() {
    const track = document.getElementById('circle-filter-track');
    if (!track) return;
    track.innerHTML = '';

    const isPale = state.currentPalette === 'pale';
    const textColor = isPale ? '#1e293b' : '#ffffff';
    const borderColor = isPale ? '#1e293b' : '#ffffff';
    const t = TRANSLATIONS[state.currentLang] || TRANSLATIONS.fi;

    CONFIG.DEFAULT_LINES.forEach((line) => {
      const mode = state.lineModes.get(line) || 'both';
      const meta = LINE_META[line] || { color: '#10b981' };

      const btn = document.createElement('button');
      btn.className = `circle-line-btn mode-${mode}`;
      btn.dataset.line = line;
      btn.dataset.mode = mode;
      btn.textContent = line;

      const routeName = (typeof meta.name === 'object') ? (meta.name[state.currentLang] || meta.name.fi) : meta.name;
      const modeLabel = (mode === 'both') ? (t.brand ? 'Näytetään vaunut ja reitti' : 'Showing trams and line') : (mode === 'tracks_only') ? (t.brand ? 'Vain reitti näkyvissä' : 'Tracks only visible') : (t.brand ? 'Piilotettu' : 'Hidden');

      btn.title = `${t.linePrefix} ${line}: ${routeName} (${modeLabel})`;

      if (mode === 'both') {
        btn.style.backgroundColor = meta.color;
        btn.style.color = textColor;
        btn.style.borderColor = borderColor;
        btn.style.boxShadow = `0 4px 12px ${meta.color}66`;
        btn.style.borderStyle = 'solid';
      } else if (mode === 'tracks_only') {
        btn.style.backgroundColor = meta.color + '33';
        btn.style.color = meta.color;
        btn.style.borderColor = meta.color;
        btn.style.borderStyle = 'dashed';
        btn.style.boxShadow = `0 0 10px ${meta.color}44`;
      } else {
        btn.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
        btn.style.color = isPale ? '#94a3b8' : 'rgba(255, 255, 255, 0.4)';
        btn.style.borderColor = 'transparent';
        btn.style.borderStyle = 'solid';
        btn.style.boxShadow = 'none';
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLineFilter(line);
      });

      track.appendChild(btn);
    });
  }

  function renderFilterButtons() {
    // Legacy modal filter renderer stub
  }

  function applyFilterChanges() {
    const toggleTracksCb = document.getElementById('toggle-tracks');
    if (toggleTracksCb) {
      state.showRouteTracks = toggleTracksCb.checked;
    }

    // Save to localStorage
    localStorage.setItem('tram_active_filters', JSON.stringify(Array.from(state.activeFilters)));
    localStorage.setItem('tram_show_tracks', String(state.showRouteTracks));

    // Refresh vehicle markers on map
    state.vehicles.forEach((veh) => {
      const isVisible = state.activeFilters.has(veh.line);
      if (veh.marker) {
        if (isVisible) {
          if (!state.map.hasLayer(veh.marker)) veh.marker.addTo(state.map);
        } else {
          if (state.map.hasLayer(veh.marker)) state.map.removeLayer(veh.marker);
        }
      }
    });

    // Refresh route track lines on map
    renderRouteTracks();

    updateTramCounterUI();
    closeFilterModal();
    showToast(`Suodatus käytössä (${state.activeFilters.size} linjaa valittuna)`, 'info');
  }

  function updateFilterSummaryText() {
    const summary = document.getElementById('filter-summary-text');
    const badge = document.getElementById('filter-badge');

    if (state.activeFilters.size === CONFIG.DEFAULT_LINES.length) {
      summary.textContent = 'Näytetään kaikki linjat';
      badge.classList.add('hidden');
    } else {
      summary.textContent = `Näytetään ${state.activeFilters.size} / ${CONFIG.DEFAULT_LINES.length} linjaa`;
      badge.textContent = state.activeFilters.size;
      badge.classList.remove('hidden');
    }
  }

  // =========================================================================
  // UI EVENT HANDLERS & HELPERS
  // =========================================================================
  // =========================================================================
  // SETTINGS & INTERNATIONALIZATION (FI / EN, THEMES & PALETTES)
  // =========================================================================
  const PALETTES = {
    default: {
      '1': '#10b981', '2': '#2563eb', '3': '#f59e0b', '4': '#84cc16',
      '5': '#f43f5e', '6': '#ec4899', '7': '#a855f7', '8': '#dc2626',
      '9': '#14b8a6', '10': '#6366f1', '13': '#eab308', '15': '#007ac9'
    },
    rainbow: {
      '1': '#ff0055', '2': '#ff5500', '3': '#ffaa00', '4': '#aaff00',
      '5': '#00ff66', '6': '#00ffcc', '7': '#0099ff', '8': '#3333ff',
      '9': '#8800ff', '10': '#ff00ff', '13': '#ff00aa', '15': '#00e5ff'
    },
    pale: {
      '1': '#a7f3d0', '2': '#fed7aa', '3': '#fef08a', '4': '#d9f99d',
      '5': '#fecdd3', '6': '#fbcfe8', '7': '#e9d5ff', '8': '#cff4fc',
      '9': '#ccfbf1', '10': '#c7d2fe', '13': '#fef08a', '15': '#bae6fd'
    },
    hsl: {
      '1': '#007348', '2': '#007348', '3': '#007348', '4': '#007348',
      '5': '#007348', '6': '#007348', '7': '#007348', '8': '#007348',
      '9': '#007348', '10': '#007348', '13': '#007348', '15': '#007ac9'
    },
    dark: {
      '1': '#18181b', '2': '#18181b', '3': '#18181b', '4': '#18181b',
      '5': '#18181b', '6': '#18181b', '7': '#18181b', '8': '#18181b',
      '9': '#18181b', '10': '#18181b', '13': '#18181b', '15': '#18181b'
    }
  };

  const TRANSLATIONS = {
    fi: {
      brand: "Spora-Live",
      connecting: "Yhdistetään...",
      live: "Live",
      offline: "Ei yhteyttä",
      trams: "vaunua",
      settingsTitle: "Asetukset",
      language: "Kieli",
      theme: "Teema",
      darkTheme: "Tumma",
      lightTheme: "Vaalea",
      colorPalette: "Ratikoiden väriteema",
      paletteDefault: "Oletus",
      paletteRainbow: "Sateenkaari",
      palettePale: "Haalea",
      paletteHsl: "HSL",
      paletteDark: "Musta",
      speed: "Nopeus",
      delay: "Tila / Viive",
      onTime: "Aikataulussa",
      delayed: "myöhässä",
      early: "etuajassa",
      vehNo: "Vaununumero",
      direction: "Suunta",
      linePrefix: "Linja",
      followTram: "Seuraa vaunua",
      followingTram: "Seurataan vaunua kartalla",
      dataSource: "Lähde: HSL Avoin Data",
      pwaTitle: "Asenna Spora-Live",
      pwaDesc: "Paina ⎋ Jaa, ja valitse Lisää kotivalikkoon.",
      disturbancesTitle: "Häiriötiedotteet",
      noDisturbances: "Ei aktiivisia häiriöitä"
    },
    en: {
      brand: "Spora-Live",
      connecting: "Connecting...",
      live: "Live",
      offline: "Offline",
      trams: "trams",
      settingsTitle: "Settings",
      language: "Language",
      theme: "Theme",
      darkTheme: "Dark",
      lightTheme: "Light",
      colorPalette: "Color Palette",
      paletteDefault: "Default",
      paletteRainbow: "Rainbow",
      palettePale: "Pale",
      paletteHsl: "HSL",
      paletteDark: "Black",
      speed: "Speed",
      delay: "Status / Delay",
      onTime: "On time",
      delayed: "late",
      early: "early",
      vehNo: "Vehicle No.",
      direction: "Direction",
      linePrefix: "Line",
      followTram: "Follow Tram",
      followingTram: "Following tram on map",
      dataSource: "Source: HSL Open Data",
      pwaTitle: "Install Spora-Live",
      pwaDesc: "Tap ⎋ Share, then select Add to Home Screen.",
      disturbancesTitle: "Service Disturbances",
      noDisturbances: "No active disturbances"
    }
  };

  function initSettings() {
    setLanguage(state.currentLang, false);
    setTheme(state.currentTheme, false);
    setPalette(state.currentPalette, false);
  }

  function setLanguage(lang, save = true) {
    state.currentLang = lang;
    if (save) localStorage.setItem('app_lang', lang);

    const t = TRANSLATIONS[lang] || TRANSLATIONS.fi;

    document.querySelectorAll('.count-label').forEach(el => el.textContent = t.trams);
    document.getElementById('txt-settings-title').textContent = t.settingsTitle;
    document.getElementById('lbl-language').textContent = t.language;
    document.getElementById('lbl-theme').textContent = t.theme;
    document.getElementById('lbl-palette').textContent = t.colorPalette;

    document.getElementById('btn-lang-fi').textContent = 'Suomi';
    document.getElementById('btn-lang-en').textContent = 'English';

    document.getElementById('btn-theme-dark').textContent = t.darkTheme;
    document.getElementById('btn-theme-light').textContent = t.lightTheme;

    document.getElementById('btn-lang-fi').classList.toggle('active', lang === 'fi');
    document.getElementById('btn-lang-en').classList.toggle('active', lang === 'en');

    // Update Drawer Labels
    const lblSpeed = document.getElementById('lbl-stat-speed');
    if (lblSpeed) lblSpeed.textContent = t.speed;
    const lblDelay = document.getElementById('lbl-stat-delay');
    if (lblDelay) lblDelay.textContent = t.delay;
    const lblVeh = document.getElementById('lbl-stat-veh');
    if (lblVeh) lblVeh.textContent = t.vehNo;
    const lblHdg = document.getElementById('lbl-stat-hdg');
    if (lblHdg) lblHdg.textContent = t.direction;
    const txtTrack = document.getElementById('txt-track-tram');
    if (txtTrack) txtTrack.textContent = t.followTram;
    const dataSource = document.getElementById('drawer-data-source');
    if (dataSource) dataSource.textContent = t.dataSource;

    document.querySelectorAll('.palette-name').forEach((el) => {
      const key = el.dataset.key;
      if (key && t[key]) el.textContent = t[key];
    });

    const txtDistTitle = document.getElementById('txt-disturbance-title');
    if (txtDistTitle) txtDistTitle.textContent = t.disturbancesTitle;
    const txtEmptyDist = document.getElementById('txt-empty-disturbance');
    if (txtEmptyDist) txtEmptyDist.textContent = t.noDisturbances;

    const pwaTitle = document.getElementById('txt-pwa-title');
    if (pwaTitle) pwaTitle.textContent = t.pwaTitle;
    const pwaDesc = document.getElementById('txt-pwa-desc');
    if (pwaDesc) pwaDesc.innerHTML = `${t.pwaDesc}`;

    if (state.selectedVehicleId) {
      let foundVeh = null;
      state.vehicles.forEach((v) => {
        if (v.id === state.selectedVehicleId) foundVeh = v;
      });
      if (foundVeh) updateDrawerStats(foundVeh);
    }
  }

  function setTheme(theme, save = true) {
    state.currentTheme = theme;
    if (save) localStorage.setItem('app_theme', theme);

    const isLight = theme === 'light';
    const targetColor = isLight ? '#ffffff' : '#0f172a';

    document.documentElement.classList.toggle('light-theme', isLight);
    document.body.classList.toggle('light-theme', isLight);
    document.documentElement.style.backgroundColor = targetColor;
    document.body.style.backgroundColor = targetColor;

    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute('content', targetColor);
    });

    const metaAppleStatusBar = document.getElementById('meta-apple-status') || document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (metaAppleStatusBar) {
      metaAppleStatusBar.setAttribute('content', isLight ? 'default' : 'black-translucent');
    }

    const btnDark = document.getElementById('btn-theme-dark');
    const btnLight = document.getElementById('btn-theme-light');
    if (btnDark) btnDark.classList.toggle('active', theme === 'dark');
    if (btnLight) btnLight.classList.toggle('active', theme === 'light');
  }

  function setPalette(paletteKey, save = true) {
    if (!PALETTES[paletteKey]) paletteKey = 'default';
    state.currentPalette = paletteKey;
    if (save) localStorage.setItem('tram_palette', paletteKey);

    const activeMap = PALETTES[paletteKey];
    Object.keys(activeMap).forEach((lineKey) => {
      if (LINE_META[lineKey]) {
        LINE_META[lineKey].color = activeMap[lineKey];
      }
    });

    renderCircleFilterBar();
    renderRouteTracks();

    state.vehicles.forEach((veh) => {
      if (veh.marker) {
        state.map.removeLayer(veh.marker);
        const newMarker = createTramMarker(veh);
        veh.marker = newMarker;
        if (state.activeFilters.has(veh.line)) {
          newMarker.addTo(state.map);
        }
      }
    });

    document.querySelectorAll('.palette-option-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.palette === paletteKey);
    });
  }

  function initUIEvents() {
    // Settings Modal Controls
    const btnSettings = document.getElementById('btn-settings');
    const settingsModal = document.getElementById('settings-modal');
    const btnCloseSettings = document.getElementById('btn-close-settings');

    if (btnSettings && settingsModal) {
      btnSettings.addEventListener('click', () => {
        settingsModal.classList.remove('hidden');
      });
    }

    if (btnCloseSettings && settingsModal) {
      btnCloseSettings.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
      });
    }

    if (settingsModal) {
      settingsModal.addEventListener('click', (e) => {
        if (e.target.id === 'settings-modal') {
          settingsModal.classList.add('hidden');
        }
      });
    }

    // Language Toggles
    document.getElementById('btn-lang-fi')?.addEventListener('click', () => setLanguage('fi'));
    document.getElementById('btn-lang-en')?.addEventListener('click', () => setLanguage('en'));

    // Theme Toggles
    document.getElementById('btn-theme-dark')?.addEventListener('click', () => setTheme('dark'));
    document.getElementById('btn-theme-light')?.addEventListener('click', () => setTheme('light'));

    // Palette Options
    document.querySelectorAll('.palette-option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pal = btn.dataset.palette;
        setPalette(pal);
      });
    });

    // Drawer Controls
    document.getElementById('btn-close-drawer')?.addEventListener('click', deselectVehicle);
    document.getElementById('btn-track-tram')?.addEventListener('click', () => {
      state.isFollowing = true;
      if (state.selectedVehicleId) {
        state.vehicles.forEach(v => {
          if (v.id === state.selectedVehicleId) {
            state.map.panTo([v.lat, v.lng], { animate: true });
          }
        });
      }
      const t = TRANSLATIONS[state.currentLang] || TRANSLATIONS.fi;
      showToast(t.followingTram, 'info');
    });

    // Lower Left Disturbance Popover Controls
    const btnDistToggle = document.getElementById('btn-disturbance-toggle');
    const distPopover = document.getElementById('disturbance-popover');
    const btnCloseDist = document.getElementById('btn-close-disturbance');

    if (btnDistToggle && distPopover) {
      btnDistToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        distPopover.classList.toggle('hidden');
      });
    }

    if (btnCloseDist && distPopover) {
      btnCloseDist.addEventListener('click', () => {
        distPopover.classList.add('hidden');
      });
    }

    document.addEventListener('click', (e) => {
      if (distPopover && !distPopover.contains(e.target) && !btnDistToggle.contains(e.target)) {
        distPopover.classList.add('hidden');
      }
    });

    // Locate user button
    document.getElementById('btn-locate').addEventListener('click', locateUser);

    // Dismiss iOS PWA banner
    document.getElementById('btn-close-pwa-banner').addEventListener('click', () => {
      document.getElementById('ios-pwa-banner').classList.add('hidden');
      localStorage.setItem('pwa_banner_dismissed', 'true');
    });
  }

  function openFilterModal() {
    renderFilterButtons();
    document.getElementById('filter-modal').classList.remove('hidden');
  }

  function closeFilterModal() {
    document.getElementById('filter-modal').classList.add('hidden');
  }

  function locateUser() {
    if (!navigator.geolocation) {
      showToast('Selain ei tue sijaintipalvelua', 'warn');
      return;
    }

    showToast('Haetaan omaa sijaintia...', 'info');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        
        if (state.userMarker) {
          state.userMarker.setLatLng([latitude, longitude]);
        } else {
          const userIcon = L.divIcon({
            html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(59,130,246,0.8);"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
          });
          state.userMarker = L.marker([latitude, longitude], { icon: userIcon }).addTo(state.map);
        }

        state.map.flyTo([latitude, longitude], 15, { duration: 1 });
      },
      (err) => {
        showToast('Sijainnin hakeminen epäonnistui', 'warn');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // Update Top Bar & Footer UI
  function updateConnectionStatus(mode, text) {
    state.connectionMode = mode;
    const badge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');

    badge.className = `status-badge ${mode}`;
    statusText.textContent = text;
  }

  function updateTramCounterUI() {
    let activeCount = 0;
    state.vehicles.forEach(v => {
      const mode = state.lineModes.get(v.line) || 'both';
      if (mode === 'both') activeCount++;
    });
    document.getElementById('tram-count-val').textContent = activeCount;
  }

  function updateLastSeenUI() {
    // Legacy last seen UI helper stub
  }

  // Disturbance & Detour Alerts System (GTFS-RT, GraphQL Poikkeusreitit, and Delays)
  async function fetchDisturbances() {
    const listEl = document.getElementById('disturbance-list');
    const badgeEl = document.getElementById('disturbance-count-badge');
    const t = TRANSLATIONS[state.currentLang] || TRANSLATIONS.fi;
    const items = [];
    const seenTitles = new Set();

    // 1. Fetch GTFS-RT Service Alerts Feed (Protobuf)
    try {
      const res = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent('https://realtime.hsl.fi/realtime/service-alerts/v2/hsl'));
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        const root = protobuf.Root.fromJSON(GTFS_RT_SCHEMA);
        const FeedMessage = root.lookupType('FeedMessage');
        const message = FeedMessage.decode(new Uint8Array(buffer));

        if (message.entity && Array.isArray(message.entity)) {
          message.entity.forEach((ent) => {
            if (ent.alert) {
              const header = ent.alert.headerText?.translation?.[0]?.text || ent.alert.headerText?.translation?.find(x => x.language === state.currentLang)?.text || 'Poikkeustilanne / Häiriö';
              const desc = ent.alert.descriptionText?.translation?.[0]?.text || ent.alert.descriptionText?.translation?.find(x => x.language === state.currentLang)?.text || '';
              
              let lines = [];
              if (ent.alert.informedEntity) {
                ent.alert.informedEntity.forEach((ie) => {
                  if (ie.routeId) {
                    let rId = ie.routeId.replace(/^10+/, '').replace(/^10/, '').replace(/[A-Z]$/, '');
                    if (rId === '15' || rId === '550') rId = '15';
                    if (CONFIG.DEFAULT_LINES.includes(rId) && !lines.includes(rId)) {
                      lines.push(rId);
                    }
                  }
                });
              }

              const itemKey = `${lines.join(',')}_${header}`;
              if (!seenTitles.has(itemKey)) {
                seenTitles.add(itemKey);
                items.push({
                  title: lines.length > 0 ? `${t.linePrefix} ${lines.join(', ')}: ${header}` : header,
                  desc: desc,
                  type: 'alert'
                });
              }
            }
          });
        }
      }
    } catch (e) {
      console.warn('GTFS-RT alerts fetch error:', e);
    }

    // 2. Fetch Digitransit GraphQL Alerts (Detours, Poikkeusreitit, Planned Route Modifications)
    try {
      const gqlQuery = {
        query: `{
          alerts {
            alertHeaderText
            alertDescriptionText
            informedEntities {
              route { shortName }
            }
          }
        }`
      };
      const resGql = await fetch('https://api.digitransit.fi/routing/v1/router/hsl/index/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gqlQuery)
      });

      if (resGql.ok) {
        const json = await resGql.json();
        if (json.data && json.data.alerts) {
          json.data.alerts.forEach((alt) => {
            const header = alt.alertHeaderText || '';
            const desc = alt.alertDescriptionText || '';
            const lines = [];
            if (alt.informedEntities) {
              alt.informedEntities.forEach((ie) => {
                if (ie.route && ie.route.shortName) {
                  let sName = ie.route.shortName;
                  if (CONFIG.DEFAULT_LINES.includes(sName) && !lines.includes(sName)) {
                    lines.push(sName);
                  }
                }
              });
            }

            if (lines.length > 0) {
              const itemKey = `${lines.join(',')}_${header}`;
              if (!seenTitles.has(itemKey)) {
                seenTitles.add(itemKey);
                items.push({
                  title: `${t.linePrefix} ${lines.join(', ')}: ${header}`,
                  desc: desc,
                  type: 'detour'
                });
              }
            }
          });
        }
      }
    } catch (e) {
      // Silently ignore GraphQL fallback if offline
    }

    // 3. Include major vehicle delays (> 3 min)
    state.vehicles.forEach((veh) => {
      if (veh.delay > 180) {
        const min = Math.round(veh.delay / 60);
        const itemKey = `delay_${veh.line}_${veh.id}`;
        if (!seenTitles.has(itemKey)) {
          seenTitles.add(itemKey);
          items.push({
            title: `${t.linePrefix} ${veh.rawLine} (#${veh.id})`,
            desc: `+${min} min ${t.delayed}`,
            type: 'delay'
          });
        }
      }
    });

    state.disturbances = items;
    updateDisturbanceUI(items, t);
  }

  function updateDisturbanceUI(items, t) {
    const listEl = document.getElementById('disturbance-list');
    const badgeEl = document.getElementById('disturbance-count-badge');
    if (!listEl) return;

    if (items.length > 0) {
      if (badgeEl) {
        badgeEl.textContent = items.length;
        badgeEl.classList.remove('hidden');
      }
      listEl.innerHTML = '';
      items.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'disturbance-item';
        div.innerHTML = `
          <div class="disturbance-item-title">${item.title}</div>
          ${item.desc ? `<div class="disturbance-item-desc">${item.desc}</div>` : ''}
        `;
        listEl.appendChild(div);
      });
    } else {
      if (badgeEl) badgeEl.classList.add('hidden');
      listEl.innerHTML = `<p id="txt-empty-disturbance" class="empty-disturbance-text">${t.noDisturbances}</p>`;
    }
  }

  // Toast Notification System
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // Check iOS PWA Banner display condition
  function checkIosPwaBanner() {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    const isDismissed = localStorage.getItem('pwa_banner_dismissed') === 'true';

    if (isIos && !isStandalone && !isDismissed) {
      setTimeout(() => {
        document.getElementById('ios-pwa-banner').classList.remove('hidden');
      }, 2000);
    }
  }

})();
