import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import SafeZoneDetail from '@/components/Dashboard/SafeZoneDetail';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const CENTER = [2.1686, 41.3874];
const ZOOM = 12;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// SVG strings for Mapbox DOM markers (no emoji)
const SHELTER_SVG = {
  shelter:    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 21L12 3l11 18"/><line x1="1" y1="21" x2="23" y2="21"/><path d="M12 21v-8"/></svg>`,
  hospital:   `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>`,
  assembly:   `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20V10l8-7 8 7v10"/><rect x="9" y="14" width="6" height="6"/></svg>`,
  // Exit point: arrow-out-of-box icon in amber to distinguish from real shelters
  exit_point: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F39C12" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
};

// Disaster-type visual palette (matches notification/frontend reference)
const DISASTER_PALETTE = {
  fire:    { body: '#c0392b', front: '#FF5722', frontOpacity: 0.65, outline: '#E74C3C' },
  flood:   { body: '#1a5276', front: '#5dade2', frontOpacity: 0.45, outline: '#2980b9' },
  tsunami: { body: '#0e6655', front: '#a2d9ce', frontOpacity: 0.55, outline: '#1abc9c' },
};

/**
 * CoordinatorMap — supervisor view.
 *
 * Layer stack (bottom → top):
 *   draft-zone-fill/line  amber dashed polygon while supervisor is drawing
 *   sim-zone-fill/line    red zone broadcast from backend after launch
 *   ash-fill              charcoal burned-out area (fire only)
 *   danger-outline        hazard perimeter (color varies by disaster type)
 *   flood-body-fill       blue/teal fill for flood & tsunami body
 *   fire-front-fill/glow  bright orange active fire (fire only)
 *   flood-front-fill      animated shimmer for flood/tsunami leading edge
 *   predicted-outline     dashed 15-min forecast
 *   safe-zones-fill/border/label  circles scaled by capacity, colored by utilisation
 *   ws-shelters-circle/label      shelters from WS broadcast (post-launch)
 *   citizens-circle/citizens-real-circle  (not shown — aggregate via safe zones)
 *
 * Props:
 *   wsData            — WebSocket payload
 *   flashingSet       — Set<citizen_id> for route-reroute flash
 *   drawMode          — 'polygon' | 'shelter' | null
 *   drawResetKey      — incremented externally to clear in-progress vertices
 *   pendingShelters   — [{id,name,lat,lon,shelter_type,capacity}]
 *   zonePolygon       — GeoJSON Polygon/Feature or null (draft)
 *   onMapClick        — ({lat,lon}) => void
 *   onPolygonComplete — (GeoJSON Feature Polygon) => void
 */
export default function CoordinatorMap({
  wsData,
  flashingSet,
  drawMode,
  drawResetKey,
  pendingShelters = [],
  zonePolygon,
  onMapClick,
  onPolygonComplete,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);

  const [clickedZone, setClickedZone] = useState(null);

  // Polygon draw state
  const drawVerticesRef = useRef([]);
  const vertexMarkersRef = useRef([]);

  // Shelter DOM markers keyed by id
  const shelterMarkersRef = useRef({});

  // Flood shimmer animation
  const shimmerRef = useRef(null);
  const shimmerPhaseRef = useRef(0);

  // ── Map initialisation ─────────────────────────────────────────────────
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: CENTER,
      zoom: ZOOM,
    });
    mapRef.current = map;

    // 3D rotation interactions (enabled by default but explicit is safer)
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();

    // Navigation widget — shows tilt/compass UI, makes 3D obvious to judges
    map.addControl(
      new mapboxgl.NavigationControl({ visualizePitch: true }),
      'top-right',
    );

    map.on('load', () => {
      // Animate camera into 3D perspective on first load
      map.easeTo({
        pitch: 45,
        bearing: -17.6,
        duration: 1500,
        easing: (t) => t * (2 - t),
      });

      // Atmospheric fog — distant buildings fade into the dark background
      map.setFog({
        range: [0.5, 10],
        color: '#1a1d26',
        'horizon-blend': 0.1,
      });

      // 3D buildings — added FIRST so all data layers render on top
      map.addLayer({
        id: '3d-buildings',
        source: 'composite',
        'source-layer': 'building',
        filter: ['==', 'extrude', 'true'],
        type: 'fill-extrusion',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': [
            'interpolate', ['linear'],
            ['get', 'height'],
            0,   '#1e2128',
            50,  '#2e3340',
            100, '#3a3f4d',
          ],
          'fill-extrusion-height':  ['get', 'height'],
          'fill-extrusion-base':    ['get', 'min_height'],
          'fill-extrusion-opacity': 0.85,
        },
      });

      // ── Sources ─────────────────────────────────────────────────────────
      map.addSource('draft-zone',   { type: 'geojson', data: EMPTY_FC });
      map.addSource('sim-zone',     { type: 'geojson', data: EMPTY_FC });
      map.addSource('ash',          { type: 'geojson', data: EMPTY_FC });
      map.addSource('danger',       { type: 'geojson', data: EMPTY_FC });
      map.addSource('flood-body',   { type: 'geojson', data: EMPTY_FC });
      map.addSource('fire-front',   { type: 'geojson', data: EMPTY_FC });
      map.addSource('flood-front',  { type: 'geojson', data: EMPTY_FC });
      map.addSource('predicted',    { type: 'geojson', data: EMPTY_FC });
      map.addSource('safe-zones',   { type: 'geojson', data: EMPTY_FC });
      map.addSource('ws-shelters',  { type: 'geojson', data: EMPTY_FC });

      // ── Draft zone (supervisor drawing, amber dashed) ────────────────────
      map.addLayer({
        id: 'draft-zone-fill', type: 'fill', source: 'draft-zone',
        paint: { 'fill-color': '#F39C12', 'fill-opacity': 0.15 },
      });
      map.addLayer({
        id: 'draft-zone-line', type: 'line', source: 'draft-zone',
        paint: { 'line-color': '#F39C12', 'line-width': 2, 'line-dasharray': [4, 2] },
      });

      // ── Active simulation zone from WS ──────────────────────────────────
      map.addLayer({
        id: 'sim-zone-fill', type: 'fill', source: 'sim-zone',
        paint: { 'fill-color': '#C0392B', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'sim-zone-line', type: 'line', source: 'sim-zone',
        paint: { 'line-color': '#C0392B', 'line-width': 2.5, 'line-opacity': 0.7 },
      });

      // ── Ash (burned-out charcoal area — fire only) ───────────────────────
      map.addLayer({
        id: 'ash-fill', type: 'fill', source: 'ash',
        paint: { 'fill-color': '#2C2C2C', 'fill-opacity': 0.55 },
      });

      // ── Danger perimeter (color driven dynamically via setPaintProperty) ─
      map.addLayer({
        id: 'danger-outline', type: 'line', source: 'danger',
        paint: {
          'line-color': '#E74C3C',
          'line-width': 2.5,
          'line-opacity': 0.85,
          'line-color-transition': { duration: 600, delay: 0 },
        },
      });

      // ── Flood / tsunami body fill ────────────────────────────────────────
      map.addLayer({
        id: 'flood-body-fill', type: 'fill', source: 'flood-body',
        paint: {
          'fill-color': '#1a5276',
          'fill-opacity': 0.55,
          'fill-color-transition': { duration: 800, delay: 0 },
          'fill-opacity-transition': { duration: 800, delay: 0 },
        },
      });

      // ── Active fire front ────────────────────────────────────────────────
      map.addLayer({
        id: 'fire-front-fill', type: 'fill', source: 'fire-front',
        paint: { 'fill-color': '#FF5722', 'fill-opacity': 0.65 },
      });
      map.addLayer({
        id: 'fire-front-glow', type: 'line', source: 'fire-front',
        paint: { 'line-color': '#FFCC00', 'line-width': 2, 'line-opacity': 0.7 },
      });

      // ── Flood / tsunami leading edge (animated shimmer) ──────────────────
      map.addLayer({
        id: 'flood-front-fill', type: 'fill', source: 'flood-front',
        paint: {
          'fill-color': '#5dade2',
          'fill-opacity': 0.4,
          'fill-color-transition': { duration: 600, delay: 0 },
        },
      });

      // ── Predicted zone (dashed forecast) ────────────────────────────────
      map.addLayer({
        id: 'predicted-outline', type: 'line', source: 'predicted',
        paint: {
          'line-color': '#E67E22',
          'line-width': 2,
          'line-dasharray': [4, 2],
          'line-opacity': 0.8,
          'line-color-transition': { duration: 600, delay: 0 },
        },
      });

      // ── Safe zones (capacity-scaled circles, utilisation color) ─────────
      map.addLayer({
        id: 'safe-zones-fill', type: 'circle', source: 'safe-zones',
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
        id: 'safe-zones-border', type: 'circle', source: 'safe-zones',
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
        id: 'safe-zones-label', type: 'symbol', source: 'safe-zones',
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
        id: 'ws-shelters-circle', type: 'circle', source: 'ws-shelters',
        paint: {
          'circle-radius': 16,
          'circle-color': '#27AE60',
          'circle-opacity': 0.25,
          'circle-stroke-color': '#27AE60',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'ws-shelters-label', type: 'symbol', source: 'ws-shelters',
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
      // Stop shimmer on unmount
      if (shimmerRef.current) {
        clearInterval(shimmerRef.current);
        shimmerRef.current = null;
      }
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

    function addVertexDot(lng, lat) {
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

    function updateDraftLine(verts) {
      if (verts.length < 2) return;
      map.getSource('draft-zone')?.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: verts },
        properties: {},
      });
    }

    function handleClick(e) {
      if (drawMode === 'shelter') {
        onMapClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
        return;
      }
      if (drawMode === 'polygon') {
        const coord = [e.lngLat.lng, e.lngLat.lat];
        drawVerticesRef.current.push(coord);
        addVertexDot(e.lngLat.lng, e.lngLat.lat);
        updateDraftLine(drawVerticesRef.current);
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

  // ── Clear draw vertices when zone is externally reset ──────────────────
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
  }, [zonePolygon, drawMode]);

  // ── Hard clear on reset — removes in-progress vertices even if polygon was
  //    never completed (zonePolygon stays null, so the effect above won't fire)
  useEffect(() => {
    if (drawResetKey === 0) return; // skip initial mount
    const map = mapRef.current;
    vertexMarkersRef.current.forEach((m) => m.remove());
    vertexMarkersRef.current = [];
    drawVerticesRef.current = [];
    if (map && loadedRef.current) {
      map.getSource('draft-zone')?.setData(EMPTY_FC);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawResetKey]);

  // ── Data updates on each WS tick ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    const disasterType = wsData?.scenario?.disaster_type;
    const palette = DISASTER_PALETTE[disasterType] || DISASTER_PALETTE.fire;
    const isFloodType = disasterType === 'flood' || disasterType === 'tsunami';

    // ── Hazard layers — routed by disaster type ──────────────────────────
    if (isFloodType) {
      // Flood / tsunami: fill-based with shimmer; hide fire-specific layers
      map.getSource('flood-body')?.setData(wsData?.danger_geojson ?? EMPTY_FC);
      map.getSource('flood-front')?.setData(wsData?.predicted_zone ?? EMPTY_FC);
      map.getSource('danger')?.setData(EMPTY_FC);
      map.getSource('ash')?.setData(EMPTY_FC);
      map.getSource('fire-front')?.setData(EMPTY_FC);

      // Tsunami: wave crest (predicted) uses a near-white foamy teal; body is dark teal
      // Flood:   body is dark navy-blue; front is softer sky-blue
      try {
        map.setPaintProperty('flood-body-fill', 'fill-color', palette.body);
        map.setPaintProperty('flood-front-fill', 'fill-color', palette.front);
        map.setPaintProperty('danger-outline',   'line-color', palette.outline);
        map.setPaintProperty('predicted-outline','line-color', palette.outline);
      } catch (_) { /* layer not ready yet */ }

      // Shimmer animation — oscillates flood-front opacity for wave effect
      if (!shimmerRef.current) {
        shimmerPhaseRef.current = 0;
        shimmerRef.current = setInterval(() => {
          if (!mapRef.current || !loadedRef.current) return;
          shimmerPhaseRef.current += 0.07;
          const opacity = palette.frontOpacity + Math.sin(shimmerPhaseRef.current) * 0.15;
          try {
            mapRef.current.setPaintProperty('flood-front-fill', 'fill-opacity', opacity);
          } catch (_) {}
        }, 50);
      }
    } else {
      // Fire (or no disaster): standard fire layers, hide flood layers
      map.getSource('flood-body')?.setData(EMPTY_FC);
      map.getSource('flood-front')?.setData(EMPTY_FC);
      map.getSource('ash')?.setData(wsData?.ash_geojson ?? EMPTY_FC);
      map.getSource('danger')?.setData(wsData?.danger_geojson ?? EMPTY_FC);
      map.getSource('fire-front')?.setData(wsData?.fire_front ?? EMPTY_FC);

      try {
        map.setPaintProperty('danger-outline',    'line-color', '#E74C3C');
        map.setPaintProperty('predicted-outline', 'line-color', '#E67E22');
      } catch (_) {}

      // Stop shimmer when not flood type
      if (shimmerRef.current) {
        clearInterval(shimmerRef.current);
        shimmerRef.current = null;
        try { map.setPaintProperty('flood-front-fill', 'fill-opacity', 0.4); } catch (_) {}
      }
    }

    // Predicted zone is shown as outline regardless of type (already styled above)
    if (!isFloodType) {
      map.getSource('predicted')?.setData(wsData?.predicted_zone ?? EMPTY_FC);
    } else {
      map.getSource('predicted')?.setData(EMPTY_FC); // flood-front-fill handles this
    }

    // ── Zone overlays ────────────────────────────────────────────────────
    if (zonePolygon) {
      map.getSource('draft-zone')?.setData(zonePolygon);
    }
    const simZone = wsData?.scenario?.zone_polygon;
    map.getSource('sim-zone')?.setData(simZone ?? EMPTY_FC);

    // ── Shelters & safe zones ────────────────────────────────────────────
    map.getSource('safe-zones')?.setData(wsData?.safe_zones ?? EMPTY_FC);

    // Filter exit_point shelters out of the ws-shelters circle layer so they don't
    // show as generic green circles — they're handled as amber DOM markers below.
    const wsSheltersonGeoJSON = wsData?.shelters_geojson ?? EMPTY_FC;
    const wsRealShelters = {
      ...wsSheltersonGeoJSON,
      features: (wsSheltersonGeoJSON.features ?? []).filter(
        (f) => f.properties?.shelter_type !== 'exit_point'
      ),
    };
    map.getSource('ws-shelters')?.setData(wsRealShelters);

    // ── Shelter DOM markers: pending (pre-launch) + exit_points (post-launch) ─
    const exitPointsFromWS = (wsData?.shelters_geojson?.features ?? [])
      .filter((f) => f.properties?.shelter_type === 'exit_point')
      .map((f) => ({
        id:           f.properties.id,
        name:         f.properties.name,
        lat:          f.geometry.coordinates[1],
        lon:          f.geometry.coordinates[0],
        shelter_type: 'exit_point',
        capacity:     f.properties.capacity,
      }));

    const allMarkerShelters = [...(pendingShelters ?? []), ...exitPointsFromWS];
    const currentIds = new Set(allMarkerShelters.map((s) => s.id));
    for (const id of Object.keys(shelterMarkersRef.current)) {
      if (!currentIds.has(id)) {
        shelterMarkersRef.current[id].remove();
        delete shelterMarkersRef.current[id];
      }
    }
    for (const s of allMarkerShelters) {
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

// ── Module-level helpers ────────────────────────────────────────────────────

function _makeShelterMarker(map, shelter) {
  const isExit = shelter.shelter_type === 'exit_point' || shelter.id?.startsWith('exit-');
  const iconSvg = SHELTER_SVG[shelter.shelter_type] ?? SHELTER_SVG.shelter;
  const color = isExit ? '#F39C12' : '#1abc9c';
  const borderColor = isExit ? 'rgba(243,156,18,0.4)' : 'rgba(26,188,156,0.4)';
  const el = document.createElement('div');
  Object.assign(el.style, { display: 'flex', flexDirection: 'column', alignItems: 'center' });
  el.innerHTML = `
    <div style="filter:drop-shadow(0 2px 6px rgba(0,0,0,0.9))">${iconSvg}</div>
    <div style="background:rgba(10,15,30,0.9);color:${color};font-size:${isExit ? '9px' : '10px'};font-weight:700;
      padding:2px 6px;border-radius:4px;margin-top:2px;white-space:nowrap;
      border:1px solid ${borderColor};letter-spacing:0.04em;opacity:${isExit ? '0.85' : '1'};">
      ${shelter.name}
    </div>
  `;
  return new mapboxgl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([shelter.lon, shelter.lat])
    .addTo(map);
}
