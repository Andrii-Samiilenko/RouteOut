import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import CoordinatorMap from '@/components/Map/CoordinatorMap';
import MapErrorBoundary from '@/components/Map/MapErrorBoundary';
import ControlPanel from '@/components/Dashboard/ControlPanel';
import Statistics from '@/components/Dashboard/Statistics';

/**
 * Supervisor dashboard.
 *
 * Layout: full-screen map with a floating glass panel on the right.
 *
 * State owned here:
 *   - Flash detection (route_version bumps → 2 s red flash on map)
 *   - Chart history snapshots (appended each WS tick)
 *   - Draw state: drawMode, pendingShelters, zonePolygon, shelterDialog
 *   - Error toast (auto-cleared after 5 s)
 */
export default function Coordinator() {
  const { data: wsData, connected } = useWebSocket();
  const [error, setError] = useState(null);

  // ── Route flash detection ─────────────────────────────────────────────────
  const prevVersionsRef = useRef({});
  const [flashingCitizens, setFlashingCitizens] = useState(new Set());

  useEffect(() => {
    if (!wsData?.routes?.features) return;
    const newlyFlashing = [];
    wsData.routes.features.forEach((f) => {
      const { citizen_id, route_version } = f.properties || {};
      if (citizen_id == null) return;
      const prev = prevVersionsRef.current[citizen_id];
      if (prev !== undefined && route_version > prev) newlyFlashing.push(citizen_id);
      prevVersionsRef.current[citizen_id] = route_version;
    });
    if (newlyFlashing.length > 0) {
      setFlashingCitizens((s) => new Set([...s, ...newlyFlashing]));
      const ids = [...newlyFlashing];
      setTimeout(() => {
        setFlashingCitizens((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n; });
      }, 2000);
    }
  }, [wsData]);

  // ── Error auto-clear ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  // ── Draw state ────────────────────────────────────────────────────────────
  const [drawMode, setDrawMode]               = useState(null);
  const [zonePolygon, setZonePolygon]         = useState(null);
  const [pendingShelters, setPendingShelters] = useState([]);
  const [shelterDialog, setShelterDialog]     = useState(null);
  // Incremented on reset — signals CoordinatorMap to clear any in-progress
  // polygon vertices even if the polygon was never completed (zonePolygon stays null).
  const [drawResetKey, setDrawResetKey]       = useState(0);

  // Called when preset shelters are loaded from backend
  function handleSheltersLoaded(shelterList) {
    // Convert backend shelter objects to the same shape as pendingShelters
    setPendingShelters(shelterList.map((s) => ({
      id:           s.id,
      name:         s.name,
      lat:          s.lat,
      lon:          s.lon,
      capacity:     s.capacity,
      shelter_type: s.shelter_type,
    })));
  }

  function handleClearDraft() {
    setZonePolygon(null);
    setPendingShelters([]);
    setDrawMode(null);
    setShelterDialog(null);
    prevVersionsRef.current = {};
    setDrawResetKey((k) => k + 1); // tells CoordinatorMap to clear in-progress vertices
  }

  function handleMapClick({ lat, lon }) {
    if (drawMode === 'shelter') setShelterDialog({ lat, lon });
  }

  function handlePolygonComplete(polygon) {
    setZonePolygon(polygon);
    setDrawMode(null);
  }

  function confirmShelter({ name, capacity, shelter_type }) {
    if (!shelterDialog) return;
    setPendingShelters((prev) => [
      ...prev,
      {
        id:           `s-${Date.now()}`,
        name:         name || 'Shelter',
        lat:          shelterDialog.lat,
        lon:          shelterDialog.lon,
        capacity:     Number(capacity),
        shelter_type,
      },
    ]);
    setShelterDialog(null);
  }

  const scenario    = wsData?.scenario    || {};
  const stats       = wsData?.statistics  || {};
  const totalCit    = (wsData?.citizens?.features || []).length;

  // Live shelter data from backend (post-launch)
  const liveShelters = (wsData?.safe_zones?.features || [])
    .filter((f) => !f.properties?.id?.startsWith('exit-'))
    .map((f) => ({
      id:          f.properties.id,
      name:        f.properties.name,
      capacity:    f.properties.capacity,
      utilisation: f.properties.utilisation,
    }));

  // Pre-launch: show preset/pending shelters with 0% occupancy so the section
  // is always visible rather than empty until simulation starts.
  const shelterPreview = pendingShelters
    .filter((s) => s.shelter_type !== 'exit_point' && !s.id?.startsWith('exit-'))
    .map((s) => ({ ...s, utilisation: 0 }));

  const sheltersForStats = liveShelters.length > 0 ? liveShelters : shelterPreview;

  // The effective zone polygon: drawn draft or echoed back from backend
  const effectiveZone = zonePolygon || scenario.zone_polygon || null;

  const PANEL_STYLE = {
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255,255,255,0.1) transparent',
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0a0f1e]" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ── Full-screen map ── */}
      <MapErrorBoundary>
        <CoordinatorMap
          wsData={wsData}
          flashingSet={flashingCitizens}
          drawMode={drawMode}
          drawResetKey={drawResetKey}
          pendingShelters={pendingShelters}
          zonePolygon={zonePolygon}
          onMapClick={handleMapClick}
          onPolygonComplete={handlePolygonComplete}
        />
      </MapErrorBoundary>

      {/* ── Single right panel — controls + statistics ─────────────────────── */}
      <div
        className="absolute top-4 right-4 bottom-4 z-20 w-[400px] flex flex-col overflow-hidden rounded-2xl bg-[#0d1424]/95 backdrop-blur-md border border-white/[0.08] shadow-2xl"
        style={PANEL_STYLE}
      >
        {/* ── Panel header ── */}
        <div className="shrink-0 flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/[0.06]">
          <h1 className="text-[#f0f0f0] font-extrabold text-lg tracking-tight">
            Route<span style={{ color: '#1abc9c' }}>Out</span>
          </h1>
          <div className="flex items-center gap-3">
            {scenario.active && (
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#c0392b] animate-pulse" />
                <span className="text-[10px] text-[#f0f0f0] font-semibold tabular-nums capitalize">
                  {scenario.disaster_type} · T+{Math.round(scenario.elapsed_minutes ?? 0)}m
                </span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-[#1abc9c] animate-pulse' : 'bg-[#c0392b]'}`} />
              <span className="text-[10px] text-[#a0a0a0] font-medium">{connected ? 'Live' : 'Offline'}</span>
            </div>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-4 pb-4" style={PANEL_STYLE}>
          {/* Controls */}
          <div className="pt-3">
            <ControlPanel
              simulationActive={scenario.active}
              notifOnline={wsData?.notification_service_online ?? false}
              drawMode={drawMode}
              onDrawModeChange={setDrawMode}
              pendingShelters={pendingShelters}
              zonePolygon={zonePolygon}
              onClearDraft={handleClearDraft}
              onError={setError}
              onSheltersLoaded={handleSheltersLoaded}
            />
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 border-t border-white/[0.06]" />
            <span className="text-[#a0a0a0] text-[9px] uppercase tracking-[0.18em] font-bold shrink-0">Live Statistics</span>
            <div className="flex-1 border-t border-white/[0.06]" />
          </div>

          {/* Statistics */}
          <Statistics
            stats={stats}
            total={totalCit}
            active={scenario.active}
            zonePolygon={effectiveZone}
            shelters={sheltersForStats}
            timeAvailable={scenario.time_available || 30}
          />
        </div>
      </div>

      {/* Draw mode hint — floats above map, left-of-panel center */}
      {drawMode && !scenario.active && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-[#0d1424]/95 backdrop-blur-sm rounded-full px-4 py-1.5 border border-[#1abc9c]/30 shadow pointer-events-none"
          style={{ marginRight: '200px' }}>
          <span className="text-[11px] text-[#1abc9c] font-medium">
            {drawMode === 'polygon'
              ? 'Click to add vertices — double-click to finish the zone'
              : 'Click on the map to place a shelter'}
          </span>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-[#c0392b]/20 border border-[#c0392b]/50 text-[#f0f0f0] text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-sm text-center backdrop-blur-sm"
          style={{ marginRight: '200px' }}>
          {error}
        </div>
      )}

      {/* ── Safe zone capacity legend — bottom-left ── */}
      <div className="absolute bottom-4 left-4 z-20 bg-[#0d1424]/90 backdrop-blur-sm rounded-xl px-3 py-2 border border-white/[0.08] shadow">
        <p className="text-[#a0a0a0] text-[9px] uppercase tracking-[0.18em] mb-1.5 font-bold">Safe Zone Capacity</p>
        <div className="flex flex-col gap-1">
          {[
            { color: '#27AE60', label: 'Available (<50%)' },
            { color: '#F39C12', label: 'Filling (50–80%)' },
            { color: '#E74C3C', label: 'Near Full (>80%)' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span style={{ background: color }} className="w-2 h-2 rounded-full opacity-90 shrink-0" />
              <span className="text-[#a0a0a0] text-[9px]">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Shelter placement dialog */}
      {shelterDialog && (
        <ShelterDialog
          onConfirm={confirmShelter}
          onCancel={() => setShelterDialog(null)}
        />
      )}
    </div>
  );
}

// SVG shelter type icons (no emoji)
function ShelterTypeIcon({ type, size = 13 }) {
  if (type === 'hospital') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="12" height="12" rx="1.5"/>
        <path d="M8 5v6M5 8h6"/>
      </svg>
    );
  }
  if (type === 'assembly') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 15h14"/>
        <path d="M3 15V9l5-5 5 5v6"/>
        <rect x="6" y="10" width="4" height="5"/>
      </svg>
    );
  }
  // default: shelter/tent
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 14L8 2l7 12"/>
      <path d="M1 14h14"/>
      <path d="M8 14V8"/>
    </svg>
  );
}

function ShelterDialog({ onConfirm, onCancel }) {
  const [name, setName]           = useState('');
  const [capacity, setCapacity]   = useState(200);
  const [shelterType, setShelterType] = useState('shelter');

  const types = [
    { value: 'shelter',  label: 'Shelter'  },
    { value: 'hospital', label: 'Hospital' },
    { value: 'assembly', label: 'Assembly' },
  ];

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0d1424] border border-white/[0.1] rounded-2xl p-6 w-80 shadow-2xl">
        <h3 className="text-[#f0f0f0] font-bold text-sm mb-4 tracking-wide">Add Shelter Marker</h3>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em] mb-1 block">Name</label>
            <input
              autoFocus value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Palau Sant Jordi"
              className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-[#f0f0f0] placeholder-[#a0a0a0]/50 focus:outline-none focus:border-[#1abc9c]/60"
            />
          </div>

          <div>
            <label className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em] mb-1 block">Type</label>
            <div className="flex gap-1.5">
              {types.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setShelterType(value)}
                  className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] font-semibold tracking-wide transition-all
                    ${shelterType === value
                      ? 'bg-[#1abc9c]/20 border border-[#1abc9c]/40 text-[#1abc9c]'
                      : 'bg-white/[0.04] border border-white/[0.08] text-[#a0a0a0] hover:bg-white/[0.08]'}`}
                >
                  <ShelterTypeIcon type={value} size={13} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.12em]">Capacity</label>
              <span className="text-[#f0f0f0] text-xs font-bold tabular-nums">{capacity}</span>
            </div>
            <input
              type="range" min={50} max={5000} step={50} value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
              onInput={(e) => setCapacity(Number(e.target.value))}
              className="w-full accent-[#1abc9c]"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={() => onConfirm({ name: name || 'Shelter', capacity, shelter_type: shelterType })}
            className="flex-1 py-2 bg-[#1abc9c] hover:bg-[#16a085] text-[#0a0f1e] rounded-lg text-sm font-bold tracking-wide transition-colors"
          >
            Place
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#a0a0a0] rounded-lg text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
