import { useState, useEffect, useRef, useCallback } from 'react';
import CitizenMap from '@/components/Map/CitizenMap';
import RouteInstruction from '@/components/Citizen/RouteInstruction';
import StatusPill from '@/components/Citizen/StatusPill';
import { joinCitizen, getCitizenState } from '@/services/api';

const POLL_INTERVAL_MS = 5000;

/**
 * Citizen page — full-screen, mobile-first.
 *
 * States:
 *   idle      → location share button
 *   locating  → waiting for browser geolocation
 *   joining   → POST /citizen/join in flight
 *   active    → showing map + route, polling every 5 s
 *   error     → error message with retry button
 */
export default function Citizen() {
  const [phase, setPhase] = useState('idle');        // idle | locating | joining | active | error
  const [errorMsg, setErrorMsg] = useState('');
  const [position, setPosition] = useState(null);    // { lat, lon }
  const [citizenId, setCitizenId] = useState(null);
  const [routeData, setRouteData] = useState(null);  // RouteResponse from join + state updates
  const [pillStatus, setPillStatus] = useState('waiting');
  const prevVersionRef = useRef(null);
  const pollRef = useRef(null);

  const showError = (msg) => {
    setPhase('error');
    setErrorMsg(msg);
  };

  // --- Geolocation → join scenario ---
  const handleShare = useCallback(() => {
    if (!navigator.geolocation) {
      showError('Geolocation is not supported by this browser.');
      return;
    }
    setPhase('locating');

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setPosition({ lat, lon });
        setPhase('joining');

        try {
          const data = await joinCitizen(lat, lon);
          setCitizenId(data.citizen_id);
          setRouteData(data);
          prevVersionRef.current = data.route_version ?? 0;
          setPillStatus(data.status === 'reached_safety' ? 'reached' : 'safe');
          setPhase('active');
        } catch (e) {
          showError(e.message || 'Could not join evacuation. Is the coordinator scenario active?');
        }
      },
      (err) => {
        const msgs = {
          1: 'Location permission denied. Please allow location access and try again.',
          2: 'Location unavailable. Check GPS signal.',
          3: 'Location request timed out. Try again.',
        };
        showError(msgs[err.code] || 'Could not get location.');
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  }, []);

  // --- 5-second polling while active ---
  useEffect(() => {
    if (phase !== 'active' || !citizenId) return;

    const poll = async () => {
      try {
        const state = await getCitizenState(citizenId);
        const newVersion = state.route_version ?? 0;

        // Route was recalculated — flash "Route Updated" for 3 s
        if (prevVersionRef.current !== null && newVersion > prevVersionRef.current) {
          setPillStatus('updated');
          setTimeout(() => {
            setPillStatus(state.status === 'reached_safety' ? 'reached' : 'safe');
          }, 3000);
        } else {
          setPillStatus(state.status === 'reached_safety' ? 'reached' : 'safe');
        }

        prevVersionRef.current = newVersion;
        setRouteData((prev) => ({ ...prev, ...state }));
      } catch {
        // Network blip — silently retry next poll
      }
    };

    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [phase, citizenId]);

  // ---- Render ----

  if (phase === 'active' && routeData && position) {
    return (
      <div className="flex flex-col h-screen bg-navy-900 font-sans">
        {/* Map */}
        <div className="flex-1 min-h-0">
          <CitizenMap
            citizenLat={position.lat}
            citizenLon={position.lon}
            routeGeojson={routeData.route_geojson}
            destinationName={routeData.destination_name}
          />
        </div>

        {/* Instruction panel */}
        <div className="shrink-0 bg-navy-800 border-t border-navy-700">
          <div className="flex justify-center pt-4 pb-2">
            <StatusPill status={pillStatus} />
          </div>
          <RouteInstruction
            destinationName={routeData.destination_name}
            distanceKm={routeData.distance_km}
            timeMinutes={routeData.time_minutes}
            routeGeojson={routeData.route_geojson}
            citizenLat={position.lat}
            citizenLon={position.lon}
          />
          <div className="text-center text-xs text-gray-600 pb-4">
            Updating every 5 seconds · RouteOut
          </div>
        </div>
      </div>
    );
  }

  // Idle / loading / error screen
  return (
    <div className="min-h-screen bg-navy-900 flex flex-col items-center justify-center px-6 font-sans">
      {/* Wordmark */}
      <div className="mb-10 text-center">
        <h1 className="text-white font-bold text-4xl tracking-tight mb-1">
          Route<span className="text-route">Out</span>
        </h1>
        <p className="text-gray-400 text-sm">
          Emergency Evacuation Intelligence
        </p>
      </div>

      {phase === 'idle' && (
        <>
          <button
            onClick={handleShare}
            className="bg-route hover:bg-teal-500 text-white font-semibold text-base py-4 px-8 rounded-xl transition-colors w-full max-w-xs shadow-lg"
          >
            Share my location to receive evacuation route
          </button>
          <p className="text-gray-500 text-xs text-center mt-4 max-w-xs">
            Your location is used only to calculate your personal evacuation route
            and is not stored.
          </p>
        </>
      )}

      {phase === 'locating' && (
        <div className="flex flex-col items-center gap-4">
          <Spinner />
          <p className="text-gray-300 text-sm">Getting your location…</p>
        </div>
      )}

      {phase === 'joining' && (
        <div className="flex flex-col items-center gap-4">
          <Spinner />
          <p className="text-gray-300 text-sm">Calculating your evacuation route…</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-col items-center gap-5 max-w-xs w-full">
          <div className="bg-red-900/40 border border-red-700 rounded-xl p-4 text-center">
            <p className="text-red-300 text-sm leading-relaxed">{errorMsg}</p>
          </div>
          <button
            onClick={() => setPhase('idle')}
            className="text-route text-sm underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Status pill at bottom when waiting */}
      {phase === 'idle' && (
        <div className="mt-8">
          <StatusPill status="waiting" />
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-10 h-10 border-4 border-navy-700 border-t-route rounded-full animate-spin" />
  );
}
