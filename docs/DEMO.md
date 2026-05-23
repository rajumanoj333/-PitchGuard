# PitchGuard Demo Script (3 min)

## Opening (15 s)

> "120,000 fans. One stadium. Zero room for error. PitchGuard is the AI command
> center that sees the surge before it happens."

## Beat 1 — Console live (45 s)

- Open `https://pitchguard.web.app`.
- Show **stadium map** with live gate markers, color-coded by density.
- Point at **severity badge**: currently `WATCH`.
- Mention "every signal you see here is updating in real time from Firestore."

## Beat 2 — Surge happens (45 s)

- Start the simulator with a spike pattern:
  ```bash
  python simulator/simulate.py --brain $BRAIN_URL --rate 2
  ```
- Watch a gate marker grow red.
- Severity badge flips to `WARN`, then `CRITICAL`.
- Decision feed shows Gemini's recommendation: *"Density at Gate B reached 4.6/m²; redirect arrivals to Gate D."*

## Beat 3 — Fans get pushed (30 s)

- Switch to a phone (or emulator) subscribed to `pitchguard-alerts`.
- FCM notification appears with the reroute instruction.
- Open the in-app map — recommended exit highlighted.

## Beat 4 — Storm warning (30 s)

- Simulator injects `lightning_km: 6.0`.
- Console flips to red banner: "Lightning within 6 km — move to covered concourse."
- Show Gemini's structured `Decision` JSON in the logs panel.

## Beat 5 — Wrap (15 s)

> "Built end-to-end on Google Cloud — Gemini 2.5, Vertex AI, Firestore,
> Cloud Run, Firebase Hosting, Maps Platform. Less than $1 per match.
> Scales from one ground to every IPL venue."

## Backup talking points if Q&A

- **Latency:** brain median 700ms (Gemini Flash) → Firestore push < 300ms → console < 100ms render.
- **Privacy:** no faces stored. Vision API returns counts only; raw frames discarded after inference.
- **Vendor lock-in?** Single brain endpoint; could swap Gemini for any LLM with structured output.
