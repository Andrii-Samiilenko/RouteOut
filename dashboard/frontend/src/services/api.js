/**
 * REST API client.
 * All paths are relative so they route through the Vite /api proxy
 * → http://localhost:8000 (works transparently for a phone on the same WiFi).
 */

const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export function launchSimulation(payload) {
  return request('/simulation/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function resetSimulation() {
  return request('/simulation/reset', { method: 'POST' });
}

export function getSimulationState() {
  return request('/simulation/state');
}

export function getHealth() {
  return request('/health');
}

// Simulation advances server-side on a tick timer; this is a no-op kept for
// TimeSlider compatibility (it has no backend equivalent).
export function advanceScenario() {
  return Promise.resolve({ status: 'ok' });
}
