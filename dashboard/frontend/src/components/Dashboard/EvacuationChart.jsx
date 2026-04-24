import { useEffect, useRef } from 'react';

/**
 * EvacuationChart — pure-SVG sparkline tracking evacuation progress over time.
 *
 * Stores up to MAX_POINTS history samples passed in via `snapshot` prop.
 * Parent must pass a new snapshot object reference each time data changes —
 * the hook dedups by elapsed_minutes so duplicate ticks are ignored.
 *
 * Props:
 *   snapshot  — { elapsed: number, reached: number, evacuating: number, total: number }
 */

const MAX_POINTS = 24;  // 24 ticks × 5 min = 2 h
const W = 300;
const H = 72;
const PAD = { top: 8, right: 8, bottom: 16, left: 28 };

function scaleX(i, len) {
  const chartW = W - PAD.left - PAD.right;
  return PAD.left + (len <= 1 ? chartW / 2 : (i / (len - 1)) * chartW);
}

function scaleY(val, max) {
  const chartH = H - PAD.top - PAD.bottom;
  if (max === 0) return PAD.top + chartH;
  return PAD.top + chartH - (val / max) * chartH;
}

function buildPath(points, xFn, yFn) {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFn(i)} ${yFn(p)}`)
    .join(' ');
}

function buildArea(points, xFn, yFn, bottom) {
  if (points.length === 0) return '';
  const line = buildPath(points, xFn, yFn);
  const last = `L ${xFn(points.length - 1)} ${bottom} L ${xFn(0)} ${bottom} Z`;
  return `${line} ${last}`;
}

export default function EvacuationChart({ snapshot }) {
  const historyRef = useRef([]);

  useEffect(() => {
    if (!snapshot || snapshot.total === 0) return;

    const hist = historyRef.current;
    // Deduplicate by elapsed time
    if (hist.length > 0 && hist[hist.length - 1].elapsed === snapshot.elapsed) return;

    hist.push({ ...snapshot });
    if (hist.length > MAX_POINTS) hist.splice(0, hist.length - MAX_POINTS);
  }, [snapshot]);

  const hist = historyRef.current;
  if (hist.length < 2) {
    return (
      <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4">
        <p className="text-gray-400 text-[10px] uppercase tracking-widest mb-2 font-medium">
          Evacuation Progress
        </p>
        <p className="text-gray-600 text-xs text-center py-3">Waiting for data…</p>
      </div>
    );
  }

  const maxTotal = Math.max(...hist.map((p) => p.total), 1);
  const n = hist.length;

  const xFn = (i) => scaleX(i, n);
  const bottom = H - PAD.bottom;

  const reachedPoints = hist.map((p) => p.reached);
  const evacuatingPoints = hist.map((p) => p.evacuating);
  const totalPoints = hist.map((p) => p.total);

  const yReached = (v) => scaleY(v, maxTotal);
  const yEvac = (v) => scaleY(v, maxTotal);

  const reachedPath = buildPath(reachedPoints, xFn, yReached);
  const reachedArea = buildArea(reachedPoints, xFn, yReached, bottom);
  const evacPath = buildPath(evacuatingPoints, xFn, yEvac);

  const latest = hist[hist.length - 1];
  const reachedPct = latest.total > 0 ? Math.round((latest.reached / latest.total) * 100) : 0;

  // Y-axis label values
  const yLabels = [0, Math.round(maxTotal / 2), maxTotal];

  return (
    <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-gray-400 text-[10px] uppercase tracking-widest font-medium">
          Evacuation Progress
        </p>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-safe inline-block" />
            <span className="text-gray-400">Safe</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-citizen inline-block" />
            <span className="text-gray-400">Evacuating</span>
          </span>
        </div>
      </div>

      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        {/* Y-axis grid lines */}
        {yLabels.map((v) => {
          const y = scaleY(v, maxTotal);
          return (
            <g key={v}>
              <line
                x1={PAD.left} y1={y}
                x2={W - PAD.right} y2={y}
                stroke="#374151" strokeWidth="0.5" strokeDasharray="3 3"
              />
              <text
                x={PAD.left - 4} y={y}
                textAnchor="end" dominantBaseline="middle"
                fontSize="7" fill="#4B5563"
              >
                {v}
              </text>
            </g>
          );
        })}

        {/* X-axis */}
        <line
          x1={PAD.left} y1={bottom}
          x2={W - PAD.right} y2={bottom}
          stroke="#374151" strokeWidth="0.5"
        />

        {/* Evacuating line (amber, dashed, no fill) */}
        <path
          d={evacPath}
          fill="none"
          stroke="#F39C12"
          strokeWidth="1.5"
          strokeDasharray="4 2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.7"
        />

        {/* Reached safety area fill */}
        <path
          d={reachedArea}
          fill="#27AE60"
          opacity="0.15"
        />
        {/* Reached safety line */}
        <path
          d={reachedPath}
          fill="none"
          stroke="#27AE60"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Latest value dot — reached */}
        {hist.length > 0 && (
          <circle
            cx={xFn(n - 1)}
            cy={yReached(latest.reached)}
            r="3"
            fill="#27AE60"
            stroke="#0A1628"
            strokeWidth="1.5"
          />
        )}
      </svg>

      {/* Summary footer */}
      <div className="flex justify-between items-center mt-1 text-[10px] text-gray-500">
        <span>T+{hist[0]?.elapsed ?? 0}m</span>
        <span className="text-safe font-semibold">{reachedPct}% safe</span>
        <span>T+{latest.elapsed}m</span>
      </div>
    </div>
  );
}
