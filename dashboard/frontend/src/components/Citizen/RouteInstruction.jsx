/**
 * Route instruction shown on the citizen page — large, readable on a phone.
 *
 * Computes a cardinal bearing from citizen position to the first route
 * waypoint so we can say "Head northwest toward …".
 *
 * Props:
 *   destinationName — string
 *   distanceKm      — number
 *   timeMinutes     — number
 *   routeGeojson    — GeoJSON LineString feature (may be null)
 *   citizenLat      — number
 *   citizenLon      — number
 */
export default function RouteInstruction({
  destinationName,
  distanceKm,
  timeMinutes,
  routeGeojson,
  citizenLat,
  citizenLon,
}) {
  const bearing = _initialBearing(routeGeojson, citizenLat, citizenLon);
  const direction = bearing != null ? _bearingToText(bearing) : null;

  return (
    <div className="px-6 py-4 text-center">
      {direction && (
        <div className="text-gray-400 text-sm mb-1">Head {direction}</div>
      )}
      <div className="text-white text-xl font-semibold leading-snug mb-3">
        toward{' '}
        <span className="text-safe">{destinationName || 'Safe Zone'}</span>
      </div>
      <div className="flex justify-center items-center gap-6 text-sm">
        <div className="text-center">
          <div className="text-white font-bold text-lg">
            {distanceKm != null ? distanceKm.toFixed(1) : '—'} km
          </div>
          <div className="text-gray-500 text-xs">distance</div>
        </div>
        <div className="w-px h-8 bg-gray-700" />
        <div className="text-center">
          <div className="text-white font-bold text-lg">
            ~{timeMinutes != null ? Math.round(timeMinutes) : '—'} min
          </div>
          <div className="text-gray-500 text-xs">on foot</div>
        </div>
      </div>
    </div>
  );
}

// --- helpers ---

function _initialBearing(routeGeojson, fromLat, fromLon) {
  const coords = routeGeojson?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;

  // Use the 5th waypoint to smooth out immediate turns, fallback to 2nd
  const [toLon, toLat] = coords[Math.min(4, coords.length - 1)];
  return _bearing(fromLat, fromLon, toLat, toLon);
}

function _bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const x = Math.sin(dLon) * Math.cos(toRad(lat2));
  const y =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function _bearingToText(deg) {
  const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
