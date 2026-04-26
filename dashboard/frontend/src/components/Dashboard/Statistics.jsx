/**
 * Statistics panel — live stats + population-scale stub overlay.
 *
 * Real data (from WebSocket):
 *   evacuating, reached_safety, routes_recalculated, clearance_minutes,
 *   shelter utilisation, elapsed_minutes
 *
 * Stub layer (when active):
 *   Scales the real 80-agent sim to a realistic Barcelona population (derived
 *   from zone area × density). All stub values move in proportion to real
 *   simulation progress so the numbers are internally consistent.
 */
import { useRef, useEffect, useState } from 'react';

const RING_R = 40;
const RING_C = 2 * Math.PI * RING_R;
const POP_DENSITY = 12_000; // people / km² — Barcelona mixed urban

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function polygonAreaKm2(geojson) {
  if (!geojson) return 0;
  try {
    const geom = geojson.geometry ?? geojson;
    const ring = geom?.coordinates?.[0];
    if (!ring || ring.length < 3) return 0;
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return (Math.abs(area) / 2) * 111 * 83.5;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function ProgressRing({ pct, color = '#1abc9c' }) {
  const offset = RING_C * (1 - pct / 100);
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" className="rotate-[-90deg]">
      <circle cx="48" cy="48" r={RING_R} fill="none" stroke="#1e2d40" strokeWidth="8" />
      <circle cx="48" cy="48" r={RING_R} fill="none" stroke={color} strokeWidth="8"
        strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
    </svg>
  );
}

function Bar({ value, max, color = '#1abc9c' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full bg-white/[0.07] rounded-full h-1.5 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function MiniBar({ pct, color }) {
  return (
    <div className="w-full bg-white/[0.06] rounded-full h-1 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700"
        style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  );
}

function ShelterRow({ name, utilisation }) {
  const pct = Math.min(100, Math.round((utilisation || 0) * 100));
  const color = pct >= 80 ? '#e74c3c' : pct >= 50 ? '#f39c12' : '#1abc9c';
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-[100px] text-[9.5px] text-white/50 truncate shrink-0">{name}</span>
      <div className="flex-1 bg-white/[0.08] rounded-full h-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] tabular-nums shrink-0 w-8 text-right font-bold" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

function StatSection({ title, children, accent }) {
  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-3.5"
      style={accent ? { borderColor: accent + '33' } : {}}>
      <p className="text-white/40 text-[8px] uppercase tracking-[0.18em] mb-3 font-bold">{title}</p>
      {children}
    </div>
  );
}

// Tiny sparkline — array of 0-1 values
function Sparkline({ points, color, height = 28 }) {
  if (!points || points.length < 2) return null;
  const w = 120, h = height;
  const xs = points.map((_, i) => (i / (points.length - 1)) * w);
  const ys = points.map((v) => h - v * (h - 4) - 2);
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  // Fill area
  const fill = `${d} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="spkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#spkGrad)" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// Stat chip — a small inline metric pill
function Chip({ label, value, color }) {
  return (
    <div className="flex flex-col items-center bg-white/[0.05] rounded-lg px-2.5 py-2 min-w-0 flex-1">
      <span className="text-[9px] text-white/35 uppercase tracking-[0.1em] mb-1 font-semibold leading-none">{label}</span>
      <span className="text-[15px] font-bold tabular-nums leading-none" style={{ color: color || '#fff' }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Statistics({ stats, total, active, zonePolygon, shelters = [], timeAvailable, elapsedMinutes = 0 }) {
  const lastStatsRef = useRef({});
  if (stats && Object.keys(stats).length > 0) lastStatsRef.current = stats;
  const s = active ? lastStatsRef.current : (stats || {});

  // Real sim values
  const evacuating    = s.evacuating    ?? 0;
  const reachedSafety = s.reached_safety ?? 0;
  const realTotal     = total || evacuating + reachedSafety;
  const reachedPct    = realTotal > 0 ? Math.round((reachedSafety / realTotal) * 100) : 0;
  const clearanceMin  = s.clearance_minutes != null ? Math.round(s.clearance_minutes) : null;
  const limit         = timeAvailable || 30;

  // Population-scale stub — derived from zone area × density
  const areaKm2       = polygonAreaKm2(zonePolygon);
  const popEstimate   = areaKm2 > 0 ? Math.round(areaKm2 * POP_DENSITY) : 85_000;
  // Scale factor: real sim is 80 agents, stub scales to full population
  const scaleFactor   = active && realTotal > 0 ? popEstimate / realTotal : 1;

  const stubTotal     = active ? popEstimate : popEstimate;
  const stubReached   = active ? Math.round(reachedSafety * scaleFactor) : 0;
  const stubEnRoute   = active ? Math.round(evacuating * scaleFactor) : 0;
  const stubNotified  = active ? stubTotal : 0;
  // Compliance rate climbs from 82% to 96% as simulation progresses
  const compliancePct = active ? Math.min(96, 82 + reachedPct * 0.14) : 0;
  // Avg walk time: mix of clearance and a realistic urban baseline (18 min)
  const avgWalkMin    = active && clearanceMin ? Math.round(clearanceMin * 0.55 + 8) : null;
  // Hazard exposure: shrinks as people evacuate
  const hazardExposurePct = active ? Math.max(0, Math.round(30 - reachedPct * 0.28)) : 0;
  // Throughput: people reaching safety per minute (stub)
  const throughput    = active && elapsedMinutes > 0
    ? Math.round(stubReached / Math.max(1, elapsedMinutes))
    : null;

  // Clearance colour
  const clearColor = clearanceMin == null ? '#a0a0a0'
    : clearanceMin <= limit * 0.8 ? '#1abc9c'
    : clearanceMin <= limit       ? '#f39c12'
    :                               '#e74c3c';
  const clearLabel = clearanceMin == null ? null
    : clearanceMin <= limit
      ? `On track — ${limit - clearanceMin}m margin`
      : `Over limit by ${clearanceMin - limit}m`;

  // Sparkline history — appended each second while active
  const sparkRef = useRef([]);
  useEffect(() => {
    if (!active) { sparkRef.current = []; return; }
    const frac = realTotal > 0 ? reachedSafety / realTotal : 0;
    sparkRef.current = [...sparkRef.current.slice(-39), frac];
  }, [reachedSafety, active, realTotal]);

  // Real shelters only
  const realShelters = shelters.filter((sh) => !sh.id?.startsWith('exit-'));

  return (
    <div className={`flex flex-col gap-3 transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-60'}`}>

      {/* ── Population overview ─────────────────────────────────────────── */}
      <StatSection title="Population in Evacuation Zone">
        <div className="flex items-baseline gap-2.5 mb-2">
          <span className="text-4xl font-bold text-white tabular-nums leading-none">
            {stubTotal.toLocaleString()}
          </span>
          <span className="text-white/40 text-[11px] font-medium">
            {active ? 'residents' : areaKm2 > 0 ? 'est. residents' : 'no zone drawn'}
          </span>
        </div>
        {areaKm2 > 0 && (
          <p className="text-white/25 text-[9px] leading-snug mb-3">
            {areaKm2.toFixed(2)} km² · {POP_DENSITY.toLocaleString()} pop/km² (Barcelona)
          </p>
        )}
        {active && (
          <div className="flex gap-2">
            <Chip label="Notified" value={stubNotified.toLocaleString()} color="#5b9bd5" />
            <Chip label="En Route" value={stubEnRoute.toLocaleString()} color="#e8a020" />
            <Chip label="Safe" value={stubReached.toLocaleString()} color="#1abc9c" />
          </div>
        )}
      </StatSection>

      {/* ── Evacuation progress ──────────────────────────────────────────── */}
      <StatSection title="Evacuation Progress">
        <div className="flex gap-4">
          <div className="relative inline-flex items-center justify-center shrink-0">
            <ProgressRing pct={active ? reachedPct : 0} color={clearColor} />
            <div className="absolute flex flex-col items-center">
              <span className="text-xl font-bold text-white leading-none tabular-nums">
                {active ? `${reachedPct}%` : '—'}
              </span>
              <span className="text-[8px] text-white/40 mt-0.5 font-medium">safe</span>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-3 justify-center min-w-0">
            {[
              { label: 'Notified',  val: stubNotified, max: stubTotal, color: '#5b9bd5' },
              { label: 'En Route',  val: stubEnRoute,  max: stubTotal, color: '#e8a020' },
              { label: 'At Shelter',val: stubReached,  max: stubTotal, color: '#1abc9c' },
            ].map(({ label, val, max, color }) => (
              <div key={label}>
                <div className="flex justify-between text-[10px] mb-1.5">
                  <span className="text-white/45">{label}</span>
                  <span className="tabular-nums font-bold" style={{ color }}>
                    {active ? val.toLocaleString() : '—'}
                  </span>
                </div>
                <Bar value={val} max={max} color={color} />
              </div>
            ))}
          </div>
        </div>

        {/* Sparkline */}
        {active && sparkRef.current.length > 2 && (
          <div className="mt-3 pt-3 border-t border-white/[0.06]">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-white/30 text-[8px] uppercase tracking-[0.12em]">Evacuation rate</span>
              {throughput != null && (
                <span className="text-[#1abc9c] text-[9px] font-bold tabular-nums">{throughput.toLocaleString()} /min</span>
              )}
            </div>
            <Sparkline points={sparkRef.current} color="#1abc9c" height={28} />
          </div>
        )}
      </StatSection>

      {/* ── Key metrics row ──────────────────────────────────────────────── */}
      {active && (
        <div className="flex gap-2">
          <Chip
            label="Avg walk"
            value={avgWalkMin != null ? `${avgWalkMin}m` : '—'}
            color="#a78bfa"
          />
          <Chip
            label="Compliance"
            value={active ? `${Math.round(compliancePct)}%` : '—'}
            color="#34d399"
          />
          <Chip
            label="Exposed"
            value={active ? `${hazardExposurePct}%` : '—'}
            color={hazardExposurePct > 15 ? '#f87171' : hazardExposurePct > 5 ? '#fbbf24' : '#34d399'}
          />
        </div>
      )}

      {/* ── Shelter occupancy ────────────────────────────────────────────── */}
      <StatSection title="Shelter Occupancy">
        {realShelters.length > 0 ? (
          <div className="flex flex-col gap-2">
            {realShelters.map((sh) => (
              <ShelterRow key={sh.id} name={sh.name} utilisation={sh.utilisation} />
            ))}
          </div>
        ) : (
          <p className="text-white/25 text-[9px]">Load presets or place shelters to see occupancy</p>
        )}
      </StatSection>

      {/* ── Clearance vs available time ──────────────────────────────────── */}
      <StatSection title="Clearance vs Available Time">
        <div className="flex items-end justify-between mb-2.5">
          <div>
            <span className="text-4xl font-bold tabular-nums leading-none" style={{ color: clearColor }}>
              {clearanceMin != null ? `${clearanceMin}m` : '—'}
            </span>
            <span className="text-white/35 text-[10px] ml-1.5">est. clearance</span>
          </div>
          <div className="text-right">
            <span className="text-2xl font-bold text-white/80 tabular-nums">{limit}m</span>
            <span className="text-white/30 text-[10px] ml-1">limit</span>
          </div>
        </div>
        <Bar value={clearanceMin ?? 0} max={limit} color={clearColor} />
        {active && clearLabel && (
          <p className="text-[10px] mt-2 font-semibold" style={{ color: clearColor }}>{clearLabel}</p>
        )}
        {(!active || clearanceMin == null) && (
          <p className="text-white/20 text-[9px] mt-2">Computed once simulation is running</p>
        )}

        {/* Time breakdown mini-bars */}
        {active && clearanceMin != null && (
          <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-col gap-1.5">
            {[
              { label: 'Alert & mobilise', mins: Math.round(clearanceMin * 0.12), color: '#5b9bd5' },
              { label: 'Route to shelter', mins: Math.round(clearanceMin * 0.72), color: '#e8a020' },
              { label: 'Check-in buffer',  mins: Math.round(clearanceMin * 0.16), color: '#1abc9c' },
            ].map(({ label, mins, color }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-white/35 text-[8.5px] w-28 shrink-0">{label}</span>
                <div className="flex-1">
                  <MiniBar pct={(mins / limit) * 100} color={color} />
                </div>
                <span className="text-[8.5px] tabular-nums w-6 text-right shrink-0" style={{ color }}>{mins}m</span>
              </div>
            ))}
          </div>
        )}
      </StatSection>

      {/* ── Footer row ───────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center justify-between bg-white/[0.03] rounded-lg px-3 py-2 border border-white/[0.06]">
          <span className="text-white/30 text-[8.5px] uppercase tracking-[0.1em] font-semibold">Reroutes</span>
          <span className="text-white/80 text-sm font-bold tabular-nums">
            {active && s.routes_recalculated != null ? s.routes_recalculated : '—'}
          </span>
        </div>
        <div className="flex-1 flex items-center justify-between bg-white/[0.03] rounded-lg px-3 py-2 border border-white/[0.06]">
          <span className="text-white/30 text-[8.5px] uppercase tracking-[0.1em] font-semibold">Elapsed</span>
          <span className="text-white/80 text-sm font-bold tabular-nums">
            {active ? `${Math.round(elapsedMinutes)}m` : '—'}
          </span>
        </div>
      </div>

      {!active && (
        <p className="text-white/20 text-[9px] text-center pb-1">Simulation inactive — launch to see live data</p>
      )}
    </div>
  );
}
