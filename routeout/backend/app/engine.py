"""
Singleton simulation engine.

All mutable runtime state lives here so every module (API routes, WebSocket
broadcaster, invalidation monitor) imports from one place — no circular deps.

Usage:
    from app.engine import engine
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional, Set

from app.api.schemas import (
    CitizenState,
    HazardEvent,
    LLMLogEntry,
    NotificationCard,
    SafeZone,
    ScenarioMeta,
    Statistics,
)


class SimulationEngine:
    # How many seconds the LLM log panel stays visible on the dashboard
    LLM_LOG_TTL_S = 10.0

    def __init__(self) -> None:
        # Loaded once at startup via main.py lifespan
        self.graph: Any = None                          # networkx.MultiDiGraph
        self.safe_zones: List[SafeZone] = []
        self.vegetation_zones: List[Dict[str, Any]] = []
        self.scenarios: Dict[str, Any] = {}

        # Runtime scenario state
        self.scenario: ScenarioMeta = ScenarioMeta()
        self.hazard_event: Optional[HazardEvent] = None

        # Physics simulators — set when scenario is triggered
        self.fire_simulator: Any = None
        self.flood_model: Any = None

        # Live citizen registry  {citizen_id → CitizenState}
        self.citizens: Dict[str, CitizenState] = {}

        # Last computed polygons (GeoJSON dicts)
        self.danger_polygon: Optional[Dict[str, Any]] = None
        self.predicted_polygon: Optional[Dict[str, Any]] = None
        self.ash_polygon: Optional[Dict[str, Any]] = None
        self.fire_front_polygon: Optional[Dict[str, Any]] = None

        # Global counters / stats
        self.statistics: Statistics = Statistics()
        self.weather: Optional[Dict[str, Any]] = None

        # Notification feed — newest first, capped at 50
        self.notifications: List[NotificationCard] = []

        # LLM log entry + timestamp it was created (for TTL check)
        self.llm_log: Optional[LLMLogEntry] = None
        self._llm_log_created_at: float = 0.0

        # Active WebSocket connections (FastAPI WebSocket objects)
        self.ws_connections: Set[Any] = set()

        # asyncio background task handles
        self._broadcast_task: Optional[asyncio.Task] = None
        self._invalidation_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def add_notification(self, card: NotificationCard) -> None:
        self.notifications.insert(0, card)
        if len(self.notifications) > 50:
            self.notifications = self.notifications[:50]

    def set_llm_log(self, entry: LLMLogEntry) -> None:
        self.llm_log = entry
        self._llm_log_created_at = time.time()

    def current_llm_log(self) -> Optional[LLMLogEntry]:
        """Returns log entry only within the TTL window."""
        if self.llm_log is None:
            return None
        if time.time() - self._llm_log_created_at > self.LLM_LOG_TTL_S:
            return None
        return self.llm_log

    def increment_routes_recalculated(self) -> None:
        self.statistics.routes_recalculated += 1

    def recompute_statistics(self) -> None:
        evacuating = sum(
            1 for c in self.citizens.values() if c.status.value == "evacuating"
        )
        reached = sum(
            1 for c in self.citizens.values() if c.status.value == "reached_safety"
        )
        self.statistics.evacuating = evacuating
        self.statistics.reached_safety = reached

        total = len(self.citizens)
        if total > 0:
            # Rough clearance estimate: avg time_minutes of still-evacuating citizens
            remaining_times = [
                c.time_minutes
                for c in self.citizens.values()
                if c.status.value == "evacuating"
            ]
            self.statistics.clearance_minutes = (
                sum(remaining_times) / len(remaining_times) if remaining_times else 0.0
            )

    def reset(self) -> None:
        self.scenario = ScenarioMeta()
        self.hazard_event = None
        self.fire_simulator = None
        self.flood_model = None
        self.citizens = {}
        self.danger_polygon = None
        self.predicted_polygon = None
        self.ash_polygon = None
        self.fire_front_polygon = None
        self.statistics = Statistics()
        self.notifications = []
        self.llm_log = None
        self._llm_log_created_at = 0.0
        for sz in self.safe_zones:
            sz.current_occupancy = 0


# Module-level singleton — import this everywhere
engine = SimulationEngine()
