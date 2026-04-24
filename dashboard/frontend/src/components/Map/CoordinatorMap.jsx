import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const CENTER = [2.1686, 41.3874];
const ZOOM = 12;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const SHELTER_ICONS = { shelter: '⛺', hospital: '🏥', assembly: '🏛️' };

/**
 * CoordinatorMap — supervisor view.
 *
 * Layers (no citizens, no routes — those belong to A* integration):
 *   draft-zone-fill/line  amber dashed polygon while supervisor is drawing
 *   sim-zone-fill/line    red zone broadcast from backend after launch
 *   ws-shelters-circle/label  shelters from WS broadcast (post-launch)
 *   Shelter DOM markers   pending supervisor placements (pre-launch)
 *
 * Props:
 *   wsData            — WebSocket payload
 *   drawMode          — 'polygon' | 'shelter' | null
 *   pendingShelters   — [{id,name,lat,lon,shelter_type,capacity}]
 *   zonePolygon       — GeoJSON Polygon/Feature or null (draft)
 *   onMapClick        — ({lat,lon}) => void
 *   onPolygonComplete — (GeoJSON Feature Polygon) => void
 */
export default function CoordinatorMap({
  wsData,
  drawMode,
  pendingShelters,
  zonePolygon,
  onMapClick,
  onPolygonComplete,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);

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
      // Draft zone drawn by supervisor (amber, dashed)
      map.addSource('draft-zone', { type: 'geojson', data: EMPTY_FC });
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

      // Active simulation zone from WS (red, solid)
      map.addSource('sim-zone', { type: 'geojson', data: EMPTY_FC });
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

      // WS-broadcast shelters (post-launch)
      map.addSource('ws-shelters', { type: 'geojson', data: EMPTY_FC });
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

  // ── Map interaction — depends on drawMode ──────────────────────────────
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

      // Clear vertex dots
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

  // ── Sync sources + DOM markers with React state ────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    // Draft zone (supervisor drawing)
    map.getSource('draft-zone')?.setData(
      zonePolygon ?? EMPTY_FC
    );

    // Active simulation zone from WS
    const simZone = wsData?.simulation?.zone_polygon;
    map.getSource('sim-zone')?.setData(simZone ?? EMPTY_FC);

    // WS shelter GeoJSON (post-launch)
    map.getSource('ws-shelters')?.setData(wsData?.shelters_geojson ?? EMPTY_FC);

    // Pending shelter DOM markers
    const currentIds = new Set(pendingShelters.map((s) => s.id));
    for (const id of Object.keys(shelterMarkersRef.current)) {
      if (!currentIds.has(id)) {
        shelterMarkersRef.current[id].remove();
        delete shelterMarkersRef.current[id];
      }
    }
    for (const s of pendingShelters) {
      if (!shelterMarkersRef.current[s.id]) {
        shelterMarkersRef.current[s.id] = _makeShelterMarker(map, s);
      }
    }
  }, [wsData, zonePolygon, pendingShelters]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', cursor: drawMode ? 'crosshair' : 'default' }}
    />
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
