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
        <div className="shrink-0 flex items-center justify-between px-4 pt-3 pb-2.5 border-b border-white/[0.06]">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 160" style={{ height: '68px', width: 'auto' }}>
            <defs>
              <filter id="pinGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="5" result="blur"/>
                <feFlood floodColor="#00d4aa" floodOpacity="0.28" result="color"/>
                <feComposite in="color" in2="blur" operator="in" result="glow"/>
                <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            <g transform="translate(10, 30)" filter="url(#pinGlow)">
              <path d="M50 0C32.327 0 18 14.327 18 32C18 50.5 50 92 50 92C50 92 82 50.5 82 32C82 14.327 67.673 0 50 0Z" fill="none" stroke="#00d4aa" strokeWidth="9" opacity="0.1"/>
              <path d="M50 0C32.327 0 18 14.327 18 32C18 50.5 50 92 50 92C50 92 82 50.5 82 32C82 14.327 67.673 0 50 0Z" fill="#0d1e2d" stroke="#00d4aa" strokeWidth="2.8"/>
              <circle cx="50" cy="32" r="18.5" fill="none" stroke="#00d4aa" strokeWidth="2.5"/>
              <circle cx="50" cy="32" r="13.5" fill="#081319"/>
              <line x1="50" y1="20.5" x2="50" y2="23.5" stroke="#00d4aa" strokeWidth="1.3" opacity="0.5"/>
              <line x1="50" y1="40.5" x2="50" y2="43.5" stroke="#00d4aa" strokeWidth="1.3" opacity="0.5"/>
              <line x1="38.5" y1="32" x2="41.5" y2="32" stroke="#00d4aa" strokeWidth="1.3" opacity="0.5"/>
              <line x1="58.5" y1="32" x2="61.5" y2="32" stroke="#00d4aa" strokeWidth="1.3" opacity="0.5"/>
              <polygon points="50,20.5 52.8,30.5 50,28.5 47.2,30.5" fill="#00d4aa"/>
              <polygon points="50,43.5 52.8,33.5 50,35.5 47.2,33.5" fill="#1a7060"/>
              <circle cx="50" cy="32" r="2.6" fill="#081319" stroke="#00d4aa" strokeWidth="1.2"/>
            </g>
            <text x="115" y="103" fontFamily="'Outfit', 'Helvetica Neue', Arial, sans-serif" fontWeight="800" fontSize="86" letterSpacing="-2" fill="#eef2f6">Route<tspan fill="#00d4aa">Out</tspan></text>
            <text x="118" y="130" fontFamily="'Barlow Condensed', 'Arial Narrow', Arial, sans-serif" fontWeight="600" fontSize="19" letterSpacing="3.2" fill="#00c49a" opacity="0.9">EMERGENCY NAVIGATION SYSTEM</text>
          </svg>
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
            elapsedMinutes={scenario.elapsed_minutes || 0}
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

      {/* ── Map legend — bottom-left ── */}
      <div className="absolute bottom-4 left-4 z-20 rounded-2xl px-4 py-3.5" style={{ minWidth: '210px', background: 'linear-gradient(160deg, rgba(10,15,30,0.55) 0%, rgba(8,12,24,0.45) 100%)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.07)' }}>

        <p className="text-white/80 text-[9px] uppercase tracking-[0.28em] mb-3 font-bold">Legend</p>

        {/* ── SHELTERS ── */}
        <p className="text-white/45 text-[7.5px] uppercase tracking-[0.18em] mb-2 font-semibold">Shelters</p>
        <div className="flex flex-col gap-2 mb-3">
          {[
            { icon: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></>, label: 'Hospital', color: '#1abc9c' },
            { icon: <><path d="M2 20h20"/><path d="M4 20V10l8-7 8 7v10"/><rect x="9" y="14" width="6" height="6"/></>, label: 'Assembly point', color: '#1abc9c' },
            { icon: <><path d="M1 21L12 3l11 18"/><line x1="1" y1="21" x2="23" y2="21"/><path d="M12 21v-8"/></>, label: 'Shelter', color: '#1abc9c' },
            { icon: <><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>, label: 'Zone exit point', color: '#F39C12' },
          ].map(({ icon, label, color }) => (
            <div key={label} className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">{icon}</svg>
              <span className="text-white/75 text-[10px]">{label}</span>
            </div>
          ))}
        </div>

        {/* Capacity colour key */}
        <div className="flex flex-col gap-1.5 mb-3">
          {[
            { color: '#27AE60', label: 'Available  < 50%' },
            { color: '#F39C12', label: 'Filling  50 – 80%' },
            { color: '#E74C3C', label: 'Near full  > 80%' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2.5">
              <span className="shrink-0 w-3.5 h-3.5 rounded-full border-2" style={{ borderColor: color, background: color + '30' }} />
              <span className="text-white/65 text-[10px]">{label}</span>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div className="border-t border-white/[0.08] mb-3" />

        {/* ── HAZARD ── */}
        <p className="text-white/45 text-[7.5px] uppercase tracking-[0.18em] mb-2 font-semibold">Hazard</p>
        <div className="flex flex-col gap-2 mb-3">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 w-10 h-3.5 rounded" style={{ background: 'linear-gradient(90deg,#7b1a1a,#c0392b)' }} />
            <span className="text-white/75 text-[10px]">Fire / ash area</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 w-10 h-3.5 rounded" style={{ background: 'linear-gradient(90deg,#FF5722cc,#FF8C00cc)', boxShadow: '0 0 0 1.5px #FFCC0066' }} />
            <span className="text-white/75 text-[10px]">Active fire front</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 w-10 h-3.5 rounded" style={{ background: '#1a527699' }} />
            <span className="text-white/75 text-[10px]">Flood / tsunami</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 w-10 h-3.5 rounded" style={{ background: '#a2d9ce55' }} />
            <span className="text-white/75 text-[10px]">Wave leading edge</span>
          </div>
          <div className="flex items-center gap-2.5">
            <svg width="40" height="8" className="shrink-0"><line x1="0" y1="4" x2="40" y2="4" stroke="#E67E22" strokeWidth="2" strokeDasharray="6 3"/></svg>
            <span className="text-white/75 text-[10px]">Predicted spread</span>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-white/[0.08] mb-3" />

        {/* ── ZONE ── */}
        <p className="text-white/45 text-[7.5px] uppercase tracking-[0.18em] mb-2 font-semibold">Zone</p>
        <div className="flex items-center gap-2.5">
          <svg width="40" height="8" className="shrink-0"><line x1="0" y1="4" x2="40" y2="4" stroke="#F39C12" strokeWidth="2" strokeDasharray="6 3"/></svg>
          <span className="text-white/75 text-[10px]">Evacuation zone</span>
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
