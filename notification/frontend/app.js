/**
 * RouteOut Notification PWA — app.js
 *
 * Flow:
 *   1. On load: connect WebSocket, register service worker, request push permission
 *   2. Idle state: shield icon, "Connected" pill
 *   3. On alert: flash transition → alert screen with map
 */

// ── Config ─────────────────────────────────────────────────────────────────
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL   = `${WS_PROTO}://${location.host}/ws`;
const API_BASE = `${location.protocol}//${location.host}`;

// SVG icons for each disaster type (inline, monoline)
const DISASTER_SVG = {
  fire: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C12 2 7 7 7 13C7 16.3 9.2 18 12 18C14.8 18 17 16.3 17 13C17 7 12 2 12 2Z"
          stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>
    <path d="M9 14C9 14 9.5 16 12 16C14.5 16 15 14 15 14"
          stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path d="M12 18V21" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,

  flood: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 14C3 14 5.5 11 9 14C12.5 17 15 14 15 14C15 14 17.5 11 21 14"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    <path d="M3 18C3 18 5.5 15 9 18C12.5 21 15 18 15 18C15 18 17.5 15 21 18"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    <path d="M12 2V10M9 5L12 2L15 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  tsunami: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 16C2 16 5 10 9 12C12 13.5 12 8 16 6C19 4.5 22 8 22 8"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    <path d="M2 20C2 20 5 17 8 18C11 19 13 17 16 18C18.5 18.8 22 17 22 17"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
  </svg>`,
};

const DISASTER_CONFIG = {
  fire:    { color: '#c0392b', bg: 'rgba(192,57,43,0.12)',  iconBg: 'rgba(192,57,43,0.18)', label: 'FIRE EVACUATION',  typeLabel: 'Fire Emergency' },
  flood:   { color: '#1a5276', bg: 'rgba(26,82,118,0.12)', iconBg: 'rgba(26,82,118,0.18)', label: 'FLOOD EVACUATION', typeLabel: 'Flood Emergency' },
  tsunami: { color: '#0e6655', bg: 'rgba(14,102,85,0.12)', iconBg: 'rgba(14,102,85,0.18)', label: 'TSUNAMI WARNING',  typeLabel: 'Tsunami Warning' },
};

// ── State ──────────────────────────────────────────────────────────────────
let map = null;
let userMarker = null;
let shelterMarker = null;
let routeLine = null;
let reconnectDelay = 500;
let _currentPayload = null;
let _currentAccent  = '#c0392b';

// ── DOM refs ───────────────────────────────────────────────────────────────
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const idleScreen    = document.getElementById('idle-screen');
const alertScreen   = document.getElementById('alert-screen');
const dismissBtn    = document.getElementById('dismiss-btn');
const routeStatus   = document.getElementById('route-status');
const getRouteBtn   = document.getElementById('get-route-btn');
const flashOverlay  = document.getElementById('flash-overlay');

dismissBtn.addEventListener('click', () => {
  alertScreen.classList.add('hidden');
  idleScreen.classList.remove('hidden');
});

getRouteBtn.addEventListener('click', () => {
  if (_currentPayload) {
    getRouteBtn.classList.remove('visible');
    setRouteStatus('Locating you…', 'warn');
    fetchAndDrawRoute(_currentPayload, _currentAccent);
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────
function connect() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectDelay = 500;
    setStatus('connected');
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'alert') showAlert(msg.payload);
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    setStatus('disconnected');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };

  ws.onerror = () => { /* onclose handles reconnect */ };
}

function setStatus(state) {
  if (state === 'connected') {
    statusDot.className = 'dot dot-green';
    statusText.textContent = 'Connected to alert system';
  } else {
    statusDot.className = 'dot dot-red';
    statusText.textContent = 'Reconnecting…';
  }
}

// ── Geometry helpers ───────────────────────────────────────────────────────
function _nearestShelter(userLat, userLon, shelters) {
  if (!shelters || shelters.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const s of shelters) {
    const d = ((s.lat - userLat) * 111) ** 2 + ((s.lon - userLon) * 85) ** 2;
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function _pointInPolygon(lat, lon, geoJsonPolygon) {
  // Extract ring from GeoJSON Polygon or Feature
  let ring;
  try {
    const geom = geoJsonPolygon.geometry ?? geoJsonPolygon;
    ring = geom.coordinates[0]; // [[lon,lat], ...]
  } catch { return true; } // if malformed, don't block
  // Ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Alert display ──────────────────────────────────────────────────────────
function showAlert(payload) {
  const type = payload.disaster_type || 'fire';
  const cfg  = DISASTER_CONFIG[type] || DISASTER_CONFIG.fire;

  _currentPayload = payload;
  _currentAccent  = cfg.color;

  // Flash transition
  flashOverlay.classList.add('active');
  setTimeout(() => flashOverlay.classList.remove('active'), 180);

  // Populate alert content
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8);

  document.getElementById('alert-time').textContent   = timeStr;
  document.getElementById('issued-time').textContent  = timeStr;
  document.getElementById('alert-title').textContent  = cfg.label;
  document.getElementById('hero-type-label').textContent = cfg.typeLabel;
  document.getElementById('alert-subtitle').textContent =
    payload.message || 'Immediate action required — follow evacuation route';

  // Hero accent color
  document.getElementById('alert-hero').style.setProperty('--hero-accent', cfg.color);

  // Disaster icon
  const iconWrap = document.getElementById('hero-icon-wrap');
  iconWrap.style.background = cfg.iconBg;
  iconWrap.style.color = cfg.color;
  iconWrap.innerHTML = DISASTER_SVG[type] || DISASTER_SVG.fire;

  // Shelter badge
  const shelter = payload.shelter;
  const shelterBadge = document.getElementById('shelter-badge');
  const shelterNameEl = document.getElementById('shelter-name');
  if (shelter) {
    shelterNameEl.textContent = shelter.name;
    shelterBadge.classList.add('visible');
  } else {
    shelterBadge.classList.remove('visible');
  }

  // Switch screens
  idleScreen.classList.add('hidden');
  alertScreen.classList.remove('hidden');

  // Build / update map
  initOrUpdateMap(payload, cfg.color);

  // Vibrate (mobile)
  if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 500]);
}

function setRouteStatus(msg, state) {
  routeStatus.textContent = msg;
  routeStatus.className = `visible ${state || ''}`;
}

function hideRouteStatus() {
  routeStatus.className = '';
}

// ── Map ────────────────────────────────────────────────────────────────────
function initOrUpdateMap(payload, accentColor) {
  const mapEl = document.getElementById('alert-map');

  if (!map) {
    map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      dragging: false,
      touchZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });

    // CartoDB Positron — light, minimal, no token needed
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);
  } else {
    [userMarker, shelterMarker, routeLine].forEach((l) => l && map.removeLayer(l));
    userMarker = null; shelterMarker = null; routeLine = null;
  }

  const shelter = payload.shelter;

  if (shelter) {
    // SVG pin marker for shelter
    const shelterIcon = L.divIcon({
      className: '',
      html: `<div class="shelter-pin-wrap">
        <svg width="22" height="28" viewBox="0 0 22 28" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 1C6.6 1 3 4.6 3 9C3 14.5 11 27 11 27C11 27 19 14.5 19 9C19 4.6 15.4 1 11 1Z"
                fill="${accentColor}" stroke="white" stroke-width="1.5"/>
          <circle cx="11" cy="9" r="3" fill="white" opacity="0.9"/>
        </svg>
        <div class="shelter-pin-label">${shelter.name}</div>
      </div>`,
      iconSize: [80, 46],
      iconAnchor: [11, 28],
    });
    shelterMarker = L.marker([shelter.lat, shelter.lon], { icon: shelterIcon }).addTo(map);
    map.setView([shelter.lat, shelter.lon], 14);
  }

  setRouteStatus('Locating you…', 'warn');
  fetchAndDrawRoute(payload, accentColor);
}

// ── Geolocation + route ────────────────────────────────────────────────────
async function _getIPLocation() {
  try {
    const r = await fetch('https://ip-api.com/json/', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status === 'success' && d.lat && d.lon) return { lat: d.lat, lon: d.lon };
  } catch {}
  return null;
}

function fetchAndDrawRoute(payload, accentColor) {
  const shelter = payload.shelter;

  if (!navigator.geolocation) {
    setRouteStatus('GPS unavailable — trying network location…', 'warn');
    _getIPLocation().then((loc) => {
      if (loc) {
        _onLocationReady(loc.lat, loc.lon, shelter, accentColor);
      } else {
        setRouteStatus('Could not determine your location', 'warn');
        getRouteBtn.classList.add('visible');
      }
    });
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: userLat, longitude: userLon } = pos.coords;

      // Sanity check: more than 100 km from Barcelona means stale cached fix
      const BCN_LAT = 41.385, BCN_LON = 2.173;
      const distKm = Math.sqrt(
        ((userLat - BCN_LAT) * 111) ** 2 +
        ((userLon - BCN_LON) * 85) ** 2
      );
      if (distKm > 100) {
        setRouteStatus('GPS fix seems far — retrying…', 'warn');
        navigator.geolocation.getCurrentPosition(
          (pos2) => _onLocationReady(pos2.coords.latitude, pos2.coords.longitude, shelter, accentColor),
          async () => {
            const loc = await _getIPLocation();
            if (loc) { _onLocationReady(loc.lat, loc.lon, shelter, accentColor); return; }
            setRouteStatus('Allow location to see your route', 'warn');
            getRouteBtn.classList.add('visible');
          },
          { timeout: 15000, maximumAge: 0, enableHighAccuracy: false }
        );
        return;
      }

      _onLocationReady(userLat, userLon, shelter, accentColor);
    },
    async () => {
      setRouteStatus('GPS blocked — trying network location…', 'warn');
      const loc = await _getIPLocation();
      if (loc) { _onLocationReady(loc.lat, loc.lon, shelter, accentColor); return; }
      if (shelter) {
        setRouteStatus('Allow location to see your route', 'warn');
      } else {
        hideRouteStatus();
      }
      getRouteBtn.classList.add('visible');
    },
    { timeout: 12000, maximumAge: 0, enableHighAccuracy: false },
  );
}

function _onLocationReady(userLat, userLon, shelter, accentColor) {
  // Check user is within the evacuation zone (if zone was sent with alert)
  const zone = _currentPayload?.zone_polygon;
  if (zone && !_pointInPolygon(userLat, userLon, zone)) {
    setRouteStatus('You are outside the evacuation zone — no action needed', 'ok');
    map.setView([userLat, userLon], 14);
    setTimeout(hideRouteStatus, 6000);
    return;
  }

  // Pick the nearest shelter for this specific user
  const nearest = _nearestShelter(userLat, userLon, _currentPayload?.shelters);
  if (nearest) {
    shelter = nearest;
    // Update shelter badge with the personalised shelter name
    const shelterNameEl = document.getElementById('shelter-name');
    const shelterBadge  = document.getElementById('shelter-badge');
    if (shelterNameEl) shelterNameEl.textContent = shelter.name;
    if (shelterBadge)  shelterBadge.classList.add('visible');
    // Move shelter marker to nearest shelter
    if (shelterMarker) map.removeLayer(shelterMarker);
    const shelterIcon = L.divIcon({
      className: '',
      html: `<div class="shelter-pin-wrap">
        <svg width="22" height="28" viewBox="0 0 22 28" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 1C6.6 1 3 4.6 3 9C3 14.5 11 27 11 27C11 27 19 14.5 19 9C19 4.6 15.4 1 11 1Z"
                fill="${accentColor}" stroke="white" stroke-width="1.5"/>
          <circle cx="11" cy="9" r="3" fill="white" opacity="0.9"/>
        </svg>
        <div class="shelter-pin-label">${shelter.name}</div>
      </div>`,
      iconSize: [80, 46], iconAnchor: [11, 28],
    });
    shelterMarker = L.marker([shelter.lat, shelter.lon], { icon: shelterIcon }).addTo(map);
  }

  if (userMarker) map.removeLayer(userMarker);
  const userIcon = L.divIcon({
    className: '',
    html: `<div class="user-dot"><div class="user-dot-ring"></div></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  userMarker = L.marker([userLat, userLon], { icon: userIcon }).addTo(map);

  if (!shelter) {
    map.setView([userLat, userLon], 15);
    hideRouteStatus();
    return;
  }

  const dKm = Math.sqrt(
    ((userLat - shelter.lat) * 111) ** 2 +
    ((userLon - shelter.lon) * 85) ** 2
  );
  if (dKm > 50) {
    setRouteStatus('Could not confirm your location — showing shelter only', 'warn');
    setTimeout(hideRouteStatus, 5000);
    map.setView([shelter.lat, shelter.lon], 14);
    return;
  }

  setRouteStatus('Calculating route…', 'warn');

  // Include danger origin so route avoids the hazard source
  const danger = _currentPayload?.danger_origin;
  const dangerParams = danger ? `&danger_lat=${danger.lat}&danger_lon=${danger.lon}` : '';
  const url = `${API_BASE}/route?from_lat=${userLat}&from_lon=${userLon}&to_lat=${shelter.lat}&to_lon=${shelter.lon}${dangerParams}`;
  fetch(url)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
      const path = data.path;
      if (path && path.length >= 2) {
        const latlngs = path.map((p) => [p.lat, p.lng]);
        routeLine = L.polyline(latlngs, {
          color: '#27ae60',
          weight: 4,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(map);
        const allBounds = [[userLat, userLon], [shelter.lat, shelter.lon], ...latlngs];
        setTimeout(() => map.fitBounds(allBounds, { padding: [36, 36], maxZoom: 16 }), 200);
        setRouteStatus(`Route ready — ${data.waypoints} waypoints`, 'ok');
        setTimeout(hideRouteStatus, 4000);
      } else {
        _drawStraightLine(userLat, userLon, shelter, accentColor);
      }
      getRouteBtn.classList.remove('visible');
    })
    .catch(() => {
      _drawStraightLine(userLat, userLon, shelter, accentColor);
      getRouteBtn.classList.remove('visible');
    });
}

function _drawStraightLine(userLat, userLon, shelter, accentColor) {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  routeLine = L.polyline(
    [[userLat, userLon], [shelter.lat, shelter.lon]],
    { color: '#27ae60', weight: 4, opacity: 0.7, dashArray: '8 6', lineCap: 'round' }
  ).addTo(map);
  setTimeout(() => map.fitBounds([[userLat, userLon], [shelter.lat, shelter.lon]], { padding: [36, 36] }), 200);
  setRouteStatus('Showing direct path (road route unavailable)', 'warn');
  setTimeout(hideRouteStatus, 5000);
}

// ── Service Worker + Web Push ───────────────────────────────────────────────
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await requestPushPermission(reg);
  } catch (e) {
    console.warn('SW registration failed:', e);
  }
}

async function requestPushPermission(reg) {
  if (!('PushManager' in window)) return;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  try {
    const res = await fetch(`${API_BASE}/vapid-public-key`);
    if (!res.ok) return;
    const { publicKey } = await res.json();
    if (!publicKey) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey),
    });
    await fetch(`${API_BASE}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
  } catch (e) {
    console.warn('Push subscription failed (expected on HTTP/LAN):', e);
  }
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// ── Boot ───────────────────────────────────────────────────────────────────
connect();
registerServiceWorker();
