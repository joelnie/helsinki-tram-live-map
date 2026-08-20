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
    '1': { name: 'Eira – Käpylä', color: '#10b981' },       // Emerald Green
    '2': { name: 'Olympiaterminaali – Pasila', color: '#f97316' }, // Coral Orange
    '3': { name: 'Olympiaterminaali – Meilahti', color: '#f59e0b' }, // Amber Gold
    '4': { name: 'Katajanokka – Munkkiniemi', color: '#a855f7' },   // Lavender Purple
    '5': { name: 'Katajanokan terminaali – Rautatientori', color: '#f43f5e' }, // Rose Pink
    '6': { name: 'Hietalahti – Arabia', color: '#06b6d4' },      // Cyan Sky
    '7': { name: 'Länsiterminaali – Meilahden sairaala', color: '#84cc16' }, // Lime Green
    '8': { name: 'Jätkäsaari – Arabia', color: '#ec4899' },      // Magenta Pink
    '9': { name: 'Länsiterminaali – Ilmala', color: '#14b8a6' }, // Turquoise Teal
    '10': { name: 'Kirurgi – Pikku Huopalahti', color: '#6366f1' }, // Indigo Violet
    '13': { name: 'Kalasatama – Pasila', color: '#eab308' },     // Electric Yellow
    '15': { name: 'Raide-Jokeri: Keilaniemi – Itäkeskus', color: '#007ac9', isLightRail: true } // Raide-Jokeri Blue
  };

  // =========================================================================
  // STATE MANAGEMENT
  // =========================================================================
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
    connectionMode: 'connecting', // 'mqtt' | 'gtfs-rt' | 'offline'
    gtfsPollTimer: null,
    mqttTimeoutTimer: null,
    lastMsgTimestamp: null,
    staleCheckTimer: null
  };

  // =========================================================================
  // INITIALIZATION
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    initFilters();
    initMap();
    initUIEvents();
    checkIosPwaBanner();
    loadRouteData();
    startRealtimeEngine();
    
    // Periodically remove vehicles with stale signals
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
      attributionControl: true
    });

    // CartoDB Positron Tile Layer (crisp, beautiful retina display map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | Data: HSL'
    }).addTo(state.map);

    // Layer group for route track polylines
    state.routePolylineGroup = L.layerGroup().addTo(state.map);

    // Custom Leaflet Zoom Control at top right
    L.control.zoom({ position: 'topright' }).addTo(state.map);

    // Map click clears selection
    state.map.on('click', () => {
      deselectVehicle();
    });
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
    if (!state.routePolylineGroup) return;
    state.routePolylineGroup.clearLayers();

    if (!state.showRouteTracks || !state.routeData) return;

    // Get sorted active line list for deterministic side-by-side track offset
    const activeLineList = Array.from(state.activeFilters).sort((a, b) => {
      const numA = parseInt(a, 10) || 99;
      const numB = parseInt(b, 10) || 99;
      return numA - numB;
    });

    const totalActive = activeLineList.length;

    activeLineList.forEach((lineKey, idx) => {
      if (state.routeData[lineKey]) {
        const segments = state.routeData[lineKey];
        const meta = LINE_META[lineKey] || { color: '#10b981' };
        const isLightRail = lineKey === '15';
        const weight = isLightRail ? 4.5 : 3.5;

        // Calculate parallel track offset
        const offsetStep = 0.000030; // ~3.3 meters lateral offset per line position
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

  // =========================================================================
  // REAL-TIME DATA ENGINE (MQTT & GTFS-RT FALLBACK)
  // =========================================================================
  function startRealtimeEngine() {
    updateConnectionStatus('connecting', 'Connecting to HSL...');
    
    // Set a 6-second timeout: if MQTT doesn't receive data, fallback to GTFS-RT HTTP polling
    state.mqttTimeoutTimer = setTimeout(() => {
      if (!state.lastMsgTimestamp && state.connectionMode !== 'gtfs-rt') {
        showToast('WebSocket delayed. Switching to GTFS-RT polling...', 'warn');
        initGtfsRtPolling();
      }
    }, 6000);

    initMqttConnection();
  }

  // 1. MQTT Connection over WebSockets
  function initMqttConnection() {
    if (typeof mqtt === 'undefined') {
      console.warn('MQTT.js client script not loaded. Falling back to GTFS-RT HTTP polling.');
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
        console.log('Connected to HSL MQTT broker via WSS!');
        updateConnectionStatus('live', 'Live (MQTT)');
        
        state.mqttClient.subscribe(CONFIG.MQTT_TOPIC, (err) => {
          if (err) {
            console.error('Failed to subscribe to MQTT topic:', err);
            initGtfsRtPolling();
          } else {
            console.log('Subscribed to topic:', CONFIG.MQTT_TOPIC);
          }
        });
      });

      state.mqttClient.on('message', (topic, message) => {
        state.lastMsgTimestamp = Date.now();
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
        console.warn('MQTT Client Error:', err);
        if (!state.lastMsgTimestamp) {
          initGtfsRtPolling();
        }
      });

      state.mqttClient.on('offline', () => {
        if (state.connectionMode === 'live') {
          updateConnectionStatus('offline', 'Reconnecting...');
        }
      });

    } catch (err) {
      console.error('MQTT Initialization failed:', err);
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
    if (state.connectionMode === 'gtfs-rt') return;
    state.connectionMode = 'gtfs-rt';
    
    if (state.mqttClient) {
      try { state.mqttClient.end(true); } catch(e){}
    }

    updateConnectionStatus('polling', 'Polling (GTFS-RT)');
    fetchGtfsRtVehicles();

    if (state.gtfsPollTimer) clearInterval(state.gtfsPollTimer);
    state.gtfsPollTimer = setInterval(fetchGtfsRtVehicles, CONFIG.GTFS_RT_POLL_INTERVAL);
  }

  async function fetchGtfsRtVehicles() {
    try {
      const response = await fetch(CONFIG.GTFS_RT_HTTP_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const buffer = await response.arrayBuffer();
      
      // If protobuf.js is available, decode GTFS-RT
      if (typeof protobuf !== 'undefined') {
        decodeGtfsRtProtobuf(buffer);
      } else {
        showToast('Unable to parse GTFS-RT feed', 'error');
      }
      state.lastMsgTimestamp = Date.now();
    } catch (err) {
      console.warn('GTFS-RT Fetch Error:', err);
      updateConnectionStatus('offline', 'Network error');
    }
  }

  function decodeGtfsRtProtobuf(buffer) {
    try {
      // Inline lightweight GTFS-RT VehiclePositions parser schema fallback
      const root = protobuf.Root.fromJSON({
        nested: {
          transit_realtime: {
            nested: {
              FeedMessage: {
                fields: {
                  header: { id: 1, type: "FeedHeader" },
                  entity: { rule: "repeated", id: 2, type: "FeedEntity" }
                }
              },
              FeedHeader: { fields: { gtfsRealtimeVersion: { id: 1, type: "string" } } },
              FeedEntity: {
                fields: {
                  id: { id: 1, type: "string" },
                  vehicle: { id: 4, type: "VehiclePosition" }
                }
              },
              VehiclePosition: {
                fields: {
                  trip: { id: 1, type: "TripDescriptor" },
                  position: { id: 2, type: "Position" },
                  vehicle: { id: 8, type: "VehicleDescriptor" },
                  timestamp: { id: 5, type: "uint64" }
                }
              },
              TripDescriptor: { fields: { routeId: { id: 5, type: "string" } } },
              Position: {
                fields: {
                  latitude: { id: 1, type: "float" },
                  longitude: { id: 2, type: "float" },
                  bearing: { id: 3, type: "float" },
                  speed: { id: 4, type: "float" }
                }
              },
              VehicleDescriptor: { fields: { id: { id: 1, type: "string" }, label: { id: 2, type: "string" } } }
            }
          }
        }
      });

      const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
      const message = FeedMessage.decode(new Uint8Array(buffer));
      
      if (message.entity) {
        message.entity.forEach(e => {
          if (e.vehicle && e.vehicle.position) {
            const vp = e.vehicle;
            const routeId = vp.trip ? vp.trip.routeId : '';
            const lineKey = normalizeLineKey(routeId);
            
            // Only process tram lines (1-10, 15)
            if (state.activeFilters.has(lineKey) || CONFIG.DEFAULT_LINES.includes(lineKey)) {
              const vehId = vp.vehicle ? (vp.vehicle.id || vp.vehicle.label) : e.id;
              const vehicleData = {
                id: vehId,
                key: `veh_${vehId}`,
                line: lineKey,
                rawLine: lineKey,
                lat: vp.position.latitude,
                lng: vp.position.longitude,
                heading: vp.position.bearing || 0,
                speed: vp.position.speed ? Math.round(vp.position.speed * 3.6) : 0,
                delay: 0,
                dir: '1',
                lastUpdated: Date.now()
              };
              updateVehicleOnMap(vehicleData);
            }
          }
        });
      }
    } catch (e) {
      console.warn('Protobuf decode error:', e);
    }
  }

  // =========================================================================
  // VEHICLE MARKER & MAP RENDERER
  // =========================================================================
  function updateVehicleOnMap(data) {
    // Check if line is filtered out
    const isVisible = state.activeFilters.has(data.line);

    let existing = state.vehicles.get(data.key);

    if (existing) {
      // Update existing vehicle
      existing.lat = data.lat;
      existing.lng = data.lng;
      existing.heading = data.heading;
      existing.speed = data.speed;
      existing.delay = data.delay;
      existing.lastUpdated = data.lastUpdated;

      if (existing.marker) {
        // Smoothly animate marker location
        existing.marker.setLatLng([data.lat, data.lng]);
        
        // Rotate direction pointer
        const pointerEl = existing.marker.getElement()?.querySelector('.tram-direction-pointer');
        if (pointerEl) {
          pointerEl.style.transform = `rotate(${data.heading}deg)`;
        }

        // Toggle visibility based on active filter
        if (isVisible) {
          if (!state.map.hasLayer(existing.marker)) {
            existing.marker.addTo(state.map);
          }
        } else {
          if (state.map.hasLayer(existing.marker)) {
            state.map.removeLayer(existing.marker);
          }
        }
      }

      // If this vehicle is currently selected and follow mode is active, center map
      if (state.selectedVehicleId === data.id && state.isFollowing) {
        state.map.panTo([data.lat, data.lng], { animate: true, duration: 0.5 });
        updateDrawerStats(existing);
      }

    } else {
      // Create new vehicle entry
      const marker = createTramMarker(data);

      const vehObj = {
        ...data,
        marker: marker
      };

      if (isVisible) {
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
        <div class="tram-direction-pointer" style="border-bottom-color: ${meta.color}; transform: rotate(${data.heading}deg)"></div>
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
    // Find vehicle by ID
    let foundVeh = null;
    state.vehicles.forEach((v) => {
      if (v.id === vehId) foundVeh = v;
    });

    if (!foundVeh) return;

    state.selectedVehicleId = vehId;
    state.isFollowing = true;

    // Highlight selected marker
    document.querySelectorAll('.tram-marker-wrapper').forEach(el => el.classList.remove('selected'));
    const markerEl = document.getElementById(`marker-${vehId}`);
    if (markerEl) markerEl.classList.add('selected');

    // Pan map to vehicle
    state.map.panTo([foundVeh.lat, foundVeh.lng], { animate: true, duration: 0.6 });

    // Open detail drawer
    updateDrawerStats(foundVeh);
    document.getElementById('detail-drawer').classList.remove('hidden');
  }

  function deselectVehicle() {
    state.selectedVehicleId = null;
    state.isFollowing = false;
    document.querySelectorAll('.tram-marker-wrapper').forEach(el => el.classList.remove('selected'));
    document.getElementById('detail-drawer').classList.add('hidden');
  }

  function updateDrawerStats(veh) {
    const meta = LINE_META[veh.line] || { name: `Tram Line ${veh.rawLine}`, color: '#10b981' };
    const badgeEl = document.getElementById('drawer-line-badge');
    
    badgeEl.textContent = veh.rawLine;
    badgeEl.style.backgroundColor = meta.color;
    badgeEl.style.boxShadow = `0 4px 12px ${meta.color}66`;

    document.getElementById('drawer-title').textContent = `Tram Line ${veh.rawLine}`;
    document.getElementById('drawer-subtitle').textContent = meta.name;
    document.getElementById('stat-speed').innerHTML = `${veh.speed} <small>km/h</small>`;

    // Format Delay
    const delayEl = document.getElementById('stat-delay');
    if (Math.abs(veh.delay) <= 15) {
      delayEl.textContent = 'On time';
      delayEl.className = 'stat-value status-on-time';
    } else if (veh.delay > 15) {
      const min = Math.round(veh.delay / 60);
      delayEl.textContent = `+${min > 0 ? min + ' min' : veh.delay + 's'} delay`;
      delayEl.className = 'stat-value status-delayed';
    } else {
      const min = Math.abs(Math.round(veh.delay / 60));
      delayEl.textContent = `-${min > 0 ? min + ' min' : Math.abs(veh.delay) + 's'} early`;
      delayEl.className = 'stat-value status-early';
    }

    document.getElementById('stat-veh').textContent = `#${veh.id}`;
    document.getElementById('stat-hdg').textContent = `${veh.heading}° ${getCompassHeading(veh.heading)}`;
  }

  function getCompassHeading(deg) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(deg / 45) % 8;
    return directions[idx];
  }

  // =========================================================================
  // TRAM LINE FILTER SYSTEM
  // =========================================================================
  function initFilters() {
    // Load saved filters or default to all
    const saved = localStorage.getItem('tram_active_filters');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.activeFilters = new Set(parsed);
        } else {
          state.activeFilters = new Set(CONFIG.DEFAULT_LINES);
        }
      } catch (e) {
        state.activeFilters = new Set(CONFIG.DEFAULT_LINES);
      }
    } else {
      state.activeFilters = new Set(CONFIG.DEFAULT_LINES);
    }

    renderFilterButtons();
  }

  function renderFilterButtons() {
    const grid = document.getElementById('line-grid');
    grid.innerHTML = '';

    CONFIG.DEFAULT_LINES.forEach((line) => {
      const isSelected = state.activeFilters.has(line);
      const isLightRail = line === '15';
      const meta = LINE_META[line] || { color: '#10b981' };

      const btn = document.createElement('button');
      btn.className = `line-toggle-btn ${isSelected ? 'active' : ''}`;
      btn.dataset.line = line;
      
      if (isSelected) {
        btn.style.borderColor = meta.color;
        btn.style.backgroundColor = meta.color + '22';
        btn.style.boxShadow = `0 4px 12px ${meta.color}44`;
      } else {
        btn.style.borderColor = 'transparent';
        btn.style.backgroundColor = '';
        btn.style.boxShadow = '';
      }

      btn.innerHTML = `
        <span class="line-num" style="color: ${isSelected ? meta.color : 'inherit'}">${line}</span>
        <span class="line-name">${isLightRail ? 'Raide-Jokeri' : 'Line ' + line}</span>
      `;

      btn.addEventListener('click', () => {
        if (state.activeFilters.has(line)) {
          if (state.activeFilters.size > 1) {
            state.activeFilters.delete(line);
          } else {
            showToast('At least one tram line must remain selected', 'warn');
          }
        } else {
          state.activeFilters.add(line);
        }
        const activeNow = state.activeFilters.has(line);
        btn.classList.toggle('active', activeNow);
        if (activeNow) {
          btn.style.borderColor = meta.color;
          btn.style.backgroundColor = meta.color + '22';
          btn.style.boxShadow = `0 4px 12px ${meta.color}44`;
          btn.querySelector('.line-num').style.color = meta.color;
        } else {
          btn.style.borderColor = 'transparent';
          btn.style.backgroundColor = '';
          btn.style.boxShadow = '';
          btn.querySelector('.line-num').style.color = 'inherit';
        }
        updateFilterSummaryText();
      });

      grid.appendChild(btn);
    });

    updateFilterSummaryText();
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
    showToast(`Filter applied (${state.activeFilters.size} routes active)`, 'info');
  }

  function updateFilterSummaryText() {
    const summary = document.getElementById('filter-summary-text');
    const badge = document.getElementById('filter-badge');

    if (state.activeFilters.size === CONFIG.DEFAULT_LINES.length) {
      summary.textContent = 'Showing all tram lines';
      badge.classList.add('hidden');
    } else {
      summary.textContent = `Showing ${state.activeFilters.size} of ${CONFIG.DEFAULT_LINES.length} lines`;
      badge.textContent = state.activeFilters.size;
      badge.classList.remove('hidden');
    }
  }

  // =========================================================================
  // UI EVENT HANDLERS & HELPERS
  // =========================================================================
  function initUIEvents() {
    // Filter Modal Controls
    document.getElementById('btn-filter').addEventListener('click', openFilterModal);
    document.getElementById('btn-close-filter').addEventListener('click', closeFilterModal);
    document.getElementById('btn-apply-filter').addEventListener('click', applyFilterChanges);

    document.getElementById('btn-select-all').addEventListener('click', () => {
      state.activeFilters = new Set(CONFIG.DEFAULT_LINES);
      renderFilterButtons();
    });

    document.getElementById('btn-select-main').addEventListener('click', () => {
      state.activeFilters = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
      renderFilterButtons();
    });

    document.getElementById('btn-select-lightrail').addEventListener('click', () => {
      state.activeFilters = new Set(['15']);
      renderFilterButtons();
    });

    document.getElementById('btn-clear-all').addEventListener('click', () => {
      state.activeFilters = new Set(['1']); // Keep line 1 active minimum
      renderFilterButtons();
    });

    // Close modal on background click
    document.getElementById('filter-modal').addEventListener('click', (e) => {
      if (e.target.id === 'filter-modal') closeFilterModal();
    });

    // Drawer Controls
    document.getElementById('btn-close-drawer').addEventListener('click', deselectVehicle);
    document.getElementById('btn-track-tram').addEventListener('click', () => {
      state.isFollowing = true;
      if (state.selectedVehicleId) {
        state.vehicles.forEach(v => {
          if (v.id === state.selectedVehicleId) {
            state.map.panTo([v.lat, v.lng], { animate: true });
          }
        });
      }
      showToast('Following tram on map', 'info');
    });

    // Recenter & Locate buttons
    document.getElementById('btn-recenter').addEventListener('click', () => {
      state.isFollowing = false;
      state.map.flyTo(CONFIG.HELSINKI_CENTER, CONFIG.DEFAULT_ZOOM, { duration: 1 });
    });

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
      showToast('Geolocation not supported by browser', 'warn');
      return;
    }

    showToast('Locating your position...', 'info');

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
        showToast('Unable to fetch location', 'warn');
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
      if (state.activeFilters.has(v.line)) activeCount++;
    });
    document.getElementById('tram-count-val').textContent = activeCount;
  }

  function updateLastSeenUI() {
    const el = document.getElementById('last-update-time');
    if (!state.lastMsgTimestamp) {
      el.textContent = 'Connecting...';
      return;
    }

    const secAgo = Math.floor((Date.now() - state.lastMsgTimestamp) / 1000);
    if (secAgo < 3) {
      el.textContent = 'Updated just now';
    } else {
      el.textContent = `Updated ${secAgo}s ago`;
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
