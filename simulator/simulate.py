"""PitchGuard match-day simulator.

Pumps zone-density and weather signals at the brain so the console + fan phones light up.

  # nominal day
  python simulate.py --brain http://localhost:8080 --rate 2

  # celebrity arrival surge in Zone NORTH (THE hackathon demo)
  python simulate.py --scenario celebrity --rate 2

  # storm
  python simulate.py --scenario storm --rate 2
"""

from __future__ import annotations

import argparse
import math
import random
import time

import httpx

# Narendra Modi Stadium, Ahmedabad — 4 main gate concourses (one per zone).
# capacity_m2 sized for surge-math, not real footprint.
GATES = [
    {"gate_id": "Gate 1",  "zone_id": "NORTH", "capacity_m2": 60.0},
    {"gate_id": "Gate 5",  "zone_id": "EAST",  "capacity_m2": 60.0},
    {"gate_id": "Gate 9",  "zone_id": "SOUTH", "capacity_m2": 80.0},
    {"gate_id": "Gate 11", "zone_id": "WEST",  "capacity_m2": 60.0},
]


def gate_payload(t: float, scenario: str) -> dict:
    gates = []
    note = None

    for i, g in enumerate(GATES):
        phase = i * 1.4
        base = 80 + 120 * (math.sin(t / 10.0 + phase) ** 2)
        scan = random.randint(60, 180)
        headcount = int(base + random.randint(-15, 15))

        if scenario == "celebrity" and g["zone_id"] == "NORTH":
            # Ramp NORTH zone to crush levels over ~20 ticks
            ramp = min(1.0, t / 20.0)
            surge = 320 * ramp + random.randint(-20, 40)
            headcount = int(base + surge)
            scan = random.randint(180, 260)
            note = "Celebrity arrival reported at North entrance — crowd converging"

        if scenario == "storm":
            note = "Storm front approaching — lightning <10km"

        gates.append({**g, "headcount": headcount, "scan_rate_per_min": scan})

    if scenario == "storm":
        weather = {
            "lightning_km": 6.0,
            "rain_mm_per_hr": 14.0,
            "temperature_c": 27.0 + random.uniform(-1, 1),
        }
    else:
        weather = {
            "lightning_km": random.choice([None, None, None, 18.0]),
            "rain_mm_per_hr": random.choice([0.0, 0.0, 0.0, 2.0]),
            "temperature_c": 30.0 + random.uniform(-2, 4),
        }

    payload: dict = {"gates": gates, "weather": weather}
    if note:
        payload["note"] = note
    return payload


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", default="http://localhost:8080")
    ap.add_argument("--rate", type=float, default=1.0, help="signals per second")
    ap.add_argument("--ticks", type=int, default=0, help="0 = forever")
    ap.add_argument(
        "--scenario",
        choices=["nominal", "celebrity", "storm"],
        default="nominal",
    )
    args = ap.parse_args()

    print(f"[sim] target={args.brain} scenario={args.scenario} rate={args.rate}/s")
    t = 0.0
    i = 0
    with httpx.Client(timeout=20.0) as c:
        while args.ticks == 0 or i < args.ticks:
            payload = gate_payload(t, args.scenario)
            try:
                r = c.post(f"{args.brain}/ingest", json=payload)
                d = r.json()
                alarm = "🚨" if d.get("alarm") else "  "
                print(
                    f"[sim] {alarm} tick={i:>3} sev={d.get('severity'):<8} "
                    f"reroute={d.get('reroute_from_zone')}→{d.get('reroute_to_zone')} "
                    f"{d.get('summary', '')[:80]}"
                )
            except Exception as e:
                print(f"[sim] error: {e}")
            time.sleep(1.0 / args.rate)
            t += 1.0
            i += 1


if __name__ == "__main__":
    main()
