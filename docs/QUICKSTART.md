# PitchGuard Quickstart (2-hour hackathon track)

## Prereqs

- `gcloud` CLI authenticated (`gcloud auth login` + `gcloud auth application-default login`)
- `firebase` CLI (`npm i -g firebase-tools`)
- Node 20+, Python 3.11+
- GCP project `pitchguard` with billing on

## Step 1 — Bootstrap (one-time, ~5 min)

```bash
bash infra/setup.sh
```

Creates SA, enables APIs, sets up Firestore + Pub/Sub topic.

## Step 2 — Run brain locally (~10 min)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export GOOGLE_CLOUD_PROJECT=pitchguard
export GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/service-account.json   # if using a key
uvicorn main:app --reload --port 8080
```

Test:

```bash
curl -X POST localhost:8080/ingest \
  -H 'content-type: application/json' \
  -d '{"gates":[{"gate_id":"A","headcount":260,"capacity_m2":60,"scan_rate_per_min":140}]}'
```

## Step 3 — Run console locally (~5 min)

```bash
cd console
cp .env.local.example .env.local        # fill in Firebase web config + Maps key
npm install
npm run dev
```

Open http://localhost:3000.

## Step 4 — Pump signals (~2 min)

```bash
cd simulator
pip install -r requirements.txt
python simulate.py --brain http://localhost:8080 --rate 2
```

Watch the console light up.

## Step 5 — Deploy (~10 min)

```bash
bash infra/deploy.sh
```

Outputs:
- Brain Cloud Run URL
- Console URL: `https://pitchguard.web.app`

## Step 6 — Demo

Follow `docs/DEMO.md`.

## Troubleshooting

- **`PERMISSION_DENIED` from Vertex AI** → run `gcloud auth application-default login` and ensure `aiplatform.user` is on your SA.
- **Firestore rules error in console** → `firebase deploy --only firestore:rules`.
- **Map blank** → check `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and that Maps JavaScript API is enabled in your project.
- **CORS** on `/ingest` → backend already has `allow_origins=["*"]`; for prod, restrict to console origin.
