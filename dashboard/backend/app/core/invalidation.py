"""
Route invalidation monitor — THE WOW MOMENT.

asyncio background task that runs every TICK_INTERVAL_SECONDS.
For each active citizen route, checks if any segment intersects the updated
danger polygon. If compromised: recalculates A* from estimated current position
and pushes the new route via WebSocket broadcast.

No human presses a button. The system detects and fixes broken routes itself.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any, Dict

from shapely.geometry import shape

from app.api.schemas import CitizenStatus, NotificationCard, SafeZone
from app.core import pathfinder, safe_zones as sz_selector

logger = logging.getLogger(__name__)

TICK_INTERVAL = int(os.getenv("TICK_INTERVAL_SECONDS", "30"))


async def run_simulation_loop(engine: Any) -> None:
    """
    Main simulation loop. Advances physics, checks routes, broadcasts state.
    Runs until the scenario is deactivated or the task is cancelled.
    """
    from app.api.websocket import broadcast_state

    logger.info("Simulation loop started")

    while engine.scenario.active:
        await asyncio.sleep(TICK_INTERVAL)

        if not engine.scenario.active:
            break

        # 1. Advance physics by one tick (5 simulated minutes)
        _advance_physics(engine)

        # 2. Check and fix compromised routes
        await _check_routes(engine)

        # 3. Advance simulated time
        engine.scenario.tick += 1
        engine.scenario.elapsed_minutes += 5.0

        # 4. Recompute stats
        engine.recompute_statistics()

        # 5. Push state to all connected dashboards
        await broadcast_state(engine)

    logger.info("Simulation loop stopped")


def _advance_physics(engine: Any) -> None:
    if engine.hazard_event is None:
        return

    if engine.hazard_event.hazard_type.value == "fire" and engine.fire_simulator:
        engine.fire_simulator.tick(
            wind_dir_deg=engine.hazard_event.wind_direction_deg,
            wind_speed_kmh=engine.hazard_event.wind_speed_kmh,
        )
        engine.danger_polygon = engine.fire_simulator.get_danger_geojson()
        engine.predicted_polygon = engine.fire_simulator.get_predicted_geojson(
            engine.hazard_event.wind_direction_deg,
            engine.hazard_event.wind_speed_kmh,
        )
        engine.ash_polygon = engine.fire_simulator.get_ash_geojson()
        engine.fire_front_polygon = engine.fire_simulator.get_fire_front_geojson()

    elif engine.hazard_event.hazard_type.value == "flood" and engine.flood_model:
        engine.flood_model.advance()
        engine.danger_polygon = engine.flood_model.get_flood_geojson()
        engine.predicted_polygon = engine.flood_model.get_predicted_geojson()


async def _check_routes(engine: Any) -> None:
    """Detect compromised routes; recalculate and push notifications.
    Also marks citizens as reached_safety once elapsed time exceeds their route time."""
    if engine.danger_polygon is None or engine.graph is None:
        return

    danger_shape = shape(engine.danger_polygon)
    citizens_list = list(engine.citizens.values())

    for citizen in citizens_list:
        if citizen.status != CitizenStatus.evacuating:
            continue

        # Mark arrived when simulated elapsed time exceeds original route duration
        if (
            citizen.time_minutes > 0
            and engine.scenario.elapsed_minutes >= citizen.time_minutes
        ):
            citizen.status = CitizenStatus.reached_safety
            continue

        if not pathfinder.is_route_compromised(engine.graph, citizen.route_geojson, danger_shape):
            continue

        # Route is compromised — find new best zone
        old_destination = citizen.destination_name

        new_zone = sz_selector.select_best_zone(
            citizen.lat,
            citizen.lon,
            engine.safe_zones,
            engine.danger_polygon,
        )
        if new_zone is None:
            logger.warning("No safe zone available for citizen %s", citizen.citizen_id)
            continue

        new_route = pathfinder.build_route(
            engine.graph,
            citizen,
            new_zone,
            engine.danger_polygon,
            engine.predicted_polygon,
            citizens_list,
        )
        if new_route is None:
            logger.warning("Could not find route for citizen %s", citizen.citizen_id)
            continue

        dist, time_min = pathfinder.route_distance_and_time(new_route)

        # Decrement old zone occupancy, increment new
        _update_zone_occupancy(engine, citizen.assigned_zone_id, new_zone.id)

        citizen.route_geojson = new_route
        citizen.assigned_zone_id = new_zone.id
        citizen.destination_name = new_zone.name
        citizen.distance_km = dist
        citizen.time_minutes = time_min
        citizen.route_version += 1

        engine.increment_routes_recalculated()

        card = NotificationCard(
            id=str(uuid.uuid4()),
            timestamp=time.time(),
            citizen_id=citizen.citizen_id,
            message=f"Route updated — original path is now inside the danger zone.",
            old_destination=old_destination,
            new_destination=new_zone.name,
        )
        engine.add_notification(card)
        logger.info(
            "Rerouted citizen %s → %s (v%d)",
            citizen.citizen_id,
            new_zone.name,
            citizen.route_version,
        )


def _update_zone_occupancy(engine: Any, old_zone_id: str, new_zone_id: str) -> None:
    for zone in engine.safe_zones:
        if zone.id == old_zone_id and zone.current_occupancy > 0:
            zone.current_occupancy -= 1
        if zone.id == new_zone_id:
            zone.current_occupancy += 1
