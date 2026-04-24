import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/**
 * Small map for the citizen page showing:
 *   - Citizen's current position (amber dot)
 *   - Route line to safe zone (green)
 *   - Destination safe zone marker
 *
 * Props:
 *   citizenLat, citizenLon — current GPS position
 *   routeGeojson           — GeoJSON LineString feature from the API
 *   destinationName        — name of the safe zone
 */
export default function CitizenMap({ citizenLat, citizenLon, routeGeojson, destinationName }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [citizenLon, citizenLat],
      zoom: 14,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: EMPTY_FC });
      map.addSource('citizen', { type: 'geojson', data: EMPTY_FC });
      map.addSource('destination', { type: 'geojson', data: EMPTY_FC });

      // Route line
      map.addLayer({
        id: 'route-shadow',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#000', 'line-width': 5, 'line-opacity': 0.3 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#1ABC9C', 'line-width': 3, 'line-opacity': 0.9 },
      });

      // Citizen dot
      map.addLayer({
        id: 'citizen-dot',
        type: 'circle',
        source: 'citizen',
        paint: {
          'circle-radius': 9,
          'circle-color': '#F39C12',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });

      // Destination marker
      map.addLayer({
        id: 'destination-dot',
        type: 'circle',
        source: 'destination',
        paint: {
          'circle-radius': 12,
          'circle-color': '#27AE60',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'destination-label',
        type: 'symbol',
        source: 'destination',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#27AE60',
          'text-halo-color': '#0A1628',
          'text-halo-width': 1.5,
        },
      });

      loadedRef.current = true;
    });

    return () => {
      loadedRef.current = false;
      map.remove();
    };
    // Only run once — updates handled in the next effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update sources whenever route or position changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    // Citizen position
    map.getSource('citizen')?.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [citizenLon, citizenLat] },
        properties: {},
      }],
    });

    if (routeGeojson) {
      // Route line
      const routeFC = routeGeojson.type === 'FeatureCollection'
        ? routeGeojson
        : { type: 'FeatureCollection', features: [routeGeojson] };
      map.getSource('route')?.setData(routeFC);

      // Destination = last coordinate of the route
      const coords = routeGeojson?.geometry?.coordinates || [];
      if (coords.length > 0) {
        const [dLon, dLat] = coords[coords.length - 1];
        map.getSource('destination')?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [dLon, dLat] },
            properties: { name: destinationName || 'Safe Zone' },
          }],
        });

        // Fit map to show the full route with padding
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        map.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 50, maxZoom: 16, duration: 800 }
        );
      }
    } else {
      map.getSource('route')?.setData(EMPTY_FC);
      map.getSource('destination')?.setData(EMPTY_FC);
    }
  }, [citizenLat, citizenLon, routeGeojson, destinationName]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
  );
}
