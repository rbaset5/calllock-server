# Urgency State Split — Structural Booking-Skip Fix

**Date:** 2026-02-12
**Patch:** #18
**Problem:** Agent calls `end_call` from urgency state without attempting booking
**Root Cause:** `end_call` tool available in urgency state; LLM prefers it over transition edges
**Fix:** Split urgency into two states — remove `end_call` from triage path

## Background

Call `call_f363ef11dc899c050ced367ec03` (Jonas, 56s) showed the agent reaching urgency with `lead_type=""` (correct — Patch #17 fix working) but immediately calling `end_call` instead of proceeding to `pre_confirm` → `booking`. The agent never asked about timing, never attempted booking, and hung up on the customer.

This is the same class of bug fixed structurally in Patch #7 (v61) for discovery, lookup, and pre_confirm states. Prompt-based guards have failed 6 times for this pattern (Patches #5, #6, #7, #10, #13, #17).

## Design

### State Machine Change

**Before (14 states):**
```
discovery → urgency [end_call, create_callback_request, send_sales_lead_alert] → pre_confirm
```

**After (15 states):**
```
discovery → urgency [NO tools] → pre_confirm                    (scheduling path — DEFAULT)
                             ↘ urgency_callback [end_call, ...]  (callback/sales path)
```

### `urgency` State (Modified)

- **Tools:** NONE (pure triage state, like lookup/discovery)
- **Edges:** `pre_confirm` (scheduling) + `urgency_callback` (callback/sales)
- **Job:** Determine timing preference, detect callback vs scheduling intent, route

**Routing logic:**
1. `lead_type == "high_ticket"` AND problem genuinely about new equipment → `urgency_callback`
2. Caller explicitly requests callback → `urgency_callback`
3. Everything else (DEFAULT) → `pre_confirm`

**Edge parameters:**
- `urgency → pre_confirm`: `urgency_tier`, `preferred_time`
- `urgency → urgency_callback`: `lead_type`, `problem_description`, `customer_name`, `customer_phone`, `service_address`, `callback_reason`

### `urgency_callback` State (NEW — 15th state)

Terminal state modeled after `safety_emergency`.

- **Tools:** `send_sales_lead_alert`, `create_callback_request`, `end_call`
- **Edges:** None (terminal)
- **Job:** Execute the callback request, then end call

**Prompt structure:**
1. If `lead_type == "high_ticket"`: call `send_sales_lead_alert`, then `create_callback_request`, then `end_call`
2. If standard callback: call `create_callback_request`, then `end_call`
3. ALWAYS call `create_callback_request` before `end_call`

### Additional Fixes

1. **Banned phrase "Moving forward"** — Already in WORDS TO AVOID but agent still used it. The doubled speech "Noted. Moving forward.Noted. Moving forward." came from the end_call execution_message. Will be addressed by removing end_call from urgency entirely.

2. **`booking_status` null on lead** — Jobs webhook handler should default to `"not_requested"` when booking_status is not in the payload.

## Approach Rejected

**Prompt hardening only:** Adding more rules to the urgency state prompt. Rejected because prompt-based guards have a documented 0% success rate for preventing end_call misuse (6 failed patches).

## Verification

After deployment:
1. Test call: "broken thermostat cover" → should reach pre_confirm → booking → confirm
2. Test call: "I need a new AC unit" → should reach urgency_callback → sales alert → callback → end
3. Test call: "just have someone call me back" → should reach urgency_callback → callback → end
4. Run `/audit-call` on all three to verify state flow and booking_status

## Files Changed

- `voice-agent/retell-llm-v9-triage.json` — Split urgency state, add urgency_callback state
- `voice-agent/AGENT-STATUS.md` — Document Patch #18
- `src/app/api/webhook/jobs/route.ts` (dashboard) — Default booking_status to "not_requested"
