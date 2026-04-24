# RouteOut — Notification Service

A standalone FastAPI service that delivers real-time emergency alerts to judges' phones via a PWA. No app install required — they scan a QR code, open a browser page, and are instantly connected.

---

## Architecture

```
Dashboard backend (port 8000)
  │  POST /trigger-alert
  ▼
Notification backend (port 9000)
  │  WebSocket broadcast
  ▼
Judge's phone browser (PWA)
  • Shows full-screen emergency popup
  • Leaflet map with route + shelter marker + live GPS dot
  • Web Push notification (if HTTPS)
```

---

## Folder structure

```
notification/
  backend/
    main.py           FastAPI app (WS broadcaster, push relay, alert endpoint)
    push.py           VAPID / Web Push helper
    requirements.txt
    .env.example
  frontend/
    index.html        PWA shell (dark-themed, mobile-first)
    app.js            WebSocket client, Leaflet map, push registration
    sw.js             Service Worker (Web Push handler)
    manifest.json     PWA manifest
  README.md           (this file)
```

---

## Running locally

### 1. Notification service (port 9000)

```bash
cd notification/backend

# Install dependencies
pip install -r requirements.txt

# Copy env file and optionally set VAPID keys
# (keys are auto-generated on first run if left blank)
cp .env.example .env

# Start
python main.py
# or:
uvicorn main:app --host 0.0.0.0 --port 9000 --reload
```

### 2. Dashboard backend (port 8000)

```bash
cd dashboard/backend

cp .env.example .env
# Set NOTIFICATION_SERVICE_URL=http://localhost:9000

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Dashboard frontend (port 3000)

```bash
cd dashboard/frontend
npm install
npm run dev
```

### 4. Give judges the PWA URL

Open `http://localhost:9000/qr` — it prints your local IP and port to the terminal.
Give judges the URL `http://<your-ip>:9000` or QR-encode it with any free online tool.

---

## Environment variables

### notification/backend/.env

| Variable          | Default              | Description                                         |
|-------------------|----------------------|-----------------------------------------------------|
| `PORT`            | `9000`               | Port for the notification service                   |
| `VAPID_PUBLIC_KEY` | *(auto-generated)*  | VAPID public key for Web Push                       |
| `VAPID_PRIVATE_KEY`| *(auto-generated)*  | VAPID private key for Web Push                      |

> **VAPID keys** are auto-generated on first run and printed to stdout. Copy them into `.env` to persist them. Web Push only works over **HTTPS** in production; on a local LAN the in-tab WebSocket popup is used as fallback automatically.

### dashboard/backend/.env

| Variable                   | Default                    | Description                            |
|----------------------------|----------------------------|----------------------------------------|
| `NOTIFICATION_SERVICE_URL` | `http://localhost:9000`    | Where the dashboard forwards alerts    |

---

## Triggering an alert manually (demo / testing)

```bash
curl -X POST http://localhost:9000/trigger-alert \
  -H "Content-Type: application/json" \
  -d '{
    "disaster_type": "fire",
    "message": "FIRE EMERGENCY — Evacuate the zone immediately.",
    "shelter": { "name": "Palau Sant Jordi", "lat": 41.3647, "lon": 2.1527 },
    "path": [
      { "lat": 41.3780, "lng": 2.1900 },
      { "lat": 41.3720, "lng": 2.1750 },
      { "lat": 41.3647, "lng": 2.1527 }
    ]
  }'
```

---

## Real-world integration

In a production deployment `POST /trigger-alert` would not be a manual HTTP endpoint — it would be driven by an authoritative government alerting feed.

### CAP (Common Alerting Protocol)

The [Common Alerting Protocol (CAP)](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html) is an OASIS/ITU-T standard for machine-to-machine emergency alerts. It is used by:

- **EU-Alert / Cell Broadcast** — all EU member states are required to implement by 2022 (Directive 2018/1972)
- **IPMA** (Portugal), **AEMET** (Spain), **SENAPRED** (Chile), **NOAA** (USA), and virtually every national meteorological or civil protection agency

A production integration would look like:

```python
# In notification/backend/main.py — replace or supplement POST /trigger-alert

import xml.etree.ElementTree as ET
import httpx

CAP_FEED_URL = "https://alerts.example.gov/cap/feed.xml"  # government CAP atom feed

async def poll_cap_feed():
    """Poll a CAP feed every 60 s; fire _broadcast() on new alerts."""
    seen_ids = set()
    while True:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(CAP_FEED_URL, timeout=10)
            root = ET.fromstring(resp.text)
            for alert in root.findall("{urn:oasis:names:tc:emergency:cap:1.2}alert"):
                alert_id = alert.findtext("{...}identifier")
                if alert_id in seen_ids:
                    continue
                seen_ids.add(alert_id)

                # Map CAP fields to our AlertPayload
                event = alert.findtext(".//{...}event") or "emergency"
                description = alert.findtext(".//{...}description") or ""
                payload = {
                    "disaster_type": _map_cap_event(event),
                    "message": description,
                    "shelter": None,
                    "path": [],
                }
                await _broadcast(payload)
        except Exception as exc:
            logger.warning("CAP feed poll failed: %s", exc)
        await asyncio.sleep(60)
```

The `_broadcast()` and `send_push()` calls are identical to the manual endpoint — only the trigger mechanism changes.
