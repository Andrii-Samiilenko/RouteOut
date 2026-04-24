"""
Danger-aware A* pathfinder.

Builds a weighted NetworkX graph from the pre-downloaded Barcelona OSMnx
GraphML file, then finds the safest pedestrian route for each citizen.

Edge weight strategy:
    base_weight   = edge length in metres
    if edge inside current danger polygon:   weight = INFINITY (impassable)
    if edge inside predicted 15-min polygon: weight *= DANGER_PENALTY (×1000)
    if multiple citizens on same edge:       weight *= 1.1 per extra citizen
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Set, Tuple

import networkx as nx
from shapely.geometry import LineString, Point, shape

from app.api.schemas import CitizenState, SafeZone

DANGER_PENALTY = 1_000.0
CONGESTION_FACTOR = 1.1
WALK_SPEED_KMH = 4.5


def build_route(
    graph: nx.MultiDiGraph,
    citizen: CitizenState,
    target_zone: SafeZone,
    danger_geojson: Optional[Dict[str, Any]],
    predicted_geojson: Optional[Dict[str, Any]],
    all_citizens: List[CitizenState],
) -> Optional[Dict[str, Any]]:
    """
    Compute A* route from citizen position to target_zone.

    Returns a GeoJSON LineString feature dict, or None if no path exists.
    """
    if graph is None:
        return None

    danger_shape = _to_shape(danger_geojson)
    predicted_shape = _to_shape(predicted_geojson)
    congested_edges = _build_congestion_map(graph, all_citizens)

    origin_node = nearest_node(graph, citizen.lat, citizen.lon)
    target_node = nearest_node(graph, target_zone.lat, target_zone.lon)

    if origin_node is None or target_node is None:
        return None

    # Weight function — evaluated per edge during A* search
    def weight_fn(u: int, v: int, edge_data: Dict) -> float:
        length = edge_data.get("length", 50.0)

        # Check impassable
        if danger_shape is not None:
            edge_line = _edge_geometry(graph, u, v, edge_data)
            if edge_line and danger_shape.intersects(edge_line):
                return float("inf")

        w = length

        # Danger penalty for predicted zone
        if predicted_shape is not None:
            edge_line = _edge_geometry(graph, u, v, edge_data)
            if edge_line and predicted_shape.intersects(edge_line):
                w *= DANGER_PENALTY

        # Congestion — look up by coordinate pair (matches _build_congestion_map keys)
        u_data = graph.nodes[u]
        v_data = graph.nodes[v]
        coord_key = (
            round(float(u_data.get("x", 0)), 4),
            round(float(u_data.get("y", 0)), 4),
            round(float(v_data.get("x", 0)), 4),
            round(float(v_data.get("y", 0)), 4),
        )
        coord_key_rev = (coord_key[2], coord_key[3], coord_key[0], coord_key[1])
        extra = congested_edges.get(coord_key, 0) + congested_edges.get(coord_key_rev, 0)
        if extra > 0:
            w *= CONGESTION_FACTOR ** extra

        return w

    try:
        path_nodes = nx.astar_path(
            graph,
            origin_node,
            target_node,
            heuristic=lambda u, v: _node_dist(graph, u, v),
            weight=weight_fn,
        )
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None

    return _nodes_to_geojson(graph, path_nodes)


def route_distance_and_time(route_geojson: Dict[str, Any]) -> Tuple[float, float]:
    """Returns (distance_km, time_minutes) for a LineString GeoJSON feature."""
    coords = route_geojson.get("geometry", {}).get("coordinates", [])
    if len(coords) < 2:
        return 0.0, 0.0
    total_m = sum(
        _haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]) * 1000
        for i in range(len(coords) - 1)
    )
    dist_km = total_m / 1000
    time_min = (dist_km / WALK_SPEED_KMH) * 60
    return round(dist_km, 2), round(time_min, 1)


_node_array_cache: dict = {}  # graph id → (np.ndarray of [[lat,lon],...], node_list)


def nearest_node(graph: nx.MultiDiGraph, lat: float, lon: float) -> Optional[int]:
    """Vectorised numpy nearest-node lookup. Builds coordinate array once per graph."""
    import numpy as np

    gid = id(graph)
    if gid not in _node_array_cache:
        valid_nodes = []
        coords = []
        for node, data in graph.nodes(data=True):
            try:
                coords.append([float(data["y"]), float(data["x"])])
                valid_nodes.append(node)
            except (KeyError, TypeError, ValueError):
                continue
        if not coords:
            return None
        _node_array_cache[gid] = (np.array(coords, dtype=np.float64), valid_nodes)

    arr, node_list = _node_array_cache[gid]
    diffs = arr - np.array([lat, lon])
    idx = int(np.argmin((diffs ** 2).sum(axis=1)))
    return node_list[idx]


def is_route_compromised(
    graph: nx.MultiDiGraph,
    route_geojson: Optional[Dict[str, Any]],
    danger_shape: Any,
) -> bool:
    """True if any segment of the route intersects the danger polygon."""
    if route_geojson is None or danger_shape is None:
        return False
    coords = route_geojson.get("geometry", {}).get("coordinates", [])
    if len(coords) < 2:
        return False
    line = LineString(coords)
    return danger_shape.intersects(line)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _edge_geometry(
    graph: nx.MultiDiGraph, u: int, v: int, data: Dict
) -> Optional[LineString]:
    geom = data.get("geometry")
    if geom is not None:
        return geom
    # Fall back to straight line between node centroids
    u_data = graph.nodes[u]
    v_data = graph.nodes[v]
    if "x" in u_data and "x" in v_data:
        return LineString([
            (float(u_data["x"]), float(u_data["y"])),
            (float(v_data["x"]), float(v_data["y"])),
        ])
    return None


def _node_dist(graph: nx.MultiDiGraph, u: int, v: int) -> float:
    ud, vd = graph.nodes[u], graph.nodes[v]
    dlat = float(ud.get("y", 0)) - float(vd.get("y", 0))
    dlon = float(ud.get("x", 0)) - float(vd.get("x", 0))
    return math.sqrt(dlat ** 2 + dlon ** 2) * 111_000  # approximate metres


def _build_congestion_map(
    graph: nx.MultiDiGraph, citizens: List[CitizenState]
) -> Dict[Tuple[int, int], int]:
    """Counts how many citizens are assigned to each undirected edge."""
    counts: Dict[Tuple[int, int], int] = {}
    for citizen in citizens:
        if citizen.route_geojson is None:
            continue
        coords = citizen.route_geojson.get("geometry", {}).get("coordinates", [])
        for i in range(len(coords) - 1):
            # Use midpoint as proxy — good enough
            key = (
                round(coords[i][0], 4),
                round(coords[i][1], 4),
                round(coords[i + 1][0], 4),
                round(coords[i + 1][1], 4),
            )
            counts[key] = counts.get(key, 0) + 1  # type: ignore[assignment]
    return counts  # type: ignore[return-value]


def _nodes_to_geojson(graph: nx.MultiDiGraph, nodes: List[int]) -> Dict[str, Any]:
    coords = []
    for node in nodes:
        data = graph.nodes[node]
        coords.append([float(data["x"]), float(data["y"])])
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {},
    }


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _to_shape(geojson: Optional[Dict[str, Any]]) -> Optional[Any]:
    if geojson is None:
        return None
    try:
        return shape(geojson)
    except Exception:
        return None
