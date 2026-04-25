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

    engine.launch(
        disaster_type=req.disaster_type,
        zone_polygon=req.zone_polygon,
        shelters=shelters_raw,
        time_available=req.time_available,
        wind_dir_deg=req.wind_dir_deg or 225.0,
        wind_speed_kmh=req.wind_speed_kmh or 18.0,
        origin_lat=req.origin_lat,
        origin_lon=req.origin_lon,
    )

    # Load graph (may be cached)
    _get_graph()

    # Spawn virtual evacuees (runs synchronously — fast enough for demo)
    engine.spawn_virtual_evacuees(count=80)

    # Forward alert to notification service
    best_shelter = shelters_raw[0] if shelters_raw else None
    alert = AlertForwardPayload(
        disaster_type=req.disaster_type.value,
        message=_DISASTER_MESSAGES[req.disaster_type],
        shelter=(
            {"name": best_shelter.name, "lat": best_shelter.lat, "lon": best_shelter.lon}
            if best_shelter else None
        ),
        path=[],
    )
    notif_ok = await _forward_alert(alert)
    engine.notification_service_online = notif_ok

    # Broadcast initial state before the loop ticks
    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    # Start the background simulation loop
    from app.core.invalidation import run_simulation_loop
    task = asyncio.create_task(run_simulation_loop(engine))
    engine._sim_task = task

    return {
        "status": "launched",
        "disaster_type": req.disaster_type,
        "shelters": len(shelters_raw),
        "virtual_evacuees": len(engine.citizens),
        "time_available": req.time_available,
        "notification_forwarded": notif_ok,
    }


@router.post("/simulation/reset")
async def reset_simulation():
    engine = _get_engine()
    engine.reset()

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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _forward_alert(payload: AlertForwardPayload) -> bool:
    # Try https first (notification service runs with self-signed cert), fall back to http
    for url in [
        f"https://localhost:9000/trigger-alert",
        f"http://localhost:9000/trigger-alert",
        f"{NOTIFICATION_SERVICE_URL}/trigger-alert",
    ]:
        try:
            async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
                resp = await client.post(url, json=payload.model_dump())
                resp.raise_for_status()
                logger.info("Alert forwarded to notification service via %s: %s", url, resp.status_code)
                return True
        except Exception as exc:
            logger.warning("Could not reach notification service at %s: %s", url, exc)
    return False
