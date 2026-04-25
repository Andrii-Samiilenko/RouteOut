"""
Tsunami inundation model for Barcelona coast.

Approach
--------
BFS spreading inland from the Barcelona shoreline, driven by a wave run-up
schedule.  The wave arrives, peaks, then retreats — giving a full lifecycle
that looks dramatic on the dashboard.

The model does NOT clip to the evacuation zone — tsunami water floods wherever
the real terrain allows (coastal plain, Barceloneta, Poblenou, waterfront).
The evacuation zone just defines where the citizens are, not where water stops.

Coastline geometry
------------------
Barcelona beach runs NNE from Port Vell (41.370 N, 2.182 E) to Diagonal Mar
(41.413 N, 2.222 E).  Coastline formula:

    coast_lon(lat) = 2.182 + (lat − 41.370) × 0.93

BFS seeds sit just west of the shoreline (low-elevation land cells).

Elevation profile (m above sea level)
--------------------------------------
    0 –  300 m inland :  1.0 –  2.2 m   beach / waterfront
    300 –  800 m inland:  2.2 –  6.7 m   Barceloneta / Poblenou flat
    800 – 2000 m inland:  6.7 – 22.3 m   inner city / Eixample fringe
    > 2000 m inland   : rising steeply   Eixample hills → Tibidabo

Run-up schedule  (each tick = 1 real second = wall-clock)
----------------------------------------------------------
    tick  1 :  3 m   first wave tongue reaches the beach
    tick  2 :  7 m   wave fully on shore, flooding Barceloneta
    tick  3 : 12 m   PEAK — Poblenou, Vila Olímpica, Port Olímpic
    tick  4 : 12 m   sustained peak (second wave)
    tick  5 :  9 m   slow retreat begins
    tick  6 :  6 m   continued retreat
    tick  7 :  4 m
    tick  8 :  2 m
    tick  9+ :  0 m  fully receded

Predicted zone
--------------
Leading-edge band (next-tick flood − current flood) rendered as an animated
shimmer on the frontend — shows where the wave is about to arrive.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any, Dict, List, Optional

import numpy as np
from shapely.geometry import mapping
from shapely.ops import unary_union


_RUNUP_SCHEDULE: Dict[int, float] = {
    1:  3.0,
    2:  7.0,
    3: 12.0,
    4: 12.0,
    5:  9.0,
    6:  6.0,
    7:  4.0,
    8:  2.0,
}
_MAX_TICK = max(_RUNUP_SCHEDULE)

_BFS_DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


class TsunamiModel:
    """BFS coastal inundation — Barcelona, full wave lifecycle."""

    LAT_MIN, LAT_MAX = 41.30, 41.50
    LON_MIN, LON_MAX = 2.05, 2.28
    CELL_SIZE_M = 50

    _LAT_PER_CELL = CELL_SIZE_M / 111_000
    _LON_PER_CELL = CELL_SIZE_M / (111_000 * math.cos(math.radians(41.4)))

    # BFS seed points: just inside the shoreline, low elevation land cells.
    # coast_lon(lat) = 2.182 + (lat − 41.370) × 0.93
    # Seeds are placed ~120 m west (lon − 0.0014) so they land on beach/sand.
    _COAST_SEEDS: List[tuple[float, float]] = [
        (41.371, 2.180),   # Port Vell north
        (41.375, 2.184),   # Barceloneta south
        (41.380, 2.189),   # Barceloneta centre
        (41.385, 2.194),   # Barceloneta north
        (41.390, 2.198),   # Vila Olímpica south
        (41.395, 2.203),   # Vila Olímpica north
        (41.400, 2.208),   # Bogatell
        (41.405, 2.213),   # Mar Bella
        (41.410, 2.218),   # Poblenou / Diagonal Mar
        (41.414, 2.222),   # Forum
    ]

    def __init__(self, zone_polygon_geojson=None) -> None:
        self.grid_h = int((self.LAT_MAX - self.LAT_MIN) / self._LAT_PER_CELL) + 1
        self.grid_w = int((self.LON_MAX - self.LON_MIN) / self._LON_PER_CELL) + 1
        self.elevation_grid = self._build_elevation()
        self.current_runup: float = 0.0
        self.tick: int = 0

    # ── public API ──────────────────────────────────────────────────────────

    def advance(self) -> None:
        self.tick += 1
        if self.tick in _RUNUP_SCHEDULE:
            self.current_runup = _RUNUP_SCHEDULE[self.tick]
        elif self.tick > _MAX_TICK:
            self.current_runup = max(0.0, self.current_runup - 2.0)

    def get_inundation_geojson(self) -> Optional[Dict[str, Any]]:
        if self.current_runup <= 0:
            return None
        mask = self._bfs_inundation(self.current_runup)
        return self._mask_to_geojson(mask)

    def get_predicted_geojson(self, steps_ahead: int = 1) -> Optional[Dict[str, Any]]:
        """
        Leading-edge band: cells about to flood next tick.
        Frontend renders this as an animated shimmer ahead of the wave body.
        """
        if self.current_runup <= 0:
            return None

        future_tick = self.tick + steps_ahead
        future_runup = _RUNUP_SCHEDULE.get(
            future_tick,
            max(0.0, self.current_runup - steps_ahead * 2.0),
        )

        if future_runup <= self.current_runup:
            return self.get_inundation_geojson()

        future_mask  = self._bfs_inundation(future_runup)
        current_mask = self._bfs_inundation(self.current_runup)
        leading_edge = future_mask & ~current_mask
        result = self._mask_to_geojson(leading_edge)
        return result if result is not None else self.get_inundation_geojson()

    def is_inundated(self, lat: float, lon: float) -> bool:
        r, c = self._coords_to_cell(lat, lon)
        return float(self.elevation_grid[r, c]) <= self.current_runup

    # ── internals ───────────────────────────────────────────────────────────

    def _bfs_inundation(self, runup: float) -> np.ndarray:
        mask    = np.zeros((self.grid_h, self.grid_w), dtype=bool)
        visited = np.zeros((self.grid_h, self.grid_w), dtype=bool)
        queue: deque = deque()

        for lat, lon in self._COAST_SEEDS:
            r, c = self._coords_to_cell(lat, lon)
            if not visited[r, c] and self.elevation_grid[r, c] <= runup:
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
        rows = np.arange(self.grid_h, dtype=np.float64)
        cols = np.arange(self.grid_w, dtype=np.float64)
        C, R = np.meshgrid(cols, rows)

        lat = self.LAT_MIN + R * self._LAT_PER_CELL
        lon = self.LON_MIN + C * self._LON_PER_CELL

        # Coastline: NNE-trending, slope 0.93
        coast_lon = 2.182 + (lat - 41.370) * 0.93
        sea_mask  = lon >= coast_lon

        # Distance inland from shoreline (metres, positive = land)
        inland_m = np.maximum(0.0, (coast_lon - lon) * 85_000)

        # Piecewise elevation — Barcelona coastal plain is very flat
        elev = np.where(
            inland_m < 300,
            1.0 + inland_m * 0.004,                        # 1.0–2.2 m  beach
            np.where(
                inland_m < 800,
                2.2 + (inland_m - 300) * 0.009,            # 2.2–6.7 m  Barceloneta flat
                np.where(
                    inland_m < 2000,
                    6.7 + (inland_m - 800) * 0.013,        # 6.7–22.3 m inner city
                    22.3 + (inland_m - 2000) * 0.025,      # 22.3+ m    Eixample rising
                ),
            ),
        )

        # Hard walls: outside Barcelona coastal strip → very high elevation
        outside = (lat < 41.355) | (lat > 41.430) | (lon < 2.140)
        elev = np.where(outside & ~sea_mask, 200.0, elev)

        # Montjuïc hill — blocks southern spread
        montjuic_dist = np.sqrt(((lat - 41.364) / 0.012) ** 2 + ((lon - 2.153) / 0.010) ** 2)
        montjuic_bump = 80.0 * np.exp(-montjuic_dist ** 2 * 4.0)
        elev = np.where(~sea_mask, elev + montjuic_bump, elev)

        # Ocean cells → impassable for BFS
        elev = np.where(sea_mask, 200.0, elev)

        return np.clip(elev, 1.0, 500.0).astype(np.float32)

    def _coords_to_cell(self, lat: float, lon: float) -> tuple[int, int]:
        r = int((lat - self.LAT_MIN) / self._LAT_PER_CELL)
        c = int((lon - self.LON_MIN) / self._LON_PER_CELL)
        return (
            max(0, min(self.grid_h - 1, r)),
            max(0, min(self.grid_w - 1, c)),
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
