"""
FastAPI application entry point for the RouteOut supervisor dashboard.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.api.websocket import ws_endpoint
from app.engine import engine

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("RouteOut dashboard backend ready")
    yield


app = FastAPI(title="RouteOut Dashboard API", version="2.0.0", lifespan=lifespan)

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
        "simulation_active": engine.scenario.active,
        "disaster_type": engine.scenario.disaster_type,
        "virtual_evacuees": len(engine.citizens),
        "notification_service_online": engine.notification_service_online,
    }
