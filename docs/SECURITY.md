# PitchGuard Security Model

## Identities

| Identity | Purpose |
|---|---|
| `pitchguard-brain-sa@pitchguard.iam` | Cloud Run runtime |
| Firebase Auth users | Console operators, fan app sign-in |
| App Check tokens | Fan app integrity attestation |

## IAM (least privilege)

| Role | Resource | Why |
|---|---|---|
| `roles/aiplatform.user` | project | Call Gemini |
| `roles/datastore.user` | project | Firestore RW |
| `roles/firebase.admin` | project | FCM messaging.send |
| `roles/secretmanager.secretAccessor` | per-secret | Read API keys |
| `roles/logging.logWriter` | project | Emit structured logs |

No `roles/owner`, no `roles/editor` on the runtime SA.

## Firestore Rules

See `infra/firestore.rules`. Summary:

- `/decisions`, `/gates`, `/alerts` — public read, admin-only write.
- `/reports` — authed-create only, schema-validated, 280-char cap on `message`.
- All other paths denied by default.

## Network

- Cloud Run TLS via Google-managed cert.
- Optional VPC-SC perimeter around Vertex + Firestore + BigQuery for production.
- Cloud Armor (Edge) — recommended for production console.

## Data Handling

- CCTV frames inferenced in-memory, discarded after the Gemini call. **No persisted images.**
- Personally identifiable data (ticket IDs, fan phone numbers) hashed before Firestore write.
- Firestore TTL policy: `decisions` older than 90 days auto-deleted.

## Secrets

| Secret | Where |
|---|---|
| Firebase admin SDK key | Secret Manager → mounted to Cloud Run as env |
| Google Maps API key | Public, but **restricted** to console domain + referrer |
| Service-account JSON | Never committed; CI uses Workload Identity Federation |

`.gitignore` blocks `*.env`, `service-account*.json`, `*-credentials.json`.

## Audit + Threat Detection

- Cloud Audit Logs streamed to BigQuery dataset `pitchguard_audit`.
- Security Command Center scans IAM + Firebase config nightly.
- Cloud Run revisions tagged with git SHA for forensic rollback.

## Threat Model (STRIDE highlights)

| Threat | Mitigation |
|---|---|
| **Spoofing** fan app | Firebase App Check + signed FCM tokens |
| **Tampering** with decisions | Firestore rules deny client writes |
| **Repudiation** | All ops actions logged with operator UID |
| **Information disclosure** | TLS everywhere, no PII in logs |
| **Denial of service** | Cloud Run max-instances cap, Cloud Armor rate-limit |
| **Elevation of privilege** | Runtime SA scoped; no shared keys |
