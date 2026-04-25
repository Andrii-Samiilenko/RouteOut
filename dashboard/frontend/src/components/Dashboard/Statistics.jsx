/**
 * Statistics panel — full live stats for the right sidebar.
 *
 * Props:
 *   stats         — { evacuating, reached_safety, routes_recalculated, clearance_minutes }
 *   total         — simulated citizen count (from WS)
 *   active        — whether simulation is running
 *   zonePolygon   — GeoJSON Feature/Geometry for the evacuation zone (for area estimate)
 *   shelters      — [{ id, name, capacity, utilisation }] from wsData.safe_zones.features
 *   timeAvailable — evacuation threshold in minutes (from scenario)
 */
import { useRef } from 'react';

const RING_R = 40;
const RING_C = 2 * Math.PI * RING_R;
// Barcelona mixed urban population density used for zone-area estimate
const POP_DENSITY = 12_000; // people / km²

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function polygonAreaKm2(geojson) {
  if (!geojson) return 0;
  try {
    const geom = geojson.geometry ?? geojson;
    const ring = geom?.coordinates?.[0];
    if (!ring || ring.length < 3) return 0;
    // Shoelace in lon/lat degrees, then convert to km²
    // At Barcelona (41.4°N): 1° lat ≈ 111 km, 1° lon ≈ 83.5 km
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return (Math.abs(area) / 2) * 111 * 83.5;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProgressRing({ pct }) {
  const offset = RING_C * (1 - pct / 100);
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" className="rotate-[-90deg]">
      <circle cx="48" cy="48" r={RING_R} fill="none" stroke="#1e2d40" strokeWidth="8" />
      <circle
        cx="48" cy="48" r={RING_R}
        fill="none" stroke="#1abc9c" strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
    </svg>
  );
}

function Bar({ value, max, color = '#1abc9c' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full bg-white/[0.07] rounded-full h-1.5 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

function ShelterRow({ name, capacity, utilisation }) {
  const pct = Math.min(100, Math.round((utilisation || 0) * 100));
  const color = pct >= 80 ? '#e74c3c' : pct >= 50 ? '#f39c12' : '#1abc9c';
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="w-[96px] text-[9px] text-[#a0a0a0] truncate shrink-0 leading-tight">{name}</span>
      <div className="flex-1 bg-white/[0.07] rounded-full h-1.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-[9px] tabular-nums shrink-0 w-8 text-right leading-tight" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

function StatSection({ title, children }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
      <p className="text-[#a0a0a0] text-[9px] uppercase tracking-[0.14em] mb-3 font-semibold">{title}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Statistics({ stats, total, active, zonePolygon, shelters = [], timeAvailable }) {
  const lastStatsRef = useRef({});
  if (stats && Object.keys(stats).length > 0) lastStatsRef.current = stats;
  const s = active ? lastStatsRef.current : (stats || {});

  const evacuating    = s.evacuating    ?? 0;
  const reachedSafety = s.reached_safety ?? 0;
  const totalCitizens = total || evacuating + reachedSafety;
  const reachedPct    = totalCitizens > 0 ? Math.round((reachedSafety / totalCitizens) * 100) : 0;

  // Zone area → population estimate
  const areaKm2          = polygonAreaKm2(zonePolygon);
  const estimatedInZone  = areaKm2 > 0 ? Math.round(areaKm2 * POP_DENSITY) : null;

  // Clearance time color coding
  const clearanceMin = s.clearance_minutes != null ? Math.round(s.clearance_minutes) : null;
  const limit        = timeAvailable || 30;
  const clearColor   = clearanceMin == null
    ? '#a0a0a0'
    : clearanceMin <= limit * 0.8 ? '#1abc9c'
    : clearanceMin <= limit       ? '#f39c12'
    :                               '#e74c3c';
  const clearLabel   = clearanceMin == null ? null
    : clearanceMin <= limit
      ? `On track — ${limit - clearanceMin}m margin`
      : `Over limit by ${clearanceMin - limit}m`;

  // Real shelters only (exclude exit-point markers)
  const realShelters = shelters.filter((sh) => !sh.id?.startsWith('exit-'));

  return (
    <div className={`flex flex-col gap-3 transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-60'}`}>

      {/* ── Citizens in zone ─────────────────────────────────────────────── */}
      <StatSection title="Citizens in Evacuation Zone">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-[#f0f0f0] tabular-nums leading-none">
            {active && totalCitizens > 0
              ? totalCitizens.toLocaleString()
              : estimatedInZone != null
                ? estimatedInZone.toLocaleString()
                : '—'}
          </span>
          <span className="text-[#a0a0a0] text-[10px]">
            {active ? 'simulated' : estimatedInZone != null ? 'est.' : 'no zone drawn'}
          </span>
        </div>
        {!active && areaKm2 > 0 && (
          <p className="text-[#a0a0a0]/50 text-[9px] mt-1.5 leading-snug">
            {areaKm2.toFixed(2)} km² × {POP_DENSITY.toLocaleString()} pop/km² (Barcelona density)
          </p>
        )}
      </StatSection>

      {/* ── Evacuation progress ──────────────────────────────────────────── */}
      <StatSection title="Evacuation Progress">
        <div className="flex gap-4">
          {/* Ring */}
          <div className="relative inline-flex items-center justify-center shrink-0">
            <ProgressRing pct={active ? reachedPct : 0} />
            <div className="absolute flex flex-col items-center">
              <span className="text-lg font-bold text-[#f0f0f0] leading-none tabular-nums">
                {active ? `${reachedPct}%` : '—'}
              </span>
              <span className="text-[8px] text-[#a0a0a0] mt-0.5">safe</span>
            </div>
          </div>

          {/* Progress bars */}
          <div className="flex-1 flex flex-col gap-2.5 justify-center min-w-0">
            <div>
              <div className="flex justify-between text-[9px] mb-1">
                <span className="text-[#a0a0a0]">Notified</span>
                <span className="text-[#5b9bd5] tabular-nums font-semibold">
                  {active ? totalCitizens.toLocaleString() : '—'}
                </span>
              </div>
              <Bar value={totalCitizens} max={totalCitizens} color="#5b9bd5" />
            </div>
            <div>
              <div className="flex justify-between text-[9px] mb-1">
                <span className="text-[#a0a0a0]">En Route</span>
                <span className="text-[#e8a020] tabular-nums font-semibold">
                  {active ? evacuating.toLocaleString() : '—'}
                </span>
              </div>
              <Bar value={evacuating} max={totalCitizens} color="#e8a020" />
            </div>
            <div>
              <div className="flex justify-between text-[9px] mb-1">
                <span className="text-[#a0a0a0]">At Shelter</span>
                <span className="text-[#1abc9c] tabular-nums font-semibold">
                  {active ? reachedSafety.toLocaleString() : '—'}
                </span>
              </div>
              <Bar value={reachedSafety} max={totalCitizens} color="#1abc9c" />
            </div>
          </div>
        </div>
      </StatSection>

      {/* ── Shelter occupancy ────────────────────────────────────────────── */}
      <StatSection title="Shelter Occupancy">
        {realShelters.length > 0 ? (
          <div className="flex flex-col gap-2">
            {realShelters.map((sh) => (
              <ShelterRow
                key={sh.id}
                name={sh.name}
                capacity={sh.capacity}
                utilisation={sh.utilisation}
              />
            ))}
          </div>
        ) : (
          <p className="text-[#a0a0a0]/40 text-[9px]">Load presets or place shelters to preview</p>
        )}
      </StatSection>

      {/* ── Clearance vs available time ──────────────────────────────────── */}
      <StatSection title="Clearance vs Available Time">
        <div className="flex items-end justify-between mb-2">
          <div>
            <span className="text-3xl font-bold tabular-nums leading-none" style={{ color: clearColor }}>
              {clearanceMin != null ? `${clearanceMin}m` : '—'}
            </span>
            <span className="text-[#a0a0a0] text-[9px] ml-1.5">est. clearance</span>
          </div>
          <div className="text-right">
            <span className="text-xl font-bold text-[#f0f0f0] tabular-nums">{limit}m</span>
            <span className="text-[#a0a0a0] text-[9px] ml-1">limit</span>
          </div>
        </div>
        <Bar value={clearanceMin ?? 0} max={limit} color={clearColor} />
        {active && clearLabel && (
          <p className="text-[9px] mt-1.5 font-medium" style={{ color: clearColor }}>{clearLabel}</p>
        )}
        {(!active || clearanceMin == null) && (
          <p className="text-[#a0a0a0]/40 text-[9px] mt-1.5">Computed once simulation is running</p>
        )}
      </StatSection>

      {/* ── Routes recalculated — small footer stat ──────────────────────── */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[#a0a0a0] text-[9px] uppercase tracking-[0.1em]">Routes recalculated</span>
        <span className="text-[#f0f0f0] text-sm font-bold tabular-nums">
          {active && s.routes_recalculated != null ? s.routes_recalculated : '—'}
        </span>
      </div>

      {!active && (
        <p className="text-[#a0a0a0]/30 text-[9px] text-center pb-1">Simulation inactive — launch to see live data</p>
      )}
    </div>
  );
}
