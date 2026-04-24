import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import CoordinatorMap from '@/components/Map/CoordinatorMap';
import MapErrorBoundary from '@/components/Map/MapErrorBoundary';
import ControlPanel from '@/components/Dashboard/ControlPanel';
import Statistics from '@/components/Dashboard/Statistics';
import LLMLog from '@/components/Dashboard/LLMLog';
import NotificationFeed from '@/components/Dashboard/NotificationFeed';
import TimeSlider from '@/components/Dashboard/TimeSlider';
import EvacuationChart from '@/components/Dashboard/EvacuationChart';

/**
 * Coordinator dashboard.
 *
 * Layout: full-screen map with a floating glass panel on the right.
 *
 * Responsibilities handled here (not in child components):
 *   - Flash logic: route_version bump → citizen in flashingCitizens set for 2 s
 *   - History snapshot: appended each WS tick for EvacuationChart
 *   - Error toast auto-clear
 */
export default function Coordinator() {
  const { data: wsData, connected } = useWebSocket();
  const [flashingCitizens, setFlashingCitizens] = useState(new Set());
  const [error, setError] = useState(null);
  const prevVersionsRef = useRef({});

  // Chart snapshot — new object reference each tick so EvacuationChart detects change
  const [chartSnapshot, setChartSnapshot] = useState(null);

  // ── Route flash detection ────────────────────────────────────────────────
  useEffect(() => {
    if (!wsData?.routes?.features) return;

    const newlyFlashing = [];
    wsData.routes.features.forEach((f) => {
      const { citizen_id, route_version } = f.properties || {};
      if (citizen_id == null) return;
      const prev = prevVersionsRef.current[citizen_id];
      if (prev !== undefined && route_version > prev) {
        newlyFlashing.push(citizen_id);
      }
      prevVersionsRef.current[citizen_id] = route_version;
    });

    if (newlyFlashing.length > 0) {
      setFlashingCitizens((s) => new Set([...s, ...newlyFlashing]));
      const ids = [...newlyFlashing];
      setTimeout(() => {
        setFlashingCitizens((s) => {
          const next = new Set(s);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }, 2000);
    }
  }, [wsData]);

  // ── Build chart snapshot each tick ──────────────────────────────────────
  useEffect(() => {
    if (!wsData?.scenario?.active) return;
    const stats = wsData.statistics || {};
    const total = (stats.evacuating ?? 0) + (stats.reached_safety ?? 0);
    if (total === 0) return;
    setChartSnapshot({
      elapsed: Math.round(wsData.scenario.elapsed_minutes ?? 0),
      reached: stats.reached_safety ?? 0,
      evacuating: stats.evacuating ?? 0,
      total,
    });
  }, [wsData]);

  // ── Error auto-clear ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const scenario = wsData?.scenario || {};
  const stats = wsData?.statistics || {};
  const totalCitizens = (wsData?.citizens?.features || []).length;

  return (
    <div className="relative w-screen h-screen overflow-hidden font-sans">

      {/* ── Full-screen map ── */}
      <MapErrorBoundary>
        <CoordinatorMap wsData={wsData} flashingSet={flashingCitizens} />
      </MapErrorBoundary>

      {/* ── Connection badge (top-left) ── */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-1.5 bg-gray-900/80 backdrop-blur-sm rounded-full px-3 py-1.5 border border-gray-700/60 shadow">
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`}
        />
        <span className="text-xs text-gray-300">
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      {/* ── Elapsed time badge (top-center) ── */}
      {scenario.active && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-gray-900/80 backdrop-blur-sm rounded-full px-4 py-1.5 border border-gray-700/60 shadow">
          <span className="text-xs text-gray-300">
            T+{Math.round(scenario.elapsed_minutes ?? 0)} min simulated
          </span>
        </div>
      )}

      {/* ── Error toast ── */}
      {error && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-red-950/90 border border-red-700 text-red-300 text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-sm text-center">
          {error}
        </div>
      )}

      {/* ── Safe zone legend (bottom-left) ── */}
      <div className="absolute bottom-4 left-4 z-20 bg-gray-900/80 backdrop-blur-sm rounded-xl px-3 py-2 border border-gray-700/60 shadow">
        <p className="text-gray-500 text-[9px] uppercase tracking-widest mb-1.5">Safe Zone Status</p>
        <div className="flex flex-col gap-1">
          {[
            { color: 'bg-safe', label: 'Available (<50%)' },
            { color: 'bg-citizen', label: 'Filling (50–80%)' },
            { color: 'bg-danger', label: 'Near Full (>80%)' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${color} opacity-80`} />
              <span className="text-gray-400 text-[10px]">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Floating right panel ── */}
      <div
        className="absolute top-4 right-4 bottom-4 z-20 w-[360px] flex flex-col gap-3 overflow-y-auto rounded-2xl bg-gray-900/90 backdrop-blur-md border border-gray-700/50 shadow-2xl p-4"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#374151 transparent' }}
      >
        {/* Wordmark */}
        <div className="flex items-center justify-between pb-1 border-b border-gray-700/50">
          <h1 className="text-white font-bold text-lg tracking-tight">
            Route<span className="text-emerald-400">Out</span>
          </h1>
          <span className="text-gray-500 text-xs font-medium uppercase tracking-wider">Coordinator</span>
        </div>

        <ControlPanel
          scenarioActive={scenario.active}
          scenarioId={scenario.scenario_id}
          weather={wsData?.weather}
          onError={setError}
        />

        {/* Time slider — only visible when scenario is active */}
        {scenario.active && (
          <TimeSlider
            elapsed={Math.round(scenario.elapsed_minutes ?? 0)}
            disabled={!scenario.active}
            onError={setError}
          />
        )}

        <Statistics stats={stats} total={totalCitizens} />

        {/* Evacuation chart — shows once we have data */}
        {chartSnapshot && <EvacuationChart snapshot={chartSnapshot} />}

        {wsData?.llm_log && <LLMLog log={wsData.llm_log} />}

        <NotificationFeed notifications={wsData?.notifications} />
      </div>
    </div>
  );
}
