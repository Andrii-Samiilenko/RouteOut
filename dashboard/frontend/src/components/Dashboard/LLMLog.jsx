import { useState } from 'react';

/**
 * LLM Synthesis Log panel.
 * Visible for 10 seconds after scenario trigger (TTL enforced by backend — this
 * component just renders when the WS payload includes a non-null llm_log).
 *
 * Props:
 *   log — LLMLogEntry { inputs, hazard_event, provider, latency_ms }
 */
export default function LLMLog({ log }) {
  const [expanded, setExpanded] = useState(false);

  if (!log) return null;

  const { inputs, hazard_event: he, provider, latency_ms } = log;

  return (
    <div className="rounded-xl bg-gray-800/60 border border-emerald-800/50 overflow-hidden animate-pulse-once">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-teal-900/30 border-b border-teal-800/40">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-route animate-pulse" />
          <span className="text-route text-xs font-semibold uppercase tracking-widest">
            AI Hazard Synthesis
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-xs">{Math.round(latency_ms)} ms</span>
          <span className="text-gray-500 text-xs capitalize">{provider}</span>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-gray-400 hover:text-white text-xs transition-colors"
          >
            {expanded ? 'less' : 'more'}
          </button>
        </div>
      </div>

      {/* Compact output — always visible */}
      <div className="px-4 py-3">
        <div className="text-gray-400 text-xs mb-1 uppercase tracking-wide">
          3 inputs → HazardEvent
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {[
            ['Type', he.hazard_type],
            ['Origin', `${he.origin_lat.toFixed(4)}, ${he.origin_lon.toFixed(4)}`],
            ['Wind', `${Math.round(he.wind_speed_kmh)} km/h @ ${Math.round(he.wind_direction_deg)}°`],
            ['Spread', he.spread_rate],
            ['Confidence', `${Math.round(he.confidence * 100)}%`],
            ['Sources', he.sources_count],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-1.5">
              <span className="text-gray-500 shrink-0">{k}:</span>
              <span className="text-white font-medium truncate">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Expanded — shows raw inputs */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-700/50 pt-3 space-y-2">
          {Object.entries(inputs).map(([key, value]) => (
            <div key={key}>
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">
                {key}
              </div>
              <div className="text-gray-300 text-xs leading-relaxed bg-gray-900/60 rounded-lg p-2">
                {value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
