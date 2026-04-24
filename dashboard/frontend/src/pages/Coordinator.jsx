import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import CoordinatorMap from '@/components/Map/CoordinatorMap';
import ControlPanel from '@/components/Dashboard/ControlPanel';
import Statistics from '@/components/Dashboard/Statistics';
import LLMLog from '@/components/Dashboard/LLMLog';
import NotificationFeed from '@/components/Dashboard/NotificationFeed';

/**
 * Coordinator dashboard.
 *
 * Layout: full-screen map with a floating glass panel on the right.
 *
 * Flash logic:
 *   When a route's route_version increases, add citizen_id to flashingCitizens
 *   for 2 seconds so the map renders it red then reverts to green.
 */
export default function Coordinator() {
  const { data: wsData, connected } = useWebSocket();
  const [flashingCitizens, setFlashingCitizens] = useState(new Set());
  const [error, setError] = useState(null);
  const prevVersionsRef = useRef({});

  // Detect route_version bumps → flash red for 2 s
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

  // Auto-clear error after 5 s
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const scenario = wsData?.scenario || {};
  const stats = wsData?.statistics || {};
  const totalCitizens = Object.values(wsData?.citizens?.features || []).length;

  return (
    <div className="relative w-screen h-screen overflow-hidden font-sans">

      {/* ── Full-screen map ── */}
      <CoordinatorMap wsData={wsData} flashingSet={flashingCitizens} />

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

        <Statistics stats={stats} total={totalCitizens} />

        {wsData?.llm_log && <LLMLog log={wsData.llm_log} />}

        <NotificationFeed notifications={wsData?.notifications} />
      </div>
    </div>
  );
}
