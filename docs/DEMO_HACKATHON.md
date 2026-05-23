# PitchGuard — 2-Hour Hackathon Demo (iPhone)

USP: **Fan Beacon.** Open a web page on your iPhone, arm the beacon, and the moment
Gemini detects a celebrity-driven surge in your zone the phone flashes red, blasts a
siren, and shows turn-by-turn distance + heading from your live GPS to the safe gate.

---

## 0. Prereqs (≤ 5 min)

You need:
- Python 3.11+, Node 18+, an iPhone on the same Wi-Fi as your laptop.
- A Firebase project with **Firestore enabled**. Free tier is fine.
- (Optional) Vertex AI access. If skipped, brain falls back to deterministic rules — demo still works.
- (Optional) Google Maps JS API key for the satellite stadium map.

### Firebase config

1. Firebase Console → Project Settings → Web app → copy the config.
2. `console/.env.local.example` → `console/.env.local`, fill:
   ```
   NEXT_PUBLIC_FIREBASE_API_KEY=...
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=pitchguard
   NEXT_PUBLIC_FIREBASE_APP_ID=...
   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...   # optional
   ```
3. Firestore Rules (Console → Firestore → Rules). For demo only:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
       match /{document=**} { allow read: if true; allow write: if true; }
     }
   }
   ```
   *(Production: read [docs/SECURITY.md](SECURITY.md). Tighten before any real deploy.)*

### Backend creds

Easiest: `gcloud auth application-default login` on the laptop. The brain auto-detects
ADC and writes to Firestore. If you have no GCP at all, the brain still runs — it just
won't reach Vertex or Firestore, and the simulator output will print in the terminal.

---

## 1. Start the brain (terminal 1)

```powershell
cd backend
pip install -r requirements.txt
$env:GOOGLE_CLOUD_PROJECT = "pitchguard"
$env:DENSITY_THRESHOLD_PER_M2 = "4.0"
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

Check: open `http://localhost:8080/healthz` → should return `{"status":"ok",...}`.
If it says `model: fallback-rule`, Vertex wasn't reachable — that's fine, rules
take over. Demo still works.

---

## 2. Start the console + fan page (terminal 2)

iPhone Safari **requires HTTPS** for geolocation. Easiest path is `localhost`
on the laptop + ngrok tunnel to the phone.

```powershell
cd console
npm install
npm run dev -- --hostname 0.0.0.0
```

Then in terminal 3, expose it over HTTPS:

```powershell
# Install ngrok once: https://ngrok.com/download
ngrok http 3000
```

Copy the printed `https://<random>.ngrok-free.app` URL. That's your demo URL.

Operator console:  `https://<ngrok>.ngrok-free.app/`
Fan beacon (iPhone): `https://<ngrok>.ngrok-free.app/fan`

---

## 3. Start the celebrity-surge simulator (terminal 4)

```powershell
cd simulator
pip install -r requirements.txt
python simulate.py --scenario celebrity --rate 1.5
```

Watch the terminal: density on Zone NORTH climbs each tick; after ~10 ticks the
brain returns `severity=critical alarm=true reroute=NORTH→EAST/WEST`.

---

## 4. The demo (≤ 3 min on stage)

1. **Stage left — laptop:** show operator console. Three zones, density bars
   climbing in NORTH. Map overlay shows red dot inflating on Gate N1.
2. **Stage right — iPhone:**
   1. Open the `/fan` URL.
   2. Tap **Zone North** in the dropdown (or whatever section you're "sitting in").
   3. Tap **🛡 Arm Beacon**. Allow location + sound when iOS prompts.
3. Run simulator with `--scenario celebrity`. ~10 seconds later:
   - **Operator console** shows `CRITICAL` chip, cyan arrow from NORTH → EAST on the
     stadium map, action list ("Open auxiliary lanes…", "Push reroute beacon…").
   - **iPhone** flashes red full-screen, siren wails, panel shows
     `EVACUATE TO Zone EAST · Gate E1`, live distance in metres, compass heading.
     Tap "Open turn-by-turn in Maps" → launches Google Maps walking nav from your
     real GPS to the gate.

### Drop the mic

> "PitchGuard sees the surge before it crushes anyone. Gemini reads density,
> weather, and operator notes, picks the safest balance, and the fan's own phone
> tells them exactly where to walk — by name, by distance, by direction. Two
> seconds end-to-end."

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| iPhone says "Location services denied" | Settings → Safari → Location → Ask. Reload page, tap Arm again. |
| No siren on iPhone | Phone in silent / Focus mode. WebAudio still plays through speaker if media volume up. Toggle ringer switch. |
| Map view says "Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" | Add key to `console/.env.local`. Map is optional — fan beacon works without it. |
| Brain prints `Vertex AI unavailable` | Run `gcloud auth application-default login`. Or ignore — rule-based fallback runs. |
| Firestore writes 403 | Loosen rules per step 0. Production rules: see [SECURITY.md](SECURITY.md). |
| iPhone won't reach `localhost:3000` | Use the ngrok HTTPS URL, not the LAN IP. Safari blocks geolocation on plain HTTP. |
| Siren doesn't fire even though console shows CRITICAL | The phone's selected zone must match `affected_zones`. Pick **Zone North** before arming when running `--scenario celebrity`. |

---

## What's the USP, in one sentence?

Gemini-driven crowd reasoning + iPhone-as-beacon. No app install, no FCM, no Twilio —
just open a URL, arm once, and the AI talks straight to the fan's phone the instant
a surge is forecast.
