"""
LLM hazard synthesiser.

Receives three heterogeneous text inputs (AEMET alert, tweet, emergency report)
plus live weather data and returns a typed HazardEvent.

Design: one structured-output API call per scenario trigger.
Always falls back to the pre-written HazardEvent from scenarios.json so the
demo never breaks because of API latency.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict

from app.api.schemas import HazardEvent

_SYSTEM_PROMPT = """\
You are an emergency hazard analysis system.
You receive multiple text inputs describing an ongoing emergency and must output
a single structured JSON object that captures the key hazard parameters.

Rules:
- Output ONLY valid JSON matching the schema below. No explanation, no markdown.
- If wind data is available in the inputs, use it. Otherwise estimate from context.
- confidence: 0-1, reflecting agreement between sources.
- spread_rate: "low" | "medium" | "high"
- hazard_type: "fire" | "flood"

Schema:
{
  "hazard_type": string,
  "origin_lat": float,
  "origin_lon": float,
  "wind_direction_deg": float,
  "wind_speed_kmh": float,
  "spread_rate": string,
  "confidence": float,
  "sources_count": integer
}"""


def synthesise(
    inputs: Dict[str, str],
    weather: Dict[str, Any],
    fallback: Dict[str, Any],
) -> tuple[HazardEvent, float, str]:
    """
    Returns (HazardEvent, latency_ms, provider_used).

    Tries Anthropic Claude first. Falls back to hardcoded event if API fails.
    Set LLM_PROVIDER=gemini to swap (one-line change for MLH Gemini prize).
    """
    provider = os.getenv("LLM_PROVIDER", "anthropic").lower()

    user_content = (
        f"AEMET ALERT: {inputs.get('aemet', '')}\n\n"
        f"SOCIAL MEDIA: {inputs.get('tweet', '')}\n\n"
        f"EMERGENCY SERVICES: {inputs.get('emergency', '')}\n\n"
        f"LIVE WEATHER DATA: wind {weather.get('wind_speed_kmh', '?')} km/h "
        f"from {weather.get('wind_direction_deg', '?')}°, "
        f"temperature {weather.get('temperature_c', '?')}°C, "
        f"humidity {weather.get('humidity_pct', '?')}%"
    )

    t0 = time.time()
    try:
        if provider == "anthropic":
            event = _call_anthropic(user_content)
        else:
            event = _call_gemini(user_content)
        latency_ms = (time.time() - t0) * 1000
        return event, latency_ms, provider
    except Exception:
        latency_ms = (time.time() - t0) * 1000
        return HazardEvent(**fallback), latency_ms, "fallback"


def _call_anthropic(user_content: str) -> HazardEvent:
    import anthropic  # lazy import — not installed crashes fail gracefully above

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )
    raw = msg.content[0].text.strip()
    return HazardEvent(**json.loads(raw))


def _call_gemini(user_content: str) -> HazardEvent:
    import google.generativeai as genai  # pip install google-generativeai

    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    model = genai.GenerativeModel("gemini-1.5-flash")
    prompt = f"{_SYSTEM_PROMPT}\n\n{user_content}"
    response = model.generate_content(prompt)
    raw = response.text.strip()
    # Strip markdown fences if Gemini wraps in ```json
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return HazardEvent(**json.loads(raw))
