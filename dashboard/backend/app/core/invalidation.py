"""
Simulation tick loop — THE core of the demo.

Each tick (TICK_INTERVAL_SECONDS wall-clock seconds = 5 sim-minutes):
  1. Advance hazard physics (fire spread / flood rise / tsunami surge)
  2. Move each virtual evacuee along their route by 375 m
  3. Mark citizens who've completed their route as reached_safety
  4. Detect routes newly compromised by hazard growth → reroute via A*
  5. Recompute statistics
  6. Broadcast full state to all connected WebSocket clients (dashboard + evacuees)
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from shapely.geometry import shape

from app.api.schemas import CitizenStatus, NotificationCard, SafeZone
from app.core import pathfinder, safe_zones as sz_selector

logger = logging.getLogger(__name__)

TICK_INTERVAL = int(os.getenv("TICK_INTERVAL_SECONDS", "1"))  # 1s wall-clock per tick
TICK_SIM_MINUTES = 40.0      # simulated minutes per real-world tick
TICK_ADVANCE_M = 3000.0      # evacuees move 3000 m per tick


async def run_simulation_loop(engine: Any) -> None:
    """
    Main simulation loop. Runs until scenario is deactivated or task cancelled.
    Safe to cancel — all state lives on engine, loop is stateless.
    """
    from app.api.websocket import broadcast_state

    logger.info("Simulation loop started (tick=%ds, sim_min=%.1f)", TICK_INTERVAL, TICK_SIM_MINUTES)

    while engine.scenario.active:
        await asyncio.sleep(TICK_INTERVAL)

        if not engine.scenario.active:
            break

        # 1. Advance physics
        engine.advance_physics()

        # 2. Move virtual evacuees
        _advance_citizens(engine)

        # 3. Check / reroute compromised paths
        await _check_routes(engine)

        # 4. Advance simulated time
        engine.scenario.tick += 1
        engine.scenario.elapsed_minutes += TICK_SIM_MINUTES

        # 5. Stats
        engine.recompute_statistics()

        # 6. Broadcast
        await broadcast_state(engine)

        logger.debug(
            "Tick %d | elapsed %.0f min | evacuating=%d reached=%d reroutes=%d",
            engine.scenario.tick,
            engine.scenario.elapsed_minutes,
            sum(1 for c in engine.citizens.values() if c.status == CitizenStatus.evacuating),
            sum(1 for c in engine.citizens.values() if c.status == CitizenStatus.reached_safety),
            engine._routes_recalculated,
        )

    logger.info("Simulation loop stopped")


# ------------------------------------------------------------------
# Move citizens along their routes
# ------------------------------------------------------------------

def _advance_citizens(engine: Any) -> None:
    """
    Walk each evacuating citizen 375 m along their planned route.
    Uses linear interpolation along the GeoJSON LineString coordinates.
    """
    for citizen in engine.citizens.values():
        if citizen.status != CitizenStatus.evacuating:
            continue
        if citizen.route_geojson is None:
            continue

        coords = citizen.route_geojson.get("geometry", {}).get("coordinates", [])
        if len(coords) < 2:
            citizen.status = CitizenStatus.reached_safety
            _update_zone_on_arrival(engine, citizen.assigned_zone_id)
            continue

        # How far has this citizen already travelled (approximate from position)
        # We track via a simple heuristic: advance distance and find new position
        new_pos = _advance_along_path(coords, citizen.lat, citizen.lon, TICK_ADVANCE_M)
        if new_pos is None:
            # Reached the end
            citizen.status = CitizenStatus.reached_safety
            citizen.lat = coords[-1][1]
            citizen.lon = coords[-1][0]
            _update_zone_on_arrival(engine, citizen.assigned_zone_id)
        else:
            citizen.lat, citizen.lon = new_pos

        # Also check elapsed time vs route time
        if (
            citizen.time_minutes > 0
            and engine.scenario.elapsed_minutes >= citizen.time_minutes
        ):
            citizen.status = CitizenStatus.reached_safety
            citizen.lat = coords[-1][1]
            citizen.lon = coords[-1][0]
            _update_zone_on_arrival(engine, citizen.assigned_zone_id)


def _advance_along_path(
    coords: list,
    current_lat: float,
    current_lon: float,
    advance_m: float,
) -> Optional[tuple[float, float]]:
    """
    Find the position along coords that is advance_m metres ahead of (current_lat, current_lon).
    Returns None when the end of the path is reached.
    """
    # Find closest point on path to current position
    best_i, best_dist = 0, float("inf")
    for i, (plon, plat) in enumerate(coords):
        d = _haversine_m(current_lat, current_lon, plat, plon)
        if d < best_dist:
            best_dist = d
            best_i = i

    # Walk forward advance_m from that segment
    remaining = advance_m
    for i in range(best_i, len(coords) - 1):
        p1 = coords[i]
        p2 = coords[i + 1]
        seg_m = _haversine_m(p1[1], p1[0], p2[1], p2[0])
        if remaining <= seg_m:
            frac = remaining / max(1.0, seg_m)
            lon = p1[0] + frac * (p2[0] - p1[0])
            lat = p1[1] + frac * (p2[1] - p1[1])
            return lat, lon
        remaining -= seg_m

    return None  # past the end


def _update_zone_on_arrival(engine: Any, zone_id: Optional[str]) -> None:
    """Shelter occupancy is already set at spawn; just log here."""
    pass


# ------------------------------------------------------------------
# Route compromise detection + rerouting
# ------------------------------------------------------------------

async def _check_routes(engine: Any) -> None:
    if engine.graph is None:
        return

    danger_shape = None
    if engine.danger_polygon is not None:
        try:
            danger_shape = shape(engine.danger_polygon)
        except Exception:
            pass

    elapsed   = engine.scenario.elapsed_minutes
    remaining = max(1.0, engine.scenario.time_available - elapsed)
    citizens_list = list(engine.citizens.values())

    for citizen in citizens_list:
        if citizen.status != CitizenStatus.evacuating:
            continue

        # ── Trigger 1: route physically intersects the danger polygon ────────
        route_blocked = (
            danger_shape is not None
            and pathfinder.is_route_compromised(engine.graph, citizen.route_geojson, danger_shape)
        )

        # ── Trigger 2: assigned shelter is now engulfed by hazard ────────────
        shelter_engulfed = False
        if danger_shape is not None and citizen.assigned_zone_id:
            for zone in engine.safe_zones:
                if zone.id == citizen.assigned_zone_id:
                    if danger_shape.contains(_shapely_pt(zone.lat, zone.lon)):
                        shelter_engulfed = True
                    break

        # ── Trigger 3: remaining travel time exceeds remaining scenario time ─
        # Citizen was assigned a far shelter but time is running out; switch to
        # something closer (exit point or internal shelter).
        time_overrun = (
            citizen.time_minutes > 0
            and citizen.time_minutes > remaining * 1.15
        )

        if not (route_blocked or shelter_engulfed or time_overrun):
            continue

        reason = (
            "path blocked by hazard" if route_blocked else
            "assigned shelter engulfed by hazard" if shelter_engulfed else
            "insufficient time remaining to reach original destination"
        )
        old_destination = citizen.destination_name

        new_zone = sz_selector.select_zone_with_threshold(
            citizen.lat, citizen.lon,
            engine.safe_zones,
            engine.danger_polygon,
            engine.zone_polygon,
            engine.scenario.time_available,
            elapsed_minutes=elapsed,
        )
        if new_zone is None or new_zone.id == citizen.assigned_zone_id:
            # No better option available — keep current assignment
            continue

        new_route = pathfinder.build_route(
            engine.graph, citizen, new_zone,
            engine.danger_polygon, engine.predicted_polygon,
            citizens_list,
        )
        if new_route is None:
            continue

        dist, time_min = pathfinder.route_distance_and_time(new_route)

        _transfer_zone_occupancy(engine, citizen.assigned_zone_id, new_zone.id)

        citizen.route_geojson    = new_route
        citizen.assigned_zone_id = new_zone.id
        citizen.destination_name = new_zone.name
        citizen.distance_km      = dist
        citizen.time_minutes     = time_min
        citizen.route_version   += 1

        engine.increment_routes_recalculated()

        engine.add_notification(NotificationCard(
            citizen_id=citizen.citizen_id,
            message=f"Route updated — {reason}.",
            old_destination=old_destination,
            new_destination=new_zone.name,
        ))

        logger.info(
            "Rerouted %s → %s (v%d, %.1f km, %.0f min) [%s]",
            citizen.citizen_id, new_zone.name,
            citizen.route_version, dist, time_min, reason,
        )


def _transfer_zone_occupancy(engine: Any, old_id: Optional[str], new_id: str) -> None:
    for zone in engine.safe_zones:
        if zone.id == old_id and zone.current_occupancy > 0:
            zone.current_occupancy -= 1
        if zone.id == new_id:
            zone.current_occupancy += 1


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _shapely_pt(lat: float, lon: float):
    from shapely.geometry import Point
    return Point(lon, lat)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    R = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.asin(max(0.0, a) ** 0.5)
