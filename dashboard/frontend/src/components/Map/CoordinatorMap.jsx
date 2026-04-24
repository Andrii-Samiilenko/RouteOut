import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import SafeZoneDetail from '@/components/Dashboard/SafeZoneDetail';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const CENTER = [2.1686, 41.3874];
const ZOOM = 12;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const SHELTER_ICONS = { shelter: '⛺', hospital: '🏥', assembly: '🏛️' };

/**
 * CoordinatorMap — supervisor view.
 *
 * Layer stack (bottom → top):
 *   draft-zone-fill/line  amber dashed polygon while supervisor is drawing
 *   sim-zone-fill/line    red zone broadcast from backend after launch
 *   ash-fill              charcoal burned-out area
 *   danger-outline        red perimeter (combined ash + fire front)
 *   fire-front-fill       bright orange active fire
 *   predicted-outline     dashed amber 15-min forecast
 *   routes-shadow/line    green evacuation routes (red flash on reroute)
 *   safe-zones-fill/border/label  circles scaled by capacity, colored by utilisation
 *   ws-shelters-circle/label      shelters from WS broadcast (post-launch)
 *   citizens-circle/citizens-real-circle  amber dots + real citizen marker
 *
 * Props:
 *   wsData            — WebSocket payload
 *   flashingSet       — Set<citizen_id> for route-reroute flash
 *   drawMode          — 'polygon' | 'shelter' | null
 *   pendingShelters   — [{id,name,lat,lon,shelter_type,capacity}]
 *   zonePolygon       — GeoJSON Polygon/Feature or null (draft)
 *   onMapClick        — ({lat,lon}) => void
 *   onPolygonComplete — (GeoJSON Feature Polygon) => void
 */
export default function CoordinatorMap({
  wsData,
  flashingSet,
  drawMode,
  pendingShelters = [],
  zonePolygon,
  onMapClick,
  onPolygonComplete,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);

  // Safe zone click popup state
  const [clickedZone, setClickedZone] = useState(null); // { props, screenX, screenY }

  // Polygon draw state
  const drawVerticesRef = useRef([]);
  const vertexMarkersRef = useRef([]);

  // Shelter DOM markers keyed by id
  const shelterMarkersRef = useRef({});

  // ── Map initialisation ─────────────────────────────────────────────────
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: CENTER,
      zoom: ZOOM,
    });
    mapRef.current = map;

    map.on('load', () => {
      // ── Sources ─────────────────────────────────────────────────────────
      map.addSource('draft-zone',  { type: 'geojson', data: EMPTY_FC });
      map.addSource('sim-zone',    { type: 'geojson', data: EMPTY_FC });
      map.addSource('ash',         { type: 'geojson', data: EMPTY_FC });
      map.addSource('danger',      { type: 'geojson', data: EMPTY_FC });
      map.addSource('fire-front',  { type: 'geojson', data: EMPTY_FC });
      map.addSource('predicted',   { type: 'geojson', data: EMPTY_FC });
      map.addSource('routes',      { type: 'geojson', data: EMPTY_FC });
      map.addSource('citizens',    { type: 'geojson', data: EMPTY_FC });
      map.addSource('safe-zones',  { type: 'geojson', data: EMPTY_FC });
      map.addSource('ws-shelters', { type: 'geojson', data: EMPTY_FC });

      // ── Draft zone (supervisor drawing, amber dashed) ────────────────────
      map.addLayer({
        id: 'draft-zone-fill',
        type: 'fill',
        source: 'draft-zone',
        paint: { 'fill-color': '#F39C12', 'fill-opacity': 0.15 },
      });
      map.addLayer({
        id: 'draft-zone-line',
        type: 'line',
        source: 'draft-zone',
        paint: { 'line-color': '#F39C12', 'line-width': 2, 'line-dasharray': [4, 2] },
      });

      // ── Active simulation zone from WS (red, solid) ──────────────────────
      map.addLayer({
        id: 'sim-zone-fill',
        type: 'fill',
        source: 'sim-zone',
        paint: { 'fill-color': '#C0392B', 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: 'sim-zone-line',
        type: 'line',
        source: 'sim-zone',
        paint: { 'line-color': '#C0392B', 'line-width': 2.5, 'line-opacity': 0.9 },
      });

      // ── Ash (burned-out charcoal area) ───────────────────────────────────
      map.addLayer({
        id: 'ash-fill',
        type: 'fill',
        source: 'ash',
        paint: { 'fill-color': '#2C2C2C', 'fill-opacity': 0.55 },
      });

      // ── Danger perimeter ────────────────────────────────────────────────
      map.addLayer({
        id: 'danger-outline',
        type: 'line',
        source: 'danger',
        paint: { 'line-color': '#E74C3C', 'line-width': 2.5, 'line-opacity': 0.85 },
      });

      // ── Active fire front ────────────────────────────────────────────────
      map.addLayer({
        id: 'fire-front-fill',
        type: 'fill',
        source: 'fire-front',
        paint: { 'fill-color': '#FF5722', 'fill-opacity': 0.65 },
      });
      map.addLayer({
        id: 'fire-front-glow',
        type: 'line',
        source: 'fire-front',
        paint: { 'line-color': '#FFCC00', 'line-width': 2, 'line-opacity': 0.7 },
      });

      // ── Predicted zone (dashed amber) ────────────────────────────────────
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

      // ── Safe zones (capacity-scaled circles, utilisation color) ─────────
      map.addLayer({
        id: 'safe-zones-fill',
        type: 'circle',
        source: 'safe-zones',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'capacity'],
            1000, 12, 5000, 16, 10000, 22, 15000, 28,
          ],
          'circle-color': [
            'case',
            ['>=', ['get', 'utilisation'], 0.8], '#E74C3C',
            ['>=', ['get', 'utilisation'], 0.5], '#F39C12',
            '#27AE60',
          ],
          'circle-opacity': [
            'interpolate', ['linear'], ['get', 'utilisation'],
            0, 0.18, 0.5, 0.30, 1, 0.55,
          ],
        },
      });
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

      // ── WS-broadcast shelters (post-launch) ──────────────────────────────
      map.addLayer({
        id: 'ws-shelters-circle',
        type: 'circle',
        source: 'ws-shelters',
        paint: {
          'circle-radius': 16,
          'circle-color': '#27AE60',
          'circle-opacity': 0.25,
          'circle-stroke-color': '#27AE60',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'ws-shelters-label',
        type: 'symbol',
        source: 'ws-shelters',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.8],
          'text-anchor': 'top',
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
        setClickedZone({ props, screenX: e.point.x, screenY: e.point.y });
      });
      map.on('mouseenter', 'safe-zones-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'safe-zones-fill', () => {
        map.getCanvas().style.cursor = drawMode ? 'crosshair' : '';
      });
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['safe-zones-fill'] });
        if (hits.length === 0) setClickedZone(null);
      });

      loadedRef.current = true;
    });

    return () => {
      loadedRef.current = false;
      vertexMarkersRef.current.forEach((m) => m.remove());
      vertexMarkersRef.current = [];
      Object.values(shelterMarkersRef.current).forEach((m) => m.remove());
      shelterMarkersRef.current = {};
      map.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Map interaction — polygon draw + shelter placement ─────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function handleClick(e) {
      if (drawMode === 'shelter') {
        onMapClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
        return;
      }
      if (drawMode === 'polygon') {
        const coord = [e.lngLat.lng, e.lngLat.lat];
        drawVerticesRef.current.push(coord);
        _addVertexDot(map, e.lngLat.lng, e.lngLat.lat);
        _updateDraftLine(map, drawVerticesRef.current);
      }
    }

    function handleDblClick(e) {
      if (drawMode !== 'polygon') return;
      e.preventDefault();
      const verts = drawVerticesRef.current;
      if (verts.length < 3) return;

      const ring = [...verts, verts[0]];
      const polygon = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {},
      };

      vertexMarkersRef.current.forEach((m) => m.remove());
      vertexMarkersRef.current = [];
      drawVerticesRef.current = [];

      onPolygonComplete?.(polygon);
    }

    map.doubleClickZoom.disable();
    map.on('click', handleClick);
    map.on('dblclick', handleDblClick);

    return () => {
      map.off('click', handleClick);
      map.off('dblclick', handleDblClick);
      map.doubleClickZoom.enable();
    };
  }, [drawMode, onMapClick, onPolygonComplete]);

  // ── Clear draw vertices when zone is externally reset ─────────────────────
  useEffect(() => {
    if (zonePolygon === null) {
      const map = mapRef.current;
      vertexMarkersRef.current.forEach((m) => m.remove());
      vertexMarkersRef.current = [];
      drawVerticesRef.current = [];
      if (map && loadedRef.current) {
        map.getSource('draft-zone')?.setData(EMPTY_FC);
      }
    }
  }, [zonePolygon]);

  // ── Data updates on each WS tick ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    // Hazard layers
    map.getSource('ash')?.setData(wsData?.ash_geojson ?? EMPTY_FC);
    map.getSource('danger')?.setData(wsData?.danger_geojson ?? EMPTY_FC);
    map.getSource('fire-front')?.setData(wsData?.fire_front ?? EMPTY_FC);
    map.getSource('predicted')?.setData(wsData?.predicted_zone ?? EMPTY_FC);

    // Routes — inject flashing flag into each feature
    const routeFeatures = (wsData?.routes?.features ?? []).map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        flashing: flashingSet?.has(f.properties?.citizen_id) ?? false,
      },
    }));
    map.getSource('routes')?.setData({
      type: 'FeatureCollection',
      features: routeFeatures,
    });

    // Citizens
    map.getSource('citizens')?.setData(wsData?.citizens ?? EMPTY_FC);

    // Safe zones — backend sends as 'safe_zones' (GeoJSON FC)
    map.getSource('safe-zones')?.setData(wsData?.safe_zones ?? EMPTY_FC);

    // Draft zone (supervisor drawing)
    if (zonePolygon) {
      map.getSource('draft-zone')?.setData(zonePolygon);
    }

    // Active simulation zone from WS (scenario zone polygon)
    const simZone = wsData?.scenario?.zone_polygon;
    map.getSource('sim-zone')?.setData(simZone ?? EMPTY_FC);

    // WS shelter GeoJSON (post-launch)
    map.getSource('ws-shelters')?.setData(wsData?.shelters_geojson ?? EMPTY_FC);

    // Pending shelter DOM markers
    const currentIds = new Set((pendingShelters ?? []).map((s) => s.id));
    for (const id of Object.keys(shelterMarkersRef.current)) {
      if (!currentIds.has(id)) {
        shelterMarkersRef.current[id].remove();
        delete shelterMarkersRef.current[id];
      }
    }
    for (const s of (pendingShelters ?? [])) {
      if (!shelterMarkersRef.current[s.id]) {
        shelterMarkersRef.current[s.id] = _makeShelterMarker(map, s);
      }
    }
  }, [wsData, flashingSet, zonePolygon, pendingShelters]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', cursor: drawMode ? 'crosshair' : 'default' }}
      />

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

// ── Helpers ────────────────────────────────────────────────────────────────

function _addVertexDot(map, lng, lat) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    width: '10px', height: '10px', borderRadius: '50%',
    background: '#F39C12', border: '2px solid #fff',
    boxShadow: '0 0 6px rgba(0,0,0,0.6)',
  });
  const m = new mapboxgl.Marker({ element: el, anchor: 'center' })
    .setLngLat([lng, lat])
    .addTo(map);
  vertexMarkersRef.current.push(m);
}

function _updateDraftLine(map, verts) {
  if (verts.length < 2) return;
  map.getSource('draft-zone')?.setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: verts },
    properties: {},
  });
}

function _makeShelterMarker(map, shelter) {
  const icon = SHELTER_ICONS[shelter.shelter_type] ?? '⛺';
  const el = document.createElement('div');
  Object.assign(el.style, { display: 'flex', flexDirection: 'column', alignItems: 'center' });
  el.innerHTML = `
    <div style="font-size:24px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.9))">${icon}</div>
    <div style="background:rgba(10,22,40,0.9);color:#27AE60;font-size:10px;font-weight:600;
      padding:2px 6px;border-radius:4px;margin-top:2px;white-space:nowrap;border:1px solid #27AE60;">
      ${shelter.name}
    </div>
  `;
  return new mapboxgl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([shelter.lon, shelter.lat])
    .addTo(map);
}
