"""
Cellular automata fire spread simulator.

Grid: 50 m cells covering Barcelona bounding box.
Physics: wind alignment (exponential, strongly anisotropic) + uphill bonus +
         vegetation factor + ember spotting for long-range ignition.

Cell states:
    0 = unburned
    1 = burning (actively spreading)
    2 = burned out (ash)

Each tick represents 5 simulated minutes.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np
from shapely.geometry import mapping
from shapely.ops import unary_union

# Per-spread-rate config: base ignition probability, ticks before burnout, ember probability
_RATE_CONFIG = {
    "high":   {"base_prob": 0.48, "max_burn_age": 2, "ember_prob": 0.05},
    "medium": {"base_prob": 0.32, "max_burn_age": 3, "ember_prob": 0.02},
    "low":    {"base_prob": 0.18, "max_burn_age": 4, "ember_prob": 0.008},
}


class FireSpreadSimulator:
    CELL_SIZE_M = 50
    LAT_MIN, LAT_MAX = 41.30, 41.50
    LON_MIN, LON_MAX = 2.05, 2.28

    _LAT_PER_CELL = CELL_SIZE_M / 111_000
    _LON_PER_CELL = CELL_SIZE_M / (111_000 * math.cos(math.radians(41.4)))

    _NEIGHBORS = [(-1, 0), (1, 0), (0, -1), (0, 1),
                  (-1, -1), (-1, 1), (1, -1), (1, 1)]

    def __init__(
        self,
        vegetation_zones: List[Dict[str, Any]],
        spread_rate: str = "medium",
    ) -> None:
        self.grid_h = int((self.LAT_MAX - self.LAT_MIN) / self._LAT_PER_CELL) + 1
        self.grid_w = int((self.LON_MAX - self.LON_MIN) / self._LON_PER_CELL) + 1

        self.grid = np.zeros((self.grid_h, self.grid_w), dtype=np.uint8)
        # How many ticks each burning cell has been on fire
        self._burn_age = np.zeros((self.grid_h, self.grid_w), dtype=np.uint8)

        self.vegetation_grid = self._build_vegetation_grid(vegetation_zones)
        self.elevation_grid = self._build_elevation_grid()

        cfg = _RATE_CONFIG.get(spread_rate, _RATE_CONFIG["medium"])
        self._base_prob: float = cfg["base_prob"]
        self._max_burn_age: int = cfg["max_burn_age"]
        self._ember_prob: float = cfg["ember_prob"]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def ignite(self, lat: float, lon: float) -> None:
        r, c = self._coords_to_cell(lat, lon)
        self.grid[r, c] = 1
        self._burn_age[r, c] = 1

    def tick(self, wind_dir_deg: float, wind_speed_kmh: float, n_steps: int = 1) -> None:
        for _ in range(n_steps):
            self._spread_step(wind_dir_deg, wind_speed_kmh)

    def get_danger_geojson(self) -> Optional[Dict[str, Any]]:
        """All affected cells (burning + ash) — used for route invalidation."""
        return self._cells_to_geojson(self.grid > 0)

    def get_fire_front_geojson(self) -> Optional[Dict[str, Any]]:
        """Active fire front only (state == 1)."""
        return self._cells_to_geojson(self.grid == 1)

    def get_ash_geojson(self) -> Optional[Dict[str, Any]]:
        """Burned-out ash area (state == 2)."""
        return self._cells_to_geojson(self.grid == 2)

    def get_predicted_geojson(
        self, wind_dir_deg: float, wind_speed_kmh: float, steps: int = 3
    ) -> Optional[Dict[str, Any]]:
        """15-minute forecast polygon — clones state, runs forward, discards clone."""
        saved_grid = self.grid.copy()
        saved_age = self._burn_age.copy()
        for _ in range(steps):
            self._spread_step(wind_dir_deg, wind_speed_kmh)
        result = self.get_danger_geojson()
        self.grid = saved_grid
        self._burn_age = saved_age
        return result

    def burning_cell_count(self) -> int:
        return int(np.sum(self.grid == 1))

    # ------------------------------------------------------------------
    # Internal — spread physics
    # ------------------------------------------------------------------

    def _spread_step(self, wind_dir_deg: float, wind_speed_kmh: float) -> None:
        new_grid = self.grid.copy()
        new_burn_age = self._burn_age.copy()
        burning_coords = list(zip(*np.where(self.grid == 1)))

        # Meteorological convention: wind_dir_deg = direction wind comes FROM.
        # Fire spreads TOWARD the downwind direction (180° opposite).
        downwind_deg = (wind_dir_deg + 180.0) % 360.0

        for r, c in burning_coords:
            # Spread to 8 neighbours
            for dr, dc in self._NEIGHBORS:
                nr, nc = r + dr, c + dc
                if not self._valid(nr, nc) or self.grid[nr, nc] != 0:
                    continue
                prob = self._spread_probability(r, c, nr, nc, downwind_deg, wind_speed_kmh)
                if np.random.random() < prob:
                    new_grid[nr, nc] = 1
                    new_burn_age[nr, nc] = 1

            # Ember spotting: occasional long-range ignition ahead of the front
            if np.random.random() < self._ember_prob * (wind_speed_kmh / 25.0):
                dist = np.random.randint(5, 16)
                dw_rad = math.radians(downwind_deg)
                # N=0 → row decreases; E=90 → col increases
                er = r + int(-dist * math.cos(dw_rad))
                ec = c + int(dist * math.sin(dw_rad))
                if self._valid(er, ec) and self.grid[er, ec] == 0:
                    if self.vegetation_grid[er, ec] > 0.08:
                        new_grid[er, ec] = 1
                        new_burn_age[er, ec] = 1

            # Age the burning cell; burn out to ash when max age reached
            new_burn_age[r, c] += 1
            if new_burn_age[r, c] >= self._max_burn_age:
                new_grid[r, c] = 2

        self.grid = new_grid
        self._burn_age = new_burn_age

    def _spread_probability(
        self,
        r1: int, c1: int,
        r2: int, c2: int,
        downwind_deg: float,
        wind_speed_kmh: float,
    ) -> float:
        dr, dc = r2 - r1, c2 - c1
        # Bearing of spread direction: N=0°, E=90°, S=180°, W=270°
        spread_bearing = math.degrees(math.atan2(dc, -dr)) % 360.0

        angle_diff = abs((spread_bearing - downwind_deg + 180.0) % 360.0 - 180.0)
        wind_alignment = math.cos(math.radians(angle_diff))

        # Exponential wind factor — strongly anisotropic.
        # At 25 km/h: downwind ≈ 3.5×, perpendicular = 1×, upwind ≈ 0.28×
        wind_strength = wind_speed_kmh / 20.0
        wind_factor = math.exp(wind_strength * wind_alignment)

        # Uphill accelerates fire
        elev_diff = float(self.elevation_grid[r2, c2] - self.elevation_grid[r1, c1])
        elevation_factor = 1.0 + max(0.0, elev_diff / 50.0) * 0.5

        veg_factor = float(self.vegetation_grid[r2, c2])

        return min(0.95, self._base_prob * wind_factor * elevation_factor * veg_factor)

    # ------------------------------------------------------------------
    # Internal — grid helpers
    # ------------------------------------------------------------------

    def _coords_to_cell(self, lat: float, lon: float) -> tuple[int, int]:
        r = int((lat - self.LAT_MIN) / self._LAT_PER_CELL)
        c = int((lon - self.LON_MIN) / self._LON_PER_CELL)
        r = max(0, min(self.grid_h - 1, r))
        c = max(0, min(self.grid_w - 1, c))
        return r, c

    def _cell_to_coords(self, r: int, c: int) -> tuple[float, float]:
        """Returns (lon, lat) of the SW corner of cell (r, c)."""
        lat = self.LAT_MIN + r * self._LAT_PER_CELL
        lon = self.LON_MIN + c * self._LON_PER_CELL
        return lon, lat

    def _valid(self, r: int, c: int) -> bool:
        return 0 <= r < self.grid_h and 0 <= c < self.grid_w

    def _cells_to_geojson(self, mask: np.ndarray) -> Optional[Dict[str, Any]]:
        indices = list(zip(*np.where(mask)))
        if not indices:
            return None

        # Build exact grid-square polygons and union them.
        # Adjacent cells share edges → result follows actual fire shape, not convex hull.
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

    # ------------------------------------------------------------------
    # Internal — precomputed grids
    # ------------------------------------------------------------------

    def _build_vegetation_grid(self, vegetation_zones: List[Dict[str, Any]]) -> np.ndarray:
        """Vectorised: axis-aligned bbox check replaces per-cell Shapely point-in-poly."""
        rows = np.arange(self.grid_h, dtype=np.float64)
        cols = np.arange(self.grid_w, dtype=np.float64)
        C, R = np.meshgrid(cols, rows)
        lat_grid = self.LAT_MIN + R * self._LAT_PER_CELL
        lon_grid = self.LON_MIN + C * self._LON_PER_CELL

        grid = np.full((self.grid_h, self.grid_w), 0.05, dtype=np.float32)

        for zone in sorted(vegetation_zones, key=lambda z: z["vegetation_factor"]):
            coords = zone["polygon"]
            factor = float(zone["vegetation_factor"])
            lons = [p[0] for p in coords]
            lats = [p[1] for p in coords]
            mask = (
                (lon_grid >= min(lons)) & (lon_grid <= max(lons)) &
                (lat_grid >= min(lats)) & (lat_grid <= max(lats))
            )
            grid[mask] = factor

        return grid

    def _build_elevation_grid(self) -> np.ndarray:
        """Vectorised NumPy DEM — same model, ~100x faster."""
        rows = np.arange(self.grid_h, dtype=np.float64)
        cols = np.arange(self.grid_w, dtype=np.float64)
        C, R = np.meshgrid(cols, rows)
        lat = self.LAT_MIN + R * self._LAT_PER_CELL
        lon = self.LON_MIN + C * self._LON_PER_CELL

        dist_ridge = np.sqrt(((lat - 41.43) / 0.05) ** 2 + ((lon - 2.12) / 0.03) ** 2)
        dist_coast = np.sqrt(((lat - 41.37) / 0.08) ** 2 + ((lon - 2.20) / 0.05) ** 2)
        elev = np.maximum(3.0, 500.0 * np.exp(-dist_ridge * 1.5) - 20.0 * dist_coast)
        return np.clip(elev, 3.0, 500.0).astype(np.float32)
