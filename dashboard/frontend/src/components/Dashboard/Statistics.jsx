/**
 * Statistics panel — circular evacuation ring + 3 stat tiles.
 *
 * Props:
 *   stats   — { evacuating, reached_safety, routes_recalculated, clearance_minutes }
 *   total   — total citizen count (for % computation)
 */

const RADIUS = 44;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ProgressRing({ pct }) {
  const offset = CIRCUMFERENCE * (1 - pct / 100);
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" className="rotate-[-90deg]">
      {/* Track */}
      <circle
        cx="60" cy="60" r={RADIUS}
        fill="none"
        stroke="#374151"
        strokeWidth="10"
      />
      {/* Progress arc */}
      <circle
        cx="60" cy="60" r={RADIUS}
        fill="none"
        stroke="#22C55E"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
    </svg>
  );
}

export default function Statistics({ stats, total }) {
  const s = stats || {};
  const totalCitizens = total || (s.evacuating || 0) + (s.reached_safety || 0);
  const reachedPct = totalCitizens > 0
    ? Math.round(((s.reached_safety || 0) / totalCitizens) * 100)
    : 0;

  const tiles = [
    {
      label: 'Evacuating',
      value: s.evacuating ?? '—',
      accent: 'text-amber-400',
      border: 'border-amber-900/40',
    },
    {
      label: 'Reached Safety',
      value: s.reached_safety ?? '—',
      accent: 'text-emerald-400',
      border: 'border-emerald-900/40',
    },
    {
      label: 'Est. Clearance',
      value: s.clearance_minutes ? `${Math.round(s.clearance_minutes)}m` : '—',
      accent: 'text-gray-200',
      border: 'border-gray-700/40',
    },
  ];

  return (
    <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4">
      <p className="text-gray-400 text-[10px] uppercase tracking-widest mb-3 font-medium">
        Live Statistics
      </p>

      {/* Circular progress ring */}
      <div className="flex flex-col items-center mb-4">
        <div className="relative inline-flex items-center justify-center">
          <ProgressRing pct={reachedPct} />
          <div className="absolute flex flex-col items-center">
            <span className="text-2xl font-bold text-white leading-none">{reachedPct}%</span>
            <span className="text-[10px] text-gray-400 mt-0.5 leading-none">safe</span>
          </div>
        </div>
        <p className="text-gray-400 text-xs mt-1">
          <span className="text-green-400 font-semibold">{s.reached_safety ?? 0}</span>
          {' / '}
          <span className="text-gray-300">{totalCitizens}</span>
          {' reached safety'}
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(({ label, value, accent, border }) => (
          <div
            key={label}
            className={`rounded-lg bg-gray-900/60 border ${border} p-2.5 flex flex-col items-center`}
          >
            <span className={`text-xl font-bold leading-none ${accent}`}>{value}</span>
            <span className="text-gray-500 text-[10px] mt-1 text-center leading-tight">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
