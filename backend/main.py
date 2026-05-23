"""PitchGuard brain service.

Single Cloud Run service. Ingests crowd/weather/ticket signals, reasons with
Gemini 2.5 Flash (with deterministic fallback), writes decisions to Firestore.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Literal

import firebase_admin
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import credentials, firestore
from pydantic import BaseModel, Field

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

log = logging.getLogger("pitchguard")
logging.basicConfig(level=logging.INFO)

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "pitchguard")
VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
MODEL_NAME = os.environ.get("VERTEX_MODEL", "gemini-2.5-flash")
DENSITY_THRESHOLD = float(os.environ.get("DENSITY_THRESHOLD_PER_M2", "4.0"))

# Vertex optional. If creds missing, fall back to deterministic decisions.
gemini = None
try:
    from vertexai import init as vertex_init
    from vertexai.generative_models import GenerativeModel, Part

    vertex_init(project=PROJECT_ID, location=VERTEX_LOCATION)
    gemini = GenerativeModel(MODEL_NAME)
    log.info("Vertex AI ready: model=%s", MODEL_NAME)
except Exception as e:
    log.warning("Vertex AI unavailable, using rule-based fallback: %s", e)

# Firestore optional too (demo can run without it; decisions still return).
db = None
try:
    if not firebase_admin._apps:
        cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path and os.path.exists(cred_path):
            firebase_admin.initialize_app(
                credentials.Certificate(cred_path), {"projectId": PROJECT_ID}
            )
        else:
            firebase_admin.initialize_app(options={"projectId": PROJECT_ID})
    db = firestore.client()
    log.info("Firestore ready")
except Exception as e:
    log.warning("Firestore unavailable: %s", e)


# Stadium zones — 3 zones, 3 gates. Coords chosen near a real stadium so Maps renders.
# Centered on Chinnaswamy Stadium, Bengaluru. Override via env if needed.
ZONES: dict[str, dict] = {
    "NORTH": {"gate_id": "N1", "lat": 12.97955, "lng": 77.59960, "label": "Zone North · Gate N1"},
    "EAST":  {"gate_id": "E1", "lat": 12.97890, "lng": 77.60040, "label": "Zone East · Gate E1"},
    "WEST":  {"gate_id": "W1", "lat": 12.97890, "lng": 77.59880, "label": "Zone West · Gate W1"},
}


class GateSignal(BaseModel):
    gate_id: str
    zone_id: str
    headcount: int
    capacity_m2: float = Field(gt=0)
    scan_rate_per_min: int = 0
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def density(self) -> float:
        return self.headcount / self.capacity_m2


class WeatherSignal(BaseModel):
    lightning_km: float | None = None
    rain_mm_per_hr: float = 0.0
    temperature_c: float = 30.0


class IngestPayload(BaseModel):
    gates: list[GateSignal]
    weather: WeatherSignal = WeatherSignal()
    cctv_frame_b64: str | None = None
    note: str | None = None  # optional context: "celebrity arrival", etc.


class Decision(BaseModel):
    severity: Literal["info", "watch", "warn", "critical"]
    summary: str
    actions: list[str] = []
    affected_zones: list[str] = []
    reroute_from_zone: str | None = None
    reroute_to_zone: str | None = None
    reroute_to_gate: str | None = None
    reroute_to_lat: float | None = None
    reroute_to_lng: float | None = None
    alarm: bool = False
    reason: str = ""


app = FastAPI(title="PitchGuard Brain", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _aggregate_zones(gates: list[GateSignal]) -> dict[str, dict]:
    z: dict[str, dict] = {}
    for g in gates:
        bucket = z.setdefault(g.zone_id, {"headcount": 0, "capacity_m2": 0.0, "gates": []})
        bucket["headcount"] += g.headcount
        bucket["capacity_m2"] += g.capacity_m2
        bucket["gates"].append(g.gate_id)
    for zid, b in z.items():
        b["density"] = b["headcount"] / b["capacity_m2"] if b["capacity_m2"] else 0.0
    return z


def _rule_decision(payload: IngestPayload) -> Decision:
    """Deterministic backup. Picks worst zone, reroutes to least-dense zone."""
    zones = _aggregate_zones(payload.gates)
    if not zones:
        return Decision(severity="info", summary="No gate signals", reason="empty")

    worst_id, worst = max(zones.items(), key=lambda kv: kv[1]["density"])
    best_id, _ = min(zones.items(), key=lambda kv: kv[1]["density"])

    d = worst["density"]
    if d >= DENSITY_THRESHOLD:
        sev: Literal["info", "watch", "warn", "critical"] = "critical"
    elif d >= DENSITY_THRESHOLD * 0.85:
        sev = "warn"
    elif d >= DENSITY_THRESHOLD * 0.6:
        sev = "watch"
    else:
        sev = "info"

    target = ZONES.get(best_id, {})
    do_reroute = sev in ("warn", "critical") and best_id != worst_id
    note = f" — {payload.note}" if payload.note else ""

    return Decision(
        severity=sev,
        summary=(
            f"Zone {worst_id} surge {d:.2f}/m² — divert to Zone {best_id}{note}"
            if do_reroute
            else f"All zones nominal (peak {worst_id} {d:.2f}/m²)"
        ),
        actions=(
            [
                f"Open auxiliary lanes at Gate {target.get('gate_id', best_id)}",
                f"Push reroute beacon to fans in Zone {worst_id}",
                f"Deploy marshals to Zone {worst_id} perimeter",
                "Sound zone PA: maintain walking pace, no pushing",
            ]
            if do_reroute
            else ["Hold current posture", "Monitor zone density"]
        ),
        affected_zones=[worst_id] if do_reroute else [],
        reroute_from_zone=worst_id if do_reroute else None,
        reroute_to_zone=best_id if do_reroute else None,
        reroute_to_gate=target.get("gate_id") if do_reroute else None,
        reroute_to_lat=target.get("lat") if do_reroute else None,
        reroute_to_lng=target.get("lng") if do_reroute else None,
        alarm=sev == "critical" and do_reroute,
        reason="rule-based",
    )


def _build_prompt(payload: IngestPayload, zones: dict[str, dict]) -> str:
    zone_lines = [
        f"- Zone {zid}: total {z['headcount']} on {z['capacity_m2']:.0f} m² "
        f"= density {z['density']:.2f}/m² (gates {','.join(z['gates'])})"
        for zid, z in zones.items()
    ]
    w = payload.weather
    note = f"\nOperator note: {payload.note}" if payload.note else ""
    zone_keys = ",".join(ZONES.keys())
    return (
        "You are PitchGuard, stadium safety AI. Given live zone signals, decide if "
        "fans must be rerouted to flatten the crowd. Return ONLY valid JSON with keys: "
        "severity(info|watch|warn|critical), summary(<=140 chars), actions(3-5 imperative "
        "bullets), affected_zones(list), reroute_from_zone, reroute_to_zone, alarm(bool — "
        "true only if severity=critical AND reroute needed), reason(short why).\n\n"
        f"Density threshold of concern: {DENSITY_THRESHOLD}/m². Valid zone ids: {zone_keys}.\n"
        f"Zones:\n" + "\n".join(zone_lines) + "\n"
        f"Weather: lightning {w.lightning_km} km, rain {w.rain_mm_per_hr} mm/hr, "
        f"temp {w.temperature_c} C.{note}\n\n"
        "Pick reroute_to_zone = the least-dense zone with spare capacity. "
        "Return ONLY JSON, no markdown."
    )


def _gemini_decision(payload: IngestPayload) -> Decision | None:
    if gemini is None:
        return None
    zones = _aggregate_zones(payload.gates)
    parts: list = [_build_prompt(payload, zones)]
    if payload.cctv_frame_b64:
        try:
            img_bytes = base64.b64decode(payload.cctv_frame_b64)
            parts.append(Part.from_data(img_bytes, mime_type="image/jpeg"))
        except Exception:
            pass
    try:
        resp = gemini.generate_content(
            parts,
            generation_config={
                "response_mime_type": "application/json",
                "temperature": 0.2,
            },
        )
        raw = json.loads(resp.text)
    except Exception as e:
        log.warning("Gemini call failed: %s", e)
        return None

    target = ZONES.get(raw.get("reroute_to_zone") or "", {})
    return Decision(
        severity=raw.get("severity", "info"),
        summary=raw.get("summary", ""),
        actions=raw.get("actions", []),
        affected_zones=raw.get("affected_zones", []),
        reroute_from_zone=raw.get("reroute_from_zone"),
        reroute_to_zone=raw.get("reroute_to_zone"),
        reroute_to_gate=target.get("gate_id"),
        reroute_to_lat=target.get("lat"),
        reroute_to_lng=target.get("lng"),
        alarm=bool(raw.get("alarm", False)),
        reason=raw.get("reason", "gemini"),
    )


@app.get("/healthz")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "project": PROJECT_ID,
        "model": MODEL_NAME if gemini else "fallback-rule",
        "firestore": "on" if db else "off",
    }


@app.get("/zones")
def zones_meta() -> dict[str, dict]:
    return ZONES


@app.post("/ingest", response_model=Decision)
def ingest(payload: IngestPayload) -> Decision:
    if not payload.gates:
        raise HTTPException(status_code=400, detail="at least one gate required")

    decision = _gemini_decision(payload) or _rule_decision(payload)
    zones = _aggregate_zones(payload.gates)

    if db is not None:
        doc = {
            "ts": firestore.SERVER_TIMESTAMP,
            **decision.model_dump(mode="json"),
            "zones": zones,
            "weather": payload.weather.model_dump(mode="json"),
        }
        db.collection("decisions").add(doc)

        for zid, z in zones.items():
            meta = ZONES.get(zid, {})
            db.collection("zones").document(zid).set(
                {
                    "headcount": z["headcount"],
                    "density": z["density"],
                    "gate_id": meta.get("gate_id"),
                    "lat": meta.get("lat"),
                    "lng": meta.get("lng"),
                    "label": meta.get("label", zid),
                    "updated": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )

        # Single "live" doc so /fan page can subscribe to one stable id.
        db.collection("live").document("current").set(
            {
                "ts": firestore.SERVER_TIMESTAMP,
                **decision.model_dump(mode="json"),
            }
        )

    return decision


@app.get("/decisions/recent")
def recent_decisions(limit: int = 20) -> list[dict]:
    if db is None:
        return []
    q = (
        db.collection("decisions")
        .order_by("ts", direction=firestore.Query.DESCENDING)
        .limit(limit)
    )
    return [{**d.to_dict(), "id": d.id} for d in q.stream()]
