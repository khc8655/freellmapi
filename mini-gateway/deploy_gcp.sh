#!/bin/bash
set -e

# Configuration
SERVICE_NAME="llm-gateway"
REGION="us-central1"

echo "========================================="
echo "Deploying Node LLM Gateway to Cloud Run..."
echo "========================================="

# Run the deployment command
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --quiet

echo "========================================="
echo "Deployment completed!"
echo "Please set your environment variables (GOOGLE_KEYS, NVIDIA_KEYS, ACCESS_TOKEN) in GCP Console."
echo "========================================="
