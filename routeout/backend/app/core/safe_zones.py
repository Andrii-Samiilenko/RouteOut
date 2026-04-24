"""
Safe zone selector.

Given the current danger polygon (Shapely geometry) and a list of SafeZone
objects, scores the remaining safe zones and returns them ranked best-first.

Scoring weights (must sum to 1.0):
    distance         35%
    capacity slack   25%
    safety margin    30%
    accessibility    10%
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from shapely.geometry import Point, shape

from app.api.schemas import SafeZone


def select_best_zone(
    citizen_lat: float,
    citizen_lon: float,
    safe_zones: List[SafeZone],
    danger_polygon_geojson: Optional[Dict[str, Any]],
) -> Optional[SafeZone]:
    """
    Returns the highest-scoring zone that does not overlap the danger polygon.
    Returns None only if every zone is inside the danger zone (shouldn't happen).
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
) -> List[tuple[SafeZone, float]]:
    """Returns list of (zone, score) sorted by score descending, excluding overlapping zones."""
    citizen_pt = Point(citizen_lon, citizen_lat)

    candidates = []
    for zone in safe_zones:
        zone_pt = Point(zone.lon, zone.lat)

        # Skip zones engulfed by the danger polygon
        if danger_shape is not None and danger_shape.contains(zone_pt):
            continue

        dist_km = _haversine(citizen_lat, citizen_lon, zone.lat, zone.lon)
        score = _score(zone, dist_km, danger_shape, zone_pt)
        candidates.append((zone, score))

    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates


def _score(
    zone: SafeZone,
    dist_km: float,
    danger_shape: Optional[Any],
    zone_pt: Any,
) -> float:
    # Distance: closer is better; normalise against 10 km max
    dist_score = max(0.0, 1.0 - dist_km / 10.0)

    # Capacity slack: less utilised is better
    utilisation = zone.current_occupancy / max(1, zone.capacity)
    capacity_score = 1.0 - utilisation

    # Safety margin: distance from danger edge (buffer in degrees ≈ km * 0.009)
    if danger_shape is not None:
        margin_deg = danger_shape.boundary.distance(zone_pt)
        # 0.009° ≈ 1 km; cap benefit at 5 km
        margin_km = margin_deg / 0.009
        margin_score = min(1.0, margin_km / 5.0)
    else:
        margin_score = 1.0

    # Accessibility: crude proxy — higher elevation → less accessible for flood scenarios
    # For fire: elevation is irrelevant, give equal weight
    accessibility_score = min(1.0, 1.0 - zone.elevation_m / 500.0)

    total = (
        0.35 * dist_score
        + 0.25 * capacity_score
        + 0.30 * margin_score
        + 0.10 * accessibility_score
    )
    return total


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _to_shape(geojson: Optional[Dict[str, Any]]) -> Optional[Any]:
    if geojson is None:
        return None
    try:
        return shape(geojson)
    except Exception:
        return None
