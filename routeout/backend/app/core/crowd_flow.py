"""
Crowd flow manager for aggregate evacuation visualization.

Spawns virtual agent clusters across the affected area, routes each cluster
via A* to a safe zone, then advances agents each tick.  The output is a
GeoJSON FeatureCollection of street segments colored by flow intensity —
replacing individual citizen dots on the coordinator map.

Design:
  - CLUSTER_COUNT clusters × AGENTS_PER_CLUSTER agents = ~400 total agents
  - One A* call per cluster (not per agent) for performance
  - Agents spread across their cluster's path so flow is non-uniform from tick 1
  - Each tick: agents advance 375 m (5 min × 4.5 km/h)
  - Compromised cluster paths are rerouted automatically
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional

from shapely.geometry import LineString, shape as shapely_shape


CLUSTER_COUNT = 25
AGENTS_PER_CLUSTER = 16
TICK_ADVANCE_M = 375.0      # 5 simulated minutes at 4.5 km/h
EMPTY_FC: Dict[str, Any] = {"type": "FeatureCollection", "features": []}


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(max(0.0, a)))


def _path_length_m(coords: List[List[float]]) -> float:
    total = 0.0
    for i in range(len(coords) - 1):
        total += _haversine_m(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
    return max(1.0, total)


def _position_at_distance(coords: List[List[float]], target_m: float) -> Optional[List[float]]:
    """Return [lon, lat] at `target_m` metres along a path."""
    cumulative = 0.0
    for i in range(len(coords) - 1):
        seg_m = _haversine_m(
            coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]
        )
        if cumulative + seg_m >= target_m:
            frac = (target_m - cumulative) / max(1.0, seg_m)
            lon = coords[i][0] + frac * (coords[i + 1][0] - coords[i][0])
            lat = coords[i][1] + frac * (coords[i + 1][1] - coords[i][1])
            return [lon, lat]
        cumulative += seg_m
    return coords[-1] if coords else None


# ------------------------------------------------------------------
# CrowdFlowManager
# ------------------------------------------------------------------

class CrowdFlowManager:

    def __init__(self, graph: Any, safe_zones: List[Any]) -> None:
        self.graph = graph
        self.safe_zones = safe_zones
        # Each agent: dict with path_coords, total_len_m, progress_m,
        #              status ('active'|'arrived'), cluster_id
        self.agents: List[Dict[str, Any]] = []
        # cluster_id → current path_coords (list of [lon, lat])
        self.cluster_paths: Dict[int, List[List[float]]] = {}
        self._flow_geojson: Dict[str, Any] = EMPTY_FC

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def spawn(
        self,
        bbox: Dict[str, float],
        danger_geojson: Optional[Dict[str, Any]],
        predicted_geojson: Optional[Dict[str, Any]],
    ) -> None:
        """Spawn agent clusters within `bbox`.  Safe to call even if graph is None."""
        if self.graph is None:
            return

        from app.core import pathfinder
        from app.core import safe_zones as sz_selector
        from app.api.schemas import CitizenState, CitizenStatus

        self.agents = []
        self.cluster_paths = {}

        for cluster_id in range(CLUSTER_COUNT):
            lat = random.uniform(bbox["lat_min"], bbox["lat_max"])
            lon = random.uniform(bbox["lon_min"], bbox["lon_max"])

            mock = CitizenState(
                citizen_id=f"cf_{cluster_id}",
                lat=lat, lon=lon,
                status=CitizenStatus.evacuating,
            )
            target = sz_selector.select_best_zone(lat, lon, self.safe_zones, danger_geojson)
            if target is None:
                continue

            route = pathfinder.build_route(
                self.graph, mock, target, danger_geojson, predicted_geojson, []
            )
            if route is None:
                continue

            path_coords: List[List[float]] = route["geometry"]["coordinates"]
            total_m = _path_length_m(path_coords)
            self.cluster_paths[cluster_id] = path_coords

            for j in range(AGENTS_PER_CLUSTER):
                # Stagger initial progress so agents are spread along the path
                initial_m = (j / AGENTS_PER_CLUSTER) * min(TICK_ADVANCE_M * 2, total_m * 0.4)
                self.agents.append({
                    "path_coords": path_coords,
                    "total_len_m": total_m,
                    "progress_m": initial_m,
                    "status": "active",
                    "cluster_id": cluster_id,
                })

        self._recompute_flow()

    def tick(
        self,
        danger_geojson: Optional[Dict[str, Any]],
        predicted_geojson: Optional[Dict[str, Any]],
    ) -> None:
        """Advance all agents one simulation tick (375 m).  Reroute blocked clusters."""
        if not self.agents:
            return

        # Advance progress
        for agent in self.agents:
            if agent["status"] != "active":
                continue
            agent["progress_m"] += TICK_ADVANCE_M
            if agent["progress_m"] >= agent["total_len_m"]:
                agent["status"] = "arrived"

        # Reroute clusters whose path intersects danger zone
        if danger_geojson:
            self._reroute_blocked_clusters(danger_geojson, predicted_geojson)

        self._recompute_flow()

    def get_flow_geojson(self) -> Dict[str, Any]:
        return self._flow_geojson

    def active_agent_count(self) -> int:
        return sum(1 for a in self.agents if a["status"] == "active")

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _reroute_blocked_clusters(
        self,
        danger_geojson: Dict[str, Any],
        predicted_geojson: Optional[Dict[str, Any]],
    ) -> None:
        from app.core import pathfinder
        from app.core import safe_zones as sz_selector
        from app.api.schemas import CitizenState, CitizenStatus

        danger_shape = shapely_shape(danger_geojson)

        for cluster_id, path_coords in list(self.cluster_paths.items()):
            if len(path_coords) < 2:
                continue
            line = LineString(path_coords)
            if not danger_shape.intersects(line):
                continue

            # Find average progress of active agents in this cluster
            cluster_agents = [
                a for a in self.agents
                if a["cluster_id"] == cluster_id and a["status"] == "active"
            ]
            if not cluster_agents:
                continue

            avg_progress = sum(a["progress_m"] for a in cluster_agents) / len(cluster_agents)
            current_pos = _position_at_distance(path_coords, avg_progress)
            if current_pos is None:
                continue

            mock = CitizenState(
                citizen_id=f"cf_{cluster_id}_r",
                lat=current_pos[1], lon=current_pos[0],
                status=CitizenStatus.evacuating,
            )
            target = sz_selector.select_best_zone(
                current_pos[1], current_pos[0], self.safe_zones, danger_geojson
            )
            if target is None:
                continue

            new_route = pathfinder.build_route(
                self.graph, mock, target, danger_geojson, predicted_geojson, []
            )
            if new_route is None:
                continue

            new_path: List[List[float]] = new_route["geometry"]["coordinates"]
            new_len = _path_length_m(new_path)
            self.cluster_paths[cluster_id] = new_path

            for agent in cluster_agents:
                agent["path_coords"] = new_path
                agent["total_len_m"] = new_len
                agent["progress_m"] = 0.0

    def _recompute_flow(self) -> None:
        """Aggregate active agent positions into per-segment flow counts."""
        segment_counts: Dict[tuple, int] = {}

        for agent in self.agents:
            if agent["status"] != "active":
                continue

            path = agent["path_coords"]
            progress = agent["progress_m"]

            if len(path) < 2:
                continue

            # Walk path to find the segment the agent is currently on
            cumulative = 0.0
            for i in range(len(path) - 1):
                p1, p2 = path[i], path[i + 1]
                seg_m = _haversine_m(p1[1], p1[0], p2[1], p2[0])
                if progress <= cumulative + seg_m or i == len(path) - 2:
                    key = (
                        round(p1[0], 4), round(p1[1], 4),
                        round(p2[0], 4), round(p2[1], 4),
                    )
                    segment_counts[key] = segment_counts.get(key, 0) + 1
                    break
                cumulative += seg_m

        if not segment_counts:
            self._flow_geojson = EMPTY_FC
            return

        max_count = max(segment_counts.values())
        features = []
        for (lon1, lat1, lon2, lat2), count in segment_counts.items():
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon1, lat1], [lon2, lat2]],
                },
                "properties": {
                    "flow_count": count,
                    "flow_intensity": round(count / max_count, 3),
                },
            })

        self._flow_geojson = {"type": "FeatureCollection", "features": features}
