"""
Safe zone selector — tiered, time-aware routing decision engine.

select_zone_with_threshold() implements a 6-tier decision tree:

  TIER A   External shelter, comfortably reachable (travel ≤ 85% remaining),
           scored by composite (time feasibility + safety + distance + capacity
           + hazard-direction).                                       → IDEAL

  TIER B   Zone exit-point, comfortably reachable (travel ≤ 90% remaining).
           Citizen escapes the evacuation zone even without a formal shelter.
                                                                      → GOOD

  TIER C   External shelter, tight timing (travel 85%–105% remaining).
           Citizen might just make it; better than staying inside.    → RISKY

  TIER B2  Zone exit-point, any travel time ≤ 3× remaining (or nearest exit
           unconditionally).  Escaping the zone boundary is ALWAYS better than
           sheltering inside a burning/flooded zone.                  → ESCAPE

  TIER D   Internal shelter, safe from hazard (≥ 300 m margin).
           Only reached when no exit point exists at all.             → FALLBACK

  TIER E   Any non-engulfed shelter — absolute last resort.          → DESPERATION

Within each tier candidates are ranked by _composite_score() using:
  • Time feasibility  (40 %) — travel / remaining ratio
  • Safety margin     (25 %) — distance of shelter from danger boundary
  • Distance          (15 %) — shorter = less exposure time
  • Capacity slack    (12 %) — balance load across shelters
  • Hazard direction  ( 8 %) — dot-product bonus for routing AWAY from danger

Key fix vs. old code:
  elapsed_minutes is now subtracted from time_available so that remaining
  time shrinks as the simulation progresses and routing decisions stay valid.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from shapely.geometry import Point, shape

from app.api.schemas import SafeZone

WALK_SPEED_KMH      = 4.5
ROAD_DETOUR_FACTOR  = 1.35   # roads are ~35% longer than crow-flies
TIMING_BUFFER       = 0.85   # Tier A: use at most 85% of remaining time
TIMING_EXTENDED     = 1.05   # Tier C: accept up to 105% (tight but possible)
EXIT_TIME_RATIO     = 0.90   # Tier B: exit-points comfortably reachable (≤90% remaining)
EXIT_TIME_DESPERATE = 3.0    # Tier B2: any exit point reachable within 3× remaining time
                              # (escaping the zone is always better than internal shelter)
INTERNAL_SAFE_MARGIN_KM = 0.3  # Tier D: internal shelter must be ≥ 300 m from danger


# ---------------------------------------------------------------------------
# Primary entry point — tiered, time-aware selection
# ---------------------------------------------------------------------------

def select_zone_with_threshold(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_polygon_geojson: Optional[Dict[str, Any]],
    zone_polygon_geojson: Optional[Dict[str, Any]] = None,
    time_available_minutes: float = 30.0,
    elapsed_minutes: float = 0.0,
) -> Optional[SafeZone]:
    """
    Select the best shelter for a citizen given the remaining evacuation time.

    Parameters
    ----------
    elapsed_minutes
        Simulation minutes already elapsed.  remaining = time_available − elapsed.
        This is the key parameter that was missing in the original code —
        without it, a 30-min budget looked unchanged at minute 25.
    """
    zone_shape   = _to_shape_from_feature(zone_polygon_geojson)
    danger_shape = _to_shape(danger_polygon_geojson)
    remaining    = max(1.0, time_available_minutes - elapsed_minutes)

    if zone_shape is None:
        return select_best_zone(citizen_lat, citizen_lon, safe_zones, danger_polygon_geojson)

    # ── Partition shelters ──────────────────────────────────────────────────
    exit_shelters: List[SafeZone] = []
    real_shelters: List[SafeZone] = []
    for sz in safe_zones:
        (exit_shelters if sz.id.startswith("exit-") else real_shelters).append(sz)

    # Remove shelters engulfed by the active hazard
    viable_real = [
        sz for sz in real_shelters
        if danger_shape is None or not danger_shape.contains(Point(sz.lon, sz.lat))
    ]
    viable_exits = [
        sz for sz in exit_shelters
        if danger_shape is None or not danger_shape.contains(Point(sz.lon, sz.lat))
    ]

    citizen_pt = Point(citizen_lon, citizen_lat)
    in_zone    = zone_shape.contains(citizen_pt)

    # ── Already outside zone → nearest safe external shelter ────────────────
    if not in_zone:
        external = [sz for sz in viable_real
                    if not zone_shape.contains(Point(sz.lon, sz.lat))]
        return (_pick_best(citizen_lat, citizen_lon, external or viable_real,
                           danger_shape, remaining)
                or _nearest_by_distance(citizen_lat, citizen_lon, viable_real or safe_zones))

    # ── Citizen inside zone — build tiers ───────────────────────────────────
    external = [sz for sz in viable_real
                if not zone_shape.contains(Point(sz.lon, sz.lat))]
    internal = [sz for sz in viable_real
                if zone_shape.contains(Point(sz.lon, sz.lat))]

    def tt(sz: SafeZone) -> float:
        return _travel_time_min(citizen_lat, citizen_lon, sz.lat, sz.lon)

    # Tier A — external real shelter, comfortably reachable (≤85% remaining)
    tier_a = [sz for sz in external if tt(sz) <= remaining * TIMING_BUFFER]

    # Tier B — exit-point, comfortably reachable (≤90% remaining)
    tier_b = [sz for sz in viable_exits if tt(sz) <= remaining * EXIT_TIME_RATIO]

    # Tier C — external real shelter, tight timing (85%–105% remaining)
    tier_c = [sz for sz in external
              if remaining * TIMING_BUFFER < tt(sz) <= remaining * TIMING_EXTENDED]

    # Tier B2 — exit-point reachable within 3× remaining time.
    # Escaping the zone boundary is ALWAYS preferable to sheltering inside a
    # burning/flooded zone, even if it takes longer than the nominal budget.
    # This fires when Tier A/B/C all fail (e.g. small time budget + large zone).
    tier_b2 = [sz for sz in viable_exits if tt(sz) <= remaining * EXIT_TIME_DESPERATE]
    # If no exit qualifies on time, use the nearest exit point unconditionally —
    # getting out of the zone beats staying in it no matter the distance.
    if not tier_b2 and viable_exits:
        tier_b2 = [min(viable_exits, key=lambda sz: tt(sz))]

    # Tier D — internal shelter, safely away from hazard (≥300 m margin)
    tier_d = [sz for sz in internal
              if _safety_margin_km(sz, danger_shape) >= INTERNAL_SAFE_MARGIN_KM]

    # Tier E — anything non-engulfed (absolute last resort)
    tier_e = viable_real or safe_zones

    # Priority: A → B → C → B2 (exit even if slow) → D (internal) → E (desperation)
    for tier in [tier_a, tier_b, tier_c, tier_b2, tier_d, tier_e]:
        if tier:
            return _pick_best(citizen_lat, citizen_lon, tier, danger_shape, remaining)

    return None


# ---------------------------------------------------------------------------
# Original multi-factor scorer (fallback when no zone polygon is defined)
# ---------------------------------------------------------------------------

def select_best_zone(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_polygon_geojson: Optional[Dict[str, Any]],
) -> Optional[SafeZone]:
    danger_shape = _to_shape(danger_polygon_geojson)
    scored = score_zones(citizen_lat, citizen_lon, safe_zones, danger_shape)
    return scored[0][0] if scored else None


def score_zones(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_shape: Optional[Any],
) -> List[Tuple[SafeZone, float]]:
    candidates = []
    for zone in safe_zones:
        zone_pt = Point(zone.lon, zone.lat)
        if danger_shape is not None and danger_shape.contains(zone_pt):
            continue
        dist_km = _haversine(citizen_lat, citizen_lon, zone.lat, zone.lon)
        score   = _legacy_score(zone, dist_km, danger_shape, zone_pt)
        candidates.append((zone, score))
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates


# ---------------------------------------------------------------------------
# Public helpers (unit-testable)
# ---------------------------------------------------------------------------

def escape_time_minutes(
    citizen_lat: float,
    citizen_lon: float,
    zone_polygon_geojson: Optional[Dict[str, Any]],
) -> float:
    zone_shape = _to_shape_from_feature(zone_polygon_geojson)
    return _escape_time_minutes(citizen_lat, citizen_lon, zone_shape)


def classify_shelters(
    safe_zones: List[SafeZone],
    zone_polygon_geojson: Optional[Dict[str, Any]],
    danger_polygon_geojson: Optional[Dict[str, Any]],
) -> Tuple[List[SafeZone], List[SafeZone]]:
    zone_shape   = _to_shape_from_feature(zone_polygon_geojson)
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
# Core scoring
# ---------------------------------------------------------------------------

def _pick_best(
    citizen_lat: float,
    citizen_lon: float,
    candidates: List[SafeZone],
    danger_shape: Optional[Any],
    remaining_minutes: float,
) -> Optional[SafeZone]:
    if not candidates:
        return None
    scored = [
        (sz, _composite_score(citizen_lat, citizen_lon, sz, danger_shape, remaining_minutes))
        for sz in candidates
    ]
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[0][0]


def _composite_score(
    citizen_lat: float,
    citizen_lon: float,
    zone: SafeZone,
    danger_shape: Optional[Any],
    remaining_minutes: float,
) -> float:
    """
    Multi-factor score in [0, 1].  Weights:
      time feasibility  40 %
      safety margin     25 %
      distance          15 %
      capacity slack    12 %
      hazard direction   8 %
    """
    travel_min = _travel_time_min(citizen_lat, citizen_lon, zone.lat, zone.lon)

    # Time feasibility: 1.0 when travel is ≤ 60% of remaining, decays to 0 at 110%
    if remaining_minutes > 0:
        ratio = travel_min / remaining_minutes
        time_score = max(0.0, 1.0 - ratio / 1.1)
    else:
        time_score = 1.0 if travel_min < 3.0 else 0.0

    # Safety margin from danger boundary
    margin_km    = _safety_margin_km(zone, danger_shape)
    safety_score = min(1.0, margin_km / 3.0)

    # Distance (normalised over 8 km)
    dist_km    = _haversine(citizen_lat, citizen_lon, zone.lat, zone.lon)
    dist_score = max(0.0, 1.0 - dist_km / 8.0)

    # Capacity slack — penalise overloaded shelters
    utilisation    = zone.current_occupancy / max(1, zone.capacity)
    capacity_score = max(0.0, 1.0 - min(1.0, utilisation * 1.2))

    # Hazard direction — reward routes AWAY from the danger centroid
    direction_score = _direction_away_score(
        citizen_lat, citizen_lon, zone, danger_shape
    )

    return (
        0.40 * time_score
        + 0.25 * safety_score
        + 0.15 * dist_score
        + 0.12 * capacity_score
        + 0.08 * direction_score
    )


def _travel_time_min(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Estimated walking time (minutes) including road-detour correction."""
    return (_haversine(lat1, lon1, lat2, lon2) * ROAD_DETOUR_FACTOR / WALK_SPEED_KMH) * 60.0


def _safety_margin_km(zone: SafeZone, danger_shape: Optional[Any]) -> float:
    """Distance in km from shelter to the nearest point of the danger boundary."""
    if danger_shape is None:
        return 5.0
    try:
        return danger_shape.boundary.distance(Point(zone.lon, zone.lat)) / 0.009
    except Exception:
        return 5.0


def _direction_away_score(
    citizen_lat: float,
    citizen_lon: float,
    zone: SafeZone,
    danger_shape: Optional[Any],
) -> float:
    """
    Returns a score in [0, 1] that is high when the shelter lies in the
    direction AWAY from the hazard centroid.

    Uses the dot product of two unit vectors:
      v_shelter : citizen → shelter
      v_safe    : citizen → opposite of danger centroid (away from danger)

    score = (dot + 1) / 2  maps the [-1, 1] dot product to [0, 1].
    A score of 1.0 means the shelter is exactly opposite the danger;
    0.5 means perpendicular; 0.0 means directly toward the hazard.
    """
    if danger_shape is None:
        return 0.5  # neutral — no hazard to orient against

    try:
        centroid   = danger_shape.centroid
        danger_lat = centroid.y
        danger_lon = centroid.x
    except Exception:
        return 0.5

    cos_lat = math.cos(math.radians(citizen_lat))

    # Unit vector: citizen → shelter
    sx = (zone.lon - citizen_lon) * cos_lat
    sy = zone.lat - citizen_lat
    sm = math.sqrt(sx * sx + sy * sy) or 1.0
    sx /= sm;  sy /= sm

    # Unit vector: citizen → AWAY FROM danger centroid
    dx = -(danger_lon - citizen_lon) * cos_lat
    dy = -(danger_lat - citizen_lat)
    dm = math.sqrt(dx * dx + dy * dy) or 1.0
    dx /= dm;  dy /= dm

    dot = sx * dx + sy * dy           # [-1, 1]
    return (dot + 1.0) / 2.0          # [0, 1]


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _nearest_by_distance(
    lat: float, lon: float, zones: List[SafeZone]
) -> Optional[SafeZone]:
    if not zones:
        return None
    return min(zones, key=lambda z: _haversine(lat, lon, z.lat, z.lon))


def _escape_time_minutes(
    citizen_lat: float, citizen_lon: float, zone_shape: Optional[Any]
) -> float:
    if zone_shape is None:
        return 0.0
    citizen_pt = Point(citizen_lon, citizen_lat)
    if not zone_shape.contains(citizen_pt):
        return 0.0
    boundary_dist_deg = zone_shape.boundary.distance(citizen_pt)
    boundary_dist_km  = boundary_dist_deg / 0.009
    return (boundary_dist_km / WALK_SPEED_KMH) * 60.0


def _legacy_score(
    zone: SafeZone,
    dist_km: float,
    danger_shape: Optional[Any],
    zone_pt: Any,
) -> float:
    dist_score = max(0.0, 1.0 - dist_km / 10.0)
    utilisation    = zone.current_occupancy / max(1, zone.capacity)
    capacity_score = 1.0 - utilisation
    if danger_shape is not None:
        margin_deg   = danger_shape.boundary.distance(zone_pt)
        margin_score = min(1.0, (margin_deg / 0.009) / 5.0)
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
    R    = 6371.0
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
    if geojson is None:
        return None
    try:
        return shape(geojson)
    except Exception:
        return None


def _to_shape_from_feature(geojson: Optional[Dict[str, Any]]) -> Optional[Any]:
    if geojson is None:
        return None
    try:
        if geojson.get("type") == "Feature":
            geojson = geojson.get("geometry") or {}
        return shape(geojson)
    except Exception:
        return None
