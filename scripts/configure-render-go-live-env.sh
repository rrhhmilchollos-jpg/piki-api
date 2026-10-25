#!/usr/bin/env bash
set -euo pipefail

# Required:
#   RENDER_API_KEY           Render API key with access to the workspace.
#   RENDER_WEB_SERVICE_ID    Service ID of piki-api.
#   RENDER_WORKER_SERVICE_ID Service ID of piki-dispatch-worker.
#   MONGODB_URI              The production Atlas URI. Never commit or echo it.
#
# Optional:
#   RENDER_API_BASE          Defaults to https://api.render.com/v1

: "${RENDER_API_KEY:?Set RENDER_API_KEY}"
: "${RENDER_WEB_SERVICE_ID:?Set RENDER_WEB_SERVICE_ID}"
: "${RENDER_WORKER_SERVICE_ID:?Set RENDER_WORKER_SERVICE_ID}"
: "${MONGODB_URI:?Set MONGODB_URI from MongoDB Atlas}"

RENDER_API_BASE="${RENDER_API_BASE:-https://api.render.com/v1}"
AUTH_HEADER="Authorization: Bearer ${RENDER_API_KEY}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_command curl
require_command jq

put_env_var() {
  local service_id="$1"
  local key="$2"
  local value="$3"

  echo "Updating ${key} on service ${service_id}"
  jq -n --arg value "$value" '{value: $value}' \
    | curl --fail-with-body --silent --show-error \
      --request PUT \
      --url "${RENDER_API_BASE}/services/${service_id}/env-vars/${key}" \
      --header "$AUTH_HEADER" \
      --header 'Content-Type: application/json' \
      --data @-
  printf '\n'
}

# The individual-variable endpoint is intentional: replacing the full list of
# environment variables would delete variables omitted from the request.
put_env_var "$RENDER_WEB_SERVICE_ID" MONGODB_URI "$MONGODB_URI"
put_env_var "$RENDER_WEB_SERVICE_ID" MONGODB_DB "${MONGODB_DB:-piki}"
put_env_var "$RENDER_WEB_SERVICE_ID" PIKI_INLINE_DISPATCH_WORKER "false"
put_env_var "$RENDER_WEB_SERVICE_ID" PIKI_DISPATCH_WORKER_POLL_MS "${PIKI_DISPATCH_WORKER_POLL_MS:-1000}"
put_env_var "$RENDER_WEB_SERVICE_ID" PIKI_DISPATCH_WORKER_BATCH_SIZE "${PIKI_DISPATCH_WORKER_BATCH_SIZE:-25}"

put_env_var "$RENDER_WORKER_SERVICE_ID" MONGODB_URI "$MONGODB_URI"
put_env_var "$RENDER_WORKER_SERVICE_ID" MONGODB_DB "${MONGODB_DB:-piki}"
put_env_var "$RENDER_WORKER_SERVICE_ID" PIKI_DISPATCH_WORKER_POLL_MS "${PIKI_DISPATCH_WORKER_POLL_MS:-1000}"
put_env_var "$RENDER_WORKER_SERVICE_ID" PIKI_DISPATCH_WORKER_BATCH_SIZE "${PIKI_DISPATCH_WORKER_BATCH_SIZE:-25}"
put_env_var "$RENDER_WORKER_SERVICE_ID" PIKI_DISPATCH_HEALTH_PORT "${PIKI_DISPATCH_HEALTH_PORT:-10000}"

echo "Environment variables updated. Render API does not deploy these changes automatically."
echo "Trigger a deploy only after reviewing both services and confirming the Atlas URI."
