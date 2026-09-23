#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://api.pikidelivery.com}"
pass=0
fail=0

check() {
  local name="$1" method="$2" path="$3" expected="$4" body="${5:-}"
  local tmp code
  tmp=$(mktemp)
  if [[ "$method" == "POST" ]]; then
    code=$(curl -sS -X POST -H 'content-type: application/json' --data "$body" -o "$tmp" -w '%{http_code}' --max-time 25 "$BASE_URL$path" || true)
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 25 "$BASE_URL$path" || true)
  fi
  if [[ "$code" == "$expected" ]]; then
    printf 'PASS %-28s HTTP %s\n' "$name" "$code"
    pass=$((pass + 1))
  else
    printf 'FAIL %-28s HTTP %s (expected %s)\n' "$name" "$code" "$expected"
    sed -n '1,2p' "$tmp" | cut -c1-240
    fail=$((fail + 1))
  fi
  rm -f "$tmp"
}

check health GET /health 200
check ready GET /ready 200
check api-root GET /api/v1 200
check catalog GET /api/v1/catalog/restaurants 200
check coverage-valid GET '/api/v1/coverage?latitude=38.9898&longitude=-0.5188' 200
check coverage-invalid GET '/api/v1/coverage?latitude=999&longitude=999' 400
check admin-overview GET /api/v1/admin/overview 200
check riders-overview GET /api/v1/riders/overview 200
check fleets-overview GET /api/v1/fleets/overview 200
check onboarding-invalid POST /api/v1/partners/onboarding 400 '{}'
check order-invalid POST /api/v1/orders 400 '{}'
check zone-invalid POST /api/v1/zones 400 '{}'
check unknown-route GET /api/v1/does-not-exist 404

printf '\nResumen: %d PASS, %d FAIL\n' "$pass" "$fail"
(( fail == 0 ))
