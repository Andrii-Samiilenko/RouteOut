from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class HazardType(str, Enum):
    fire = "fire"
    flood = "flood"


class SpreadRate(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class CitizenStatus(str, Enum):
    waiting = "waiting"
    evacuating = "evacuating"
    reached_safety = "reached_safety"


# ---------------------------------------------------------------------------
# Core domain models
# ---------------------------------------------------------------------------

class HazardEvent(BaseModel):
    hazard_type: HazardType
    origin_lat: float
    origin_lon: float
    wind_direction_deg: float
    wind_speed_kmh: float
    spread_rate: SpreadRate
    confidence: float = Field(ge=0.0, le=1.0)
    sources_count: int


class CitizenState(BaseModel):
    citizen_id: str
    lat: float
    lon: float
    status: CitizenStatus = CitizenStatus.waiting
    assigned_zone_id: str = ""
    destination_name: str = ""
    distance_km: float = 0.0
    time_minutes: float = 0.0
    route_geojson: Optional[Dict[str, Any]] = None
    route_version: int = 0
    # Real judge citizen gets a pulsing ring on the map
    is_real: bool = False


class SafeZone(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    capacity: int
    current_occupancy: int = 0
    elevation_m: float
    description: str = ""

    @property
    def utilisation(self) -> float:
        if self.capacity == 0:
            return 0.0
        return self.current_occupancy / self.capacity


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------

class TriggerRequest(BaseModel):
    scenario_id: str


class CitizenJoinRequest(BaseModel):
    lat: float
    lon: float


class RouteResponse(BaseModel):
    citizen_id: str
    route_geojson: Dict[str, Any]
    destination_name: str
    distance_km: float
    time_minutes: float
    status: CitizenStatus


class CitizenStateResponse(BaseModel):
    citizen_id: str
    status: CitizenStatus
    route_geojson: Optional[Dict[str, Any]]
    destination_name: str
    distance_km: float
    time_minutes: float
    route_version: int


# ---------------------------------------------------------------------------
# Simulation-level state (serialised to WebSocket payload)
# ---------------------------------------------------------------------------

class ScenarioMeta(BaseModel):
    active: bool = False
    scenario_id: Optional[str] = None
    elapsed_minutes: float = 0.0
    tick: int = 0


class Statistics(BaseModel):
    evacuating: int = 0
    reached_safety: int = 0
    routes_recalculated: int = 0
    clearance_minutes: float = 0.0


class LLMLogEntry(BaseModel):
    """Shown for 10 s after scenario trigger; includes raw inputs + parsed event."""
    inputs: Dict[str, str]
    hazard_event: HazardEvent
    provider: str
    latency_ms: float


class NotificationCard(BaseModel):
    id: str
    timestamp: float
    citizen_id: str
    message: str
    old_destination: str
    new_destination: str


class WebSocketPayload(BaseModel):
    scenario: ScenarioMeta = Field(default_factory=ScenarioMeta)
    danger_polygon: Optional[Dict[str, Any]] = None
    predicted_polygon: Optional[Dict[str, Any]] = None
    # Fire-specific split: ash (burned out) and active fire front
    ash_polygon: Optional[Dict[str, Any]] = None
    fire_front_polygon: Optional[Dict[str, Any]] = None
    citizens: Optional[Dict[str, Any]] = None      # GeoJSON FeatureCollection
    routes: Optional[Dict[str, Any]] = None         # GeoJSON FeatureCollection
    safe_zones: Optional[Dict[str, Any]] = None     # GeoJSON FeatureCollection
    statistics: Statistics = Field(default_factory=Statistics)
    hazard_event: Optional[HazardEvent] = None
    llm_log: Optional[LLMLogEntry] = None           # None after 10 s TTL
    notifications: List[NotificationCard] = []
    weather: Optional[Dict[str, Any]] = None
