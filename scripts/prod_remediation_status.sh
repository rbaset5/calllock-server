#!/usr/bin/env bash
set -euo pipefail

# Reports production-readiness status for call_c80 remediation blockers:
# 1) Retell prompt deploy readiness
# 2) External book_service contract compatibility
#
# Usage:
#   ./scripts/prod_remediation_status.sh
#   BOOK_SERVICE_AUTH_HEADER="Authorization: Bearer xxx" ./scripts/prod_remediation_status.sh
#   BOOK_SERVICE_BEARER_TOKEN="xxx" ./scripts/prod_remediation_status.sh
#   BOOK_SERVICE_WEBHOOK_SECRET="xxx" ./scripts/prod_remediation_status.sh
#   RETELL_API_KEY="retell_..." ./scripts/prod_remediation_status.sh
#   BOOK_SERVICE_AUTH_HEADER="Authorization: Bearer xxx" BOOK_SERVICE_PAYLOAD=./request.json ./scripts/prod_remediation_status.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/voice-agent/deploy_retell_v10.sh"
CONTRACT_SCRIPT="$ROOT_DIR/scripts/verify_book_service_contract.sh"
PROMPT_JSON="$ROOT_DIR/voice-agent/retell-llm-v10-simplified.json"

BOOK_SERVICE_AUTH_HEADER="${BOOK_SERVICE_AUTH_HEADER:-}"
BOOK_SERVICE_BEARER_TOKEN="${BOOK_SERVICE_BEARER_TOKEN:-}"
BOOK_SERVICE_WEBHOOK_SECRET="${BOOK_SERVICE_WEBHOOK_SECRET:-}"
DASHBOARD_WEBHOOK_SECRET="${DASHBOARD_WEBHOOK_SECRET:-}"
BOOK_SERVICE_PAYLOAD="${BOOK_SERVICE_PAYLOAD:-}"

effective_auth_header=""
auth_header_source=""

if [[ -n "$BOOK_SERVICE_AUTH_HEADER" ]]; then
  effective_auth_header="$BOOK_SERVICE_AUTH_HEADER"
  auth_header_source="BOOK_SERVICE_AUTH_HEADER"
elif [[ -n "$BOOK_SERVICE_BEARER_TOKEN" ]]; then
  effective_auth_header="Authorization: Bearer ${BOOK_SERVICE_BEARER_TOKEN}"
  auth_header_source="BOOK_SERVICE_BEARER_TOKEN"
elif [[ -n "$BOOK_SERVICE_WEBHOOK_SECRET" ]]; then
  effective_auth_header="X-Webhook-Secret: ${BOOK_SERVICE_WEBHOOK_SECRET}"
  auth_header_source="BOOK_SERVICE_WEBHOOK_SECRET"
elif [[ -n "$DASHBOARD_WEBHOOK_SECRET" ]]; then
  effective_auth_header="X-Webhook-Secret: ${DASHBOARD_WEBHOOK_SECRET}"
  auth_header_source="DASHBOARD_WEBHOOK_SECRET"
fi

pass() { echo "[PASS] $*"; }
warn() { echo "[BLOCKED] $*"; }
info() { echo "[INFO] $*"; }

retell_ready=0
contract_error_branch_ok=0
contract_auth_branch_ok=0

echo "== call_c80 remediation status =="

# 1) Validate prompt JSON is parseable
if python3 -c "import json; json.load(open('$PROMPT_JSON'))" >/dev/null 2>&1; then
  pass "Prompt JSON parses: $PROMPT_JSON"
else
  warn "Prompt JSON invalid: $PROMPT_JSON"
fi

# 2) Check deploy script presence + dry-run
if [[ -x "$DEPLOY_SCRIPT" ]]; then
  if "$DEPLOY_SCRIPT" >/dev/null 2>&1; then
    pass "Retell deploy script dry-run succeeds"
  else
    warn "Retell deploy script dry-run failed"
  fi
else
  warn "Retell deploy script missing or not executable: $DEPLOY_SCRIPT"
fi

# 3) Check RETELL_API_KEY availability for live apply
if [[ -n "${RETELL_API_KEY:-}" ]]; then
  pass "RETELL_API_KEY is set (live prompt publish/bind can be executed)"
  retell_ready=1
else
  warn "RETELL_API_KEY is unset (cannot run live prompt publish/bind yet)"
fi

# 4) Contract check: unauthenticated branch (safe)
if "$CONTRACT_SCRIPT" --no-auth-infer >/dev/null 2>&1; then
  pass "book_service contract check (unauthenticated branch) passed"
  contract_error_branch_ok=1
else
  warn "book_service contract check (unauthenticated branch) failed"
fi

# 5) Contract check: authenticated branch (optional, recommended)
if [[ -n "$effective_auth_header" || -n "${RETELL_API_KEY:-}" ]]; then
  if [[ -n "$effective_auth_header" ]]; then
    info "Using auth header source: $auth_header_source (${effective_auth_header%%:*})"
  fi
  contract_cmd=("$CONTRACT_SCRIPT")
  if [[ -n "$BOOK_SERVICE_PAYLOAD" ]]; then
    contract_cmd+=(--payload "$BOOK_SERVICE_PAYLOAD")
  else
    info "No BOOK_SERVICE_PAYLOAD provided; using safe {} payload for authenticated check"
  fi

  if [[ -n "$effective_auth_header" ]]; then
    contract_cmd+=(--header "$effective_auth_header")
  elif [[ -n "${RETELL_API_KEY:-}" ]]; then
    auth_header_source="RETELL_API_KEY (HMAC)"
    info "Using auth source: $auth_header_source"
  fi

  contract_cmd+=(--require-auth-pass)

  if "${contract_cmd[@]}" >/dev/null 2>&1; then
    pass "book_service contract check (authenticated branch) passed"
    contract_auth_branch_ok=1
  else
    warn "book_service contract check (authenticated branch) failed"
  fi
else
  warn "No auth env found (set BOOK_SERVICE_AUTH_HEADER, BOOK_SERVICE_BEARER_TOKEN, BOOK_SERVICE_WEBHOOK_SECRET, DASHBOARD_WEBHOOK_SECRET, or RETELL_API_KEY)"
fi

echo
echo "== Summary =="
if [[ "$retell_ready" -eq 1 ]]; then
  pass "Blocker 1 readiness: prompt deploy can run now"
else
  warn "Blocker 1 readiness: waiting for RETELL_API_KEY"
fi

if [[ "$contract_error_branch_ok" -eq 1 && "$contract_auth_branch_ok" -eq 1 ]]; then
  pass "Blocker 2 verification: contract validated on both unauth and auth branches"
elif [[ "$contract_error_branch_ok" -eq 1 ]]; then
  warn "Blocker 2 verification: only unauth branch validated; auth branch still required"
else
  warn "Blocker 2 verification: contract not validated"
fi

echo
echo "Next actions:"
echo "1) Set RETELL_API_KEY and run: RETELL_API_KEY=... ./voice-agent/deploy_retell_v10.sh --apply"
echo "2) Verify authenticated contract branch:"
echo "   BOOK_SERVICE_AUTH_HEADER='Authorization: Bearer <token>' ./scripts/prod_remediation_status.sh"
echo "   or BOOK_SERVICE_BEARER_TOKEN='<token>' ./scripts/prod_remediation_status.sh"
echo "   or RETELL_API_KEY='<retell_key>' ./scripts/prod_remediation_status.sh"
