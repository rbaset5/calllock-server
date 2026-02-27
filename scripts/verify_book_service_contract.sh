#!/usr/bin/env bash
set -euo pipefail

# Verify external book_service response contract includes BOTH:
# - booked
# - booking_confirmed
#
# Default mode sends {} to test error/validation branch safely (no booking creation).
#
# Usage:
#   ./scripts/verify_book_service_contract.sh
#   ./scripts/verify_book_service_contract.sh --url https://app.calllock.co/api/retell/book-service
#   ./scripts/verify_book_service_contract.sh --payload ./request.json
#   ./scripts/verify_book_service_contract.sh --header "Authorization: Bearer xxx"
#   RETELL_API_KEY=... ./scripts/verify_book_service_contract.sh
#   ./scripts/verify_book_service_contract.sh --no-auth-infer
#   RETELL_API_KEY=... ./scripts/verify_book_service_contract.sh --require-auth-pass
#
# Auth env fallback (used when no --header is passed):
#   BOOK_SERVICE_AUTH_HEADER="Authorization: Bearer xxx"
#   BOOK_SERVICE_BEARER_TOKEN="xxx"
#   BOOK_SERVICE_WEBHOOK_SECRET="xxx"
#   DASHBOARD_WEBHOOK_SECRET="xxx"
#   RETELL_API_KEY="retell_..."   # sends x-retell-signature HMAC header

URL="https://app.calllock.co/api/retell/book-service"
PAYLOAD_FILE=""
EXTRA_HEADERS=()
DRY_RUN=0
NO_AUTH_INFER=0
REQUIRE_AUTH_PASS=0
auth_source=""
NORMALIZED_RETELL_API_KEY=""

normalize_retell_key() {
  local s="$1"
  s="$(printf "%s" "$s" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  s="$(printf "%s" "$s" | sed -E 's/(\\n|\n)+$//')"
  if [[ ( "$s" == \"*\" && "$s" == *\" ) || ( "$s" == \'*\' && "$s" == *\' ) ]]; then
    s="${s:1:${#s}-2}"
  fi
  s="$(printf "%s" "$s" | sed -E 's/(\\n|\n)+$//')"
  s="$(printf "%s" "$s" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf "%s" "$s"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      URL="$2"
      shift 2
      ;;
    --payload)
      PAYLOAD_FILE="$2"
      shift 2
      ;;
    --header)
      EXTRA_HEADERS+=("$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-auth-infer)
      NO_AUTH_INFER=1
      shift
      ;;
    --require-auth-pass)
      REQUIRE_AUTH_PASS=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Optional auth header inference if caller didn't pass --header
if [[ ${#EXTRA_HEADERS[@]-0} -gt 0 ]]; then
  auth_source="--header"
fi
if [[ $NO_AUTH_INFER -eq 0 && ${#EXTRA_HEADERS[@]-0} -eq 0 ]]; then
  if [[ -n "${BOOK_SERVICE_AUTH_HEADER:-}" ]]; then
    EXTRA_HEADERS+=("${BOOK_SERVICE_AUTH_HEADER}")
    auth_source="BOOK_SERVICE_AUTH_HEADER"
  elif [[ -n "${BOOK_SERVICE_BEARER_TOKEN:-}" ]]; then
    EXTRA_HEADERS+=("Authorization: Bearer ${BOOK_SERVICE_BEARER_TOKEN}")
    auth_source="BOOK_SERVICE_BEARER_TOKEN"
  elif [[ -n "${BOOK_SERVICE_WEBHOOK_SECRET:-}" ]]; then
    EXTRA_HEADERS+=("X-Webhook-Secret: ${BOOK_SERVICE_WEBHOOK_SECRET}")
    auth_source="BOOK_SERVICE_WEBHOOK_SECRET"
  elif [[ -n "${DASHBOARD_WEBHOOK_SECRET:-}" ]]; then
    EXTRA_HEADERS+=("X-Webhook-Secret: ${DASHBOARD_WEBHOOK_SECRET}")
    auth_source="DASHBOARD_WEBHOOK_SECRET"
  fi
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

if [[ -n "$PAYLOAD_FILE" && ! -f "$PAYLOAD_FILE" ]]; then
  echo "Payload file not found: $PAYLOAD_FILE" >&2
  exit 2
fi

tmp_req="$(mktemp)"
tmp_body="$(mktemp)"
trap 'rm -f "$tmp_req" "$tmp_body"' EXIT

if [[ -n "$PAYLOAD_FILE" ]]; then
  cp "$PAYLOAD_FILE" "$tmp_req"
else
  printf '{}\n' >"$tmp_req"
fi

# Optional Retell signature inference if caller did not pass/infer any auth header.
# This signs the exact payload bytes sent via --data-binary.
if [[ $NO_AUTH_INFER -eq 0 && ${#EXTRA_HEADERS[@]-0} -eq 0 && -n "${RETELL_API_KEY:-}" ]]; then
  NORMALIZED_RETELL_API_KEY="$(normalize_retell_key "${RETELL_API_KEY:-}")"
fi

if [[ $NO_AUTH_INFER -eq 0 && ${#EXTRA_HEADERS[@]-0} -eq 0 && -n "${NORMALIZED_RETELL_API_KEY:-}" ]]; then
  signature_hex="$(
    NORMALIZED_RETELL_API_KEY="$NORMALIZED_RETELL_API_KEY" python3 - "$tmp_req" <<'PY'
import hmac
import hashlib
import pathlib
import os
import sys

payload = pathlib.Path(sys.argv[1]).read_bytes()
secret = os.environ["NORMALIZED_RETELL_API_KEY"].encode("utf-8")
print(hmac.new(secret, payload, hashlib.sha256).hexdigest())
PY
  )"
  EXTRA_HEADERS+=("x-retell-signature: sha256=${signature_hex}")
  auth_source="RETELL_API_KEY (HMAC)"
fi

curl_cmd=(
  curl -sS -X POST "$URL"
  -H "Content-Type: application/json"
  --data-binary "@$tmp_req"
  -o "$tmp_body"
  -w "%{http_code}"
)

for h in "${EXTRA_HEADERS[@]-}"; do
  [[ -z "$h" ]] && continue
  curl_cmd+=( -H "$h" )
done

echo "[info] URL: $URL"
echo "[info] Payload file: ${PAYLOAD_FILE:-<inline {}>}"
if [[ ${#EXTRA_HEADERS[@]-0} -gt 0 ]]; then
  echo "[info] Extra headers: ${#EXTRA_HEADERS[@]}"
  [[ -n "$auth_source" ]] && echo "[info] Auth source: $auth_source"
  for h in "${EXTRA_HEADERS[@]-}"; do
    [[ -z "$h" ]] && continue
    echo "[info] Header key: ${h%%:*}"
  done
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] Request not sent."
  exit 0
fi

http_code="$("${curl_cmd[@]}")"
echo "[info] HTTP status: $http_code"

if ! jq -e . "$tmp_body" >/dev/null 2>&1; then
  echo "[fail] Response is not valid JSON"
  cat "$tmp_body"
  exit 1
fi

if [[ $REQUIRE_AUTH_PASS -eq 1 ]]; then
  if [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
    echo "[fail] Authenticated check failed: received HTTP $http_code"
    jq -c . "$tmp_body"
    exit 1
  fi
  auth_message="$(jq -r '.message // ""' "$tmp_body" | tr '[:upper:]' '[:lower:]')"
  if [[ "$auth_message" == *"missing authentication"* || "$auth_message" == *"invalid authentication"* ]]; then
    echo "[fail] Authenticated check failed: response indicates auth rejection"
    jq -c . "$tmp_body"
    exit 1
  fi
fi

has_booked="$(jq -r 'has("booked")' "$tmp_body")"
has_booking_confirmed="$(jq -r 'has("booking_confirmed")' "$tmp_body")"

if [[ "$has_booked" != "true" || "$has_booking_confirmed" != "true" ]]; then
  echo "[fail] Missing required keys in response"
  echo "       has(booked)=$has_booked has(booking_confirmed)=$has_booking_confirmed"
  jq -c . "$tmp_body"
  exit 1
fi

booked_type="$(jq -r '.booked | type' "$tmp_body")"
booking_confirmed_type="$(jq -r '.booking_confirmed | type' "$tmp_body")"

if [[ "$booked_type" != "boolean" || "$booking_confirmed_type" != "boolean" ]]; then
  echo "[fail] Required keys are present but not booleans"
  echo "       type(booked)=$booked_type type(booking_confirmed)=$booking_confirmed_type"
  jq -c . "$tmp_body"
  exit 1
fi

booked_val="$(jq -r '.booked' "$tmp_body")"
booking_confirmed_val="$(jq -r '.booking_confirmed' "$tmp_body")"

if [[ "$booked_val" != "$booking_confirmed_val" ]]; then
  echo "[fail] Contract mismatch: booked and booking_confirmed differ"
  echo "       booked=$booked_val booking_confirmed=$booking_confirmed_val"
  jq -c . "$tmp_body"
  exit 1
fi

echo "[pass] Contract OK: booked and booking_confirmed are present, boolean, and equal"
echo "[info] Response:"
jq . "$tmp_body"
