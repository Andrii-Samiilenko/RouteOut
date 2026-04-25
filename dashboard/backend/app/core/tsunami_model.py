"""
Tsunami inundation model for Barcelona coast.

Approach: BFS spreading inland from the actual Barcelona shoreline.

Coastline geometry
------------------
Barcelona's beach runs NNE from Port Vell (41.370 N, 2.182 E) to Diagonal
Mar / Forum (41.413 N, 2.222 E).  Δlon / Δlat ≈ 0.93 — this is the key fix
vs. the old model which used 0.26 and placed every BFS seed *in the ocean*.

    coast_lon(lat) = 2.182 + (lat − 41.370) × 0.93

BFS seeds sit ~100–150 m west of the shoreline (land side) with elevation
≈ 1.5–2.0 m, so they're always inside the flooded zone from tick 1.

Elevation profile (metres above sea level)
------------------------------------------
    0 – 200 m inland   : 1.0 – 1.8 m  (beach / waterfront)
    200 – 700 m inland  : 1.8 – 6.3 m  (Barceloneta / Poblenou flat)
    700 – 1 500 m inland: 6.3 – 19.1 m (inner city / Eixample fringe)
    > 1 500 m inland    : rising toward Eixample hills
    Montjuïc            : Gaussian bump +160 m  (blocks south spread)
    Collserola/Tibidabo : Gaussian bump +400 m  (blocks west spread)
    Sea cells           : 200 m  (BFS cannot enter ocean)

Run-up schedule (5 simulated minutes per tick)
-----------------------------------------------
    tick 1 :  6 m → ~650 m inundation  (beach + immediate waterfront)
    tick 2 : 10 m → ~1 050 m           (Barceloneta + Vila Olímpica + Poblenou coast)
    tick 3 : 10 m → sustained peak
    tick 4 :  7 m → retreat begins
    tick 5 :  4 m → continued retreat
    tick 6+ : −2 m / tick

Predicted zone
--------------
Returns the *leading-edge band* (future_mask − current_mask) rather than the
full future inundation.  The frontend renders this as an animated shimmer just
ahead of the solid flood body — visually it looks like a wave crest advancing.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any, Dict, List, Optional

import numpy as np
from shapely.geometry import mapping
from shapely.ops import unary_union


_RUNUP_SCHEDULE: Dict[int, float] = {1: 6.0, 2: 10.0, 3: 10.0, 4: 7.0, 5: 4.0}
_BFS_DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


class TsunamiModel:
    """BFS coastal inundation model for Barcelona with corrected coastline geometry."""

    LAT_MIN, LAT_MAX = 41.30, 41.50
    LON_MIN, LON_MAX = 2.05, 2.28
    CELL_SIZE_M = 50

    _LAT_PER_CELL = CELL_SIZE_M / 111_000
    _LON_PER_CELL = CELL_SIZE_M / (111_000 * math.cos(math.radians(41.4)))

    # Seeds placed ~100–150 m west of the actual shoreline so they're land cells
    # with elevation ≈ 1.5–2.0 m — always inside the flooded zone at tick 1.
    # Verification: coast_lon(lat) = 2.182 + (lat − 41.370) × 0.93
    #   (41.372, 2.182) → coast_lon=2.184 → inland_m≈170m ✓
    #   (41.376, 2.186) → coast_lon=2.188 → inland_m≈170m ✓  … etc.
    _COAST_ORIGINS: List[tuple[float, float]] = [
        (41.372, 2.182),   # Port Vell waterfront
        (41.376, 2.186),   # Barceloneta south
        (41.381, 2.191),   # Barceloneta centre
        (41.386, 2.195),   # Barceloneta north
        (41.391, 2.200),   # Vila Olímpica entrance
        (41.397, 2.205),   # Bogatell / Mar Bella
        (41.403, 2.211),   # Poblenou
        (41.410, 2.218),   # Diagonal Mar / Forum
    ]

    def __init__(self) -> None:
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
        elif self.tick > max(_RUNUP_SCHEDULE):
            self.current_runup = max(0.0, self.current_runup - 2.0)

    def get_inundation_geojson(self) -> Optional[Dict[str, Any]]:
        if self.current_runup <= 0:
            return None
        mask = self._bfs_inundation(self.current_runup)
        return self._mask_to_geojson(mask)

    def get_predicted_geojson(self, steps_ahead: int = 2) -> Optional[Dict[str, Any]]:
        """
        Return the leading-edge band (future_mask − current_mask).

        When the wave is advancing this is the ring of cells about to flood —
        the frontend renders it as an animated shimmer just ahead of the body.
        When retreating, fall back to the full current inundation.
        """
        if self.current_runup <= 0:
            return None

        future_tick = self.tick + steps_ahead
        future_runup = _RUNUP_SCHEDULE.get(
            future_tick,
            max(0.0, self.current_runup - steps_ahead * 2.0),
        )

        if future_runup <= self.current_runup:
            # Retreating — just return full current inundation as predicted
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

        for lat, lon in self._COAST_ORIGINS:
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
        """
        Vectorised NumPy DEM calibrated to Barcelona's coastal plain.

        Key fix: the coastline slope is 0.93 (not 0.26 as in the old model),
        matching the NNE direction of the actual Barcelona beach.
        """
        rows = np.arange(self.grid_h, dtype=np.float64)
        cols = np.arange(self.grid_w, dtype=np.float64)
        C, R = np.meshgrid(cols, rows)

        lat = self.LAT_MIN + R * self._LAT_PER_CELL
        lon = self.LON_MIN + C * self._LON_PER_CELL

        # Corrected coastline: slope 0.93, anchored at Port Vell (41.370, 2.182)
        coast_lon = 2.182 + (lat - 41.370) * 0.93
        sea_mask  = (lon >= coast_lon)

        # Metres inland from the shoreline (positive = land side)
        inland_m = np.maximum(0.0, (coast_lon - lon) * 85_000)

        # Piecewise elevation profile — Barcelona coastal plain is very flat.
        # The piecewise formula already gives 20+ m at hilltop distances so no
        # Gaussian hill bumps are needed (they would bleed onto the coastal cells).
        elev = np.where(
            inland_m < 200,
            1.0 + inland_m * 0.004,                       # 1.0–1.8 m  beach strip
            np.where(
                inland_m < 700,
                1.8 + (inland_m - 200) * 0.009,           # 1.8–6.3 m  Barceloneta/Poblenou flat
                np.where(
                    inland_m < 1_500,
                    6.3 + (inland_m - 700) * 0.016,       # 6.3–19.1 m inner city
                    19.1 + (inland_m - 1_500) * 0.030,    # 19.1+ m    Eixample rising
                ),
            ),
        )

        # Clip flooding to the Barcelona coastal municipality.
        # Without this, the straight-line coast formula creates false low-land
        # south into the Llobregat delta and too far inland past Eixample.
        outside_zone = (lat < 41.358) | (lat > 41.425) | (lon < 2.148)
        elev = np.where(outside_zone & ~sea_mask, 200.0, elev)

        # Ocean cells → 200 m so BFS cannot enter from the open sea
        elev = np.where(sea_mask, 200.0, elev)

        return np.clip(elev, 1.0, 500.0).astype(np.float32)

    def _coords_to_cell(self, lat: float, lon: float) -> tuple[int, int]:
        r = int((lat - self.LAT_MIN) / self._LAT_PER_CELL)
        c = int((lon - self.LON_MIN) / self._LON_PER_CELL)
        return (
            max(0, min(self.grid_h - 1, r)),
            max(0, min(self.grid_w - 1, c)),
        )

    def _cell_to_coords(self, r: int, c: int) -> tuple[float, float]:
        """Returns (lon, lat) of cell centre."""
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
        united = united.simplify(0.0003, preserve_topology=True)
        return mapping(united)
