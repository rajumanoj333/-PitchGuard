# PitchGuard

**A safety helper for cricket stadiums.**

Think of a packed stadium with 100,000 people. Some gates get too crowded. People can get hurt. PitchGuard watches every gate in real time, spots danger early, and tells fans to use a different exit before things get bad.

> "See the crowd push before it happens."

---

## What it does (in plain words)

1. **Watches the stadium.** Counts people at each gate every second.
2. **Thinks fast.** Sends the numbers to Google's AI (Gemini). The AI decides if any zone is too packed.
3. **Tells everyone.** Sends a message to fans' phones: "Don't use Gate 1, walk to Gate 9 instead."
4. **Helps the control room.** A big web dashboard shows live maps, alerts, and a danger score.

That's it. Watch → think → tell people → repeat.

---

## The 3 parts

The project has 3 small programs that talk to each other.

| Part | What it is | Folder |
|---|---|---|
| **Brain** | Python server that does the thinking | `backend/` |
| **Console** | The web dashboard the security team uses | `console/` |
| **Simulator** | Fake stadium that sends pretend crowd data (so you can demo without a real stadium) | `simulator/` |

```
   Simulator              Brain                  Console
  (fake data) ──POST──▶ (Python)  ──writes──▶  (Firestore) ──reads──▶ Dashboard
                            │
                            ▼
                       Google Gemini AI
                       (makes the decision)
```

---

## Tools we use (and why)

| Tool | What it's for |
|---|---|
| **Python + FastAPI** | Brain server. FastAPI is easy and fast. |
| **Google Gemini 2.5 Flash** | The AI that decides if a zone is dangerous. |
| **Vertex AI** | Google's way to use Gemini in code. |
| **Firestore** | A live database. When the brain writes, the dashboard sees it instantly. |
| **Firebase** | Hosts the database, push notifications, login. |
| **Next.js + React** | Builds the web dashboard. |
| **Tailwind CSS** | Makes the dashboard pretty. |
| **Google Maps** | Shows the stadium on a real map. |
| **Cloud Run** | Where the brain lives when we deploy it (Google's auto-scaling server). |
| **Docker** | Packs the brain into a box so it runs anywhere. |

---

## The API (what the brain accepts)

The brain is a small web server. It listens on port `8080`. You talk to it by sending HTTP requests.

| Method | URL | What it does |
|---|---|---|
| `GET` | `/healthz` | Is the brain alive? Returns `{"status":"ok"}`. |
| `GET` | `/stadium` | Get stadium center + zone list. |
| `GET` | `/zones` | Get the 4 zones (NORTH, EAST, SOUTH, WEST) and their gates. |
| `POST` | `/ingest` | Main one. Send crowd data, get back a decision. |
| `GET` | `/decisions/recent?limit=20` | Last 20 decisions the brain made. |
| `POST` | `/alerts` | Operator pushes a custom alert to fans in one zone. |

### Example: send crowd data

```bash
curl -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "gates": [
      {"gate_id":"Gate 1","zone_id":"NORTH","headcount":900,"capacity_m2":60},
      {"gate_id":"Gate 9","zone_id":"SOUTH","headcount":200,"capacity_m2":80}
    ],
    "weather": {"rain_mm_per_hr": 0, "temperature_c": 30}
  }'
```

Brain replies with something like:

```json
{
  "severity": "critical",
  "summary": "Zone NORTH surge 15.00/m² — divert to Zone SOUTH",
  "actions": ["Open auxiliary lanes at Gate 9", "Push reroute beacon..."],
  "reroute_from_zone": "NORTH",
  "reroute_to_zone": "SOUTH",
  "alarm": true
}
```

---

## How to run it (your own laptop)

### What you need first

- **Python 3.12** (for brain and simulator)
- **Node.js 20+** (for the dashboard)
- **Git**
- (Optional) A Google Cloud account if you want real Gemini AI. Without it, the brain falls back to simple rules and still works.

### Step 1 — Start the brain

Open a terminal:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Mac/Linux

pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

You should see: `Uvicorn running on http://127.0.0.1:8080`.

Test it: open `http://localhost:8080/healthz` in your browser. You should see `{"status":"ok"}`.

### Step 2 — Start the dashboard

Open a **new** terminal (leave the brain running):

```bash
cd console
npm install
npm run dev
```

Open `http://localhost:3000`. The dashboard loads but says "no data yet" — that's normal.

### Step 3 — Start the fake stadium

Open a **third** terminal:

```bash
cd simulator
pip install -r requirements.txt
python simulate.py --brain http://localhost:8080 --rate 2
```

Now the simulator sends crowd data twice per second. Watch the dashboard light up.

---

## How to test it (the fun part)

The simulator has 3 modes. Stop it (Ctrl+C) and try each one.

### Mode 1 — Normal day

```bash
python simulate.py --scenario nominal --rate 2
```

Crowds wobble up and down. Dashboard stays calm. Severity = `info` or `watch`.

### Mode 2 — Celebrity arrives (the demo)

```bash
python simulate.py --scenario celebrity --rate 2
```

Zone NORTH ramps to dangerous crowd levels over ~10 seconds. Watch:
- Severity goes `info` → `watch` → `warn` → `critical`
- A big red alarm fires on the dashboard
- Brain says: "Divert fans from NORTH to SOUTH (Gate 9)"

### Mode 3 — Storm

```bash
python simulate.py --scenario storm --rate 2
```

Lightning at 6 km. Brain factors weather into its decision.

### Test the fan view

In the dashboard, find the link to `/fan`. This is what a fan's phone shows. When the brain triggers a reroute, the fan page tells them which exit to use.

### Test the operator alert

In the dashboard, type a custom message and pick a zone. It sends to `/alerts` and shows up on the fan page for fans in that zone.

---

## How to build for production

### Build the brain into a Docker box

```bash
cd backend
docker build -t pitchguard-brain .
docker run -p 8080:8080 pitchguard-brain
```

### Build the dashboard

```bash
cd console
npm run build
```

The output goes in `console/out/` ready to host on Firebase Hosting.

### Deploy everything to Google Cloud

We have a script that does it for you:

```bash
bash infra/deploy.sh
```

This:
1. Pushes the brain Docker image to Google Container Registry
2. Deploys it to Cloud Run (gives you a public URL)
3. Deploys the dashboard to Firebase Hosting
4. Updates Firestore security rules

---

## Folder map

```
PitchGuard/
├── backend/              The brain (Python + FastAPI)
│   ├── main.py           All the brain logic — read this first
│   ├── requirements.txt  Python packages it needs
│   └── Dockerfile        Recipe to pack brain into a container
│
├── console/              The dashboard (Next.js)
│   ├── src/app/          Pages: / (operator) and /fan (fan view)
│   ├── src/components/   The map, alert cards, etc.
│   └── package.json      JS packages it needs
│
├── simulator/            The fake stadium
│   └── simulate.py       Pumps fake crowd data at the brain
│
├── infra/                Deployment scripts + Firestore rules
│   ├── deploy.sh         One-shot deploy to Google Cloud
│   ├── setup.sh          First-time project setup
│   └── firestore.rules   Who can read/write the database
│
└── docs/                 Deeper documents
    ├── ARCHITECTURE.md   How it works under the hood
    ├── QUICKSTART.md     Quick setup guide
    ├── DEMO.md           Demo script
    └── SECURITY.md       Security details
```

---

## How the brain thinks (simple version)

When `/ingest` gets called:

1. Add up the headcount per zone.
2. Find the **most crowded** zone (worst) and the **least crowded** one (best).
3. Compute density = people ÷ floor space (m²). Anything ≥ 4 people per m² is critical.
4. If we have Gemini, ask it: "Given these numbers, what should we do?"
5. If Gemini is offline (no credentials), use a simple rule: divert from worst zone to best zone.
6. Return the decision + save it to Firestore so the dashboard sees it instantly.

That's the whole brain. Read [main.py](backend/main.py) — it's under 400 lines.

---

## Common problems

| Problem | Fix |
|---|---|
| Brain says "Vertex AI unavailable" | Normal in local mode. Brain uses fallback rules. To use Gemini, set `GOOGLE_APPLICATION_CREDENTIALS` to a service account file. |
| Dashboard shows nothing | Make sure simulator is running AND brain is running. Refresh the page. |
| `npm install` fails | Use Node 20+. Delete `node_modules/` and try again. |
| Port 8080 busy | Stop other servers or change port: `uvicorn main:app --port 8090`. |

---

## What makes it cool

- **Sub-2-second alerts** to phones.
- **Smart Exit routing** — picks the exit that flattens the crowd, not the closest one.
- **Works without internet AI** — falls back to rules if Gemini is down.
- **Tiny code** — the whole brain is one Python file.

---

## Team

- **Team:** Manoj
- **GCP Project:** `pitchguard`
- **Built with:** Google Cloud · Vertex AI Gemini · Firebase
