from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class DisasterType(str, Enum):
    fire    = "fire"
    flood   = "flood"
    tsunami = "tsunami"


class ShelterType(str, Enum):
    shelter    = "shelter"
    hospital   = "hospital"
    assembly   = "assembly"
    exit_point = "exit_point"  # lightweight zone-boundary exit marker


class CitizenStatus(str, Enum):
    evacuating     = "evacuating"
    reached_safety = "reached_safety"
    waiting        = "waiting"


# ---------------------------------------------------------------------------
# Shelter
# ---------------------------------------------------------------------------

class ShelterMarker(BaseModel):
    id:           str
    name:         str
    lat:          float
    lon:          float
    capacity:     int
    shelter_type: ShelterType = ShelterType.shelter
    # Live occupancy — incremented as virtual/real evacuees arrive
    current_occupancy: int = 0

    @property
    def utilisation(self) -> float:
        return self.current_occupancy / max(1, self.capacity)

    @property
    def available_slots(self) -> int:
        return max(0, self.capacity - self.current_occupancy)


# ---------------------------------------------------------------------------
# Safe zone (alias used by pathfinder / safe_zones scorer)
# ---------------------------------------------------------------------------

class SafeZone(BaseModel):
    id:                str
    name:              str
    lat:               float
    lon:               float
    capacity:          int
    current_occupancy: int   = 0
    elevation_m:       float = 5.0
    shelter_type:      ShelterType = ShelterType.shelter

    @property
    def utilisation(self) -> float:
        return self.current_occupancy / max(1, self.capacity)


# ---------------------------------------------------------------------------
# Citizen
# ---------------------------------------------------------------------------

class CitizenState(BaseModel):
    citizen_id:       str
    lat:              float
    lon:              float
    status:           CitizenStatus = CitizenStatus.evacuating
    route_geojson:    Optional[Dict[str, Any]] = None
    assigned_zone_id: Optional[str] = None
    destination_name: Optional[str] = None
    distance_km:      float = 0.0
    time_minutes:     float = 0.0
    route_version:    int   = 0
    # Routing score breakdown shown in tooltips
    score_distance:   float = 0.0
    score_capacity:   float = 0.0
    score_safety:     float = 0.0


# ---------------------------------------------------------------------------
# Notification card
# ---------------------------------------------------------------------------

class NotificationCard(BaseModel):
    id:              str   = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp:       float = Field(default_factory=time.time)
    citizen_id:      str   = ""
    message:         str   = ""
    old_destination: Optional[str] = None
    new_destination: Optional[str] = None


# ---------------------------------------------------------------------------
# Scenario (active simulation session)
# ---------------------------------------------------------------------------

class ScenarioState(BaseModel):
    active:           bool            = False
    disaster_type:    Optional[DisasterType] = None
    time_available:   int             = 30        # minutes
    tick:             int             = 0
    elapsed_minutes:  float           = 0.0
    wind_dir_deg:     float           = 225.0     # SW wind — typical Barcelona summer
    wind_speed_kmh:   float           = 18.0


# ---------------------------------------------------------------------------
# API request bodies
# ---------------------------------------------------------------------------

class ShelterInput(BaseModel):
    """Shelter as sent from the frontend (may lack current_occupancy)."""
    id:           str
    name:         str
    lat:          float
    lon:          float
    capacity:     int
    shelter_type: ShelterType = ShelterType.shelter


class LaunchSimulationRequest(BaseModel):
    zone_polygon:   Dict[str, Any]      # GeoJSON Polygon drawn on the map
    shelters:       List[ShelterInput]  # supervisor-placed shelters
    time_available: int                 # minutes
    disaster_type:  DisasterType
    # Optional ignition / flood origin override (defaults to zone centroid)
    origin_lat:     Optional[float] = None
    origin_lon:     Optional[float] = None
    wind_dir_deg:   Optional[float] = None
    wind_speed_kmh: Optional[float] = None


class AlertForwardPayload(BaseModel):
    disaster_type:  str
    message:        str
    shelter:        Optional[Dict[str, Any]] = None   # kept for backwards compat
    shelters:       List[Dict[str, Any]]     = []     # all available shelters
    path:           List[Dict[str, float]]   = []
    danger_origin:  Optional[Dict[str, float]] = None
    zone_polygon:   Optional[Dict[str, Any]]   = None
    time_available: int                        = 60   # minutes — used by /best-shelter tier logic


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

class Statistics(BaseModel):
    evacuating:           int   = 0
    reached_safety:       int   = 0
    routes_recalculated:  int   = 0
    clearance_minutes:    float = 0.0
    virtual_agents_total: int   = 0


# ---------------------------------------------------------------------------
# WebSocket payload (everything the dashboard and evacuee client need)
# ---------------------------------------------------------------------------

class WebSocketPayload(BaseModel):
    scenario:                  ScenarioState             = Field(default_factory=ScenarioState)
    statistics:                Statistics                = Field(default_factory=Statistics)
    # GeoJSON FeatureCollections / geometries
    citizens:                  Optional[Dict[str, Any]]  = None
    routes:                    Optional[Dict[str, Any]]  = None
    safe_zones:                Optional[Dict[str, Any]]  = None
    shelters_geojson:          Optional[Dict[str, Any]]  = None
    fire_front:                Optional[Dict[str, Any]]  = None
    ash_geojson:               Optional[Dict[str, Any]]  = None
    danger_geojson:            Optional[Dict[str, Any]]  = None
    predicted_zone:            Optional[Dict[str, Any]]  = None
    crowd_flow:                Optional[Dict[str, Any]]  = None
    notifications:             List[NotificationCard]    = []
    notification_service_online: bool                    = False
