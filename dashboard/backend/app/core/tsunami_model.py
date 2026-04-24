"""
Tsunami inundation model for Barcelona coast.

Physics:
  - Wave arrives at the coastline after a configurable travel time (default 0 ticks).
  - Inundation spreads inland via BFS exactly like the flood model but with a
    different elevation profile: run-up height decays exponentially with inland
    distance so the first ~800 m are inundated deeply (up to 10 m) while areas
    >1.5 km inland are safe at normal elevation.
  - Three phases per tick:
      tick 0: initial surge (run-up 8 m) — Barceloneta + port zone
      tick 1: peak inundation (run-up 10 m) — reaches El Born / Eixample fringe
      tick 2: second wave / sustained level (run-up 9 m)
      tick 3+: gradual retreat (-1 m per tick)

Run-up schedule chosen so the first 2–3 ticks are visually dramatic for the demo.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any, Dict, List, Optional

import numpy as np
from shapely.geometry import mapping
from shapely.ops import unary_union


_RUNUP_SCHEDULE = {0: 8.0, 1: 10.0, 2: 9.0, 3: 7.0, 4: 5.0, 5: 3.0}
_BFS_DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


class TsunamiModel:
    """BFS-based coastal inundation model for Barcelona."""

    LAT_MIN, LAT_MAX = 41.30, 41.50
    LON_MIN, LON_MAX = 2.05, 2.28
    CELL_SIZE_M = 50

    _LAT_PER_CELL = CELL_SIZE_M / 111_000
    _LON_PER_CELL = CELL_SIZE_M / (111_000 * math.cos(math.radians(41.4)))

    # Multiple coast entry points — wave hits along the whole Barcelona waterfront
    _COAST_ORIGINS: List[tuple[float, float]] = [
        (41.374, 2.194),   # Barceloneta
        (41.390, 2.202),   # Vila Olímpica / Port Olímpic
        (41.408, 2.214),   # Poblenou / Rambla del Poblenou coast
        (41.360, 2.182),   # Port Vell / Barceloneta south
    ]

    def __init__(self) -> None:
        self.grid_h = int((self.LAT_MAX - self.LAT_MIN) / self._LAT_PER_CELL) + 1
        self.grid_w = int((self.LON_MAX - self.LON_MIN) / self._LON_PER_CELL) + 1
        self.elevation_grid = self._build_elevation()
        self.current_runup: float = 0.0
        self.tick: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def advance(self) -> None:
        self.tick += 1
        if self.tick in _RUNUP_SCHEDULE:
            self.current_runup = _RUNUP_SCHEDULE[self.tick]
        elif self.tick > max(_RUNUP_SCHEDULE):
            self.current_runup = max(0.0, self.current_runup - 1.5)

    def get_inundation_geojson(self) -> Optional[Dict[str, Any]]:
        if self.current_runup <= 0:
            return None
        mask = self._bfs_inundation(self.current_runup)
        return self._mask_to_geojson(mask)

    def get_predicted_geojson(self, steps_ahead: int = 2) -> Optional[Dict[str, Any]]:
        future_tick = self.tick + steps_ahead
        if future_tick in _RUNUP_SCHEDULE:
            future_runup = _RUNUP_SCHEDULE[future_tick]
        else:
            future_runup = max(0.0, self.current_runup - steps_ahead * 1.5)
        if future_runup <= 0:
            return None
        mask = self._bfs_inundation(future_runup)
        return self._mask_to_geojson(mask)

    def is_inundated(self, lat: float, lon: float) -> bool:
        r, c = self._coords_to_cell(lat, lon)
        return float(self.elevation_grid[r, c]) <= self.current_runup

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _bfs_inundation(self, runup: float) -> np.ndarray:
        mask = np.zeros((self.grid_h, self.grid_w), dtype=bool)
        visited = np.zeros((self.grid_h, self.grid_w), dtype=bool)
        queue: deque = deque()

        for lat, lon in self._COAST_ORIGINS:
            r, c = self._coords_to_cell(lat, lon)
            if self.elevation_grid[r, c] <= runup and not visited[r, c]:
                queue.append((r, c))
                visited[r, c] = True

        while queue:
            r, c = queue.popleft()
            mask[r, c] = True
            for dr, dc in _BFS_DIRS:
                nr, nc = r + dr, c + dc
                if (
                    0 <= nr < self.grid_h
                    and 0 <= nc < self.grid_w
                    and not visited[nr, nc]
                    and self.elevation_grid[nr, nc] <= runup
                ):
                    visited[nr, nc] = True
                    queue.append((nr, nc))

        return mask

    def _build_elevation(self) -> np.ndarray:
        """
        Coastal DEM tuned for tsunami inundation.
        Barcelona's waterfront is nearly at sea level (1–3 m) for ~400 m inland,
        then rises to 5–15 m before the Eixample grid.
        Montjuïc and Tibidabo are ~80 m and ~500 m — never inundated.
        """
        grid = np.zeros((self.grid_h, self.grid_w), dtype=np.float32)

        for r in range(self.grid_h):
            for c in range(self.grid_w):
                lon, lat = self._cell_to_coords(r, c)

                # Coastline equation for Barcelona (NNE–SSW diagonal)
                coast_lon = 2.193 + (lat - 41.374) * 0.26

                if lon > coast_lon:
                    # Sea — assign high elevation so BFS never enters
                    grid[r, c] = 200.0
                    continue

                inland_m = max(0.0, (coast_lon - lon) * 85_000)

                # Coastal strip: 0–400 m inland → 1–4 m (highly vulnerable)
                # 400–1500 m inland → 4–15 m
                # Beyond 1500 m → rises steeply
                if inland_m < 400:
                    elev = 1.0 + inland_m * 0.0075
                elif inland_m < 1500:
                    elev = 4.0 + (inland_m - 400) * 0.01
                else:
                    elev = 15.0 + (inland_m - 1500) * 0.04

                # Montjuïc hill — always safe
                dist_montjuic = math.sqrt(
                    ((lat - 41.364) * 111_000) ** 2
                    + ((lon - 2.160) * 85_000) ** 2
                ) / 1_000
                elev += 80.0 * math.exp(-dist_montjuic * 3.0)

                # Tibidabo ridge — always safe
                dist_tib = math.sqrt(
                    ((lat - 41.422) * 111_000) ** 2
                    + ((lon - 2.120) * 85_000) ** 2
                ) / 1_000
                elev += 200.0 * math.exp(-dist_tib * 2.5)

                grid[r, c] = float(max(1.0, min(500.0, elev)))

        return grid

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

        united = unary_union(cells)
        united = united.simplify(0.0002, preserve_topology=True)
        return mapping(united)
