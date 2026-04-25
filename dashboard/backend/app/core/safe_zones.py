"""
Safe zone selector.

Threshold-aware decision tree (select_zone_with_threshold) — highest priority:
  1. Classify shelters as external (outside evac zone) or internal (inside zone).
  2. Compute escape_time = distance from citizen to nearest zone boundary edge
     divided by walk speed — uses polygon geometry, not centroid approximation.
  3. If escape_time <= evacuation_threshold → route to nearest external shelter.
  4. Else → fall back to nearest internal shelter (safest reachable given time).

Reactive: callers pass engine.scenario.time_available each tick so any mid-session
threshold change is automatically picked up on the next reroute check.

Fallback scoring weights (select_best_zone, used when no zone polygon is defined):
    distance         35%
    capacity slack   25%
    safety margin    30%
    accessibility    10%

Unit-testable helpers exported at module level:
    escape_time_minutes()   — boundary-edge walk time
    classify_shelters()     — inside / outside zone partition
    _nearest_by_distance()  — closest shelter by haversine
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from shapely.geometry import Point, shape

from app.api.schemas import SafeZone

# Walk speed matches pathfinder.WALK_SPEED_KMH
WALK_SPEED_KMH = 4.5


# ---------------------------------------------------------------------------
# Primary entry point — threshold-aware selection
# ---------------------------------------------------------------------------

def select_zone_with_threshold(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_polygon_geojson: Optional[Dict[str, Any]],
    zone_polygon_geojson: Optional[Dict[str, Any]] = None,
    evacuation_threshold_minutes: float = 30.0,
) -> Optional[SafeZone]:
    """
    Threshold-aware shelter selection implementing the decision tree:

      Step 1 — Find nearest shelter OUTSIDE the evacuation zone.
      Step 2 — Estimate escape_time = walk time to nearest zone boundary edge.
      Step 3 — Compare against evacuation_threshold_minutes:
               <= threshold → route to external shelter (can escape in time)
               >  threshold → fall back to nearest internal shelter

    Edge cases handled:
      - zone_polygon_geojson is None → falls back to select_best_zone scoring.
      - Citizen already outside zone → escape_time = 0, always picks external.
      - No external shelter available → use nearest internal.
      - No internal shelter available → use external (best effort).
      - All shelters engulfed by danger → returns None.
    """
    zone_shape = _to_shape_from_feature(zone_polygon_geojson)

    if zone_shape is None:
        # No evac zone defined — use original multi-factor scoring
        return select_best_zone(citizen_lat, citizen_lon, safe_zones, danger_polygon_geojson)

    danger_shape = _to_shape(danger_polygon_geojson)

    # Separate exit-point shelters (generated at zone corners) from real shelters
    exit_shelters: List[SafeZone] = []
    real_shelters: List[SafeZone] = []
    for sz in safe_zones:
        if sz.id.startswith("exit-"):
            exit_shelters.append(sz)
        else:
            real_shelters.append(sz)

    # Partition real shelters; skip those engulfed by the active hazard
    external: List[SafeZone] = []
    internal: List[SafeZone] = []
    for sz in real_shelters:
        sz_pt = Point(sz.lon, sz.lat)
        if danger_shape is not None and danger_shape.contains(sz_pt):
            continue  # engulfed by fire/flood — unusable
        if zone_shape.contains(sz_pt):
            internal.append(sz)
        else:
            external.append(sz)

    citizen_pt = Point(citizen_lon, citizen_lat)
    citizen_in_zone = zone_shape.contains(citizen_pt)

    if not citizen_in_zone:
        # Already outside the zone — route to nearest real external shelter
        nearest_ext = _nearest_by_distance(citizen_lat, citizen_lon, external)
        if nearest_ext:
            return nearest_ext
        return select_best_zone(citizen_lat, citizen_lon, real_shelters or safe_zones, danger_polygon_geojson)

    # Citizen is inside zone — compute escape time to nearest zone boundary
    escape_time = _escape_time_minutes(citizen_lat, citizen_lon, zone_shape)

    nearest_external = _nearest_by_distance(citizen_lat, citizen_lon, external)
    nearest_internal = _nearest_by_distance(citizen_lat, citizen_lon, internal)
    nearest_exit     = _nearest_by_distance(citizen_lat, citizen_lon, exit_shelters)

    if escape_time <= evacuation_threshold_minutes:
        # Sufficient time to escape → nearest real external shelter
        if nearest_external:
            return nearest_external
        # No real external, fall back to nearest exit point
        return nearest_exit or nearest_internal or select_best_zone(
            citizen_lat, citizen_lon, real_shelters or safe_zones, danger_polygon_geojson
        )
    else:
        # Cannot escape to a distant shelter in time → route to nearest zone exit point
        if nearest_exit:
            return nearest_exit
        # No exit shelters defined → fall back to internal shelter
        if nearest_internal:
            return nearest_internal
        return nearest_external or select_best_zone(
            citizen_lat, citizen_lon, real_shelters or safe_zones, danger_polygon_geojson
        )


# ---------------------------------------------------------------------------
# Original multi-factor scorer (fallback when no zone polygon)
# ---------------------------------------------------------------------------

def select_best_zone(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_polygon_geojson: Optional[Dict[str, Any]],
) -> Optional[SafeZone]:
    """
    Returns the highest-scoring zone that does not overlap the danger polygon.
    Returns None only if every zone is inside the danger zone.
    """
    danger_shape = _to_shape(danger_polygon_geojson)
    scored = score_zones(citizen_lat, citizen_lon, safe_zones, danger_shape)
    if not scored:
        return None
    return scored[0][0]


def score_zones(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_shape: Optional[Any],
) -> List[Tuple[SafeZone, float]]:
    """Returns (zone, score) pairs sorted descending, excluding danger-overlapping zones."""
    citizen_pt = Point(citizen_lon, citizen_lat)
    candidates = []
    for zone in safe_zones:
        zone_pt = Point(zone.lon, zone.lat)
        if danger_shape is not None and danger_shape.contains(zone_pt):
            continue
        dist_km = _haversine(citizen_lat, citizen_lon, zone.lat, zone.lon)
        score = _score(zone, dist_km, danger_shape, zone_pt)
        candidates.append((zone, score))
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates


# ---------------------------------------------------------------------------
# Unit-testable public helpers
# ---------------------------------------------------------------------------

def escape_time_minutes(
    citizen_lat: float,
    citizen_lon: float,
    zone_polygon_geojson: Optional[Dict[str, Any]],
) -> float:
    """
    Minimum walk time (minutes) from citizen to the nearest zone boundary edge.
    Uses polygon boundary geometry, not a centroid approximation.
    Returns 0 if citizen is already outside the zone or no zone is defined.
    """
    zone_shape = _to_shape_from_feature(zone_polygon_geojson)
    return _escape_time_minutes(citizen_lat, citizen_lon, zone_shape)


def classify_shelters(
    safe_zones: List[SafeZone],
    zone_polygon_geojson: Optional[Dict[str, Any]],
    danger_polygon_geojson: Optional[Dict[str, Any]],
) -> Tuple[List[SafeZone], List[SafeZone]]:
    """
    Returns (external_shelters, internal_shelters) relative to zone_polygon.
    Shelters engulfed by danger_polygon are excluded from both lists.
    """
    zone_shape = _to_shape_from_feature(zone_polygon_geojson)
    danger_shape = _to_shape(danger_polygon_geojson)
    external: List[SafeZone] = []
    internal: List[SafeZone] = []
    for sz in safe_zones:
        sz_pt = Point(sz.lon, sz.lat)
        if danger_shape is not None and danger_shape.contains(sz_pt):
            continue
        if zone_shape is not None and zone_shape.contains(sz_pt):
            internal.append(sz)
        else:
            external.append(sz)
    return external, internal


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _escape_time_minutes(
    citizen_lat: float, citizen_lon: float, zone_shape: Optional[Any]
) -> float:
    """Boundary-edge distance converted to walk time (minutes)."""
    if zone_shape is None:
        return 0.0
    citizen_pt = Point(citizen_lon, citizen_lat)
    if not zone_shape.contains(citizen_pt):
        return 0.0  # already outside the zone
    # Distance from point to polygon boundary in degrees (lon/lat CRS)
    boundary_dist_deg = zone_shape.boundary.distance(citizen_pt)
    # Approximation: 0.009° ≈ 1 km (consistent with rest of codebase)
    boundary_dist_km = boundary_dist_deg / 0.009
    return (boundary_dist_km / WALK_SPEED_KMH) * 60.0


def _nearest_by_distance(
    lat: float, lon: float, zones: List[SafeZone]
) -> Optional[SafeZone]:
    """Shelter with smallest haversine distance from (lat, lon)."""
    if not zones:
        return None
    return min(zones, key=lambda z: _haversine(lat, lon, z.lat, z.lon))


def _score(
    zone: SafeZone,
    dist_km: float,
    danger_shape: Optional[Any],
    zone_pt: Any,
) -> float:
    dist_score = max(0.0, 1.0 - dist_km / 10.0)
    utilisation = zone.current_occupancy / max(1, zone.capacity)
    capacity_score = 1.0 - utilisation
    if danger_shape is not None:
        margin_deg = danger_shape.boundary.distance(zone_pt)
        margin_km = margin_deg / 0.009
        margin_score = min(1.0, margin_km / 5.0)
    else:
        margin_score = 1.0
    accessibility_score = min(1.0, 1.0 - zone.elevation_m / 500.0)
    return (
        0.35 * dist_score
        + 0.25 * capacity_score
        + 0.30 * margin_score
        + 0.10 * accessibility_score
    )


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(a))


def _to_shape(geojson: Optional[Dict[str, Any]]) -> Optional[Any]:
    """Convert a GeoJSON Geometry dict to a Shapely geometry."""
    if geojson is None:
        return None
    try:
        return shape(geojson)
    except Exception:
        return None


def _to_shape_from_feature(geojson: Optional[Dict[str, Any]]) -> Optional[Any]:
    """
    Convert a GeoJSON dict to Shapely geometry.
    Handles both Feature wrappers {"type":"Feature","geometry":{...}}
    and raw geometry dicts {"type":"Polygon","coordinates":[...]}.
    The zone_polygon from the frontend is always a Feature.
    """
    if geojson is None:
        return None
    try:
        if geojson.get("type") == "Feature":
            geojson = geojson.get("geometry") or {}
        return shape(geojson)
    except Exception:
        return None
