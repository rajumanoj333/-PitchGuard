# PitchGuard

**Real-Time Crowd Command & Safety AI for Cricket Stadiums**

Gemini-powered command platform that fuses CCTV vision, ticket scans, weather radar, and fan telemetry into one console. Predicts crowd surges, auto-routes gates, dispatches security, and triggers emergency protocols — all real-time on Google Cloud.

> *"See the surge before it happens."*

---

## Problem

Massive cricket crowds create dangerous bottlenecks. Manual operations cannot adapt to surges, weather shifts, or emerging threats. Organizers need one unified, real-time command platform.

## Solution

PitchGuard ingests every signal a stadium produces, reasons over them with Gemini 2.5, and pushes actions to fans, volunteers, and security in under 2 seconds.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        INGEST                                │
│  CCTV  │  Ticket Scans  │  Fan App GPS  │  Weather  │ Social │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   BRAIN (Cloud Run + Vertex AI)              │
│     Gemini 2.5 Flash  •  Vertex AI Vision  •  Forecast       │
└──────────────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌─────────┐  ┌─────────┐  ┌─────────┐
        │Firestore│  │   FCM   │  │ BigQuery│
        └─────────┘  └─────────┘  └─────────┘
              │            │            │
              ▼            ▼            ▼
        ┌─────────┐  ┌─────────┐  ┌─────────┐
        │ Console │  │ Fan App │  │ Looker  │
        └─────────┘  └─────────┘  └─────────┘
```

## Google Cloud Stack

| Layer | Product | Role |
|---|---|---|
| AI Brain | **Vertex AI — Gemini 2.5 Flash** | Multimodal reasoning over crowd, weather, threat signals |
| Vision | **Vertex AI Vision API** | Head count + density from CCTV |
| Compute | **Cloud Run** | Auto-scaling stateless brain (0 → 1000 instances) |
| Realtime DB | **Firestore** | Live sync between brain and console |
| Notifications | **Firebase Cloud Messaging** | Push reroutes to 50k+ fans in <2s |
| Maps | **Google Maps Platform** + Photorealistic 3D Tiles | Stadium overlay + indoor routing |
| Auth | **Firebase Auth** | Operator & fan identity |
| Secrets | **Secret Manager** | API keys, service accounts |
| Hosting | **Firebase Hosting** | Console SPA |
| Analytics | **BigQuery + Looker Studio** | Post-match replay + KPIs |

## Repo Layout

```
PitchGuard/
├── backend/        # FastAPI + Vertex AI + Firestore (Cloud Run)
├── console/        # Next.js operator console (Firebase Hosting)
├── simulator/      # Crowd + weather + ticket event generator
├── infra/          # Terraform + deploy scripts
└── docs/           # Architecture, demo script, security model
```

## Quick Start

```bash
# 1. Set GCP project
gcloud config set project pitchguard

# 2. Backend (local)
cd backend && pip install -r requirements.txt
export GOOGLE_CLOUD_PROJECT=pitchguard
uvicorn main:app --reload --port 8080

# 3. Console (local)
cd console && npm install && npm run dev

# 4. Simulator
cd simulator && python simulate.py
```

## Deploy

```bash
bash infra/deploy.sh
```

## KPIs

- **Surge prediction lead time:** 15 min ahead, >85% precision
- **Alert delivery:** <2 s to 50,000 devices
- **Density threshold breach:** auto-action within 5 s
- **Operator query latency (Gemini Live):** <1 s

## Security Model

- Cloud Run runs under dedicated service account, least-privilege IAM
- All secrets in **Secret Manager**, mounted as env at runtime
- Firebase Auth required for console; App Check on fan app
- Firestore rules: brain writes, clients read-only
- VPC-SC perimeter around Vertex AI + BigQuery
- Audit logs streamed to BigQuery + Chronicle SIEM

## Scalability Model

- Stateless Cloud Run: autoscales 0 → 1000 by concurrency
- Firestore: regional, multi-AZ, sub-100ms reads at scale
- FCM topic fanout: one publish → unlimited subscribers
- BigQuery streaming inserts: 1M rows/sec ceiling

## Innovation Highlights

1. **Gemini Live "Ask the Stadium"** — voice query, spoken answer with live heatmap.
2. **Predictive surge heatmap** — 15-min forecast on Photorealistic 3D Tiles.
3. **Smart Exit routing** — personalized exit chosen to flatten crowd curve, not shortest path.
4. **Autonomous Section Marshal agents** — one Gemini agent per stand, coordinating via A2A.
5. **Multimodal alerts** — text + Hindi/Tamil/Telugu TTS via Cloud Text-to-Speech.

## Team & Submission

- **Hackathon:** [Event name]
- **Team:** Raju Manoj
- **GCP Project:** `pitchguard` (1012719380061)
- **Demo:** [link]

---

Built with Google Cloud · Vertex AI Gemini · Firebase
