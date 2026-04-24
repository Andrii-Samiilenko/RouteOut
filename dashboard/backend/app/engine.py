"""
Singleton simulation engine — all mutable runtime state lives here.

Imported by API routes, WebSocket broadcaster, and the simulation loop.
Never import anything from app.api here to avoid circular imports.
"""
from __future__ import annotations

import math
import random
import time
import uuid
from typing import Any, Dict, List, Optional, Set

from app.api.schemas import (
    CitizenState,
    CitizenStatus,
    DisasterType,
    NotificationCard,
    SafeZone,
    ScenarioState,
    ShelterMarker,
    ShelterType,
    Statistics,
)

# Vegetation zones for fire spread (Barcelona parks + Collserola)
_VEGETATION_ZONES = [
    {"polygon": [(2.08, 41.38), (2.16, 41.38), (2.16, 41.50), (2.08, 41.50)], "vegetation_factor": 0.85},  # Collserola
    {"polygon": [(2.15, 41.40), (2.20, 41.40), (2.20, 41.44), (2.15, 41.44)], "vegetation_factor": 0.50},  # Gràcia parks
    {"polygon": [(2.10, 41.36), (2.17, 41.36), (2.17, 41.39), (2.10, 41.39)], "vegetation_factor": 0.40},  # Montjuïc
    {"polygon": [(2.17, 41.36), (2.22, 41.36), (2.22, 41.40), (2.17, 41.40)], "vegetation_factor": 0.15},  # Dense urban
    {"polygon": [(2.14, 41.39), (2.20, 41.39), (2.20, 41.43), (2.14, 41.43)], "vegetation_factor": 0.12},  # Eixample
]


class SimulationEngine:

    def __init__(self) -> None:
        # ── Scenario ────────────────────────────────────────────────────────
        self.scenario: ScenarioState = ScenarioState()

        # ── Zone geometry from supervisor ────────────────────────────────────
        self.zone_polygon: Optional[Dict[str, Any]] = None   # GeoJSON Polygon

        # ── Shelters (supervisor-placed + demo presets) ──────────────────────
        self.shelters: List[ShelterMarker] = []
        self.safe_zones: List[SafeZone] = []

        # ── Citizens (keyed by citizen_id) ───────────────────────────────────
        self.citizens: Dict[str, CitizenState] = {}

        # ── Route recalculation counter ──────────────────────────────────────
        self._routes_recalculated: int = 0

        # ── Hazard physics ───────────────────────────────────────────────────
        self.fire_simulator: Optional[Any] = None
        self.flood_model: Optional[Any] = None
        self.tsunami_model: Optional[Any] = None

        # Current danger polygons (GeoJSON geometries)
        self.danger_polygon: Optional[Dict[str, Any]] = None
        self.predicted_polygon: Optional[Dict[str, Any]] = None
        self.ash_polygon: Optional[Dict[str, Any]] = None
        self.fire_front_polygon: Optional[Dict[str, Any]] = None

        # ── Road network graph (loaded once at launch) ───────────────────────
        self.graph: Optional[Any] = None

        # ── Notifications feed ───────────────────────────────────────────────
        self._notifications: List[NotificationCard] = []

        # ── WebSocket connections (FastAPI WebSocket objects) ────────────────
        self.ws_connections: Set[Any] = set()

        # ── Notification service reachability ────────────────────────────────
        self.notification_service_online: bool = False

        # ── Background simulation task handle ────────────────────────────────
        self._sim_task: Optional[Any] = None

    # ------------------------------------------------------------------
    # Scenario lifecycle
    # ------------------------------------------------------------------

    def launch(
        self,
        *,
        disaster_type: DisasterType,
        zone_polygon: Dict[str, Any],
        shelters: List[ShelterMarker],
        time_available: int,
        wind_dir_deg: float = 225.0,
        wind_speed_kmh: float = 18.0,
        origin_lat: Optional[float] = None,
        origin_lon: Optional[float] = None,
    ) -> None:
        self.scenario = ScenarioState(
            active=True,
            disaster_type=disaster_type,
            time_available=time_available,
            wind_dir_deg=wind_dir_deg,
            wind_speed_kmh=wind_speed_kmh,
        )
        self.zone_polygon = zone_polygon
        self.shelters = shelters
        self.safe_zones = self._shelters_to_safe_zones(shelters)
        self.citizens = {}
        self._routes_recalculated = 0
        self._notifications = []
        self.danger_polygon = None
        self.predicted_polygon = None
        self.ash_polygon = None
        self.fire_front_polygon = None

        centroid = _polygon_centroid(zone_polygon)
        ign_lat = origin_lat if origin_lat is not None else centroid[0]
        ign_lon = origin_lon if origin_lon is not None else centroid[1]

        self._init_physics(disaster_type, ign_lat, ign_lon)

    def reset(self) -> None:
        self.scenario = ScenarioState()
        self.zone_polygon = None
        self.shelters = []
        self.safe_zones = []
        self.citizens = {}
        self._routes_recalculated = 0
        self._notifications = []
        self.danger_polygon = None
        self.predicted_polygon = None
        self.ash_polygon = None
        self.fire_front_polygon = None
        self.fire_simulator = None
        self.flood_model = None
        self.tsunami_model = None
        self.notification_service_online = False
        if self._sim_task and not self._sim_task.done():
            self._sim_task.cancel()
        self._sim_task = None

    # ------------------------------------------------------------------
    # Physics init
    # ------------------------------------------------------------------

    def _init_physics(
        self, disaster_type: DisasterType, ign_lat: float, ign_lon: float
    ) -> None:
        if disaster_type == DisasterType.fire:
            from app.core.fire_spread import FireSpreadSimulator
            self.fire_simulator = FireSpreadSimulator(
                vegetation_zones=_VEGETATION_ZONES,
                spread_rate="high",   # faster spread = better demo visibility
            )
            # Ignite at the Collserola ridge (high-veg zone), ignoring user origin
            # for fire so the demo always looks good — forest fire spreading downhill
            fire_lat = 41.432
            fire_lon = 2.126
            # Ignite multiple points along ridge for an impressive start
            for dlat, dlon in [(0, 0), (0.008, -0.005), (-0.006, 0.007), (0.012, 0.003)]:
                self.fire_simulator.ignite(fire_lat + dlat, fire_lon + dlon)
            # Pre-run 3 ticks so fire is clearly visible from the start
            self.fire_simulator.tick(
                wind_dir_deg=self.scenario.wind_dir_deg,
                wind_speed_kmh=self.scenario.wind_speed_kmh,
                n_steps=3,
            )
            self.danger_polygon = self.fire_simulator.get_danger_geojson()
            self.fire_front_polygon = self.fire_simulator.get_fire_front_geojson()
            self.ash_polygon = self.fire_simulator.get_ash_geojson()
            self.predicted_polygon = self.fire_simulator.get_predicted_geojson(
                self.scenario.wind_dir_deg, self.scenario.wind_speed_kmh
            )

        elif disaster_type == DisasterType.flood:
            from app.core.flood_model import FloodModel
            self.flood_model = FloodModel()
            self.flood_model.advance()
            self.danger_polygon = self.flood_model.get_flood_geojson()
            self.predicted_polygon = self.flood_model.get_predicted_geojson()

        elif disaster_type == DisasterType.tsunami:
            from app.core.tsunami_model import TsunamiModel
            self.tsunami_model = TsunamiModel()
            self.tsunami_model.advance()
            self.danger_polygon = self.tsunami_model.get_inundation_geojson()
            self.predicted_polygon = self.tsunami_model.get_predicted_geojson()

    # ------------------------------------------------------------------
    # Virtual evacuee spawning
    # ------------------------------------------------------------------

    def spawn_virtual_evacuees(self, count: int = 80) -> None:
        """
        Spawn virtual evacuees inside the evacuation zone.
        Uses A* to route each to the best-scoring shelter considering:
          - walking distance (weighted 35%)
          - shelter capacity slack (weighted 25%)
          - safety margin from danger (weighted 30%)
          - shelter type accessibility (weighted 10%)
        """
        if self.graph is None or not self.safe_zones:
            return

        from app.core import pathfinder, safe_zones as sz_selector

        bbox = _polygon_bbox(self.zone_polygon) if self.zone_polygon else {
            "lat_min": 41.35, "lat_max": 41.43,
            "lon_min": 2.10,  "lon_max": 2.20,
        }

        spawned = 0
        attempts = 0
        while spawned < count and attempts < count * 4:
            attempts += 1
            lat = random.uniform(bbox["lat_min"], bbox["lat_max"])
            lon = random.uniform(bbox["lon_min"], bbox["lon_max"])

            # Skip positions already engulfed by danger
            if self.danger_polygon and _point_in_geojson(lat, lon, self.danger_polygon):
                continue

            target = sz_selector.select_best_zone(
                lat, lon, self.safe_zones, self.danger_polygon
            )
            if target is None:
                continue

            cid = f"v-{spawned:04d}"
            mock = CitizenState(citizen_id=cid, lat=lat, lon=lon)
            route = pathfinder.build_route(
                self.graph, mock, target, self.danger_polygon,
                self.predicted_polygon, list(self.citizens.values()),
            )
            if route is None:
                continue

            dist, time_min = pathfinder.route_distance_and_time(route)

            # Update shelter occupancy
            for zone in self.safe_zones:
                if zone.id == target.id:
                    zone.current_occupancy += 1
                    break

            self.citizens[cid] = CitizenState(
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
            spawned += 1

    # ------------------------------------------------------------------
    # Per-tick physics advance (called by simulation loop)
    # ------------------------------------------------------------------

    def advance_physics(self) -> None:
        dt = self.scenario.disaster_type
        if dt == DisasterType.fire and self.fire_simulator:
            self.fire_simulator.tick(
                wind_dir_deg=self.scenario.wind_dir_deg,
                wind_speed_kmh=self.scenario.wind_speed_kmh,
            )
            self.danger_polygon     = self.fire_simulator.get_danger_geojson()
            self.fire_front_polygon = self.fire_simulator.get_fire_front_geojson()
            self.ash_polygon        = self.fire_simulator.get_ash_geojson()
            self.predicted_polygon  = self.fire_simulator.get_predicted_geojson(
                self.scenario.wind_dir_deg, self.scenario.wind_speed_kmh
            )
        elif dt == DisasterType.flood and self.flood_model:
            self.flood_model.advance()
            self.danger_polygon    = self.flood_model.get_flood_geojson()
            self.predicted_polygon = self.flood_model.get_predicted_geojson()
        elif dt == DisasterType.tsunami and self.tsunami_model:
            self.tsunami_model.advance()
            self.danger_polygon    = self.tsunami_model.get_inundation_geojson()
            self.predicted_polygon = self.tsunami_model.get_predicted_geojson()

    # ------------------------------------------------------------------
    # Statistics
    # ------------------------------------------------------------------

    def recompute_statistics(self) -> Statistics:
        evacuating = sum(
            1 for c in self.citizens.values() if c.status == CitizenStatus.evacuating
        )
        reached = sum(
            1 for c in self.citizens.values() if c.status == CitizenStatus.reached_safety
        )
        total = len(self.citizens)
        remaining_times = [
            c.time_minutes for c in self.citizens.values()
            if c.status == CitizenStatus.evacuating and c.time_minutes > 0
        ]
        clearance = max(remaining_times) if remaining_times else 0.0
        return Statistics(
            evacuating=evacuating,
            reached_safety=reached,
            routes_recalculated=self._routes_recalculated,
            clearance_minutes=clearance,
            virtual_agents_total=total,
        )

    def increment_routes_recalculated(self) -> None:
        self._routes_recalculated += 1

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------

    def add_notification(self, card: NotificationCard) -> None:
        self._notifications.insert(0, card)
        if len(self._notifications) > 50:
            self._notifications = self._notifications[:50]

    def get_notifications(self) -> List[NotificationCard]:
        return list(self._notifications)

    # ------------------------------------------------------------------
    # GeoJSON helpers
    # ------------------------------------------------------------------

    def citizens_geojson(self) -> Dict[str, Any]:
        features = []
        for c in self.citizens.values():
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [c.lon, c.lat]},
                "properties": {
                    "citizen_id":       c.citizen_id,
                    "status":           c.status.value,
                    "destination":      c.destination_name,
                    "distance_km":      c.distance_km,
                    "time_minutes":     c.time_minutes,
                    "route_version":    c.route_version,
                },
            })
        return {"type": "FeatureCollection", "features": features}

    def routes_geojson(self) -> Dict[str, Any]:
        features = []
        for c in self.citizens.values():
            if c.route_geojson is None or c.status != CitizenStatus.evacuating:
                continue
            feat = dict(c.route_geojson)
            feat["properties"] = {
                **(feat.get("properties") or {}),
                "citizen_id":    c.citizen_id,
                "route_version": c.route_version,
                "destination":   c.destination_name,
                "time_minutes":  c.time_minutes,
            }
            features.append(feat)
        return {"type": "FeatureCollection", "features": features}

    def safe_zones_geojson(self) -> Dict[str, Any]:
        features = []
        for zone in self.safe_zones:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [zone.lon, zone.lat]},
                "properties": {
                    "id":                zone.id,
                    "name":              zone.name,
                    "capacity":          zone.capacity,
                    "current_occupancy": zone.current_occupancy,
                    "utilisation":       round(zone.utilisation, 3),
                    "elevation_m":       zone.elevation_m,
                    "shelter_type":      zone.shelter_type.value,
                },
            })
        return {"type": "FeatureCollection", "features": features}

    def shelters_geojson(self) -> Dict[str, Any]:
        features = []
        for s in self.shelters:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [s.lon, s.lat]},
                "properties": {
                    "id":           s.id,
                    "name":         s.name,
                    "capacity":     s.capacity,
                    "shelter_type": s.shelter_type.value,
                },
            })
        return {"type": "FeatureCollection", "features": features}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _shelters_to_safe_zones(shelters: List[ShelterMarker]) -> List[SafeZone]:
        zones = []
        for s in shelters:
            # Elevation: rough heuristic by type + location
            elevation = 5.0
            if s.shelter_type == ShelterType.hospital:
                elevation = 8.0
            elif s.shelter_type == ShelterType.assembly:
                elevation = 3.0
            zones.append(SafeZone(
                id=s.id,
                name=s.name,
                lat=s.lat,
                lon=s.lon,
                capacity=s.capacity,
                current_occupancy=0,
                elevation_m=elevation,
                shelter_type=s.shelter_type,
            ))
        return zones


# Module-level singleton
engine = SimulationEngine()


# ------------------------------------------------------------------
# Module-level geometry helpers
# ------------------------------------------------------------------

def _polygon_centroid(geojson: Dict[str, Any]) -> tuple[float, float]:
    """Return (lat, lon) centroid of a GeoJSON Polygon or Feature."""
    if geojson.get("type") == "Feature":
        geojson = geojson["geometry"]
    rings = geojson.get("coordinates", [[]])
    ring = rings[0] if rings else []
    if not ring:
        return 41.39, 2.17
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return sum(lats) / len(lats), sum(lons) / len(lons)


def _polygon_bbox(geojson: Optional[Dict[str, Any]]) -> Dict[str, float]:
    if geojson is None:
        return {"lat_min": 41.35, "lat_max": 41.43, "lon_min": 2.10, "lon_max": 2.20}
    if geojson.get("type") == "Feature":
        geojson = geojson["geometry"]
    rings = geojson.get("coordinates", [[]])
    ring = rings[0] if rings else []
    if not ring:
        return {"lat_min": 41.35, "lat_max": 41.43, "lon_min": 2.10, "lon_max": 2.20}
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    # Add 10% margin so evacuees spawn slightly outside the drawn zone too
    lat_margin = (max(lats) - min(lats)) * 0.1
    lon_margin = (max(lons) - min(lons)) * 0.1
    return {
        "lat_min": min(lats) - lat_margin,
        "lat_max": max(lats) + lat_margin,
        "lon_min": min(lons) - lon_margin,
        "lon_max": max(lons) + lon_margin,
    }


def _point_in_geojson(lat: float, lon: float, geojson: Dict[str, Any]) -> bool:
    """Rough check: is (lat, lon) inside a GeoJSON Polygon/MultiPolygon geometry?"""
    try:
        from shapely.geometry import Point, shape
        geom = shape(geojson)
        return geom.contains(Point(lon, lat))
    except Exception:
        return False
