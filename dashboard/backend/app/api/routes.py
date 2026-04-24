"""
REST API endpoints.

POST /scenario/trigger     — start a scenario
POST /scenario/advance     — manually advance 5 simulated minutes (demo control)
POST /scenario/reset       — clear all state
GET  /scenario/state       — full state snapshot (same shape as WS payload)
GET  /safe-zones           — list of safe zones with current occupancy
GET  /weather/current      — live AEMET wind data
POST /citizen/join         — citizen shares location, gets initial route
GET  /citizen/{id}/state   — citizen polls for their current route
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.schemas import (
    CitizenJoinRequest,
    CitizenState,
    CitizenStateResponse,
    CitizenStatus,
    LLMLogEntry,
    RouteResponse,
    TriggerRequest,
)
from app.core import pathfinder, safe_zones as sz_selector
from app.core.invalidation import run_simulation_loop
from app.services import aemet

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_engine() -> Any:
    from app.engine import engine
    return engine


# ---------------------------------------------------------------------------
# Scenario control
# ---------------------------------------------------------------------------

@router.post("/scenario/trigger")
async def trigger_scenario(req: TriggerRequest):
    engine = _get_engine()

    if engine.scenario.active:
        raise HTTPException(400, "Scenario already running. Reset first.")

    scenario_def = engine.scenarios.get(req.scenario_id)
    if not scenario_def:
        raise HTTPException(404, f"Unknown scenario: {req.scenario_id}")

    # 1. Fetch live weather
    weather = aemet.get_current_weather()
    engine.weather = weather

    # 2. LLM hazard synthesis
    from app.core.llm_synthesiser import synthesise
    from app.api.schemas import HazardEvent

    inputs = scenario_def["inputs"]
    fallback = scenario_def["fallback_hazard_event"]

    hazard_event, latency_ms, provider = synthesise(inputs, weather or {}, fallback)
    engine.hazard_event = hazard_event

    # 3. Log for dashboard (visible 10 s)
    engine.set_llm_log(LLMLogEntry(
        inputs=inputs,
        hazard_event=hazard_event,
        provider=provider,
        latency_ms=round(latency_ms, 1),
    ))

    # 4. Initialise physics simulator
    if hazard_event.hazard_type.value == "fire":
        from app.core.fire_spread import FireSpreadSimulator
        sim = FireSpreadSimulator(
            engine.vegetation_zones,
            spread_rate=hazard_event.spread_rate.value,
        )
        sim.ignite(hazard_event.origin_lat, hazard_event.origin_lon)
        # Pre-burn: run several ticks so the fire is already an established,
        # visually impressive blaze when the scenario UI first appears.
        sim.tick(hazard_event.wind_direction_deg, hazard_event.wind_speed_kmh, n_steps=4)
        engine.fire_simulator = sim
        engine.danger_polygon = sim.get_danger_geojson()
        engine.predicted_polygon = sim.get_predicted_geojson(
            hazard_event.wind_direction_deg, hazard_event.wind_speed_kmh
        )
        engine.ash_polygon = sim.get_ash_geojson()
        engine.fire_front_polygon = sim.get_fire_front_geojson()
    else:
        from app.core.flood_model import FloodModel
        engine.flood_model = FloodModel()
        engine.danger_polygon = engine.flood_model.get_flood_geojson()
        engine.predicted_polygon = engine.flood_model.get_predicted_geojson()

    # 5. Spawn simulated citizens in affected bbox
    bbox = scenario_def["citizen_spawn_bbox"]
    count = scenario_def.get("citizen_count", 30)
    _spawn_citizens(engine, bbox, count)

    # 7. Activate scenario
    engine.scenario.active = True
    engine.scenario.scenario_id = req.scenario_id
    engine.scenario.elapsed_minutes = 0.0
    engine.scenario.tick = 0

    engine.recompute_statistics()

    # 8. Start background simulation loop
    engine._broadcast_task = asyncio.create_task(run_simulation_loop(engine))

    # 9. Immediate WebSocket broadcast
    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    return {"status": "triggered", "scenario_id": req.scenario_id, "provider": provider}


@router.post("/scenario/advance")
async def advance_scenario():
    """Manually advance 5 simulated minutes. Used by coordinator for demo control."""
    engine = _get_engine()

    if not engine.scenario.active or engine.hazard_event is None:
        raise HTTPException(400, "No active scenario.")

    from app.core.invalidation import _advance_physics, _check_routes

    _advance_physics(engine)
    await _check_routes(engine)
    engine.scenario.tick += 1
    engine.scenario.elapsed_minutes += 5.0
    engine.recompute_statistics()

    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    return {
        "tick": engine.scenario.tick,
        "elapsed_minutes": engine.scenario.elapsed_minutes,
    }


@router.post("/scenario/reset")
async def reset_scenario():
    engine = _get_engine()

    # Cancel background tasks
    if engine._broadcast_task and not engine._broadcast_task.done():
        engine._broadcast_task.cancel()
    if engine._invalidation_task and not engine._invalidation_task.done():
        engine._invalidation_task.cancel()

    engine.reset()

    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    return {"status": "reset"}


@router.get("/scenario/state")
async def get_scenario_state():
    engine = _get_engine()
    from app.api.websocket import _build_payload
    import json
    return json.loads(_build_payload(engine))


# ---------------------------------------------------------------------------
# Static data
# ---------------------------------------------------------------------------

@router.get("/safe-zones")
async def get_safe_zones():
    engine = _get_engine()
    return [sz.model_dump() for sz in engine.safe_zones]


@router.get("/weather/current")
async def get_weather():
    weather = aemet.get_current_weather()
    return weather or {"source": "unavailable"}


# ---------------------------------------------------------------------------
# Citizen endpoints
# ---------------------------------------------------------------------------

@router.post("/citizen/join", response_model=RouteResponse)
async def citizen_join(req: CitizenJoinRequest):
    engine = _get_engine()

    if not engine.scenario.active:
        raise HTTPException(400, "No active scenario. Wait for coordinator to start one.")

    citizen_id = str(uuid.uuid4())[:8]
    citizen = CitizenState(
        citizen_id=citizen_id,
        lat=req.lat,
        lon=req.lon,
        status=CitizenStatus.evacuating,
        is_real=True,
    )

    # Find best safe zone
    target_zone = sz_selector.select_best_zone(
        req.lat, req.lon, engine.safe_zones, engine.danger_polygon
    )
    if target_zone is None:
        raise HTTPException(503, "No safe zones available.")

    # Calculate route
    route = pathfinder.build_route(
        engine.graph,
        citizen,
        target_zone,
        engine.danger_polygon,
        engine.predicted_polygon,
        list(engine.citizens.values()),
    )
    if route is None:
        raise HTTPException(503, "Could not compute evacuation route. Try again.")

    dist, time_min = pathfinder.route_distance_and_time(route)
    citizen.route_geojson = route
    citizen.assigned_zone_id = target_zone.id
    citizen.destination_name = target_zone.name
    citizen.distance_km = dist
    citizen.time_minutes = time_min
    target_zone.current_occupancy += 1

    engine.citizens[citizen_id] = citizen
    engine.recompute_statistics()

    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    return RouteResponse(
        citizen_id=citizen_id,
        route_geojson=route,
        destination_name=target_zone.name,
        distance_km=dist,
        time_minutes=time_min,
        status=CitizenStatus.evacuating,
    )


@router.get("/citizen/{citizen_id}/state", response_model=CitizenStateResponse)
async def get_citizen_state(citizen_id: str):
    engine = _get_engine()
    citizen = engine.citizens.get(citizen_id)
    if citizen is None:
        raise HTTPException(404, "Citizen not found.")

    return CitizenStateResponse(
        citizen_id=citizen.citizen_id,
        status=citizen.status,
        route_geojson=citizen.route_geojson,
        destination_name=citizen.destination_name,
        distance_km=citizen.distance_km,
        time_minutes=citizen.time_minutes,
        route_version=citizen.route_version,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _spawn_citizens(engine: Any, bbox: dict, count: int) -> None:
    """Randomly place simulated citizens within the scenario bounding box."""
    citizens_list = []
    for _ in range(count):
        lat = random.uniform(bbox["lat_min"], bbox["lat_max"])
        lon = random.uniform(bbox["lon_min"], bbox["lon_max"])
        cid = str(uuid.uuid4())[:8]
        citizen = CitizenState(
            citizen_id=cid,
            lat=lat,
            lon=lon,
            status=CitizenStatus.evacuating,
            is_real=False,
        )
        citizens_list.append(citizen)

    # Compute routes in batch
    for citizen in citizens_list:
        target_zone = sz_selector.select_best_zone(
            citizen.lat, citizen.lon, engine.safe_zones, engine.danger_polygon
        )
        if target_zone is None:
            continue

        route = pathfinder.build_route(
            engine.graph,
            citizen,
            target_zone,
            engine.danger_polygon,
            engine.predicted_polygon,
            citizens_list,
        )
        if route is None:
            continue

        dist, time_min = pathfinder.route_distance_and_time(route)
        citizen.route_geojson = route
        citizen.assigned_zone_id = target_zone.id
        citizen.destination_name = target_zone.name
        citizen.distance_km = dist
        citizen.time_minutes = time_min
        target_zone.current_occupancy += 1
        engine.citizens[citizen.citizen_id] = citizen
