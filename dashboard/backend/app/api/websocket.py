"""
WebSocket broadcaster.

Single /ws endpoint. On connect, immediately sends current state snapshot.
broadcast_state() is called by the simulation loop each tick and by the
scenario trigger so the dashboard updates instantly on trigger.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)


async def ws_endpoint(websocket: WebSocket, engine: Any) -> None:
    await websocket.accept()
    engine.ws_connections.add(websocket)
    logger.info("WebSocket connected (%d total)", len(engine.ws_connections))

    try:
        # Immediately send current state so dashboard is populated on connect
        try:
            logger.info("WS: Attempting to send initial state...")
            await _send_state(websocket, engine)
            logger.info("WS: Initial state sent successfully")
        except Exception as exc:
            logger.warning("Failed to send initial state: %s", exc)
            # Don't close — keep the socket open so broadcast_state() can retry

        # Keep connection alive.
        # Use receive() rather than receive_text() so that binary frames,
        # ping/pong frames, and close frames are all handled without raising a
        # KeyError (receive_text does message["text"] which throws on non-text).
        while True:
            message = await websocket.receive()
            logger.info("WS received message: %s", message.get("type"))
            if message.get("type") == "websocket.disconnect":
                logger.info("WS got disconnect message, breaking loop")
                break
            # Any other message type (client pings, stray text) — ignore.

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        engine.ws_connections.discard(websocket)
        logger.info("WebSocket disconnected (%d total)", len(engine.ws_connections))


async def broadcast_state(engine: Any) -> None:
    """Push current simulation state to every connected client."""
    if not engine.ws_connections:
        return

    payload = _build_payload(engine)
    dead: set = set()

    for ws in list(engine.ws_connections):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)

    engine.ws_connections -= dead


async def _send_state(websocket: WebSocket, engine: Any) -> None:
    payload = _build_payload(engine)
    await websocket.send_text(payload)


def _build_payload(engine: Any) -> str:
    from app.api.schemas import ScenarioMeta, Statistics, WebSocketPayload

    payload = WebSocketPayload(
        scenario=engine.scenario,
        danger_polygon=engine.danger_polygon,
        predicted_polygon=engine.predicted_polygon,
        ash_polygon=engine.ash_polygon,
        fire_front_polygon=engine.fire_front_polygon,
        citizens=_citizens_geojson(engine),
        routes=_routes_geojson(engine),
        safe_zones=_safe_zones_geojson(engine),
        statistics=engine.statistics,
        hazard_event=engine.hazard_event,
        llm_log=engine.current_llm_log(),
        notifications=engine.notifications[:20],
        weather=engine.weather,
    )
    return payload.model_dump_json()


def _citizens_geojson(engine: Any) -> dict:
    features = []
    for c in engine.citizens.values():
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [c.lon, c.lat]},
            "properties": {
                "citizen_id": c.citizen_id,
                "status": c.status.value,
                "is_real": c.is_real,
                "destination": c.destination_name,
            },
        })
    return {"type": "FeatureCollection", "features": features}


def _routes_geojson(engine: Any) -> dict:
    features = []
    for c in engine.citizens.values():
        if c.route_geojson is None:
            continue
        route = dict(c.route_geojson)
        props = route.get("properties") or {}
        props.update({
            "citizen_id": c.citizen_id,
            "status": c.status.value,
            "route_version": c.route_version,
            "is_real": c.is_real,
        })
        route["properties"] = props
        features.append(route)
    return {"type": "FeatureCollection", "features": features}


def _safe_zones_geojson(engine: Any) -> dict:
    features = []
    for sz in engine.safe_zones:
        util = sz.current_occupancy / max(1, sz.capacity)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [sz.lon, sz.lat]},
            "properties": {
                "id": sz.id,
                "name": sz.name,
                "capacity": sz.capacity,
                "current_occupancy": sz.current_occupancy,
                "utilisation": round(util, 3),
                "elevation_m": sz.elevation_m,
            },
        })
    return {"type": "FeatureCollection", "features": features}
