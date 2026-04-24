"""
RouteOut Notification Service — standalone FastAPI app on port 9000.

Endpoints:
  POST /trigger-alert       — receives alert from dashboard backend (or curl for demo)
  POST /subscribe           — PWA registers its Web Push subscription
  GET  /vapid-public-key    — PWA fetches the VAPID public key for push registration
  GET  /qr                  — prints the service frontend URL to terminal
  WS   /ws                  — real-time alert delivery to all connected PWA clients
  GET  /                    — serves the PWA (static index.html)

# INTEGRATION POINT (CAP / Government alerting API):
#   In production, POST /trigger-alert would be replaced (or supplemented) by a
#   listener on a CAP (Common Alerting Protocol) feed from a government authority
#   such as SENAPRED (Chile), IPMA (Portugal), or EU-Alert.
#   The CAP XML would be parsed (e.g. with the `cap-client` library), mapped to
#   our AlertPayload schema, and fed into _broadcast() exactly as the HTTP endpoint
#   does now — making the rest of the system unchanged.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Set

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from push import maybe_generate_keys, send_push, get_vapid_public_key

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "9000"))


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AlertPayload(BaseModel):
    disaster_type: str                      # fire | flood | tsunami
    message: str
    shelter: Dict[str, Any] | None = None  # { name, lat, lon }
    path: List[Dict[str, float]] = []      # [{ lat, lng }, ...]


class PushSubscription(BaseModel):
    endpoint: str
    keys: Dict[str, str]


# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

ws_connections: Set[WebSocket] = set()
push_subscriptions: List[Dict[str, Any]] = []
last_alert: Dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="RouteOut Notification Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Alert endpoint
# ---------------------------------------------------------------------------

@app.post("/trigger-alert")
async def trigger_alert(payload: AlertPayload):
    global last_alert
    last_alert = payload.model_dump()
    logger.info("Alert triggered: %s — broadcasting to %d WS clients, %d push subs",
                payload.disaster_type, len(ws_connections), len(push_subscriptions))

    # 1. WebSocket broadcast to all connected PWA tabs
    # Scalability note: for 100k+ users, replace this in-process loop with a
    # Redis Pub/Sub or Kafka publish so all horizontally-scaled instances fan out.
    await _broadcast(last_alert)

    # 2. Web Push to background-registered subscriptions
    push_payload = json.dumps({"title": f"EMERGENCY: {payload.disaster_type.upper()}", "body": payload.message})
    sent = 0
    for sub in list(push_subscriptions):
        if send_push(sub, push_payload):
            sent += 1

    return {"status": "sent", "ws_clients": len(ws_connections), "push_sent": sent}


# ---------------------------------------------------------------------------
# Push subscription registration
# ---------------------------------------------------------------------------

@app.post("/subscribe")
async def subscribe(sub: PushSubscription):
    push_subscriptions.append(sub.model_dump())
    logger.info("New push subscription registered (%d total)", len(push_subscriptions))
    return {"status": "subscribed"}


@app.get("/vapid-public-key")
async def vapid_public_key():
    key = get_vapid_public_key()
    if not key:
        return JSONResponse({"error": "VAPID not configured"}, status_code=503)
    return {"publicKey": key}


# ---------------------------------------------------------------------------
# QR / URL helper
# ---------------------------------------------------------------------------

@app.get("/qr")
async def qr_endpoint():
    url = f"http://<your-local-ip>:{PORT}"
    print(f"\n{'='*50}")
    print(f"  PWA URL: {url}")
    print(f"  Point judges to this URL (or QR-encode it)")
    print(f"{'='*50}\n")
    return {"url": url, "note": "Replace <your-local-ip> with your machine IP on the WiFi network"}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def ws_handler(websocket: WebSocket):
    await websocket.accept()
    ws_connections.add(websocket)
    logger.info("PWA connected (%d total)", len(ws_connections))

    # Send last alert immediately on connect (so late-joiners still see it)
    if last_alert:
        try:
            await websocket.send_text(json.dumps({"type": "alert", "payload": last_alert}))
        except Exception:
            pass

    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        ws_connections.discard(websocket)
        logger.info("PWA disconnected (%d total)", len(ws_connections))


async def _broadcast(data: Dict[str, Any]) -> None:
    msg = json.dumps({"type": "alert", "payload": data})
    dead: set = set()
    for ws in list(ws_connections):
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    ws_connections -= dead


# ---------------------------------------------------------------------------
# Serve PWA frontend
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    maybe_generate_keys()
    logger.info("Starting notification service on %s:%d", HOST, PORT)
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
