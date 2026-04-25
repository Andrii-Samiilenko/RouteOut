"""
RouteOut Notification Service — standalone FastAPI app on port 9000.

Endpoints:
  POST /trigger-alert       — receives alert from dashboard backend (or curl for demo)
  POST /subscribe           — PWA registers its Web Push subscription
  GET  /vapid-public-key    — PWA fetches the VAPID public key for push registration
  GET  /qr                  — prints the service frontend URL to terminal
  GET  /route               — compute walking route from user GPS to shelter
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
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import numpy as np
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
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
# Graph (cached after first load)
# ---------------------------------------------------------------------------

_graph = None
_graph_node_array: Optional[tuple] = None  # (np.ndarray of [lat,lon], list of node ids)

_GRAPH_CANDIDATES = [
    Path(__file__).parent.parent.parent / "dashboard" / "data" / "barcelona_graph.graphml",
    Path(__file__).parent.parent.parent.parent / "dashboard" / "data" / "barcelona_graph.graphml",
    Path("/Users/andrii_samiilenko/Desktop/HackUPC/RouteOut/dashboard/data/barcelona_graph.graphml"),
]


def _load_graph():
    global _graph, _graph_node_array
    if _graph is not None:
        return _graph
    import networkx as nx
    for candidate in _GRAPH_CANDIDATES:
        if candidate.exists():
            logger.info("Loading road graph from %s", candidate)
            g = nx.read_graphml(str(candidate))
            coords, nodes = [], []
            for nid, data in g.nodes(data=True):
                try:
                    coords.append([float(data["y"]), float(data["x"])])
                    nodes.append(nid)
                except (KeyError, ValueError):
                    pass
            _graph = g
            _graph_node_array = (np.array(coords), nodes)
            logger.info("Graph loaded: %d nodes", g.number_of_nodes())
            return g
    logger.warning("barcelona_graph.graphml not found — /route will return straight line")
    return None


def _nearest_node(lat: float, lon: float):
    if _graph_node_array is None:
        return None
    arr, nodes = _graph_node_array
    idx = int(np.argmin(((arr - [lat, lon]) ** 2).sum(axis=1)))
    return nodes[idx]


def _compute_route(
    from_lat: float, from_lon: float,
    to_lat: float, to_lon: float,
    danger_lat: Optional[float] = None,
    danger_lon: Optional[float] = None,
) -> List[Dict[str, float]]:
    """Return waypoints for a safe walking route, penalising edges near the danger origin."""
    g = _load_graph()
    if g is None:
        return [{"lat": from_lat, "lng": from_lon}, {"lat": to_lat, "lng": to_lon}]

    import networkx as nx
    src = _nearest_node(from_lat, from_lon)
    dst = _nearest_node(to_lat, to_lon)
    if src is None or dst is None or src == dst:
        return [{"lat": from_lat, "lng": from_lon}, {"lat": to_lat, "lng": to_lon}]

    def _edge_weight(u, v, data):
        try:
            base = float(data.get("length", 1))
        except (TypeError, ValueError):
            base = 1.0
        if danger_lat is not None and danger_lon is not None:
            try:
                u_lat = float(g.nodes[u].get("y", danger_lat))
                u_lon = float(g.nodes[u].get("x", danger_lon))
                v_lat = float(g.nodes[v].get("y", danger_lat))
                v_lon = float(g.nodes[v].get("x", danger_lon))
                mid_lat = (u_lat + v_lat) / 2
                mid_lon = (u_lon + v_lon) / 2
                dist_km = math.sqrt(
                    ((mid_lat - danger_lat) * 111) ** 2 +
                    ((mid_lon - danger_lon) * 85) ** 2
                )
                if dist_km < 0.3:
                    base *= 200   # very close to origin — almost impassable
                elif dist_km < 1.0:
                    base *= 30
                elif dist_km < 2.5:
                    base *= 8
                elif dist_km < 5.0:
                    base *= 2
            except Exception:
                pass
        return base

    try:
        path_nodes = nx.shortest_path(g, src, dst, weight=_edge_weight)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return [{"lat": from_lat, "lng": from_lon}, {"lat": to_lat, "lng": to_lon}]

    waypoints = []
    for nid in path_nodes:
        data = g.nodes[nid]
        try:
            waypoints.append({"lat": float(data["y"]), "lng": float(data["x"])})
        except (KeyError, ValueError):
            pass
    if not waypoints:
        return [{"lat": from_lat, "lng": from_lon}, {"lat": to_lat, "lng": to_lon}]
    return waypoints


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AlertPayload(BaseModel):
    disaster_type: str
    message:       str
    shelter:       Dict[str, Any] | None       = None
    shelters:      List[Dict[str, Any]]        = []     # all shelters — phone picks nearest
    path:          List[Dict[str, float]]       = []
    danger_origin: Dict[str, float] | None     = None
    zone_polygon:  Dict[str, Any] | None       = None


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
# Route computation
# ---------------------------------------------------------------------------

@app.post("/clear-alert")
async def clear_alert():
    global last_alert
    last_alert = None
    return {"status": "cleared"}


@app.get("/route")
async def get_route(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
    danger_lat: Optional[float] = Query(None),
    danger_lon: Optional[float] = Query(None),
):
    """Return a safe walking route from user GPS to shelter, avoiding the danger origin."""
    path = _compute_route(from_lat, from_lon, to_lat, to_lon, danger_lat, danger_lon)
    return {"path": path, "waypoints": len(path)}


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
    global ws_connections
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

SSL_CERT = "/tmp/notif_cert.pem"
SSL_KEY  = "/tmp/notif_key.pem"


def _get_local_ip() -> str:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _generate_cert(ip: str) -> bool:
    import subprocess
    try:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", SSL_KEY, "-out", SSL_CERT,
            "-days", "1", "-nodes", "-subj", "/CN=routeout",
            "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost",
        ], capture_output=True, timeout=15, check=True)
        return True
    except Exception as e:
        logger.warning("SSL cert generation failed: %s", e)
        return False


if __name__ == "__main__":
    maybe_generate_keys()
    local_ip = _get_local_ip()

    logger.info("=" * 60)
    logger.info("Notification service: http://%s:%d", local_ip, PORT)
    logger.info("Start tunnel for phones: cloudflared tunnel --url http://localhost:%d", PORT)
    logger.info("=" * 60)
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
