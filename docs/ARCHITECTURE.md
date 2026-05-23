# PitchGuard Architecture

## One-Line

Stateless Gemini brain on Cloud Run, listening for stadium signals, writing decisions to Firestore, fanning out alerts via FCM.

## Diagram

```
 ┌──────────┐   ┌──────────┐   ┌──────────┐
 │  CCTV    │   │ Turnstile│   │ Fan App  │
 │ (Vertex  │   │ Pub/Sub  │   │ GPS+FCM  │
 │  Vision) │   │  topic   │   │  tokens  │
 └────┬─────┘   └────┬─────┘   └────┬─────┘
      │              │              │
      └──────────────┴──────────────┘
                     ▼
            ┌──────────────────┐
            │   Cloud Run      │
            │   PitchGuard     │
            │   Brain (FastAPI)│
            └────┬─────────┬───┘
                 │         │
       Gemini 2.5 Flash   │
       (Vertex AI)        ▼
                 │   ┌─────────────┐
                 │   │  Firestore  │  ◀──── Console (Next.js)
                 │   └─────────────┘
                 ▼
            ┌──────────────────┐
            │ FCM topic        │ ───▶ Fans, volunteers, security
            │ pitchguard-alerts│
            └──────────────────┘
```

## Components

### Brain — Cloud Run + FastAPI (`backend/`)
- Single endpoint `POST /ingest` accepts gate/weather/CCTV-frame payload.
- Builds a structured prompt for Gemini 2.5 Flash with `response_mime_type=application/json`.
- Persists raw signals, gate state, and the decision to Firestore.
- Pushes FCM topic message when severity ≥ `warn`.
- Stateless, autoscales 0–50 instances, 80 concurrent requests each.

### Console — Next.js + Firestore SDK (`console/`)
- Server-rendered static export (Firebase Hosting).
- `onSnapshot` listeners on `decisions/` and `gates/` for sub-second UI updates.
- Google Maps satellite view with live density markers.
- Severity badge derived from the latest decision.

### Simulator — Python (`simulator/`)
- Synthetic match-day signal generator.
- Sinusoidal headcount per gate, periodic spikes, random weather events.
- Replaces real CCTV + turnstile feeds for the 2-hour build.

## Data Model (Firestore)

```
decisions/{auto}
  ts, severity, summary, actions[], affected_gates[], reroute_to, gates[], weather

gates/{gate_id}
  headcount, density, scan_rate_per_min, updated

alerts/{auto}
  ts, fcm_id, decision

reports/{auto}   # fan-submitted incidents
  type, message, geo, ts
```

## Scalability

| Tier | Mechanism | Headroom |
|---|---|---|
| Brain | Cloud Run autoscale 0→50, 80 concurrency | ~4000 req/s |
| Firestore | Regional, multi-AZ | 10k writes/sec/coll |
| FCM | Topic fanout | unlimited subscribers |
| Console | Firebase Hosting CDN | global edge cache |

## Security

- Dedicated service account `pitchguard-brain-sa` with least-privilege IAM (`aiplatform.user`, `datastore.user`, `firebase.admin` scoped).
- All client SDK keys are public by design; Firestore rules enforce read-only for `/decisions`, `/gates`, `/alerts`.
- Fan-submitted `reports/` require Firebase Auth and validated schema.
- Secrets in **Secret Manager**, never in code or git.
- Cloud Run uses HTTPS, automatic TLS via Google-managed certs.
- Audit logs streamed to BigQuery (`cloudaudit_googleapis_com_data_access`).

## Innovation Pillars

1. **Generative reasoning over heterogenous signals** — Gemini handles vision + numbers + weather + freeform context in one prompt.
2. **Sub-second realtime sync** — Firestore listeners give the console live state without any custom socket layer.
3. **Action-oriented output** — Gemini returns structured `Decision` objects, not prose, so the rest of the system is deterministic.
4. **Topic-based alerting** — one publish reaches every fan device subscribed, no per-user fanout cost.
5. **Composable** — every signal source is a JSON POST. New ingestion (drones, social media, ticket scans) plugs in without server changes.

## Failure Modes

- Gemini timeout → fall back to threshold-only severity (TODO).
- Firestore write fails → log + retry (Cloud Tasks queue, post-MVP).
- FCM rate-limit → batch + exponential backoff.
- Network partition between console and Firestore → SDK auto-reconnects, queued writes drain.

## Cost Envelope (per match)

| Item | Estimate |
|---|---|
| Gemini 2.5 Flash | ~5000 calls × ~500 tok in / 200 tok out → ~$0.30 |
| Cloud Run | 100k req × 200ms × 0.5 vCPU → ~$0.10 |
| Firestore | ~50k writes + 1M reads → ~$0.40 |
| FCM | free |
| Maps | < 5k loads/day → free tier |
| **Total** | **< $1 / match** |
