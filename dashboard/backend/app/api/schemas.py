from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DisasterType(str, Enum):
    fire = "fire"
    flood = "flood"
    tsunami = "tsunami"


class ShelterType(str, Enum):
    shelter = "shelter"
    hospital = "hospital"
    assembly = "assembly"


# ---------------------------------------------------------------------------
# Supervisor sandbox models
# ---------------------------------------------------------------------------

class ShelterMarker(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    capacity: int
    shelter_type: ShelterType = ShelterType.shelter


class LaunchSimulationRequest(BaseModel):
    """Payload the supervisor sends when clicking 'Launch Simulation'."""
    zone_polygon: Dict[str, Any]      # GeoJSON Polygon drawn on the map
    shelters: List[ShelterMarker]     # manually placed shelter markers
    time_available: int               # minutes until area must be clear
    disaster_type: DisasterType


class AlertForwardPayload(BaseModel):
    """Shape forwarded to the notification service POST /trigger-alert."""
    disaster_type: str
    message: str
    shelter: Optional[Dict[str, Any]] = None   # { name, lat, lon }
    path: List[Dict[str, float]] = []          # [{ lat, lng }, ...]


# ---------------------------------------------------------------------------
# Runtime simulation state (held in engine, broadcast over WebSocket)
# ---------------------------------------------------------------------------

class SimulationState(BaseModel):
    active: bool = False
    disaster_type: Optional[DisasterType] = None
    zone_polygon: Optional[Dict[str, Any]] = None
    shelters: List[ShelterMarker] = []
    time_available: Optional[int] = None


class WebSocketPayload(BaseModel):
    simulation: SimulationState = Field(default_factory=SimulationState)
    shelters_geojson: Optional[Dict[str, Any]] = None  # GeoJSON FeatureCollection
    notification_service_online: bool = False
