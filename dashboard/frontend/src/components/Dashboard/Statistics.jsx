/**
 * Statistics panel — circular evacuation ring + 3 stat tiles.
 *
 * Props:
 *   stats   — { evacuating, reached_safety, routes_recalculated, clearance_minutes }
 *   total   — total citizen count (for % computation)
 *   active  — whether a simulation is running (dims panel when false)
 */
import { useRef } from 'react';

const RADIUS = 44;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ProgressRing({ pct }) {
  const offset = CIRCUMFERENCE * (1 - pct / 100);
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" className="rotate-[-90deg]">
      <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="#374151" strokeWidth="10" />
      <circle
        cx="60" cy="60" r={RADIUS}
        fill="none"
        stroke="#1abc9c"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
    </svg>
  );
}

export default function Statistics({ stats, total, active }) {
  // Keep last known stats so the panel never flashes to zero during WS gaps or reset
  const lastStatsRef = useRef({});
  if (stats && Object.keys(stats).length > 0) {
    lastStatsRef.current = stats;
  }
  const s = active ? lastStatsRef.current : (stats || {});
  const totalCitizens = total || (s.evacuating || 0) + (s.reached_safety || 0);
  const reachedPct = totalCitizens > 0
    ? Math.round(((s.reached_safety || 0) / totalCitizens) * 100)
    : 0;

  const tiles = [
    {
      label: 'Evacuating',
      value: active && s.evacuating != null ? s.evacuating : '—',
      accent: 'text-[#e8a020]',
      border: 'border-[#e8a020]/20',
    },
    {
      label: 'Reached Safety',
      value: active && s.reached_safety != null ? s.reached_safety : '—',
      accent: 'text-[#1abc9c]',
      border: 'border-[#1abc9c]/20',
    },
    {
      label: 'Est. Clearance',
      value: active && s.clearance_minutes ? `${Math.round(s.clearance_minutes)}m` : '—',
      accent: 'text-[#f0f0f0]',
      border: 'border-white/[0.08]',
    },
  ];

  return (
    <div className={`rounded-xl bg-[#0d1424] border border-white/[0.08] p-4 transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-50'}`}>
      <p className="text-[#a0a0a0] text-[10px] uppercase tracking-[0.18em] mb-3 font-bold">
        Live Statistics
      </p>

      {/* Circular progress ring */}
      <div className="flex flex-col items-center mb-4">
        <div className="relative inline-flex items-center justify-center">
          <ProgressRing pct={active ? reachedPct : 0} />
          <div className="absolute flex flex-col items-center">
            <span className="text-2xl font-bold text-[#f0f0f0] leading-none tabular-nums">
              {active ? `${reachedPct}%` : '—'}
            </span>
            <span className="text-[10px] text-[#a0a0a0] mt-0.5 leading-none">safe</span>
          </div>
        </div>
        <p className="text-[#a0a0a0] text-[11px] mt-1">
          {active ? (
            <>
              <span className="text-[#1abc9c] font-semibold">{s.reached_safety ?? 0}</span>
              {' / '}
              <span className="text-[#f0f0f0]">{totalCitizens}</span>
              {' reached safety'}
            </>
          ) : (
            <span className="text-[#a0a0a0]/40">No active simulation</span>
          )}
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(({ label, value, accent, border }) => (
          <div
            key={label}
            className={`rounded-lg bg-white/[0.03] border ${border} p-2.5 flex flex-col items-center`}
          >
            <span className={`text-xl font-bold leading-none tabular-nums ${accent}`}>{value}</span>
            <span className="text-[#a0a0a0]/60 text-[10px] mt-1 text-center leading-tight">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
