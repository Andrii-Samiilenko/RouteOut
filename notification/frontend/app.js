/**
 * RouteOut Notification PWA — app.js
 *
 * Flow:
 *   1. On load: connect WebSocket, register service worker, request push permission
 *   2. Idle state: "Connected to alert system ✓"
 *   3. On alert message: show full-screen emergency popup with Leaflet map
 */

// ── Config ─────────────────────────────────────────────────────────────────
// Backend WebSocket and API live on the same origin as the served HTML
const WS_URL = `ws://${location.host}/ws`;
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

// ── DOM refs ───────────────────────────────────────────────────────────────
const statusDot   = document.getElementById('status-dot');
const statusText  = document.getElementById('status-text');
const alertModal  = document.getElementById('alert-modal');
const dismissBtn  = document.getElementById('dismiss-btn');

dismissBtn.addEventListener('click', () => {
  alertModal.classList.add('hidden');
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

// ── Alert display ──────────────────────────────────────────────────────────
function showAlert(payload) {
  const type = payload.disaster_type || 'fire';
  const cfg  = DISASTER_CONFIG[type] || DISASTER_CONFIG.fire;

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

function initOrUpdateMap(payload, accentColor) {
  const mapEl = document.getElementById('alert-map');

  if (!map) {
    map = L.map(mapEl, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);
  } else {
    // Remove old layers
    [userMarker, shelterMarker, routeLine].forEach((l) => l && map.removeLayer(l));
  }

  const bounds = [];

  // User location (blue pulsing dot)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const userIcon = L.divIcon({
        className: '',
        html: `<div class="user-dot"><div class="user-dot-ring"></div></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      userMarker = L.marker([lat, lng], { icon: userIcon }).addTo(map)
        .bindPopup('<b>Your location</b>').openPopup();
      bounds.push([lat, lng]);
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [50, 50] });
      else map.setView([lat, lng], 15);
    });
  }

  // Shelter marker (green)
  const shelter = payload.shelter;
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
    bounds.push([shelter.lat, shelter.lon]);
  }

  // Route polyline (from backend path or direct straight line as fallback)
  const path = payload.path;
  if (path && path.length >= 2) {
    const latlngs = path.map((p) => [p.lat, p.lng]);
    routeLine = L.polyline(latlngs, {
      color: accentColor,
      weight: 5,
      opacity: 0.9,
      dashArray: null,
    }).addTo(map);
    latlngs.forEach((p) => bounds.push(p));
  }

  // Fit all points into view
  if (bounds.length >= 2) {
    setTimeout(() => map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 }), 200);
  } else if (shelter) {
    map.setView([shelter.lat, shelter.lon], 15);
  }
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
