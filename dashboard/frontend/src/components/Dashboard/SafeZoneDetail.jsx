/**
 * SafeZoneDetail — floating detail card for a clicked safe zone.
 *
 * Rendered as an absolutely-positioned overlay over the map when a safe zone
 * is clicked. Position (px from top-left of viewport) is supplied by the
 * parent so it floats near the click point without overlapping the right panel.
 *
 * Props:
 *   zone      — { id, name, capacity, current_occupancy, utilisation, elevation_m }
 *   screenX   — viewport X in px (for positioning)
 *   screenY   — viewport Y in px
 *   onClose   — () => void
 */
export default function SafeZoneDetail({ zone, screenX, screenY, onClose }) {
  if (!zone) return null;

  const util = zone.utilisation ?? (zone.current_occupancy / Math.max(1, zone.capacity));
  const pct = Math.round(util * 100);
  const remaining = zone.capacity - zone.current_occupancy;

  const statusColor =
    util >= 0.8 ? 'text-red-400' :
    util >= 0.5 ? 'text-amber-400' :
    'text-safe';

  const statusLabel =
    util >= 0.8 ? 'Near Capacity' :
    util >= 0.5 ? 'Filling' :
    'Available';

  const barColor =
    util >= 0.8 ? 'bg-red-500' :
    util >= 0.5 ? 'bg-amber-500' :
    'bg-safe';

  // Keep card inside viewport: nudge left if too close to right edge
  const cardW = 220;
  const left = Math.min(screenX + 12, window.innerWidth - cardW - 16);
  const top = Math.max(16, screenY - 60);

  return (
    <div
      className="absolute z-30 pointer-events-auto"
      style={{ left, top, width: cardW }}
    >
      <div className="bg-gray-900/95 backdrop-blur-md border border-gray-700/70 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-3 py-2.5 bg-gray-800/60 border-b border-gray-700/50">
          <div>
            <p className="text-white text-xs font-semibold leading-tight">{zone.name}</p>
            <p className={`text-[10px] font-medium mt-0.5 ${statusColor}`}>{statusLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-xs ml-2 mt-0.5 leading-none transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Capacity bar */}
        <div className="px-3 pt-3 pb-1">
          <div className="flex justify-between text-[10px] text-gray-400 mb-1">
            <span>Capacity</span>
            <span className="text-white font-medium">
              {zone.current_occupancy.toLocaleString()} / {zone.capacity.toLocaleString()}
            </span>
          </div>
          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <p className="text-right text-[10px] text-gray-500 mt-0.5">{pct}% full</p>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-px bg-gray-700/40 border-t border-gray-700/40">
          {[
            ['Elevation', `${zone.elevation_m} m`],
            ['Available', remaining.toLocaleString()],
          ].map(([label, value]) => (
            <div key={label} className="bg-gray-900/80 px-3 py-2">
              <p className="text-[9px] text-gray-500 uppercase tracking-wide">{label}</p>
              <p className="text-white text-xs font-semibold mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Pointer triangle */}
      <div
        className="absolute -left-1.5 top-6 w-3 h-3 rotate-45 bg-gray-900/95 border-l border-b border-gray-700/70"
        style={{ marginTop: -6 }}
      />
    </div>
  );
}
