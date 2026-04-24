# RouteOut — HackUPC 2026 Project Breakdown

> **"When disaster strikes, existing systems tell people what is happening. RouteOut tells them where to go — with personalised evacuation routes that update automatically in real time as the danger spreads."**

**Team:** 2 people | **Duration:** 36 hours | **Event:** HackUPC 2026, Barcelona, April 24–26

---

## Table of Contents

1. [The Problem](#the-problem)
2. [What We Build](#what-we-build)
3. [Two Users — Two Interfaces](#two-users--two-interfaces)
4. [Scope — What Gets Built](#scope--what-gets-built)
5. [Architecture — Every Component](#architecture--every-component)
6. [Tech Stack](#tech-stack)
7. [UI/UX](#uiux)
8. [Do Tonight (Before Hackathon)](#do-tonight-before-hackathon)
9. [36-Hour Timeline](#36-hour-timeline)
10. [Sponsor Alignment](#sponsor-alignment)
11. [Demo Script](#demo-script)
12. [Judge Q&A — Prepared Answers](#judge-qa--prepared-answers)

---

## The Problem

Current emergency systems have a fatal flaw: they tell people **what** is happening, not **where to go**.

- SMS alerts say "wildfire near Tibidabo — evacuate"
- Sirens sound
- Broadcasts warn of danger

But nobody tells people which direction is safe, which streets are passable, or what to do when their chosen route becomes dangerous. People panic. They make wrong decisions. Routes that were safe five minutes ago are now blocked.

**72 people died at Grenfell Tower (2017).** Many didn't know which way to go.  
**200+ died in Valencia (November 2024).** AEMET predicted the DANA storm 72 hours ahead. People died anyway — because no system translated the regional alert into street-level directions.

The gap is not forecasting. The gap is **routing**.

---

## What We Build

A two-sided emergency intelligence system:

- **Coordinator side:** city-wide tactical dashboard showing danger spreading, all citizen routes, automatic rerouting events, statistics
- **Citizen side:** a single mobile page showing one person's route to safety, updated in real time

### What makes it technically non-trivial

| Component | What it does | Why it's not trivial |
|---|---|---|
| LLM hazard synthesiser | Converts 3 unstructured text feeds into a typed HazardEvent JSON | Multilingual, heterogeneous inputs — not parseable by rules |
| Cellular automata fire spread | Wind direction + elevation + vegetation factor | Real physics, not a circle |
| Predictive A* routing | Penalises edges dangerous at user ETA, not just now | Requires hazard spread forecast, not just current state |
| Route invalidation monitor | Auto-detects compromised routes, recalculates, pushes via WebSocket | Background asyncio loop — no human presses a button |
| Real citizen integration | Judge's actual GPS on coordinator map | One real dot beats fifty fake ones |
| Live AEMET weather data | Real Barcelona wind speed and direction | One genuine live data source |

---

## Two Users — Two Interfaces

### User 1 — Emergency Coordinator (authority side)

A municipal emergency management officer or 112 operations centre coordinator.

**They see:**
- City-wide dark Mapbox map of Barcelona
- Red danger zone polygon expanding as simulation advances
- Dashed orange predicted danger zone (15-min forecast)
- All citizen dots (amber = evacuating, green = reached safety)
- All route lines (green = safe, red flash = compromised → new green)
- Safe zone circles with capacity fill indicators
- Control panel (scenario buttons, advance, reset)
- Live AEMET weather readout
- Statistics panel (citizens evacuating, reached safety %, routes recalculated, clearance time)
- LLM synthesis log (appears 10s on trigger: 3 inputs → HazardEvent JSON)
- Notification feed (cards per rerouting event)

### User 2 — Citizen (individual side)

A resident in the affected area. Opens a URL on their phone. No app download required.

**They see:**
- One button: "Share my location to receive evacuation route"
- After sharing: small Mapbox map with their dot, their route line, safe zone marker
- Large instruction text: *"Head to Parc de la Ciutadella via Carrer de Wellington — 1.2km, ~15 min on foot"*
- Status pill: **Safe Route Active** (green) → **Route Updated** (red banner) → back to green with new instruction
- Nothing else — no city view, no statistics, no other citizens

### The split-screen demo moment

Coordinator dashboard on your laptop. Citizen page on the judge's phone (via QR code).

Fire starts. Both screens update simultaneously. The coordinator sees the city-scale picture. The judge feels their own route update on their phone. That simultaneity — two perspectives, one event — is the demo's most powerful moment.

---

## Scope — What Gets Built

### Real data (not simulated)

- ✅ **AEMET live weather API** — real wind speed and direction for Barcelona (free API key, 2 hours of work)
- ✅ **OSMnx Barcelona street network** — real streets, real coordinates, real topology (download tonight)
- ✅ **Browser Geolocation API** — judge's real GPS on coordinator map, real route on citizen page
- ✅ **Manually defined safe zones** — real Barcelona coordinates for 5 locations (written tonight)
- ✅ **Manually defined vegetation zones** — real geography for Tibidabo, Collserola, Gràcia, Eixample (written tonight)

### Simulated (with honest framing ready for judges)

- Disaster trigger — button press (in deployment: official alert systems and sensors)
- Social media input — pre-written tweet string (in deployment: platform API monitoring)
- Emergency services input — pre-written string (in deployment: 112 integration)
- Affected citizen pool — randomly distributed in affected area (in deployment: opted-in registered residents)

### Explicitly cut — do not build

- ❌ NDVI from Sentinel-2 — no time to pre-process (future development answer covers this)
- ❌ Twitter/X API — costs money, approval takes days
- ❌ 112 API — doesn't exist publicly
- ❌ Building-level floor routing — completely different system
- ❌ Crowd movement simulation — research-level problem
- ❌ Earthquake scenario — different physics; fire + flood only
- ❌ Multi-city global selector — good future pitch, not worth the UI time
- ❌ Docker deployment — local demo only
- ❌ Market size slide in demo — save for judge Q&A only

### Two scenarios only

**Scenario 1 — Tibidabo Wildfire (PRIMARY)**  
Fire ignites at Tibidabo (41.4227°N, 2.1186°E). Real AEMET wind data drives spread direction. Cellular automata spreads through high-vegetation Collserola toward urban Gràcia. Routes for 30 simulated citizens + 1 real judge citizen. Fire spreads → routes invalidate → automatic rerouting via WebSocket. **This scenario must work flawlessly before anything else is built.**

**Scenario 2 — Barceloneta Coastal Flood (secondary)**  
Storm surge. Water level rises incrementally. Elevation-based flood model marks streets below water_level as impassable. Barceloneta and Port Vell flood progressively. Routes redirect to elevated safe zones (Montjuïc, Ciutadella). Simpler physics — good second scenario showing system handles different hazard types.

---

## Architecture — Every Component

```
[Scenario trigger + input feeds]
        ↓
[LLM hazard synthesiser]          ← Claude/Gemini API (1 call per trigger)
        ↓
[Fire spread simulator]           ← Cellular automata (wind + elevation + vegetation)
[Flood propagation model]         ← Elevation threshold (scenario 2)
        ↓
[Safe zone selector]              ← Multi-criteria scoring
        ↓
[Danger-aware A* pathfinder]      ← NetworkX on OSMnx graph
        ↓
[Route invalidation monitor]      ← asyncio background loop (THE WOW MOMENT)
        ↓
[FastAPI WebSocket broadcaster]   ← Pushes state every 30 seconds
        ↓
[Coordinator React dashboard]     ← Mapbox GL, dark map, all layers
[Citizen React page]              ← Simple mobile view, 5-second polling
```

### Component details

**1. Scenario trigger + input feeds**  
Button press loads: 3 pre-written text strings from `scenarios.json` + real AEMET wind call + 30 random citizen positions in affected radius.

**2. LLM hazard synthesiser**  
Single API call. Receives 3 text strings + AEMET wind data. System prompt forces JSON output matching HazardEvent Pydantic schema. Always have a hardcoded fallback HazardEvent for if the API is slow.

```python
# HazardEvent schema
class HazardEvent(BaseModel):
    hazard_type: str           # "fire" | "flood"
    origin_lat: float
    origin_lon: float
    wind_direction_deg: float
    wind_speed_kmh: float
    spread_rate: str           # "low" | "medium" | "high"
    confidence: float          # 0-1
    sources_count: int
```

**3. Fire spread simulator (cellular automata)**  
Use teammate's `FireSpreadSimulator` class exactly as written. Grid of 50m cells. Each tick: applies `spread_probability()` using wind vector, elevation difference, vegetation factor from `vegetation_zones.json`. Returns GeoJSON polygon of burning zone + predicted zone (15-min forecast). Runs every 30 seconds real time = 5 minutes simulated.

**4. Flood propagation model (scenario 2)**  
Water level rises 0→3m over 20 simulated minutes. Mark all elevation raster pixels below `water_level` as flooded. Convert to GeoJSON polygon with Shapely. Uses Copernicus DEM for Barcelona as NumPy array.

**5. Safe zone selector**  
Filters zones overlapping danger polygon. Scores remainder by:
- Distance: 35%
- Capacity utilisation: 25%  
- Safety margin from danger edge: 30%
- Accessibility: 10%

**6. Danger-aware A\* pathfinder**  
NetworkX graph from `barcelona_graph.graphml`. For each citizen:
- Remove edges inside current danger polygon (impassable)
- Apply danger penalty (×1000) to edges inside predicted 15-min zone
- Apply congestion penalty (×1.1 per additional citizen on same edge)
- Run `nx.astar_path()` to assigned safe zone

**7. Route invalidation monitor — THE WOW MOMENT**  
`asyncio` background task, runs every 30 seconds. For each active route: checks if any segment intersects updated danger polygon using Shapely. If yes: recalculate A* from estimated current citizen position → push updated route via WebSocket → increment "Routes recalculated" counter. **Runs automatically. No human presses a button.**

**8. Citizen location endpoint**  
- `POST /citizen/join` → receives `{lat, lon}`, assigns ID, calculates initial A* route, returns `{citizen_id, route_geojson, destination_name, distance_km, time_minutes}`
- `GET /citizen/{id}/state` → returns current route status + updated route if changed. Citizen page polls every 5 seconds.

**9. FastAPI WebSocket broadcaster**  
`/ws` endpoint pushes every simulation tick:
```json
{
  "danger_polygon": {...geojson},
  "predicted_polygon": {...geojson},
  "citizens": {...geojson},
  "routes": {...geojson},
  "safe_zones": {...geojson},
  "statistics": {
    "evacuating": 22,
    "reached_safety": 8,
    "routes_recalculated": 3,
    "clearance_minutes": 12
  }
}
```

**10. REST endpoints**  
- `POST /scenario/trigger {scenario_id}` — starts scenario  
- `POST /scenario/advance` — advance 5 simulated minutes (demo control)  
- `GET /scenario/state` — full current state snapshot  
- `GET /safe-zones` — all safe zone data  
- `GET /weather/current` — live AEMET wind data  
- `POST /scenario/reset` — clears all state  

---

## Tech Stack

### Backend (Python)

| Library | Role |
|---|---|
| **FastAPI** | REST endpoints + WebSocket server. Team knows from Finsight. |
| **OSMnx** | Downloads Barcelona street network as NetworkX graph. Run tonight, save as GraphML. |
| **NetworkX** | Graph operations. A* built in as `nx.astar_path()`. Custom weight function adds penalties. |
| **Shapely** | Segment-polygon intersection (route invalidation), convex hull (GeoJSON output), point-in-polygon (vegetation lookup). |
| **NumPy** | Cellular automata grid (fire). Elevation raster array (flood). |
| **rasterio** | Load Copernicus DEM GeoTIFF. Extract elevation values. Used once at startup. |
| **Anthropic SDK** | One `messages.create()` call per scenario trigger. Returns HazardEvent JSON. |
| **Pydantic** | HazardEvent schema, CitizenState schema, RouteResponse schema. Team knows from Finsight. |
| **requests** | AEMET API call. Simple GET, returns current wind data. |
| **asyncio** | Background simulation loop — built into Python, no install needed. |

### Frontend (React)

| Library | Role |
|---|---|
| **React + Vite** | Two pages: `/coordinator` and `/citizen`. Team knows this. |
| **Mapbox GL JS** | Dark basemap (dark-v11). GeoJSON sources updated via `setData()` on each WebSocket tick. |
| **Native WebSocket API** | Browser WebSocket to FastAPI `/ws`. No socket.io needed. |
| **Native Geolocation API** | `navigator.geolocation.getCurrentPosition()` on citizen page. No library. |
| **Tailwind CSS** | Dark UI styling. Team knows this. |

### Data files (prepared tonight)

| File | Contents |
|---|---|
| `barcelona_graph.graphml` | OSMnx download. ~15MB. Load at FastAPI startup. |
| `safe_zones.json` | 5 safe zones with coordinates, capacity, elevation. |
| `vegetation_zones.json` | 4 polygons: Tibidabo (0.9), Collserola (0.85), Gràcia (0.1), Eixample (0.05). |
| `scenarios.json` | Pre-written input strings for Tibidabo wildfire + fallback HazardEvent. |

### NOT using
No socket.io · No Redux · No PostgreSQL · No Docker · No ML model training · No mobile app framework

---

## UI/UX

### Design system
- **Typeface:** IBM Plex Sans
- **Map base:** `mapbox://styles/mapbox/dark-v11`
- **Background:** `#0A1628` (dark navy)
- **Danger zone:** `#C0392B` (deep red, fill opacity 0.35)
- **Predicted zone:** `#E67E22` (amber, dashed outline)
- **Active routes:** `#1ABC9C` (green)
- **Citizens:** `#F39C12` (amber)
- **Safe zones:** `#27AE60` (green)

### Coordinator dashboard — layout
- **Left 70%:** fullscreen Mapbox dark map
- **Right 30%:** control panel stack

### Map layers (coordinator)

| Layer | Description |
|---|---|
| Danger zone | Red fill polygon. Updates shape each WebSocket tick. |
| Predicted zone | Dashed orange outline — 15-min forecast position. |
| Evacuation routes | Green lines. Flash red 2s when compromised → new green route. |
| Citizens | Amber dots evacuating, green dots reached safety. Real citizen dot has pulsing ring. |
| Safe zones | Green semi-transparent circles. Fill opacity = capacity utilisation. |

### Right panel (coordinator)

| Panel | Contents |
|---|---|
| Control panel | Tibidabo Wildfire button, Barceloneta Flood button, Advance 5min, Reset, AEMET live wind readout |
| Statistics | 4 metric cards: Citizens evacuating, Reached safety %, Routes recalculated, Est. clearance time |
| LLM synthesis log | Appears 10s on trigger: 3 inputs → HazardEvent JSON. Point here when judges ask "where's the AI?" |
| Notification feed | Cards per rerouting event. Simulates what citizens receive. |

### Citizen page — `/citizen`
1. Full screen, one button: "Share my location to receive evacuation route"
2. After sharing: small Mapbox map (their dot, route line, safe zone marker)
3. Large instruction text: *"Head to Parc de la Ciutadella via Carrer de Wellington — 1.2km, ~15 min"*
4. Status pill: **Safe Route Active** → **Route Updated** → back to green
5. Polls `GET /citizen/{id}/state` every 5 seconds

### Demo configuration
Generate QR code linking to `http://[YOUR_LOCAL_IP]:3000/citizen` tonight. Both devices on same WiFi. localhost on the device running the server only — use local IP for phone access.

---

## Do Tonight (Before Hackathon)

### Non-negotiable — hackathon fails without these

**Priority 1 — Barcelona OSMnx graph**
```python
import osmnx as ox
G = ox.graph_from_place("Barcelona, Spain", network_type="walk")
ox.save_graphml(G, "barcelona_graph.graphml")
print(f"Nodes: {len(G.nodes)}, Edges: {len(G.edges)}")
```
Takes 15–20 minutes. May need retries. Do it now.

**Priority 2 — AEMET API key**  
Register at opendata.aemet.es. Takes 5 minutes, key arrives by email. Test one API call returns wind data for Barcelona.

**Priority 3 — Claude or Gemini API key**  
Test one `messages.create()` call works from Python. Write a fallback hardcoded HazardEvent JSON for demo reliability.

**Priority 4 — Mapbox token**  
Create blank React app, add Mapbox GL, confirm dark-v11 basemap renders on localhost. Debug tonight, not tomorrow.

### Important — saves hackathon time

**Priority 5 — safe_zones.json**
```json
[
  {"id": "sz1", "name": "Parc de la Ciutadella", "lat": 41.3874, "lon": 2.1873, "capacity": 10000, "elevation_m": 12},
  {"id": "sz2", "name": "Montjuïc", "lat": 41.3638, "lon": 2.1597, "capacity": 15000, "elevation_m": 185},
  {"id": "sz3", "name": "Plaça Catalunya", "lat": 41.3870, "lon": 2.1700, "capacity": 5000, "elevation_m": 15},
  {"id": "sz4", "name": "Parc Güell", "lat": 41.4145, "lon": 2.1527, "capacity": 8000, "elevation_m": 130},
  {"id": "sz5", "name": "Fòrum", "lat": 41.4105, "lon": 2.2264, "capacity": 12000, "elevation_m": 5}
]
```

**Priority 6 — vegetation_zones.json**  
4 polygons with approximate bounding coordinates:
- Tibidabo forest: `vegetation: 0.9`
- Collserola park: `vegetation: 0.85`
- Urban Gràcia district: `vegetation: 0.1`
- Eixample grid: `vegetation: 0.05`

**Priority 7 — scenarios.json**
```json
{
  "tibidabo_wildfire": {
    "aemet": "AVISO ROJO. Incendio forestal activo en Tibidabo. Viento NO 25km/h. Temperatura 38°C. Humedad 15%.",
    "tweet": "Huge smoke cloud visible from Gràcia, wind pushing it southeast fast. #Tibidabo #Barcelona",
    "emergency": "Fire confirmed Tibidabo summit. Spread rate high due to dry conditions and NW wind.",
    "fallback_hazard_event": {
      "hazard_type": "fire",
      "origin_lat": 41.4227,
      "origin_lon": 2.1186,
      "wind_direction_deg": 315,
      "wind_speed_kmh": 25,
      "spread_rate": "high",
      "confidence": 0.91,
      "sources_count": 3
    }
  }
}
```

**Priority 8 — QR code**  
Find your local IP (`ipconfig` on Windows, `ifconfig` on Mac/Linux). Generate QR code at qr-code-generator.com linking to `http://[YOUR_IP]:3000/citizen`. Print or save.

**Priority 9 — test A\* on real graph**  
Load the GraphML file, pick two nodes, run `nx.astar_path()`. Confirm valid path returned.

---

## 36-Hour Timeline

| Time | Person 1 (Backend + AI) | Person 2 (Frontend) |
|---|---|---|
| **0–2hrs** | FastAPI skeleton, WebSocket stub, load graph, confirm A* runs on Barcelona nodes | React + Vite, Mapbox dark map rendering, hardcoded GeoJSON polygon as red fill layer |
| **2–4hrs** | AEMET API call working with real wind data. LLM synthesiser prompt engineering until HazardEvent JSON consistently valid. Build fallback. | All Mapbox layers set up with hardcoded test data. WebSocket client connected. |
| **4–8hrs** ⚠️ | Fire spread simulator producing GeoJSON polygons on Barcelona coordinates. Safe zone selector. A* with danger penalties for 5 test citizens. | Map layers updating from WebSocket. Control panel buttons wired. Statistics panel layout. |
| **8–14hrs** 🔴 | **INTEGRATION SPRINT** — both people together. Scenario trigger → LLM → fire spread → A* routes for 30 citizens → WebSocket push → map updates. Get end-to-end working. Do not move on until fire appears on map and green routes appear for citizen dots. ||
| **14–18hrs** 🔴 | **ROUTE INVALIDATION MONITOR** — asyncio loop, Shapely intersection check, A* recalculation, WebSocket push. Test: fire spreads into route → green turns red → new green appears automatically. This is the wow moment. Must work reliably. ||
| **18–22hrs** | POST /citizen/join, GET /citizen/state, 5-second polling, citizen position interpolation. Flood scenario spread model. | Citizen page /citizen — location share button, small map, instruction text, status pill, 5-second polling. LLM synthesis log display. Notification feed cards. |
| **22–26hrs** | Flood scenario end-to-end. Predicted danger zone polygon. | Citizen animation along routes. Safe zone capacity fill. Predicted zone dashed layer. UI polish. |
| **26–30hrs** | **Demo rehearsal** — run Tibidabo scenario 3 times. Ask someone to scan QR code. Confirm: dot appears on coordinator map, route appears on their phone, rerouting updates both screens. Fix what breaks. ||
| **30–34hrs** 🔴 | **Devpost write-up** — judges read before demo. **Record backup video.** Register GoDaddy domain. ||
| **34–36hrs** | Final rehearsal. Practice judge Q&A answers. Sleep minimum 2 hours. **Do not add features.** ||

---

## Sponsor Alignment

### Airbus — primary target
Airbus's 2026 challenge: digital technologies for safety and connected systems.

RouteOut applies to any large venue Airbus operates — airports, airshows, manufacturing campuses. The same routing algorithm that guides Barcelona residents away from a wildfire routes 50,000 passengers through an airport emergency.

> **Pitch:** "We built evacuation intelligence for any large venue. An airport, a stadium, a city. The routing algorithm and spread model are venue-agnostic."

### Skyscanner — strong secondary
Routing under extreme constraints. Predictive A* is directly analogous to routing around predicted flight delays.

> **Pitch:** "Same routing intelligence as travel planning. Different stakes — and a dynamic hazard instead of traffic."

### MLH — Gemini API prize
Swap Claude for Gemini in the LLM synthesiser. One line of code. Gemini's multilingual capability is an advantage — your inputs are Spanish (AEMET) and English (tweet, emergency).

### GoDaddy Registry — domain prize
Register `routeout.app` or `routeout.io`. 10 minutes. Makes Devpost look production-ready.

---

## Demo Script

> **"In 2017, 72 people died in Grenfell Tower. Many didn't know which way to go. Some routes were already blocked by fire. They received warnings — but no directions."**

*[open coordinator dashboard — dark Barcelona map, calm]*

> **"Current emergency systems tell you what is happening. RouteOut tells you where to go."**

> **"I'm going to ask one of you to join the system right now."**

*[hand judge the QR code — they scan — citizen page opens on their phone — their dot appears on coordinator map]*

> **"That's you. Your real location. Live."**

*[click Tibidabo Wildfire — LLM synthesis panel flashes: 3 inputs → HazardEvent JSON — AEMET live wind readout shows real current data]*

> **"A wildfire ignites near Tibidabo. Our AI reads three simultaneous data sources — a weather alert, a social media report, an emergency services update — and produces a structured hazard model in under 2 seconds. The wind data is live from AEMET right now."**

*[fire zone appears — routes generate for 30 citizens + judge's dot — green line appears on judge's phone]*

> **"Every citizen in the affected area receives a personalised route to the nearest safe zone. Including you."**

*[click Advance 5 minutes — fire spreads southeast toward Gràcia driven by NW wind]*

> **"Five minutes pass. The fire spreads with the wind."**

*[3 route lines flash red — new green routes appear automatically — judge's phone updates — notification cards appear — routes recalculated counter increments]*

> **"Three routes are compromised. The system detects this automatically — no one presses a button — recalculates, and pushes new routes instantly."**

*[show statistics: 8 reached safety, 22 in transit, 3 routes recalculated]*

> **"72 people died at Grenfell because they had warnings but no directions. RouteOut gives them directions. Updated in real time. As the danger moves."**

---

## Judge Q&A — Prepared Answers

**"Where does the data come from?"**  
"Wind data is live from AEMET's public API — you can see the current reading on screen. The street network is real Barcelona data from OpenStreetMap. The disaster trigger and social media inputs are simulated for the demo — in deployment they connect to official alert systems and monitoring feeds."

**"What does the AI do exactly?"**  
"The LLM is a data fusion engine. It receives three inputs in different formats and languages simultaneously — a Spanish weather alert, an English tweet, an emergency services update — and outputs a single typed schema that our spread model and routing engine act on. It's not generating text for humans. It's converting messy signals into clean structured data."

**"How is this different from Google Maps?"**  
"Google Maps reroutes around current obstacles — traffic that exists now. RouteOut reroutes around where the danger will be when you get there. We penalise routes that will be dangerous by your estimated arrival time, not just routes dangerous right now. That requires predicting hazard spread, not just measuring current state."

**"What's next for the system?"**  
"Vegetation data from Sentinel-2 NDVI satellite imagery updated every 5 days — replacing our manual zones with automated real-world data. Direct AEMET alert integration replacing the simulated trigger. And the citizen side scaled to all opted-in residents of a city, not just one demo user."

**"Is there any ML?"**  
"The LLM is a large language model — that's our AI component. The fire spread simulation uses physics-based cellular automata, which is the scientifically correct model for fire propagation. The routing uses graph algorithms. We used the right tool for each problem rather than forcing ML where deterministic approaches are more accurate."

---

## Repo Structure

```
routeout/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI entry point
│   │   ├── core/
│   │   │   ├── llm_synthesiser.py   # Claude/Gemini API → HazardEvent
│   │   │   ├── fire_spread.py       # Cellular automata simulator
│   │   │   ├── flood_model.py       # Elevation threshold model
│   │   │   ├── pathfinder.py        # Danger-aware A* routing
│   │   │   ├── safe_zones.py        # Multi-criteria zone selector
│   │   │   └── invalidation.py      # asyncio route monitor
│   │   ├── api/
│   │   │   ├── routes.py            # REST endpoints
│   │   │   ├── websocket.py         # WebSocket broadcaster
│   │   │   └── schemas.py           # Pydantic models
│   │   └── services/
│   │       └── aemet.py             # AEMET weather API client
│   ├── data/
│   │   ├── barcelona_graph.graphml  # Pre-downloaded tonight
│   │   ├── safe_zones.json          # Written tonight
│   │   ├── vegetation_zones.json    # Written tonight
│   │   └── scenarios.json           # Written tonight
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Coordinator.jsx      # Main dashboard
│   │   │   └── Citizen.jsx          # Simple mobile view
│   │   ├── components/
│   │   │   ├── Map/
│   │   │   │   ├── CoordinatorMap.jsx
│   │   │   │   └── CitizenMap.jsx
│   │   │   ├── Dashboard/
│   │   │   │   ├── ControlPanel.jsx
│   │   │   │   ├── Statistics.jsx
│   │   │   │   ├── LLMLog.jsx
│   │   │   │   └── NotificationFeed.jsx
│   │   │   └── Citizen/
│   │   │       ├── RouteInstruction.jsx
│   │   │       └── StatusPill.jsx
│   │   └── services/
│   │       ├── websocket.js
│   │       └── api.js
│   └── package.json
└── README.md
```

---

## Positioning

**RouteOut** is a two-sided emergency intelligence system:
- The **coordinator** sees the city and makes decisions
- The **citizen** receives personalised directions and follows them

The technology that enables this: LLM-based multi-source hazard synthesis feeding physics-based spread models feeding predictive graph routing with automatic real-time invalidation.

**This is not a wrapper.** The LLM produces structured data consumed by deterministic algorithms — not text for humans to read. The fire model implements real physics. The routing penalises future danger, not just present danger. Each component is load-bearing.

---

*Built at HackUPC 2026 · Barcelona · April 24–26*
