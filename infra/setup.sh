#!/usr/bin/env bash
# One-time project bootstrap: service account, Firestore, FCM topic.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-pitchguard}"
REGION="${REGION:-asia-south1}"
SA="pitchguard-brain-sa"

gcloud config set project "$PROJECT_ID"

echo "==> Creating service account $SA"
gcloud iam service-accounts create "$SA" \
  --display-name "PitchGuard Brain runtime" 2>/dev/null || true

SA_EMAIL="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"

for role in \
  roles/aiplatform.user \
  roles/datastore.user \
  roles/firebase.admin \
  roles/secretmanager.secretAccessor \
  roles/logging.logWriter \
  roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$SA_EMAIL" --role "$role" >/dev/null
done

echo "==> Creating Firestore database (native mode, $REGION)"
gcloud firestore databases create --location="$REGION" --type=firestore-native 2>/dev/null || \
  echo "(already exists)"

echo "==> Creating Pub/Sub topic for alerts"
gcloud pubsub topics create pitchguard-alerts 2>/dev/null || true

echo "==> Done. Service account: $SA_EMAIL"
