import { useState } from 'react';
import { launchSimulation, resetSimulation } from '@/services/api';

const DISASTER_OPTIONS = [
  { value: 'fire',    label: 'Fire',    activeClass: 'bg-red-700 ring-red-400/40',   icon: '🔥' },
  { value: 'flood',   label: 'Flood',   activeClass: 'bg-blue-700 ring-blue-400/40',  icon: '🌊' },
  { value: 'tsunami', label: 'Tsunami', activeClass: 'bg-teal-700 ring-teal-400/40',  icon: '🌀' },
];

/**
 * Supervisor sandbox control panel.
 *
 * Props:
 *   simulationActive  — bool, from WS state
 *   notifOnline       — bool, notification service reachability
 *   drawMode          — 'polygon' | 'shelter' | null (controlled by parent)
 *   onDrawModeChange  — (mode) => void
 *   pendingShelters   — [{id,name,lat,lon,capacity,shelter_type}]
 *   zonePolygon       — GeoJSON Polygon or null
 *   onClearDraft      — clears pendingShelters + zonePolygon in parent
 *   onError           — (msg) => void
 */
export default function ControlPanel({
  simulationActive,
  notifOnline,
  drawMode,
  onDrawModeChange,
  pendingShelters,
  zonePolygon,
  onClearDraft,
  onError,
}) {
  const [disasterType, setDisasterType] = useState('fire');
  const [timeAvailable, setTimeAvailable] = useState(30);
  const [loading, setLoading] = useState(null);

  const canLaunch = !simulationActive && zonePolygon && pendingShelters.length > 0;

  async function handleLaunch() {
    if (!canLaunch) return;
    setLoading('launch');
    try {
      await launchSimulation({
        zone_polygon: zonePolygon,
        shelters: pendingShelters,
        time_available: timeAvailable,
        disaster_type: disasterType,
      });
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleReset() {
    setLoading('reset');
    try {
      await resetSimulation();
      onClearDraft?.();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4 flex flex-col gap-4">
      <h2 className="text-gray-400 text-[10px] uppercase tracking-widest font-medium">
        Supervisor Sandbox
      </h2>

      {/* Disaster type selector */}
      <div>
        <p className="text-gray-500 text-xs mb-2">Disaster type</p>
        <div className="flex gap-2">
          {DISASTER_OPTIONS.map(({ value, label, activeClass, icon }) => (
            <button
              key={value}
              disabled={simulationActive || loading !== null}
              onClick={() => setDisasterType(value)}
              className={`flex-1 py-2 rounded-lg text-white text-xs font-semibold transition-all
                disabled:opacity-40 disabled:cursor-not-allowed
                ${disasterType === value
                  ? `${activeClass} ring-2`
                  : 'bg-gray-700 hover:bg-gray-600'}`}
            >
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {/* Evacuation time slider */}
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <p className="text-gray-500 text-xs">Evacuation time</p>
          <span className="text-white text-sm font-semibold">{timeAvailable} min</span>
        </div>
        <input
          type="range" min={5} max={120} step={5} value={timeAvailable}
          disabled={simulationActive}
          onChange={(e) => setTimeAvailable(Number(e.target.value))}
          className="w-full accent-emerald-400 disabled:opacity-40"
        />
        <div className="flex justify-between text-gray-600 text-[10px] mt-0.5">
          <span>5 min</span><span>120 min</span>
        </div>
      </div>

      {/* Map drawing tools */}
      <div>
        <p className="text-gray-500 text-xs mb-2">Draw on map</p>
        <div className="grid grid-cols-2 gap-2">
          <DrawModeButton
            active={drawMode === 'polygon'}
            disabled={simulationActive || loading !== null}
            onClick={() => onDrawModeChange(drawMode === 'polygon' ? null : 'polygon')}
            icon="⬡" label="Evac zone" done={!!zonePolygon}
          />
          <DrawModeButton
            active={drawMode === 'shelter'}
            disabled={simulationActive || loading !== null}
            onClick={() => onDrawModeChange(drawMode === 'shelter' ? null : 'shelter')}
            icon="⛺" label="Add shelter"
            done={pendingShelters.length > 0}
            count={pendingShelters.length}
          />
        </div>
      </div>

      {/* Placed shelters mini-list */}
      {pendingShelters.length > 0 && (
        <div className="bg-gray-900/60 rounded-lg p-2.5 max-h-28 overflow-y-auto space-y-1.5">
          {pendingShelters.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <span className="text-base leading-none">
                {{ shelter: '⛺', hospital: '🏥', assembly: '🏛️' }[s.shelter_type] ?? '⛺'}
              </span>
              <span className="text-gray-300 truncate flex-1">{s.name}</span>
              <span className="text-gray-500 shrink-0">{s.capacity} cap</span>
            </div>
          ))}
        </div>
      )}

      {/* Readiness checklist */}
      <div className="bg-gray-900/40 rounded-lg p-2.5 space-y-1">
        <ReadinessItem done={!!zonePolygon}           label="Evacuation zone drawn" />
        <ReadinessItem done={pendingShelters.length > 0} label="At least one shelter placed" />
        <ReadinessItem done={notifOnline || simulationActive} label="Notification service connected" />
      </div>

      {/* Launch / Reset */}
      <div className="flex gap-2">
        <button
          onClick={handleLaunch}
          disabled={!canLaunch || loading !== null}
          className={`flex-1 py-3 rounded-xl text-white font-bold text-sm transition-all shadow-lg
            disabled:opacity-40 disabled:cursor-not-allowed
            ${canLaunch && !loading ? 'bg-emerald-600 hover:bg-emerald-500 ring-2 ring-emerald-400/30' : 'bg-gray-700'}`}
        >
          {loading === 'launch' ? 'Launching…' : '⚡ Launch Simulation'}
        </button>
        <button
          onClick={handleReset}
          disabled={loading !== null}
          className="px-4 py-3 rounded-xl bg-gray-700 hover:bg-gray-600 text-white text-xs font-semibold transition-colors disabled:opacity-40"
        >
          {loading === 'reset' ? '…' : 'Reset'}
        </button>
      </div>

      {/* Active badge */}
      {simulationActive && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/60 border border-red-800/60">
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
          <span className="text-red-300 text-xs font-medium">Simulation active — notif sent</span>
        </div>
      )}
    </div>
  );
}

function DrawModeButton({ active, disabled, onClick, icon, label, done, count }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={`flex flex-col items-center gap-1 py-3 rounded-lg border text-xs font-medium transition-all
        disabled:opacity-40 disabled:cursor-not-allowed
        ${active
          ? 'bg-emerald-900/60 border-emerald-600 text-emerald-300'
          : done
            ? 'bg-gray-900/60 border-gray-600 text-gray-300'
            : 'bg-gray-900/40 border-gray-700 text-gray-400 hover:border-gray-500'}`}
    >
      <span className="text-xl leading-none">{icon}</span>
      <span>{label}</span>
      {count != null && count > 0
        ? <span className="text-emerald-400 text-[10px]">{count} placed</span>
        : done && <span className="text-emerald-400 text-[10px]">✓ done</span>}
    </button>
  );
}

function ReadinessItem({ done, label }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={done ? 'text-emerald-400' : 'text-gray-600'}>{done ? '✓' : '○'}</span>
      <span className={done ? 'text-gray-300' : 'text-gray-600'}>{label}</span>
    </div>
  );
}
