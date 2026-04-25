/**
 * RouteOut Notification PWA — app.js
 *
 * Flow:
 *   1. On load: connect WebSocket, register service worker, request push permission
 *   2. Idle state: "Connected to alert system ✓"
 *   3. On alert message: show full-screen emergency popup with Leaflet map
 */

// ── Config ─────────────────────────────────────────────────────────────────
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL   = `${WS_PROTO}://${location.host}/ws`;
const API_BASE = `${location.protocol}//${location.host}`;

const DISASTER_CONFIG = {
  fire:    { color: '#C0392B', bg: 'linear-gradient(135deg,#7B241C,#C0392B)', icon: '🔥', label: 'FIRE EMERGENCY' },
  flood:   { color: '#2471A3', bg: 'linear-gradient(135deg,#1A5276,#2471A3)', icon: '🌊', label: 'FLOOD EMERGENCY' },
  tsunami: { color: '#148F77', bg: 'linear-gradient(135deg,#0E6655,#148F77)', icon: '🌀', label: 'TSUNAMI WARNING' },
};

// ── State ──────────────────────────────────────────────────────────────────
let map = null;
let userMarker = null;
let shelterMarker = null;
let routeLine = null;
let reconnectDelay = 500;
let _currentPayload = null;   // saved for retry when user taps "get route" button
let _currentAccent = '#C0392B';

// ── DOM refs ───────────────────────────────────────────────────────────────
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const alertModal   = document.getElementById('alert-modal');
const dismissBtn   = document.getElementById('dismiss-btn');
const routeStatus  = document.getElementById('route-status');
const getRouteBtn  = document.getElementById('get-route-btn');

dismissBtn.addEventListener('click', () => {
  alertModal.classList.add('hidden');
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
    statusText.textContent = 'Connected to alert system ✓';
  } else {
    statusDot.className = 'dot dot-red';
    statusText.textContent = 'Reconnecting…';
  }
}

// ── Geometry helpers ───────────────────────────────────────────────────────
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

  // Header
  document.getElementById('alert-header').style.background = cfg.bg;
  document.getElementById('alert-icon').textContent  = cfg.icon;
  document.getElementById('alert-label').textContent = cfg.label;
  document.getElementById('alert-message').textContent = payload.message || '';

  // Shelter info
  const shelter = payload.shelter;
  const shelterInfoEl = document.getElementById('shelter-info');
  if (shelter) {
    shelterInfoEl.textContent = `Assigned shelter: ${shelter.name}`;
    shelterInfoEl.style.display = 'block';
  } else {
    shelterInfoEl.style.display = 'none';
  }

  // Show modal first (map needs visible container to init correctly)
  alertModal.classList.remove('hidden');

  // Build / update Leaflet map
  initOrUpdateMap(payload, cfg.color);

  // Pulse animation on the header
  document.getElementById('alert-header').classList.add('pulse-once');
  setTimeout(() => document.getElementById('alert-header').classList.remove('pulse-once'), 1200);

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

function initOrUpdateMap(payload, accentColor) {
  const mapEl = document.getElementById('alert-map');

  if (!map) {
    map = L.map(mapEl, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);
  } else {
    [userMarker, shelterMarker, routeLine].forEach((l) => l && map.removeLayer(l));
    userMarker = null; shelterMarker = null; routeLine = null;
  }

  const shelter = payload.shelter;

  // Always place shelter marker immediately
  if (shelter) {
    const shelterIcon = L.divIcon({
      className: '',
      html: `<div class="shelter-pin">⛺<div class="shelter-label">${shelter.name}</div></div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 44],
    });
    shelterMarker = L.marker([shelter.lat, shelter.lon], { icon: shelterIcon })
      .addTo(map)
      .bindPopup(`<b>${shelter.name}</b><br>Assigned evacuation shelter`);
    map.setView([shelter.lat, shelter.lon], 14);
  }

  setRouteStatus('Locating you…', 'warn');
  fetchAndDrawRoute(payload, accentColor);
}

// IP-based location fallback (used when browser blocks GPS on HTTP/LAN)
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
    // No GPS API — try IP location immediately
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

      // Sanity check: if GPS returns a position more than 100 km from Barcelona,
      // it's a stale cached fix from another city — ignore it and ask again.
      const BCN_LAT = 41.385, BCN_LON = 2.173;
      const distKm = Math.sqrt(
        ((userLat - BCN_LAT) * 111) ** 2 +
        ((userLon - BCN_LON) * 85) ** 2
      );
      if (distKm > 100) {
        setRouteStatus('GPS fix seems far away — retrying…', 'warn');
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
    async (err) => {
      // GPS denied or blocked (common on HTTP/LAN) — fall back to IP location
      setRouteStatus('GPS blocked — trying network location…', 'warn');
      const loc = await _getIPLocation();
      if (loc) {
        _onLocationReady(loc.lat, loc.lon, shelter, accentColor);
        return;
      }
      if (shelter) {
        setRouteStatus('Allow location to see your route', 'warn');
      } else {
        hideRouteStatus();
      }
      getRouteBtn.classList.add('visible');
    },
    // enableHighAccuracy: false — avoids iOS Safari silently blocking GPS on HTTP
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

  // Place / update user marker
  if (userMarker) map.removeLayer(userMarker);
  const userIcon = L.divIcon({
    className: '',
    html: `<div class="user-dot"><div class="user-dot-ring"></div></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
  userMarker = L.marker([userLat, userLon], { icon: userIcon }).addTo(map);

  if (!shelter) {
    map.setView([userLat, userLon], 15);
    hideRouteStatus();
    return;
  }

  // Distance user→shelter in km
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
        routeLine = L.polyline(latlngs, { color: accentColor, weight: 5, opacity: 0.9 }).addTo(map);
        const allBounds = [[userLat, userLon], [shelter.lat, shelter.lon], ...latlngs];
        setTimeout(() => map.fitBounds(allBounds, { padding: [50, 50], maxZoom: 16 }), 200);
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
    { color: accentColor, weight: 4, opacity: 0.7, dashArray: '8 6' }
  ).addTo(map);
  setTimeout(() => map.fitBounds([[userLat, userLon], [shelter.lat, shelter.lon]], { padding: [50, 50] }), 200);
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
