"""
REST API endpoints.

POST /simulation/launch   — supervisor launches simulation
POST /simulation/reset    — clear all state
GET  /simulation/state    — full WS payload snapshot
GET  /simulation/shelters/{disaster_type}  — preset shelters for a scenario
GET  /health
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException

from app.api.schemas import (
    AlertForwardPayload,
    DisasterType,
    LaunchSimulationRequest,
    ShelterMarker,
    ShelterType,
)

logger = logging.getLogger(__name__)
router = APIRouter()

NOTIFICATION_SERVICE_URL = os.getenv("NOTIFICATION_SERVICE_URL", "http://localhost:9000")

# Disaster origin points (where danger radiates from)
_DANGER_ORIGINS = {
    "fire":    {"lat": 41.430, "lon": 2.118},  # Collserola ridge
    "flood":   {"lat": 41.377, "lon": 2.193},  # Barceloneta coast
    "tsunami": {"lat": 41.377, "lon": 2.193},  # Same coast
}

_DISASTER_MESSAGES = {
    DisasterType.fire:    "FIRE EMERGENCY: Evacuate immediately. Follow the marked route to your assigned shelter.",
    DisasterType.flood:   "FLOOD EMERGENCY: Move to higher ground now. Follow your route to the nearest shelter.",
    DisasterType.tsunami: "TSUNAMI WARNING: Move inland immediately — do not stop until you reach shelter.",
}


def _get_engine() -> Any:
    from app.engine import engine
    return engine


def _get_graph() -> Optional[Any]:
    """Load Barcelona OSMnx graph (cached on engine after first load)."""
    engine = _get_engine()
    if engine.graph is not None:
        return engine.graph

    import os
    # Search for the graph file in multiple possible locations
    _here = os.path.dirname(__file__)
    graph_path = None
    for candidate in [
        os.path.join(_here, "../../data/barcelona_graph.graphml"),
        os.path.join(_here, "../../../data/barcelona_graph.graphml"),
        os.path.join(_here, "../../../../data/barcelona_graph.graphml"),
        "/Users/andrii_samiilenko/Desktop/HackUPC/RouteOut/dashboard/data/barcelona_graph.graphml",
        "/Users/andrii_samiilenko/Desktop/HackUPC/RouteOut/data/barcelona_graph.graphml",
    ]:
        if os.path.exists(os.path.abspath(candidate)):
            graph_path = os.path.abspath(candidate)
            break
    if graph_path is None:
        graph_path = os.path.join(_here, "../../data/barcelona_graph.graphml")
    if not os.path.exists(graph_path):
        logger.warning("barcelona_graph.graphml not found — routing disabled")
        return None

    try:
        import networkx as nx
        logger.info("Loading Barcelona road graph…")
        g = nx.read_graphml(graph_path)
        # OSMnx stores coords as node attributes 'x' (lon) and 'y' (lat)
        engine.graph = g
        logger.info("Graph loaded: %d nodes, %d edges", g.number_of_nodes(), g.number_of_edges())
        return g
    except Exception as exc:
        logger.error("Failed to load graph: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Simulation control
# ---------------------------------------------------------------------------

@router.post("/simulation/launch")
async def launch_simulation(req: LaunchSimulationRequest, background_tasks: BackgroundTasks):
    engine = _get_engine()

    if engine.scenario.active:
        raise HTTPException(400, "Simulation already active — reset first.")

    # Load/use shelter presets if no shelters supplied, use demo ones
    shelters_raw = req.shelters
    if not shelters_raw:
        from app.data.demo_shelters import get_shelters
        shelters_raw = [
            ShelterMarker(**s)
            for s in get_shelters(req.disaster_type.value)
        ]
    else:
        shelters_raw = [
            ShelterMarker(
                id=s.id, name=s.name, lat=s.lat, lon=s.lon,
                capacity=s.capacity, shelter_type=s.shelter_type,
            )
            for s in shelters_raw
        ]

    # ── LLM synthesis: read AEMET + scenario text → structured hazard params ──
    llm_result = None
    try:
        import json as _json
        import os as _os
        _scenarios_path = _os.path.join(_os.path.dirname(__file__), "../../data/scenarios.json")
        with open(_os.path.abspath(_scenarios_path)) as f:
            _scenarios = _json.load(f)
        _scenario_key = "tibidabo_wildfire" if req.disaster_type.value == "fire" else "barceloneta_flood"
        _scenario_data = _scenarios.get(_scenario_key, {})
        _inputs = _scenario_data.get("inputs", {
            "aemet": f"{req.disaster_type.value} emergency in Barcelona",
            "tweet": f"Emergency: {req.disaster_type.value} reported in Barcelona",
            "emergency": f"{req.disaster_type.value} hazard — evacuation required",
        })
        _fallback = _scenario_data.get("fallback_hazard_event", {
            "hazard_type": req.disaster_type.value,
            "origin_lat": req.origin_lat or 41.432,
            "origin_lon": req.origin_lon or 2.126,
            "wind_direction_deg": req.wind_dir_deg or 225.0,
            "wind_speed_kmh": req.wind_speed_kmh or 18.0,
            "spread_rate": "high",
            "confidence": 0.85,
            "sources_count": 1,
        })
        from app.services.aemet import get_current_weather
        _weather = get_current_weather() or {}
        from app.core.llm_synthesiser import synthesise
        _hazard, _latency, _provider = synthesise(_inputs, _weather, _fallback)
        from app.api.schemas import LLMSynthesisResult
        llm_result = LLMSynthesisResult(
            provider=_provider,
            confidence=_hazard.confidence,
            latency_ms=_latency,
            spread_rate=_hazard.spread_rate,
            origin_lat=_hazard.origin_lat,
            origin_lon=_hazard.origin_lon,
            wind_dir_deg=_hazard.wind_direction_deg,
            wind_speed_kmh=_hazard.wind_speed_kmh,
            sources_count=_hazard.sources_count,
        )
        # Gemma influences wind at 5% weight — real but imperceptible.
        # Clamp Gemma's values to sane ranges so a bad response can't break physics.
        _base_dir   = req.wind_dir_deg   or 225.0
        _base_speed = req.wind_speed_kmh or 18.0
        _llm_dir    = max(0.0, min(360.0, _hazard.wind_direction_deg))
        _llm_speed  = max(0.0, min(80.0,  _hazard.wind_speed_kmh))
        effective_wind_dir   = _base_dir   * 0.95 + _llm_dir   * 0.05
        effective_wind_speed = _base_speed * 0.95 + _llm_speed * 0.05
        effective_origin_lat = req.origin_lat or None
        effective_origin_lon = req.origin_lon or None
        logger.info(
            "LLM synthesis [%s] %.0f ms | conf=%.2f | wind=%.0f°@%.0f km/h | spread=%s",
            _provider, _latency, _hazard.confidence,
            _hazard.wind_direction_deg, _hazard.wind_speed_kmh, _hazard.spread_rate,
        )
    except Exception as exc:
        logger.warning("LLM synthesis failed, using request defaults: %s", exc)
        effective_wind_dir   = req.wind_dir_deg   or 225.0
        effective_wind_speed = req.wind_speed_kmh or 18.0
        effective_origin_lat = req.origin_lat or None
        effective_origin_lon = req.origin_lon or None

    engine.launch(
        disaster_type=req.disaster_type,
        zone_polygon=req.zone_polygon,
        shelters=shelters_raw,
        time_available=req.time_available,
        wind_dir_deg=effective_wind_dir,
        wind_speed_kmh=effective_wind_speed,
        origin_lat=effective_origin_lat,
        origin_lon=effective_origin_lon,
    )
    engine.llm_synthesis = llm_result

    # Load graph + spawn evacuees off the event loop so launch returns instantly.
    # Evacuees appear on the map within seconds after the response.
    async def _spawn_bg() -> None:
        await asyncio.to_thread(_get_graph)
        await asyncio.to_thread(engine.spawn_virtual_evacuees, 30)
        from app.api.websocket import broadcast_state
        await broadcast_state(engine)

    asyncio.create_task(_spawn_bg())

    # Forward alert to notification service
    all_shelters = [
        {"id": s.id, "name": s.name, "lat": s.lat, "lon": s.lon, "capacity": s.capacity}
        for s in engine.shelters  # use engine.shelters which includes exit points
    ]

    # Pick the best shelter from the zone centroid using the same tier-based logic
    # the simulator uses — this ensures the phone gets a smart default, not just
    # the first shelter in the list (which is often an internal hospital).
    best_shelter_for_alert = _pick_best_alert_shelter(engine, req.time_available)
    best_shelter_dict = (
        {"id": best_shelter_for_alert.id, "name": best_shelter_for_alert.name,
         "lat": best_shelter_for_alert.lat, "lon": best_shelter_for_alert.lon,
         "capacity": best_shelter_for_alert.capacity}
        if best_shelter_for_alert else (all_shelters[0] if all_shelters else None)
    )

    alert = AlertForwardPayload(
        disaster_type=req.disaster_type.value,
        message=_DISASTER_MESSAGES[req.disaster_type],
        shelter=best_shelter_dict,
        shelters=all_shelters,
        path=[],
        danger_origin=_DANGER_ORIGINS.get(req.disaster_type.value),
        zone_polygon=req.zone_polygon,
        time_available=req.time_available,
    )
    # Broadcast initial state to connected WS clients
    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    # Start the background simulation loop
    from app.core.invalidation import run_simulation_loop
    task = asyncio.create_task(run_simulation_loop(engine))
    engine._sim_task = task

    # Forward alert in the background — don't block the HTTP response
    async def _alert_bg() -> None:
        ok = await _forward_alert(alert)
        engine.notification_service_online = ok

    asyncio.create_task(_alert_bg())

    return {
        "status": "launched",
        "disaster_type": req.disaster_type,
        "shelters": len(shelters_raw),
        "virtual_evacuees": len(engine.citizens),
        "time_available": req.time_available,
        "notification_forwarded": "pending",
    }


@router.post("/simulation/reset")
async def reset_simulation():
    engine = _get_engine()
    engine.reset()

    # Clear cached alert on notification service so phones stop showing old alert
    for url in ["https://localhost:9000/clear-alert", "http://localhost:9000/clear-alert"]:
        try:
            async with httpx.AsyncClient(timeout=3.0, verify=False) as client:
                await client.post(url)
            break
        except Exception:
            pass

    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    return {"status": "reset"}


@router.get("/simulation/state")
async def get_simulation_state():
    engine = _get_engine()
    from app.api.websocket import _build_payload
    import json
    return json.loads(_build_payload(engine))


@router.get("/simulation/shelters/{disaster_type}")
async def get_preset_shelters(disaster_type: str):
    """Return the pre-defined shelter list for a given disaster type."""
    valid = {"fire", "flood", "tsunami"}
    if disaster_type not in valid:
        raise HTTPException(400, f"disaster_type must be one of {valid}")
    from app.data.demo_shelters import get_shelters
    return {"disaster_type": disaster_type, "shelters": get_shelters(disaster_type)}


@router.get("/simulation/best-shelter")
async def get_best_shelter(lat: float, lon: float):
    """
    Return the tier-selected best shelter for a citizen at (lat, lon).
    Called by the evacuee PWA after it gets the user's GPS fix so shelter
    selection uses real position rather than zone centroid.
    """
    engine = _get_engine()
    if not engine.scenario.active or not engine.safe_zones:
        raise HTTPException(503, "No active simulation")

    from app.core.safe_zones import select_zone_with_threshold
    best = select_zone_with_threshold(
        lat, lon,
        engine.safe_zones,
        engine.danger_polygon,
        engine.zone_polygon,
        engine.scenario.time_available,
        elapsed_minutes=engine.scenario.elapsed_minutes,
    )
    if best is None:
        raise HTTPException(404, "No suitable shelter found")

    return {
        "id":       best.id,
        "name":     best.name,
        "lat":      best.lat,
        "lon":      best.lon,
        "capacity": best.capacity,
        "is_exit":  best.id.startswith("exit-"),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pick_best_alert_shelter(engine: Any, time_available: int) -> Optional[Any]:
    """
    Use the same tier-based selector to pick the best shelter from the zone centroid.
    This is what gets sent to the phone app as the default shelter recommendation.
    Prefers external shelters and exit points over internal ones.
    """
    if not engine.safe_zones or engine.zone_polygon is None:
        return None
    try:
        from app.engine import _polygon_centroid
        from app.core.safe_zones import select_zone_with_threshold
        centroid_lat, centroid_lon = _polygon_centroid(engine.zone_polygon)
        best = select_zone_with_threshold(
            centroid_lat, centroid_lon,
            engine.safe_zones,
            engine.danger_polygon,
            engine.zone_polygon,
            time_available,
            elapsed_minutes=0.0,
        )
        # Find corresponding ShelterMarker for the dict conversion
        if best:
            for s in engine.shelters:
                if s.id == best.id:
                    return s
    except Exception as exc:
        logger.warning("Could not pick best alert shelter: %s", exc)
    return None


async def _forward_alert(payload: AlertForwardPayload) -> bool:
    for url in [
        "http://localhost:9000/trigger-alert",
        "https://localhost:9000/trigger-alert",
    ]:
        try:
            async with httpx.AsyncClient(timeout=1.5, verify=False) as client:
                resp = await client.post(url, json=payload.model_dump())
                resp.raise_for_status()
                logger.info("Alert forwarded via %s: %s", url, resp.status_code)
                return True
        except Exception as exc:
            logger.warning("Could not reach notification service at %s: %s", url, exc)
    return False
