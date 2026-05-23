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


# Narendra Modi Stadium, Ahmedabad — real coordinates of 4 primary entry/exit gates.
# Stadium center: ~23.0922 N, 72.5972 E (Motera, Ahmedabad). Worlds largest cricket stadium.
STADIUM_CENTER = {"lat": 23.09225, "lng": 72.59720, "name": "Narendra Modi Stadium, Ahmedabad"}

ZONES: dict[str, dict] = {
    "NORTH": {
        "gate_id": "Gate 1",
        "lat": 23.09365, "lng": 72.59710,
        "label": "Zone North · Gate 1 (Motera Stadium Rd)",
        "capacity_m2": 800.0,
    },
    "EAST": {
        "gate_id": "Gate 5",
        "lat": 23.09225, "lng": 72.59870,
        "label": "Zone East · Gate 5 (Players Pavilion)",
        "capacity_m2": 800.0,
    },
    "SOUTH": {
        "gate_id": "Gate 9",
        "lat": 23.09075, "lng": 72.59720,
        "label": "Zone South · Gate 9 (Main Entrance)",
        "capacity_m2": 1200.0,
    },
    "WEST": {
        "gate_id": "Gate 11",
        "lat": 23.09225, "lng": 72.59570,
        "label": "Zone West · Gate 11 (Broadcast Side)",
        "capacity_m2": 800.0,
    },
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


class ManualAlert(BaseModel):
    zone_id: str  # target zone (fans currently in this zone receive alert)
    exit_gate: str  # gate id like "Gate 9"
    exit_lat: float
    exit_lng: float
    message: str = Field(max_length=240)
    severity: Literal["info", "watch", "warn", "critical"] = "warn"
    operator: str = "control-room"


@app.post("/alerts")
def manual_alert(a: ManualAlert) -> dict:
    """Operator-issued push: tell every fan in `zone_id` to evacuate via `exit_gate`."""
    if db is None:
        raise HTTPException(status_code=503, detail="firestore unavailable")
    doc = {
        "ts": firestore.SERVER_TIMESTAMP,
        "type": "manual",
        **a.model_dump(),
    }
    ref = db.collection("alerts").add(doc)
    return {"id": ref[1].id, "ok": True}


@app.get("/stadium")
def stadium() -> dict:
    return {"center": STADIUM_CENTER, "zones": ZONES}
