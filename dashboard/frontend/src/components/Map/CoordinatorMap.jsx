import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import SafeZoneDetail from '@/components/Dashboard/SafeZoneDetail';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const CENTER = [2.1686, 41.3874];
const ZOOM = 12;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

function toFC(geo) {
  if (!geo) return EMPTY_FC;
  if (geo.type === 'FeatureCollection') return geo;
  if (geo.type === 'Feature') return { type: 'FeatureCollection', features: [geo] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geo, properties: {} }] };
}

/**
 * CoordinatorMap — city-wide dark Mapbox map.
 *
 * Layer stack (bottom → top):
 *   ash-fill          charcoal burned-out area
 *   danger-outline    red perimeter (combined ash + fire front)
 *   fire-front-fill   bright orange active fire
 *   fire-front-glow   yellow outline glow
 *   predicted-outline dashed amber 15-min forecast
 *   routes-shadow     thin dark pass under routes
 *   routes-line       green evacuation routes (red flash on reroute)
 *   safe-zones-fill   circles scaled by capacity, colored by utilisation
 *   safe-zones-border ring border
 *   safe-zones-label  zone name label
 *   citizens-circle   amber dots (evacuating) / green (safe)
 *   citizens-real     judge's dot — DOM pulsing ring marker
 *
 * Safe zone color:
 *   utilisation < 50%  → green  (#27AE60)
 *   utilisation 50–80% → amber  (#F39C12)
 *   utilisation > 80%  → red    (#E74C3C)
 *
 * Safe zone radius scales linearly from capacity 1 000 → 5 000 (px 12 → 28).
 */
export default function CoordinatorMap({ wsData, flashingSet }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);
  const realMarkerRef = useRef(null);

  // Safe zone click popup state
  const [clickedZone, setClickedZone] = useState(null); // { props, screenX, screenY }

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: CENTER,
      zoom: ZOOM,
      attributionControl: true,
    });
    mapRef.current = map;

    map.on('load', () => {
      // ── Sources ─────────────────────────────────────────────────────────
      map.addSource('ash',        { type: 'geojson', data: EMPTY_FC });
      map.addSource('danger',     { type: 'geojson', data: EMPTY_FC });
      map.addSource('fire-front', { type: 'geojson', data: EMPTY_FC });
      map.addSource('predicted',  { type: 'geojson', data: EMPTY_FC });
      map.addSource('routes',     { type: 'geojson', data: EMPTY_FC });
      map.addSource('citizens',   { type: 'geojson', data: EMPTY_FC });
      map.addSource('safe-zones', { type: 'geojson', data: EMPTY_FC });

      // ── Ash ─────────────────────────────────────────────────────────────
      map.addLayer({
        id: 'ash-fill',
        type: 'fill',
        source: 'ash',
        paint: { 'fill-color': '#1a0d00', 'fill-opacity': 0.72 },
      });

      // ── Danger perimeter ────────────────────────────────────────────────
      map.addLayer({
        id: 'danger-outline',
        type: 'line',
        source: 'danger',
        paint: { 'line-color': '#C0392B', 'line-width': 1.5, 'line-opacity': 0.7 },
      });

      // ── Active fire front ────────────────────────────────────────────────
      map.addLayer({
        id: 'fire-front-fill',
        type: 'fill',
        source: 'fire-front',
        paint: { 'fill-color': '#FF4500', 'fill-opacity': 0.85 },
      });
      map.addLayer({
        id: 'fire-front-glow',
        type: 'line',
        source: 'fire-front',
        paint: { 'line-color': '#FFD700', 'line-width': 2.5, 'line-opacity': 0.9 },
      });

      // ── Predicted zone ───────────────────────────────────────────────────
      map.addLayer({
        id: 'predicted-outline',
        type: 'line',
        source: 'predicted',
        paint: {
          'line-color': '#E67E22',
          'line-width': 2,
          'line-dasharray': [4, 2],
          'line-opacity': 0.8,
        },
      });

      // ── Routes ───────────────────────────────────────────────────────────
      map.addLayer({
        id: 'routes-shadow',
        type: 'line',
        source: 'routes',
        paint: { 'line-color': '#000', 'line-width': 4, 'line-opacity': 0.3 },
      });
      map.addLayer({
        id: 'routes-line',
        type: 'line',
        source: 'routes',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['get', 'flashing'], false], '#E74C3C',
            '#1ABC9C',
          ],
          'line-width': 2,
          'line-opacity': 0.8,
        },
      });

      // ── Safe zones — fill circle (capacity-scaled radius, utilisation color) ──
      map.addLayer({
        id: 'safe-zones-fill',
        type: 'circle',
        source: 'safe-zones',
        paint: {
          // Radius scales with capacity: 5 000 → 14 px, 15 000 → 28 px
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'capacity'],
            1000, 12,
            5000, 16,
            10000, 22,
            15000, 28,
          ],
          // Fill color by utilisation level
          'circle-color': [
            'case',
            ['>=', ['get', 'utilisation'], 0.8], '#E74C3C',  // red — near full
            ['>=', ['get', 'utilisation'], 0.5], '#F39C12',  // amber — filling
            '#27AE60',                                         // green — safe
          ],
          // Opacity increases as zone fills up (makes danger visible)
          'circle-opacity': [
            'interpolate', ['linear'], ['get', 'utilisation'],
            0, 0.18,
            0.5, 0.30,
            1, 0.55,
          ],
        },
      });

      // Border ring
      map.addLayer({
        id: 'safe-zones-border',
        type: 'circle',
        source: 'safe-zones',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'capacity'],
            1000, 12, 5000, 16, 10000, 22, 15000, 28,
          ],
          'circle-color': 'transparent',
          'circle-stroke-color': [
            'case',
            ['>=', ['get', 'utilisation'], 0.8], '#E74C3C',
            ['>=', ['get', 'utilisation'], 0.5], '#F39C12',
            '#27AE60',
          ],
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.9,
        },
      });

      // Zone name label
      map.addLayer({
        id: 'safe-zones-label',
        type: 'symbol',
        source: 'safe-zones',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 2.2],
          'text-anchor': 'top',
          'text-max-width': 10,
        },
        paint: {
          'text-color': '#27AE60',
          'text-halo-color': '#0A1628',
          'text-halo-width': 1.5,
        },
      });

      // ── Citizens ─────────────────────────────────────────────────────────
      map.addLayer({
        id: 'citizens-circle',
        type: 'circle',
        source: 'citizens',
        filter: ['!=', ['get', 'is_real'], true],
        paint: {
          'circle-radius': 5,
          'circle-color': [
            'case',
            ['==', ['get', 'status'], 'reached_safety'], '#27AE60',
            '#F39C12',
          ],
          'circle-stroke-color': '#0A1628',
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
      });

      // Real citizen dot (larger, white stroke)
      map.addLayer({
        id: 'citizens-real-circle',
        type: 'circle',
        source: 'citizens',
        filter: ['==', ['get', 'is_real'], true],
        paint: {
          'circle-radius': 8,
          'circle-color': '#F39C12',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });

      // ── Safe zone click handler ──────────────────────────────────────────
      map.on('click', 'safe-zones-fill', (e) => {
        const props = e.features[0]?.properties;
        if (!props) return;
        setClickedZone({
          props,
          screenX: e.point.x,
          screenY: e.point.y,
        });
      });

      // Pointer cursor on hover
      map.on('mouseenter', 'safe-zones-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'safe-zones-fill', () => {
        map.getCanvas().style.cursor = '';
      });

      // Close popup when clicking elsewhere on the map
      map.on('click', (e) => {
        const layers = map.queryRenderedFeatures(e.point, { layers: ['safe-zones-fill'] });
        if (layers.length === 0) setClickedZone(null);
      });

      loadedRef.current = true;
    });

    return () => {
      loadedRef.current = false;
      realMarkerRef.current?.remove();
      map.remove();
    };
  }, []);

  // ── Data updates on each WS tick ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !wsData) return;

    map.getSource('ash')?.setData(toFC(wsData.ash_polygon));
    map.getSource('fire-front')?.setData(toFC(wsData.fire_front_polygon));
    map.getSource('danger')?.setData(toFC(wsData.danger_polygon));
    map.getSource('predicted')?.setData(toFC(wsData.predicted_polygon));

    if (wsData.routes) {
      const withFlash = {
        ...wsData.routes,
        features: (wsData.routes.features || []).map((f) => ({
          ...f,
          properties: {
            ...f.properties,
            flashing: flashingSet ? flashingSet.has(f.properties?.citizen_id) : false,
          },
        })),
      };
      map.getSource('routes')?.setData(withFlash);
    } else {
      map.getSource('routes')?.setData(EMPTY_FC);
    }

    map.getSource('citizens')?.setData(wsData.citizens || EMPTY_FC);
    map.getSource('safe-zones')?.setData(wsData.safe_zones || EMPTY_FC);

    // Real-citizen pulsing DOM marker
    const realFeature = (wsData.citizens?.features || []).find(
      (f) => f.properties?.is_real
    );
    if (realFeature) {
      const [lon, lat] = realFeature.geometry.coordinates;
      if (!realMarkerRef.current) {
        const el = document.createElement('div');
        el.style.cssText = 'width:32px;height:32px;position:relative;';
        const ring = document.createElement('div');
        ring.className = 'citizen-pulse-ring';
        el.appendChild(ring);
        realMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lon, lat])
          .addTo(map);
      } else {
        realMarkerRef.current.setLngLat([lon, lat]);
      }
    } else if (realMarkerRef.current) {
      realMarkerRef.current.remove();
      realMarkerRef.current = null;
    }
  }, [wsData, flashingSet]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Safe zone detail popup — rendered in React, positioned over map */}
      {clickedZone && (
        <SafeZoneDetail
          zone={clickedZone.props}
          screenX={clickedZone.screenX}
          screenY={clickedZone.screenY}
          onClose={() => setClickedZone(null)}
        />
      )}
    </div>
  );
}
