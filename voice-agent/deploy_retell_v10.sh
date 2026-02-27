#!/usr/bin/env bash
set -euo pipefail

# Deploy Retell v10 config, publish agent, and re-bind phone version.
# Default mode is DRY RUN. Use --apply to execute API calls.
#
# Usage:
#   RETELL_API_KEY=... ./voice-agent/deploy_retell_v10.sh
#   RETELL_API_KEY=... ./voice-agent/deploy_retell_v10.sh --apply
#   RETELL_API_KEY=... ./voice-agent/deploy_retell_v10.sh --apply --config voice-agent/retell-llm-v10-simplified.json

API_BASE="${API_BASE:-https://api.retellai.com}"
AGENT_ID="${AGENT_ID:-agent_4fb753a447e714064e71fadc6d}"
LLM_ID="${LLM_ID:-llm_4621893c9db9478b431a418dc2b6}"
PHONE_NUMBER="${PHONE_NUMBER:-+13126463816}"
CONFIG_PATH="voice-agent/retell-llm-v10-simplified.json"
APPLY=0

normalize_retell_key() {
  local s="$1"
  # Trim leading/trailing whitespace
  s="$(printf "%s" "$s" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  # Strip trailing literal/escaped newlines before quote detection
  s="$(printf "%s" "$s" | sed -E 's/(\\n|\n)+$//')"
  # Strip wrapping quotes once
  if [[ ( "$s" == \"*\" && "$s" == *\" ) || ( "$s" == \'*\' && "$s" == *\' ) ]]; then
    s="${s:1:${#s}-2}"
  fi
  # Strip trailing literal/escaped newlines again defensively
  s="$(printf "%s" "$s" | sed -E 's/(\\n|\n)+$//')"
  # Final trim
  s="$(printf "%s" "$s" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf "%s" "$s"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --agent-id)
      AGENT_ID="$2"
      shift 2
      ;;
    --llm-id)
      LLM_ID="$2"
      shift 2
      ;;
    --phone-number)
      PHONE_NUMBER="$2"
      shift 2
      ;;
    --api-base)
      API_BASE="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

if [[ $APPLY -eq 1 && -z "${RETELL_API_KEY:-}" ]]; then
  echo "RETELL_API_KEY is required when using --apply" >&2
  exit 2
fi

if [[ $APPLY -eq 1 ]]; then
  RETELL_API_KEY="$(normalize_retell_key "${RETELL_API_KEY:-}")"
  if [[ -z "$RETELL_API_KEY" ]]; then
    echo "RETELL_API_KEY is empty after normalization" >&2
    exit 2
  fi
fi

run() {
  local method="$1"
  local path="$2"
  local data_file="${3:-}"

  if [[ $APPLY -eq 0 ]]; then
    if [[ -n "$data_file" ]]; then
      echo "[dry-run] $method $API_BASE$path (body: $data_file)"
    else
      echo "[dry-run] $method $API_BASE$path"
    fi
    return 0
  fi

  if [[ -n "$data_file" ]]; then
    curl -fsS -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $RETELL_API_KEY" \
      -H "Content-Type: application/json" \
      --data-binary "@$data_file"
  else
    curl -fsS -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $RETELL_API_KEY"
  fi
}

echo "[info] config=$CONFIG_PATH"
echo "[info] agent_id=$AGENT_ID llm_id=$LLM_ID phone=$PHONE_NUMBER"
echo "[info] mode=$([[ $APPLY -eq 1 ]] && echo apply || echo dry-run)"

# 1) Update LLM config (draft)
run PATCH "/update-retell-llm/$LLM_ID" "$CONFIG_PATH" >/tmp/retell.update_llm.json
[[ $APPLY -eq 1 ]] && echo "[ok] updated LLM draft config"

# 2) Publish agent
run POST "/publish-agent/$AGENT_ID" >/tmp/retell.publish_agent.json
[[ $APPLY -eq 1 ]] && echo "[ok] published agent"

# 3) Read agent to infer live version
run GET "/get-agent/$AGENT_ID" >/tmp/retell.agent_after_publish.json

if [[ $APPLY -eq 1 ]]; then
  version="$(jq -r '.version // empty' /tmp/retell.agent_after_publish.json)"
  is_published="$(jq -r '.is_published // empty' /tmp/retell.agent_after_publish.json)"
  if [[ -z "$version" ]]; then
    echo "Could not parse agent version from get-agent response" >&2
    cat /tmp/retell.agent_after_publish.json >&2
    exit 1
  fi
  if [[ "$is_published" == "true" ]]; then
    live_version="$version"
  else
    live_version=$((version - 1))
  fi
  if [[ "$live_version" -lt 1 ]]; then
    echo "Inferred invalid live version: $live_version (version=$version, is_published=$is_published)" >&2
    exit 1
  fi
  echo "[ok] inferred live version: $live_version"

  # 4) Bind phone to live version
  tmp_body="$(mktemp)"
  printf '{"inbound_agent_version": %s}\n' "$live_version" >"$tmp_body"
  run PATCH "/update-phone-number/$PHONE_NUMBER" "$tmp_body" >/tmp/retell.update_phone.json
  rm -f "$tmp_body"
  echo "[ok] updated phone binding to version $live_version"

  # 5) Verify phone binding
  run GET "/list-phone-numbers" >/tmp/retell.list_phone_numbers.json
  actual_binding="$(
    jq -r --arg p "$PHONE_NUMBER" '
      (
        if type == "array" then .
        else (.phone_numbers // .data // .results // [])
        end
      )
      | map(select((.phone_number // .number // .e164_phone_number) == $p))
      | (.[0].inbound_agent_version // empty)
    ' /tmp/retell.list_phone_numbers.json
  )"
  if [[ -z "$actual_binding" ]]; then
    echo "Could not verify phone binding for $PHONE_NUMBER" >&2
    cat /tmp/retell.list_phone_numbers.json >&2
    exit 1
  fi
  if [[ "$actual_binding" != "$live_version" ]]; then
    echo "Phone binding mismatch: expected=$live_version actual=$actual_binding" >&2
    exit 1
  fi
  echo "[ok] verified phone $PHONE_NUMBER -> inbound_agent_version=$actual_binding"

  echo "[done] Retell deployment flow completed"
else
  echo "[done] dry-run complete. Re-run with --apply to execute."
fi
