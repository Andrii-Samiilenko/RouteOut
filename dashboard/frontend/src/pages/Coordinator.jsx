import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import CoordinatorMap from '@/components/Map/CoordinatorMap';
import ControlPanel from '@/components/Dashboard/ControlPanel';

/**
 * Supervisor dashboard.
 *
 * Owns draw state (drawMode, pendingShelters, zonePolygon) and passes it
 * down to both the map (handles interactions) and the control panel
 * (renders summary + fires the launch request).
 */
export default function Coordinator() {
  const { data: wsData, connected } = useWebSocket();
  const [error, setError] = useState(null);

  const [drawMode, setDrawMode] = useState(null);          // 'polygon' | 'shelter' | null
  const [zonePolygon, setZonePolygon] = useState(null);    // GeoJSON Polygon or null
  const [pendingShelters, setPendingShelters] = useState([]); // ShelterMarker[]
  const [shelterDialog, setShelterDialog] = useState(null);   // {lat,lon} or null

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const simulation = wsData?.simulation || {};

  function handleClearDraft() {
    setZonePolygon(null);
    setPendingShelters([]);
    setDrawMode(null);
    setShelterDialog(null);
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
        id: `s-${Date.now()}`,
        name: name || 'Shelter',
        lat: shelterDialog.lat,
        lon: shelterDialog.lon,
        capacity: Number(capacity),
        shelter_type,
      },
    ]);
    setShelterDialog(null);
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden font-sans">

      <CoordinatorMap
        wsData={wsData}
        drawMode={drawMode}
        pendingShelters={pendingShelters}
        zonePolygon={zonePolygon}
        onMapClick={handleMapClick}
        onPolygonComplete={handlePolygonComplete}
      />

      {/* Connection badge */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-1.5 bg-gray-900/80 backdrop-blur-sm rounded-full px-3 py-1.5 border border-gray-700/60 shadow">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
        <span className="text-xs text-gray-300">{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>

      {/* Draw mode hint */}
      {drawMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-gray-900/90 backdrop-blur-sm rounded-full px-4 py-1.5 border border-emerald-700/60 shadow pointer-events-none">
          <span className="text-xs text-emerald-300 font-medium">
            {drawMode === 'polygon'
              ? 'Click to add vertices — double-click to close the zone'
              : 'Click anywhere on the map to place a shelter'}
          </span>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-red-950/90 border border-red-700 text-red-300 text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-sm text-center">
          {error}
        </div>
      )}

      {/* Floating right panel */}
      <div
        className="absolute top-4 right-4 bottom-4 z-20 w-[360px] flex flex-col gap-3 overflow-y-auto rounded-2xl bg-gray-900/90 backdrop-blur-md border border-gray-700/50 shadow-2xl p-4"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#374151 transparent' }}
      >
        <div className="flex items-center justify-between pb-1 border-b border-gray-700/50">
          <h1 className="text-white font-bold text-lg tracking-tight">
            Route<span className="text-emerald-400">Out</span>
          </h1>
          <span className="text-gray-500 text-xs font-medium uppercase tracking-wider">Supervisor</span>
        </div>

        <ControlPanel
          simulationActive={simulation.active}
          notifOnline={wsData?.notification_service_online ?? false}
          drawMode={drawMode}
          onDrawModeChange={setDrawMode}
          pendingShelters={pendingShelters}
          zonePolygon={zonePolygon}
          onClearDraft={handleClearDraft}
          onError={setError}
        />
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

function ShelterDialog({ onConfirm, onCancel }) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState(200);
  const [shelterType, setShelterType] = useState('shelter');

  const types = [
    { value: 'shelter',  label: '⛺ Shelter' },
    { value: 'hospital', label: '🏥 Hospital' },
    { value: 'assembly', label: '🏛️ Assembly' },
  ];

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-80 shadow-2xl">
        <h3 className="text-white font-bold text-sm mb-4">Add Shelter Marker</h3>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-gray-400 text-xs mb-1 block">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Palau Sant Jordi"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="text-gray-400 text-xs mb-1 block">Type</label>
            <div className="flex gap-1.5">
              {types.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setShelterType(value)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all
                    ${shelterType === value
                      ? 'bg-emerald-700 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-gray-400 text-xs">Capacity</label>
              <span className="text-white text-xs font-semibold">{capacity}</span>
            </div>
            <input
              type="range" min={50} max={2000} step={50} value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
              className="w-full accent-emerald-400"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={() => onConfirm({ name: name || 'Shelter', capacity, shelter_type: shelterType })}
            className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            Place
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
