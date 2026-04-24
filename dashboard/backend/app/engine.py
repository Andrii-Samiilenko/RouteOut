"""
Singleton simulation engine.

All mutable runtime state lives here — API routes, WebSocket broadcaster,
and any background tasks all import from this one place.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from app.api.schemas import ShelterMarker, SimulationState


class SimulationEngine:
    def __init__(self) -> None:
        # Supervisor-defined simulation configuration
        self.simulation: SimulationState = SimulationState()

        # Active WebSocket connections (FastAPI WebSocket objects)
        self.ws_connections: Set[Any] = set()

        # Cached reachability of the notification service
        self.notification_service_online: bool = False

    def reset(self) -> None:
        self.simulation = SimulationState()
        self.notification_service_online = False

    def shelters_geojson(self) -> Dict[str, Any]:
        features = []
        for s in self.simulation.shelters:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [s.lon, s.lat]},
                "properties": {
                    "id": s.id,
                    "name": s.name,
                    "capacity": s.capacity,
                    "shelter_type": s.shelter_type.value,
                },
            })
        return {"type": "FeatureCollection", "features": features}


# Module-level singleton — import this everywhere
engine = SimulationEngine()
