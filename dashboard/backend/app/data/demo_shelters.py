"""
Pre-defined shelter sets for each disaster scenario — used in demo mode.

Each shelter is a dict matching ShelterInput schema.
Shelters are named and typed specifically per scenario:
  fire    → firebreak zones, hospitals away from hills, assembly at coast
  flood   → elevated ground (Montjuïc, Gràcia hills, Tibidabo foothills)
  tsunami → inland high-ground, far from coastline

Coordinates are real Barcelona landmarks verified on OSM.
"""
from __future__ import annotations

from typing import Dict, List, Any

# ---------------------------------------------------------------------------
# Fire scenario — Collserola wildfire spreading toward city
# Shelters: sports halls, coastal end, elevated plateaus away from ridge
# ---------------------------------------------------------------------------
FIRE_SHELTERS: List[Dict[str, Any]] = [
    {
        "id": "fire-s1",
        "name": "Palau Sant Jordi Arena",
        "lat": 41.3643,
        "lon": 2.1527,
        "capacity": 5000,
        "shelter_type": "assembly",
    },
    {
        "id": "fire-s2",
        "name": "Hospital del Mar",
        "lat": 41.3837,
        "lon": 2.1976,
        "capacity": 800,
        "shelter_type": "hospital",
    },
    {
        "id": "fire-s3",
        "name": "Fòrum Firebreak Camp",
        "lat": 41.4108,
        "lon": 2.2218,
        "capacity": 3000,
        "shelter_type": "assembly",
    },
    {
        "id": "fire-s4",
        "name": "Parc de la Ciutadella Relief Centre",
        "lat": 41.3867,
        "lon": 2.1862,
        "capacity": 2000,
        "shelter_type": "shelter",
    },
    {
        "id": "fire-s5",
        "name": "Estació de França Triage Post",
        "lat": 41.3832,
        "lon": 2.1840,
        "capacity": 1200,
        "shelter_type": "shelter",
    },
    {
        "id": "fire-s6",
        "name": "Hospital Clínic Emergency Wing",
        "lat": 41.3884,
        "lon": 2.1529,
        "capacity": 600,
        "shelter_type": "hospital",
    },
    {
        "id": "fire-s7",
        "name": "Barceloneta Beach Safety Zone",
        "lat": 41.3800,
        "lon": 2.1940,
        "capacity": 4000,
        "shelter_type": "assembly",
    },
    {
        "id": "fire-s8",
        "name": "Recinte Modernista Shelter",
        "lat": 41.3997,
        "lon": 2.1736,
        "capacity": 1800,
        "shelter_type": "shelter",
    },
]

# ---------------------------------------------------------------------------
# Flood scenario — coastal flash flood from Barceloneta spreading inland
# Shelters: elevated ground — Montjuïc, Gràcia, Eixample high floors
# ---------------------------------------------------------------------------
FLOOD_SHELTERS: List[Dict[str, Any]] = [
    {
        "id": "flood-s1",
        "name": "Montjuïc Castle High Ground",
        "lat": 41.3641,
        "lon": 2.1658,
        "capacity": 4000,
        "shelter_type": "assembly",
    },
    {
        "id": "flood-s2",
        "name": "Hospital de la Santa Creu i Sant Pau",
        "lat": 41.4136,
        "lon": 2.1745,
        "capacity": 900,
        "shelter_type": "hospital",
    },
    {
        "id": "flood-s3",
        "name": "Gràcia Hills Community Centre",
        "lat": 41.4043,
        "lon": 2.1572,
        "capacity": 1500,
        "shelter_type": "shelter",
    },
    {
        "id": "flood-s4",
        "name": "Tibidabo Foothills Camp",
        "lat": 41.4198,
        "lon": 2.1337,
        "capacity": 2500,
        "shelter_type": "shelter",
    },
    {
        "id": "flood-s5",
        "name": "Sants Station Elevated Hall",
        "lat": 41.3794,
        "lon": 2.1414,
        "capacity": 3000,
        "shelter_type": "assembly",
    },
    {
        "id": "flood-s6",
        "name": "Hospital General de Catalunya (Sant Cugat)",
        "lat": 41.4721,
        "lon": 2.0855,
        "capacity": 700,
        "shelter_type": "hospital",
    },
    {
        "id": "flood-s7",
        "name": "Parc de Collserola Refuge",
        "lat": 41.4310,
        "lon": 2.1105,
        "capacity": 2000,
        "shelter_type": "shelter",
    },
    {
        "id": "flood-s8",
        "name": "Plaça de les Glòries High Platform",
        "lat": 41.4035,
        "lon": 2.1894,
        "capacity": 1200,
        "shelter_type": "assembly",
    },
]

# ---------------------------------------------------------------------------
# Tsunami scenario — mega-wave from Mediterranean; all shelters inland/elevated
# Priority: get as far from coast as possible, fastest
# ---------------------------------------------------------------------------
TSUNAMI_SHELTERS: List[Dict[str, Any]] = [
    {
        "id": "tsun-s1",
        "name": "Montjuïc Bunkers Fortress",
        "lat": 41.3753,
        "lon": 2.1533,
        "capacity": 5000,
        "shelter_type": "assembly",
    },
    {
        "id": "tsun-s2",
        "name": "Hospital de Bellvitge (L'Hospitalet)",
        "lat": 41.3563,
        "lon": 2.1090,
        "capacity": 1000,
        "shelter_type": "hospital",
    },
    {
        "id": "tsun-s3",
        "name": "Tibidabo Summit Shelter",
        "lat": 41.4219,
        "lon": 2.1186,
        "capacity": 3000,
        "shelter_type": "shelter",
    },
    {
        "id": "tsun-s4",
        "name": "Sant Cugat del Vallès Assembly",
        "lat": 41.4740,
        "lon": 2.0839,
        "capacity": 4000,
        "shelter_type": "assembly",
    },
    {
        "id": "tsun-s5",
        "name": "Collserola Tower Refuge",
        "lat": 41.4243,
        "lon": 2.1150,
        "capacity": 800,
        "shelter_type": "shelter",
    },
    {
        "id": "tsun-s6",
        "name": "Hospital Mútua de Terrassa",
        "lat": 41.5605,
        "lon": 2.0099,
        "capacity": 600,
        "shelter_type": "hospital",
    },
    {
        "id": "tsun-s7",
        "name": "Molins de Rei Inland Camp",
        "lat": 41.4133,
        "lon": 1.9988,
        "capacity": 3500,
        "shelter_type": "shelter",
    },
    {
        "id": "tsun-s8",
        "name": "Esplugues High-Ground Centre",
        "lat": 41.3756,
        "lon": 2.0877,
        "capacity": 2000,
        "shelter_type": "assembly",
    },
]

SHELTERS_BY_SCENARIO: Dict[str, List[Dict[str, Any]]] = {
    "fire":    FIRE_SHELTERS,
    "flood":   FLOOD_SHELTERS,
    "tsunami": TSUNAMI_SHELTERS,
}


def get_shelters(disaster_type: str) -> List[Dict[str, Any]]:
    return SHELTERS_BY_SCENARIO.get(disaster_type, FIRE_SHELTERS)
