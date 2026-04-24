"""
WebSocket broadcaster.

Single /ws endpoint. On connect, immediately sends current state snapshot.
broadcast_state() is called after any simulation state change.

Scalability note: for 100k+ concurrent users this broadcaster would be replaced
by a message queue fan-out (Redis Pub/Sub or Kafka) so a single publish reaches
all horizontally-scaled backend instances without per-connection in-process loops.
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
        try:
            await _send_state(websocket, engine)
        except Exception as exc:
            logger.warning("Failed to send initial state: %s", exc)

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        engine.ws_connections.discard(websocket)
        logger.info("WebSocket disconnected (%d total)", len(engine.ws_connections))


async def broadcast_state(engine: Any) -> None:
    """Push current simulation state to every connected dashboard client."""
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
    payload = WebSocketPayload(
        simulation=engine.simulation,
        shelters_geojson=engine.shelters_geojson(),
        notification_service_online=engine.notification_service_online,
    )
    return payload.model_dump_json()
