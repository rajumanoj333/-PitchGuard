#!/usr/bin/env bash
# PitchGuard deploy: backend → Cloud Run, console → Firebase Hosting, rules → Firestore.
# Requires: gcloud, firebase, npm, python.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-pitchguard}"
REGION="${REGION:-asia-south1}"
VERTEX_LOCATION="${VERTEX_LOCATION:-us-central1}"
SERVICE="pitchguard-brain"

echo "==> Project: $PROJECT_ID  Region: $REGION"
gcloud config set project "$PROJECT_ID"

echo "==> Enabling APIs (idempotent)"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  aiplatform.googleapis.com \
  firestore.googleapis.com \
  firebase.googleapis.com \
  secretmanager.googleapis.com \
  pubsub.googleapis.com

echo "==> Deploying backend to Cloud Run"
gcloud run deploy "$SERVICE" \
  --source ./backend \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 1Gi \
  --concurrency 80 \
  --max-instances 10 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,VERTEX_LOCATION=$VERTEX_LOCATION,VERTEX_MODEL=gemini-2.5-flash,DENSITY_THRESHOLD_PER_M2=4.0,ALERT_TOPIC=pitchguard-alerts"

BRAIN_URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo "==> Brain URL: $BRAIN_URL"

echo "==> Deploying Firestore rules + indexes"
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"

echo "==> Building console"
pushd console >/dev/null
[ -f .env.local ] || cp .env.local.example .env.local
echo "NEXT_PUBLIC_BRAIN_URL=$BRAIN_URL" >> .env.local
npm ci || npm install
npm run build
popd >/dev/null

echo "==> Deploying console to Firebase Hosting"
firebase deploy --only hosting --project "$PROJECT_ID"

echo "==> Done."
echo "Brain:   $BRAIN_URL"
echo "Console: https://${PROJECT_ID}.web.app"
