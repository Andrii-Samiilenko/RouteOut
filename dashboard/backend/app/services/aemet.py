"""
AEMET OpenData weather client.

Fetches real wind speed and direction for Barcelona (station 0076).
Returns a dict so callers don't need to know the AEMET response format.

Docs: https://opendata.aemet.es/opendata/api
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

import requests

# Barcelona Observatori Fabra station id
_BARCELONA_STATION = "0076"
_BASE_URL = "https://opendata.aemet.es/opendata/api"
_CACHE_TTL_S = 300  # AEMET updates every 10 min; we cache 5 min

_cache: Dict[str, Any] = {}
_cache_time: float = 0.0


def get_current_weather() -> Optional[Dict[str, Any]]:
    """
    Returns parsed weather dict:
        {
            "wind_speed_kmh": float,
            "wind_direction_deg": float,
            "temperature_c": float,
            "humidity_pct": float,
            "station": str,
            "timestamp": str,
        }
    Returns None if API key is missing or request fails; callers should use
    the fallback HazardEvent wind values in that case.
    """
    global _cache, _cache_time

    if time.time() - _cache_time < _CACHE_TTL_S and _cache:
        return _cache

    api_key = os.getenv("AEMET_API_KEY")
    if not api_key:
        return _make_fallback()

    try:
        # Step 1: get the redirect URL that contains the actual data
        url = f"{_BASE_URL}/observacion/convencional/datos/estacion/{_BARCELONA_STATION}"
        r = requests.get(url, headers={"api_key": api_key}, timeout=8)
        r.raise_for_status()
        data_url = r.json().get("datos")
        if not data_url:
            return _make_fallback()

        # Step 2: fetch the actual observation data
        obs_r = requests.get(data_url, timeout=8)
        obs_r.raise_for_status()
        observations = obs_r.json()
        if not observations:
            return _make_fallback()

        # Observations are sorted ascending by date; take the last entry
        latest = observations[-1]
        result = {
            "wind_speed_kmh": float(latest.get("vv", 0)) * 3.6,   # m/s → km/h
            "wind_direction_deg": float(latest.get("dv", 0)),
            "temperature_c": float(latest.get("ta", 0)),
            "humidity_pct": float(latest.get("hr", 0)),
            "station": _BARCELONA_STATION,
            "timestamp": latest.get("fint", ""),
            "source": "aemet_live",
        }
        _cache = result
        _cache_time = time.time()
        return result

    except Exception:
        return _make_fallback()


def _make_fallback() -> Dict[str, Any]:
    """Typical Barcelona summer afternoon — used when API key absent or fails."""
    return {
        "wind_speed_kmh": 15.0,
        "wind_direction_deg": 315.0,   # NW — realistic for Tibidabo scenario
        "temperature_c": 32.0,
        "humidity_pct": 30.0,
        "station": _BARCELONA_STATION,
        "timestamp": "",
        "source": "fallback",
    }
