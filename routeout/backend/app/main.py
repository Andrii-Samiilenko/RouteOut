"""
FastAPI application entry point.

Loads static data at startup via asynccontextmanager lifespan, mounts the
REST router and the /ws WebSocket endpoint.
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.api.schemas import SafeZone
from app.api.websocket import ws_endpoint
from app.engine import engine

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

DATA_DIR = Path(__file__).parent.parent / "data"


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_safe_zones()
    _load_vegetation_zones()
    _load_scenarios()
    _load_graph()

    logger.info(
        "RouteOut ready — %d safe zones, %d scenarios, graph_loaded=%s",
        len(engine.safe_zones),
        len(engine.scenarios),
        engine.graph is not None,
    )
    yield

    engine.scenario.active = False
    for task in (engine._broadcast_task, engine._invalidation_task):
        if task and not task.done():
            task.cancel()


def _load_graph() -> None:
    graph_path = DATA_DIR / "barcelona_graph.graphml"
    if not graph_path.exists():
        logger.warning(
            "barcelona_graph.graphml not found at %s — routing will be disabled. "
            "Run `python backend/download_graph.py` to download it (takes ~15 min).",
            graph_path,
        )
        return

    logger.info("Loading Barcelona street graph from %s …", graph_path)
    try:
        import osmnx as ox

        # ox.load_graphml properly restores OSMnx node attribute types (x/y as floats,
        # length as float, etc.) from the GraphML key metadata — unlike nx.read_graphml.
        engine.graph = ox.load_graphml(str(graph_path))
        logger.info(
            "Graph loaded: %d nodes, %d edges",
            len(engine.graph.nodes),
            len(engine.graph.edges),
        )
    except Exception as exc:
        logger.error("Failed to load graph: %s — routing disabled", exc)


def _load_safe_zones() -> None:
    path = DATA_DIR / "safe_zones.json"
    with open(path) as f:
        engine.safe_zones = [SafeZone(**z) for z in json.load(f)]
    logger.info("Loaded %d safe zones", len(engine.safe_zones))


def _load_vegetation_zones() -> None:
    path = DATA_DIR / "vegetation_zones.json"
    with open(path) as f:
        engine.vegetation_zones = json.load(f)
    logger.info("Loaded %d vegetation zones", len(engine.vegetation_zones))


def _load_scenarios() -> None:
    path = DATA_DIR / "scenarios.json"
    with open(path) as f:
        engine.scenarios = json.load(f)
    logger.info("Loaded %d scenarios", len(engine.scenarios))


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="RouteOut API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await ws_endpoint(websocket, engine)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "graph_loaded": engine.graph is not None,
        "safe_zones": len(engine.safe_zones),
        "scenario_active": engine.scenario.active,
        "citizens": len(engine.citizens),
    }
