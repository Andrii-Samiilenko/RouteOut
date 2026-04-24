"""
WebSocket broadcaster.

Single /ws endpoint — both the supervisor dashboard and evacuee PWA connect here.
On connect, immediately sends the full current state snapshot.
broadcast_state() is called every tick by the simulation loop.

Message shape: WebSocketPayload (JSON) — see schemas.py for field documentation.
The evacuee PWA can extract:
  - payload.scenario.active / disaster_type
  - payload.safe_zones (GeoJSON FeatureCollection of shelters with occupancy)
  - payload.danger_geojson (current hazard polygon — for route decisions)
  - payload.predicted_zone (15-min forecast)
  - payload.citizens (virtual + real evacuee positions)
  - payload.routes (all active evacuation routes)
  - payload.statistics
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.schemas import WebSocketPayload

logger = logging.getLogger(__name__)


async def ws_endpoint(websocket: WebSocket, engine: Any) -> None:
    await websocket.accept()
    engine.ws_connections.add(websocket)
    logger.info("WebSocket connected (%d total)", len(engine.ws_connections))

    try:
        await _send_state(websocket, engine)

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            # Support citizen registration message from evacuee PWA
            # Shape: { "type": "register_citizen", "citizen_id": "...", "lat": ..., "lon": ... }
            if message.get("type") == "websocket.receive":
                import json
                try:
                    data = json.loads(message.get("text", "{}"))
                    if data.get("type") == "register_citizen":
                        _handle_citizen_register(engine, data)
                        await _send_state(websocket, engine)
                except Exception:
                    pass

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
    await websocket.send_text(_build_payload(engine))


def _build_payload(engine: Any) -> str:
    stats = engine.recompute_statistics()

    payload = WebSocketPayload(
        scenario=engine.scenario,
        statistics=stats,
        citizens=engine.citizens_geojson()    if engine.scenario.active else None,
        routes=engine.routes_geojson()        if engine.scenario.active else None,
        safe_zones=engine.safe_zones_geojson() if engine.scenario.active else None,
        shelters_geojson=engine.shelters_geojson(),
        fire_front=engine.fire_front_polygon,
        ash_geojson=engine.ash_polygon,
        danger_geojson=engine.danger_polygon,
        predicted_zone=engine.predicted_polygon,
        notifications=engine.get_notifications(),
        notification_service_online=engine.notification_service_online,
    )
    return payload.model_dump_json()


# ------------------------------------------------------------------
# Real citizen registration (from evacuee PWA)
# ------------------------------------------------------------------

def _handle_citizen_register(engine: Any, data: dict) -> None:
    """
    Register a real (human) evacuee connecting from the PWA.
    Routes them to the best available shelter and adds them to citizens dict.
    """
    if not engine.scenario.active or engine.graph is None:
        return

    from app.api.schemas import CitizenState, CitizenStatus
    from app.core import pathfinder, safe_zones as sz_selector

    cid = data.get("citizen_id") or f"real-{len(engine.citizens)}"
    lat = float(data.get("lat", 41.39))
    lon = float(data.get("lon", 2.17))

    if cid in engine.citizens:
        # Update position only
        engine.citizens[cid].lat = lat
        engine.citizens[cid].lon = lon
        return

    target = sz_selector.select_best_zone(lat, lon, engine.safe_zones, engine.danger_polygon)
    if target is None:
        return

    mock = CitizenState(citizen_id=cid, lat=lat, lon=lon)
    route = pathfinder.build_route(
        engine.graph, mock, target,
        engine.danger_polygon, engine.predicted_polygon,
        list(engine.citizens.values()),
    )
    if route is None:
        return

    dist, time_min = pathfinder.route_distance_and_time(route)

    for zone in engine.safe_zones:
        if zone.id == target.id:
            zone.current_occupancy += 1
            break

    engine.citizens[cid] = CitizenState(
        citizen_id=cid,
        lat=lat,
        lon=lon,
        status=CitizenStatus.evacuating,
        route_geojson=route,
        assigned_zone_id=target.id,
        destination_name=target.name,
        distance_km=dist,
        time_minutes=time_min,
        route_version=1,
    )
    logger.info("Real citizen registered: %s → %s (%.1f km)", cid, target.name, dist)
