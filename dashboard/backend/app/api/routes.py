"""
REST API endpoints for the RouteOut supervisor dashboard.

POST /simulation/launch   — supervisor launches a simulation with zone + shelters
POST /simulation/reset    — clear all state
GET  /simulation/state    — full state snapshot (same shape as WS payload)
GET  /health
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from app.api.schemas import (
    AlertForwardPayload,
    DisasterType,
    LaunchSimulationRequest,
    SimulationState,
)

logger = logging.getLogger(__name__)
router = APIRouter()

NOTIFICATION_SERVICE_URL = os.getenv("NOTIFICATION_SERVICE_URL", "http://localhost:9000")

_DISASTER_MESSAGES = {
    DisasterType.fire:    "FIRE EMERGENCY — Evacuate the zone immediately. Follow the marked route to your assigned shelter.",
    DisasterType.flood:   "FLOOD EMERGENCY — Move to higher ground immediately. Follow the marked route to your assigned shelter.",
    DisasterType.tsunami: "TSUNAMI WARNING — Move inland immediately. Do not stop until you reach the designated shelter.",
}


def _get_engine() -> Any:
    from app.engine import engine
    return engine


# ---------------------------------------------------------------------------
# Simulation control
# ---------------------------------------------------------------------------

@router.post("/simulation/launch")
async def launch_simulation(req: LaunchSimulationRequest):
    engine = _get_engine()

    if engine.simulation.active:
        raise HTTPException(400, "Simulation already active. Reset first.")

    # Store simulation state
    engine.simulation = SimulationState(
        active=True,
        disaster_type=req.disaster_type,
        zone_polygon=req.zone_polygon,
        shelters=req.shelters,
        time_available=req.time_available,
    )

    # INTEGRATION POINT: Replace this with A* path computation per citizen.
    # Input:  zone_polygon (GeoJSON Polygon), shelters (List[ShelterMarker]),
    #         time_available (int, minutes)
    # Expected output: List of { citizen_id, path: [{ lat, lng }], assigned_shelter }
    # For now we forward a placeholder route to the notification service.
    computed_path: list = []
    assigned_shelter = req.shelters[0] if req.shelters else None

    # Forward to notification service
    alert_payload = AlertForwardPayload(
        disaster_type=req.disaster_type.value,
        message=_DISASTER_MESSAGES[req.disaster_type],
        shelter=(
            {"name": assigned_shelter.name, "lat": assigned_shelter.lat, "lon": assigned_shelter.lon}
            if assigned_shelter else None
        ),
        path=computed_path,
    )

    notif_ok = await _forward_alert(alert_payload)
    engine.notification_service_online = notif_ok

    from app.api.websocket import broadcast_state
    await broadcast_state(engine)

    return {
        "status": "launched",
        "disaster_type": req.disaster_type,
        "shelters": len(req.shelters),
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _forward_alert(payload: AlertForwardPayload) -> bool:
    """POST payload to the notification service. Returns True on success."""
    url = f"{NOTIFICATION_SERVICE_URL}/trigger-alert"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, json=payload.model_dump())
            resp.raise_for_status()
            logger.info("Alert forwarded to notification service: %s", resp.status_code)
            return True
    except Exception as exc:
        logger.warning("Could not reach notification service at %s: %s", url, exc)
        return False
