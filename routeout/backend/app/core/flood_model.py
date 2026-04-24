"""
Coastal flood propagation model (Scenario 2 — Barceloneta).

Water level rises 0 → 3.5 m over 20 simulated minutes.
Flood uses a BFS from the coastline, spreading INLAND only — sea cells are
excluded via a land/sea mask so the flood never "spills into the ocean."

DEM design:
  - Barcelona coast line: lon ≈ 2.192 + (lat - 41.374) * 0.25 (rough diagonal)
  - Sea cells (east of line): elevation = 100 m  → never flood
  - Land cells: elevation = 0.5 + inland_distance_m * 0.004
      coast (0 m inland)  → 0.5 m   (floods at tick 1, water=1.2 m)
      250 m inland        → 1.5 m   (floods at tick 2, water=2.0 m)
      500 m inland        → 2.5 m   (floods at tick 3, water=2.8 m)
      750 m inland        → 3.5 m   (floods at tick 4, water=3.5 m)
  This creates a progressive strip flood from beach inward through
  Barceloneta → El Born → Sant Pere, matching real Barcelona topography.
"""
from __future__ import annotations

import math
import os
from collections import deque
from typing import Any, Dict, Optional

import numpy as np
from shapely.geometry import mapping
from shapely.ops import unary_union


ELEVATION_RASTER_PATH = os.path.join(
    os.path.dirname(__file__), "../../data/barcelona_dem.tif"
)

_RISE_SCHEDULE = {0: 0.5, 1: 1.2, 2: 2.0, 3: 2.8, 4: 3.5}

_BFS_DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


class FloodModel:
    LAT_MIN, LAT_MAX = 41.30, 41.50
    LON_MIN, LON_MAX = 2.05, 2.28
    CELL_SIZE_M = 50

    _LAT_PER_CELL = CELL_SIZE_M / 111_000
    _LON_PER_CELL = CELL_SIZE_M / (111_000 * math.cos(math.radians(41.4)))

    # BFS origin — on the coast, elevation ≈ 0.5 m
    _COAST_LAT = 41.374
    _COAST_LON = 2.192

    def __init__(self) -> None:
        self.grid_h = int((self.LAT_MAX - self.LAT_MIN) / self._LAT_PER_CELL) + 1
        self.grid_w = int((self.LON_MAX - self.LON_MIN) / self._LON_PER_CELL) + 1
        self.elevation_grid = self._load_elevation()
        self.current_water_level: float = 0.0
        self.tick: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def advance(self) -> None:
        self.tick += 1
        self.current_water_level = _RISE_SCHEDULE.get(
            self.tick, self.current_water_level + 0.5
        )

    def get_flood_geojson(self) -> Optional[Dict[str, Any]]:
        mask = self._bfs_flood(self.current_water_level)
        return self._mask_to_geojson(mask)

    def get_predicted_geojson(self, steps_ahead: int = 3) -> Optional[Dict[str, Any]]:
        future_level = _RISE_SCHEDULE.get(
            self.tick + steps_ahead, self.current_water_level + steps_ahead * 0.5
        )
        mask = self._bfs_flood(future_level)
        return self._mask_to_geojson(mask)

    def node_elevation(self, lat: float, lon: float) -> float:
        r, c = self._coords_to_cell(lat, lon)
        return float(self.elevation_grid[r, c])

    def is_flooded(self, lat: float, lon: float) -> bool:
        return self.node_elevation(lat, lon) <= self.current_water_level

    # ------------------------------------------------------------------
    # Internal — flood fill
    # ------------------------------------------------------------------

    def _bfs_flood(self, water_level: float) -> np.ndarray:
        """
        BFS from the coast origin, strictly land-only (sea cells are excluded
        via their 100 m virtual elevation).  Spreads only to adjacent cells at
        or below water_level.
        """
        mask = np.zeros((self.grid_h, self.grid_w), dtype=bool)
        origin_r, origin_c = self._coords_to_cell(self._COAST_LAT, self._COAST_LON)

        if self.elevation_grid[origin_r, origin_c] > water_level:
            return mask

        queue: deque = deque()
        queue.append((origin_r, origin_c))
        visited = np.zeros((self.grid_h, self.grid_w), dtype=bool)
        visited[origin_r, origin_c] = True

        while queue:
            r, c = queue.popleft()
            mask[r, c] = True
            for dr, dc in _BFS_DIRS:
                nr, nc = r + dr, c + dc
                if (
                    0 <= nr < self.grid_h
                    and 0 <= nc < self.grid_w
                    and not visited[nr, nc]
                    and self.elevation_grid[nr, nc] <= water_level
                ):
                    visited[nr, nc] = True
                    queue.append((nr, nc))

        return mask

    # ------------------------------------------------------------------
    # Internal — elevation
    # ------------------------------------------------------------------

    def _load_elevation(self) -> np.ndarray:
        if os.path.exists(ELEVATION_RASTER_PATH):
            return self._load_from_raster()
        return self._synthetic_dem()

    def _load_from_raster(self) -> np.ndarray:
        import rasterio
        from rasterio.transform import rowcol

        grid = np.zeros((self.grid_h, self.grid_w), dtype=np.float32)
        with rasterio.open(ELEVATION_RASTER_PATH) as src:
            for r in range(self.grid_h):
                for c in range(self.grid_w):
                    lon, lat = self._cell_to_coords(r, c)
                    try:
                        row_i, col_i = rowcol(src.transform, lon, lat)
                        val = src.read(1)[row_i, col_i]
                        grid[r, c] = float(val) if val != src.nodata else 5.0
                    except Exception:
                        grid[r, c] = 5.0
        return grid

    def _synthetic_dem(self) -> np.ndarray:
        """
        Coast-relative DEM.
        Barcelona's coastline runs NNE–SSW; its rough equation in lat/lon:
            coast_lon(lat) = 2.192 + (lat - 41.374) * 0.25

        Cells EAST of this line are sea → elevation 100 m (never flood).
        Cells WEST of this line are land → elevation rises linearly inland.
        """
        grid = np.zeros((self.grid_h, self.grid_w), dtype=np.float32)

        for r in range(self.grid_h):
            for c in range(self.grid_w):
                lon, lat = self._cell_to_coords(r, c)

                # Coast longitude at this latitude
                coast_lon = 2.192 + (lat - 41.374) * 0.25

                if lon > coast_lon:
                    # Sea cell — assign very high elevation so BFS never floods it
                    grid[r, c] = 100.0
                    continue

                # Inland distance from coast line (metres, west of coast = positive)
                inland_m = max(0.0, (coast_lon - lon) * 85_000)

                # Linear coastal elevation model:
                # coast → 0.5 m, 750 m inland → 3.5 m
                elev = 0.5 + inland_m * 0.004

                # Montjuïc hill (never floods)
                dist_montjuic = math.sqrt(
                    ((lat - 41.364) * 111_000) ** 2
                    + ((lon - 2.160) * 85_000) ** 2
                ) / 1_000
                elev += 60.0 * math.exp(-dist_montjuic * 3.5)

                grid[r, c] = float(min(100.0, max(0.5, elev)))

        return grid

    # ------------------------------------------------------------------
    # Internal — helpers
    # ------------------------------------------------------------------

    def _coords_to_cell(self, lat: float, lon: float) -> tuple[int, int]:
        r = int((lat - self.LAT_MIN) / self._LAT_PER_CELL)
        c = int((lon - self.LON_MIN) / self._LON_PER_CELL)
        return max(0, min(self.grid_h - 1, r)), max(0, min(self.grid_w - 1, c))

    def _cell_to_coords(self, r: int, c: int) -> tuple[float, float]:
        return (
            self.LON_MIN + c * self._LON_PER_CELL,
            self.LAT_MIN + r * self._LAT_PER_CELL,
        )

    def _mask_to_geojson(self, mask: np.ndarray) -> Optional[Dict[str, Any]]:
        indices = list(zip(*np.where(mask)))
        if not indices:
            return None

        from shapely.geometry import box as shapely_box

        lat_step = self._LAT_PER_CELL
        lon_step = self._LON_PER_CELL

        cells = [
            shapely_box(
                self.LON_MIN + c * lon_step,
                self.LAT_MIN + r * lat_step,
                self.LON_MIN + (c + 1) * lon_step,
                self.LAT_MIN + (r + 1) * lat_step,
            )
            for r, c in indices
        ]

        shape = unary_union(cells)
        shape = shape.simplify(0.00015, preserve_topology=True)
        return mapping(shape)
