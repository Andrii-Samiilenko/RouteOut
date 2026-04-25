import { useEffect, useRef, useState } from 'react';
import { launchSimulation, resetSimulation } from '@/services/api';

// ── Inline SVG icons (no emoji) ─────────────────────────────────────────────

function IconFire({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C12 2 7 7 7 12a5 5 0 0010 0c0-2-1-4-1-4s-1 2-2 2c-1 0-2-1-2-3 0-1.5 0.5-3.5 0.5-3.5"/>
      <path d="M9.5 14.5C9.5 16 10.5 17 12 17s2.5-1 2.5-2.5"/>
    </svg>
  );
}

function IconFlood({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 14c2-2 4 0 6-2s4 0 6-2 4 0 6-2"/>
      <path d="M2 18c2-2 4 0 6-2s4 0 6-2 4 0 6-2"/>
      <path d="M6 6l2-4 2 4"/>
      <path d="M14 6l2-4 2 4"/>
    </svg>
  );
}

function IconTsunami({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 18c1-3 4-5 7-4 1-4 4-6 7-4 1-2 3-3 4-2"/>
      <path d="M2 22h20"/>
      <path d="M6 14c0-4 3-7 7-7"/>
      <path d="M13 7l-1-5 3 3-3 2"/>
    </svg>
  );
}

function IconShelter({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10L12 3l9 7"/>
      <path d="M5 10v9h14v-9"/>
    </svg>
  );
}

function IconHospital({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M12 8v8M8 12h8"/>
    </svg>
  );
}

function IconAssembly({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 20h20"/>
      <path d="M4 20V10l8-7 8 7v10"/>
      <rect x="9" y="14" width="6" height="6"/>
    </svg>
  );
}

function IconPolygon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
    </svg>
  );
}

function IconLaunch({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
    </svg>
  );
}

function IconCheck({ size = 10 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8l4 4 8-8"/>
    </svg>
  );
}

function IconCircle({ size = 10 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6"/>
    </svg>
  );
}

// ── Disaster options ─────────────────────────────────────────────────────────

const DISASTER_OPTIONS = [
  {
    value: 'fire',
    label: 'Wildfire',
    Icon: IconFire,
    activeClass: 'bg-red-800 ring-red-500/40 text-red-100',
    desc: 'Collserola forest fire spreading toward city',
  },
  {
    value: 'tsunami',
    label: 'Tsunami',
    Icon: IconTsunami,
    activeClass: 'bg-teal-800 ring-teal-500/40 text-teal-100',
    desc: 'Mediterranean coastal wave — inundation from the sea',
  },
];

const SHELTER_TYPE_OPTIONS = [
  { value: 'shelter',  label: 'Shelter',  Icon: IconShelter  },
  { value: 'hospital', label: 'Hospital', Icon: IconHospital },
  { value: 'assembly', label: 'Assembly', Icon: IconAssembly },
];

const SHELTER_ICONS_MAP = {
  shelter:  <IconShelter  size={16} />,
  hospital: <IconHospital size={16} />,
  assembly: <IconAssembly size={16} />,
};

/**
 * Supervisor control panel.
 *
 * Props:
 *   simulationActive  — bool
 *   notifOnline       — bool
 *   drawMode          — 'polygon' | 'shelter' | null
 *   onDrawModeChange  — (mode) => void
 *   pendingShelters   — [{id,name,lat,lon,capacity,shelter_type}]
 *   zonePolygon       — GeoJSON Polygon or null
 *   onClearDraft      — () => void
 *   onError           — (msg) => void
 *   onSheltersLoaded  — (shelters[]) => void
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
  onSheltersLoaded,
}) {
  const [disasterType, setDisasterType]   = useState(null);
  const [timeAvailable, setTimeAvailable] = useState(30);
  const [loading, setLoading]             = useState(null); // 'launch'|'reset'|'presets'|null
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [usePresets, setUsePresets]       = useState(true);
  // Prevents double-fire on rapid clicks before React re-render disables the button
  const isProcessingRef = useRef(false);

  const canLaunch = !simulationActive && !!zonePolygon && !!disasterType && (usePresets || pendingShelters.length > 0);

  // Auto-load preset shelters whenever disaster type changes (skip when null)
  useEffect(() => {
    if (!usePresets || !disasterType) return;
    loadPresets(disasterType);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disasterType, usePresets]);

  async function loadPresets(type) {
    setLoading('presets');
    setPresetsLoaded(false);
    try {
      const res = await fetch(`/api/simulation/shelters/${type}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      onSheltersLoaded?.(data.shelters);
      setPresetsLoaded(true);
    } catch (e) {
      onError?.(`Could not load preset shelters: ${e.message}`);
    } finally {
      setLoading(null);
    }
  }

  function handleDisasterChange(type) {
    setDisasterType(type);
    setPresetsLoaded(false);
  }

  async function handleLaunch() {
    if (!canLaunch || isProcessingRef.current) return;
    isProcessingRef.current = true;
    setLoading('launch');
    try {
      await launchSimulation({
        zone_polygon:   zonePolygon,
        shelters:       usePresets ? [] : pendingShelters,
        time_available: timeAvailable,
        disaster_type:  disasterType,
      });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('already active')) {
        onError?.('Simulation already running — click Reset first, then Launch again.');
      } else {
        onError?.(msg);
      }
    } finally {
      setLoading(null);
      isProcessingRef.current = false;
    }
  }

  async function handleReset() {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setLoading('reset');
    try {
      await resetSimulation();
      onClearDraft?.();
      setPresetsLoaded(false);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(null);
      isProcessingRef.current = false;
    }
  }

  const selectedOption = DISASTER_OPTIONS.find((o) => o.value === disasterType);

  return (
    <div className="rounded-xl bg-[#0d1424] border border-white/[0.08] p-4 flex flex-col gap-4">
      <h2 className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.18em] font-bold">
        Supervisor Sandbox
      </h2>

      {/* Disaster type */}
      <div>
        <p className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em] mb-2">Disaster scenario</p>
        <div className="flex gap-1.5">
          {DISASTER_OPTIONS.map(({ value, label, Icon, activeClass }) => (
            <button
              key={value}
              disabled={simulationActive || loading !== null}
              onClick={() => handleDisasterChange(value)}
              className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg text-xs font-semibold transition-all
                disabled:opacity-40 disabled:cursor-not-allowed
                ${disasterType === value
                  ? `${activeClass} ring-2`
                  : 'bg-white/[0.04] text-[#a0a0a0] hover:bg-white/[0.08] border border-white/[0.08]'}`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        <p className="text-[#a0a0a0] text-[10px] mt-1.5 leading-snug">
          {selectedOption ? selectedOption.desc : 'Select a disaster type to begin'}
        </p>
      </div>

      {/* Evacuation time */}
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <p className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em]">Evacuation time</p>
          <span className="text-[#f0f0f0] text-sm font-bold tabular-nums">{timeAvailable} min</span>
        </div>
        <input
          type="range" min={5} max={120} step={5} value={timeAvailable}
          disabled={simulationActive}
          onChange={(e) => setTimeAvailable(Number(e.target.value))}
          onInput={(e) => setTimeAvailable(Number(e.target.value))}
          className="w-full accent-[#1abc9c] disabled:opacity-40"
        />
        <div className="flex justify-between text-[#a0a0a0] text-[10px] mt-0.5">
          <span>5 min</span><span>120 min</span>
        </div>
      </div>

      {/* Shelter mode toggle */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em]">Shelter placement</p>
          <button
            disabled={simulationActive}
            onClick={() => { setUsePresets((v) => !v); setPresetsLoaded(false); }}
            className={`text-[10px] px-2 py-1 rounded-md font-bold tracking-wide transition-colors
              ${usePresets
                ? 'bg-[#1abc9c]/20 text-[#1abc9c] border border-[#1abc9c]/30 hover:bg-[#1abc9c]/30'
                : 'bg-white/[0.04] text-[#a0a0a0] border border-white/[0.08] hover:bg-white/[0.08]'}
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {usePresets ? 'Demo presets' : 'Custom'}
          </button>
        </div>

        {usePresets ? (
          <div>
            {loading === 'presets' && (
              <p className="text-[#a0a0a0] text-[10px]">Loading shelters…</p>
            )}
            {presetsLoaded && (
              <p className="text-[#1abc9c] text-[10px]">
                Pre-named shelters loaded for {disasterType} scenario
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 mt-1">
            <DrawModeButton
              active={drawMode === 'polygon'}
              disabled={simulationActive || loading !== null}
              onClick={() => onDrawModeChange(drawMode === 'polygon' ? null : 'polygon')}
              icon={<IconPolygon size={20} />}
              label="Evac zone"
              done={!!zonePolygon}
            />
            <DrawModeButton
              active={drawMode === 'shelter'}
              disabled={simulationActive || loading !== null}
              onClick={() => onDrawModeChange(drawMode === 'shelter' ? null : 'shelter')}
              icon={<IconShelter size={20} />}
              label="Add shelter"
              done={pendingShelters.length > 0}
              count={pendingShelters.length}
            />
          </div>
        )}
      </div>

      {/* Manual shelter list */}
      {!usePresets && pendingShelters.length > 0 && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-2.5 max-h-28 overflow-y-auto space-y-1.5">
          {pendingShelters.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <span className="flex-shrink-0 text-[#a0a0a0]">
                {SHELTER_ICONS_MAP[s.shelter_type] ?? <IconShelter size={16} />}
              </span>
              <span className="text-[#f0f0f0] truncate flex-1">{s.name}</span>
              <span className="text-[#a0a0a0] shrink-0">{s.capacity} cap</span>
            </div>
          ))}
        </div>
      )}

      {/* Draw zone — shown in both modes */}
      <div>
        <p className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em] mb-1.5">Evacuation zone</p>
        <DrawModeButton
          active={drawMode === 'polygon'}
          disabled={simulationActive || loading !== null}
          onClick={() => onDrawModeChange(drawMode === 'polygon' ? null : 'polygon')}
          icon={<IconPolygon size={20} />}
          label="Draw zone on map"
          done={!!zonePolygon}
        />
      </div>

      {/* Readiness checklist */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-2.5 space-y-1.5">
        <ReadinessItem done={!!zonePolygon} label="Evacuation zone drawn" />
        <ReadinessItem
          done={usePresets ? presetsLoaded : pendingShelters.length > 0}
          label={usePresets ? 'Preset shelters loaded' : 'At least one shelter placed'}
        />
        <ReadinessItem done={notifOnline || simulationActive} label="Notification service connected" />
      </div>

      {/* Launch / Reset */}
      <div className="flex gap-2">
        <button
          onClick={handleLaunch}
          disabled={!canLaunch || loading !== null}
          className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold tracking-wide transition-all shadow-lg
            disabled:opacity-40 disabled:cursor-not-allowed
            ${canLaunch && !loading
              ? 'bg-[#1abc9c] hover:bg-[#16a085] text-[#0a0f1e] ring-2 ring-[#1abc9c]/30'
              : 'bg-white/[0.06] text-[#a0a0a0] border border-white/[0.08]'}`}
        >
          {loading === 'launch' ? (
            'Launching…'
          ) : (
            <>
              <IconLaunch size={14} />
              Launch Simulation
            </>
          )}
        </button>
        <button
          onClick={handleReset}
          disabled={loading !== null}
          className="px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#a0a0a0] text-xs font-semibold tracking-wide transition-colors disabled:opacity-40"
        >
          {loading === 'reset' ? '…' : 'Reset'}
        </button>
      </div>

      {simulationActive && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#c0392b]/10 border border-[#c0392b]/30">
          <span className="w-2 h-2 rounded-full bg-[#c0392b] animate-pulse shrink-0" />
          <span className="text-[#f0f0f0] text-xs font-medium">Simulation active — 80 virtual evacuees routed</span>
        </div>
      )}
    </div>
  );
}

function DrawModeButton({ active, disabled, onClick, icon, label, done, count }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={`flex flex-col items-center gap-1 py-3 rounded-lg border text-xs font-medium tracking-wide transition-all w-full
        disabled:opacity-40 disabled:cursor-not-allowed
        ${active
          ? 'bg-[#1abc9c]/10 border-[#1abc9c]/50 text-[#1abc9c]'
          : done
            ? 'bg-white/[0.04] border-white/[0.12] text-[#f0f0f0]'
            : 'bg-white/[0.02] border-white/[0.06] text-[#a0a0a0] hover:border-white/[0.2]'}`}
    >
      <span>{icon}</span>
      <span>{label}</span>
      {count != null && count > 0
        ? <span className="text-[#1abc9c] text-[10px]">{count} placed</span>
        : done && <span className="text-[#1abc9c] text-[10px]">done</span>}
    </button>
  );
}

function ReadinessItem({ done, label }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={done ? 'text-[#1abc9c]' : 'text-[#a0a0a0]/40'}>
        {done ? <IconCheck size={10} /> : <IconCircle size={10} />}
      </span>
      <span className={done ? 'text-[#f0f0f0]' : 'text-[#a0a0a0]/50'}>{label}</span>
    </div>
  );
}
