/**
 * REST API client.
 * All paths are relative so they route through the Vite /api proxy
 * → http://localhost:8000 (works transparently for phone on same WiFi).
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

export function triggerScenario(scenarioId) {
  return request('/scenario/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario_id: scenarioId }),
  });
}

export function advanceScenario() {
  return request('/scenario/advance', { method: 'POST' });
}

export function resetScenario() {
  return request('/scenario/reset', { method: 'POST' });
}

export function getScenarioState() {
  return request('/scenario/state');
}

export function joinCitizen(lat, lon) {
  return request('/citizen/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon }),
  });
}

export function getCitizenState(citizenId) {
  return request(`/citizen/${citizenId}/state`);
}

export function getHealth() {
  return request('/health');
}
