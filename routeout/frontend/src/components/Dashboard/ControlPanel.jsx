import { useState } from 'react';
import { triggerScenario, advanceScenario, resetScenario } from '@/services/api';

/**
 * Wind direction compass — shows an arrow pointing in the wind direction.
 */
function WindCompass({ degrees }) {
  if (degrees == null) return null;
  return (
    <div className="relative w-8 h-8 flex items-center justify-center">
      <div
        className="w-0 h-0 border-l-[5px] border-r-[5px] border-b-[12px] border-l-transparent border-r-transparent border-b-[#F39C12]"
        style={{ transform: `rotate(${degrees}deg)`, transformOrigin: '50% 75%' }}
      />
    </div>
  );
}

const DIRECTION_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function degreesToName(deg) {
  if (deg == null) return '—';
  return DIRECTION_NAMES[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * ControlPanel — scenario buttons, advance/reset, live AEMET readout.
 *
 * Props:
 *   scenarioActive — bool, disables trigger buttons when a scenario is running
 *   weather        — live weather dict from WS payload (may be null)
 *   scenarioId     — currently active scenario id (or null)
 *   onError        — callback(message) for showing errors
 */
export default function ControlPanel({ scenarioActive, weather, scenarioId, onError }) {
  const [loading, setLoading] = useState(null); // 'tibidabo' | 'flood' | 'advance' | 'reset'

  async function handleTrigger(id) {
    setLoading(id);
    try {
      await triggerScenario(id);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleAdvance() {
    setLoading('advance');
    try {
      await advanceScenario();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleReset() {
    setLoading('reset');
    try {
      await resetScenario();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(null);
    }
  }

  const wind = weather || {};

  return (
    <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4">
      <h2 className="text-gray-400 text-[10px] uppercase tracking-widest mb-3 font-medium">
        Scenario Control
      </h2>

      {/* Scenario trigger buttons */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          onClick={() => handleTrigger('tibidabo_wildfire')}
          disabled={scenarioActive || loading !== null}
          className="bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold py-2.5 px-3 rounded-lg transition-colors"
        >
          {loading === 'tibidabo_wildfire' ? 'Starting…' : 'Tibidabo Wildfire'}
        </button>
        <button
          onClick={() => handleTrigger('barceloneta_flood')}
          disabled={scenarioActive || loading !== null}
          className="bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold py-2.5 px-3 rounded-lg transition-colors"
        >
          {loading === 'barceloneta_flood' ? 'Starting…' : 'Barceloneta Flood'}
        </button>
      </div>

      {/* Advance / Reset buttons */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          onClick={handleAdvance}
          disabled={!scenarioActive || loading !== null}
          className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold py-2.5 px-3 rounded-lg transition-colors"
        >
          {loading === 'advance' ? 'Advancing…' : 'Advance +5 min'}
        </button>
        <button
          onClick={handleReset}
          disabled={loading !== null}
          className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold py-2.5 px-3 rounded-lg transition-colors"
        >
          {loading === 'reset' ? 'Resetting…' : 'Reset'}
        </button>
      </div>

      {/* Active scenario badge */}
      {scenarioActive && scenarioId && (
        <div className="mb-3 px-2 py-1.5 rounded-lg bg-gray-900/60 border border-gray-700/60 text-xs text-gray-300">
          Active:{' '}
          <span className="text-white font-medium">
            {scenarioId === 'tibidabo_wildfire' ? 'Tibidabo Wildfire' : 'Barceloneta Flood'}
          </span>
        </div>
      )}

      {/* AEMET live weather */}
      <div className="bg-gray-900/60 rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-gray-400 text-xs uppercase tracking-widest">
            Live Weather · AEMET
          </span>
          {wind.source === 'fallback' && (
            <span className="text-xs text-yellow-600">fallback</span>
          )}
          {wind.source === 'aemet' && (
            <span className="text-xs text-green-600">live</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <WindCompass degrees={wind.wind_direction_deg} />
          <div>
            <span className="text-white font-semibold text-lg leading-none">
              {wind.wind_speed_kmh != null ? `${Math.round(wind.wind_speed_kmh)} km/h` : '—'}
            </span>
            <span className="text-gray-400 text-xs ml-1">
              {degreesToName(wind.wind_direction_deg)}
            </span>
          </div>
          <div className="text-gray-300 text-xs ml-auto text-right">
            {wind.temperature_c != null && (
              <div>{Math.round(wind.temperature_c)}°C</div>
            )}
            {wind.humidity_pct != null && (
              <div>{Math.round(wind.humidity_pct)}% RH</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
