# PR Summary — Remediation for `call_c80d24d2f11780aee2c1290d665`

**Date:** 2026-02-26  
**Audit target:** `call_c80d24d2f11780aee2c1290d665` (Feb 26, 2026)  
**Theme:** Booking trust + observability hardening (prompt, post-call parsing, dashboard payloads/summaries, local tool contract compatibility)

## Problem Summary (What This PR Addresses)

The audited call completed successfully, but had a trust-breaking booking UX failure:
- Caller requested `Tomorrow at 4:30 PM`
- Backend booked `Friday, February 27, 2026 at 3:45 PM`
- Agent announced the booking as final without explicitly getting acceptance for the changed slot

Additional issues observed:
- `urgency_tier` drift across state transition vs booking tool call (`routine` -> `urgent`)
- redundant confirmation loop / dead air before booking
- prompt/tool schema mismatch risk (`booking_confirmed` expected in prompt vs `booked` returned by tool in actual call)
- returning-caller lookup context (existing appointment) not surfaced to caller

## High-Level Fix Strategy

1. Harden prompt behavior so the voice agent explicitly handles slot substitutions, existing appointments, and confirm-loop drift.
2. Make post-call systems tolerant to both booking response schemas (`booked` and `booking_confirmed`).
3. Surface booking drift in logs, dashboard payloads, and operator-visible summaries (not just hidden in transcripts).
4. Normalize local booking tool responses in `V2` and `V3` to reduce future contract drift.
5. Add tests + scripted QA coverage for this exact failure pattern.

## Changes by Subsystem

### A) Voice Agent Prompt Hardening (`voice-agent`)

**File**
- `voice-agent/retell-llm-v10-simplified.json`

**Changes**
- Booking success logic tolerates either `booked` or `booking_confirmed`.
- Booking state reinforced to acknowledge slot changes and ask caller acceptance before final confirmation.
- Lookup behavior strengthened to mention existing appointment context when present.
- Confirm-state anti-loop guidance added to avoid duplicate approval questions.
- Urgency consistency reinforced from confirm/transition into booking.

**Why**
- Reduces prompt brittleness and directly addresses the hidden slot substitution UX failure seen in the audited call.

### B) Post-Call Booking Trace Parsing + Observability (`V2`)

**Files**
- `V2/src/extraction/booking-tool-result.ts` (new)
- `V2/src/server.ts`
- `V2/src/__tests__/server/booking-backfill.test.ts`

**Changes**
- Added parser/helper for booking tool result payloads that accepts both:
  - `{"booked": true}`
  - `{"booking_confirmed": true}`
- Added booking trace audit extraction from `transcript_with_tool_calls`:
  - requested time
  - booked slot
  - transition urgency
  - booking tool urgency
  - slot mismatch flag
  - urgency mismatch flag
- Added warning logs in post-call webhook processing for slot mismatch and urgency mismatch.
- Updated booking backfill logic to use compatibility parser instead of only checking `result.booked === true`.
- Added tests for alias schema + audit signal extraction.

**Why**
- Makes analytics/post-call reconstruction resilient to booking schema drift.
- Captures the exact failure modes from the audited call in logs.

### C) Dashboard Payload and Summary UX Improvements (`V2`)

**Files**
- `V2/src/services/dashboard.ts`
- `V2/src/__tests__/sync/dashboard-fields.test.ts`
- `V2/src/__tests__/sync/card-summary.test.ts`

**Changes**
- Added booking audit fields to dashboard job + call payloads:
  - `slot_changed`
  - `urgency_mismatch`
  - `booking_requested_time`
  - `booking_booked_slot`
  - `booking_urgency_transition`
- Added operator-visible card summary review note when booking drift exists.
- Upgraded review note to include exact values when available:
  - requested slot
  - booked slot
  - urgency transition
- Added/expanded tests for:
  - mismatch and no-mismatch payload fields
  - card summary annotations and exact-value messaging

**Why**
- Makes the issue visible to dispatch/ops without requiring transcript inspection.
- Improves dashboard utility for QA and incident triage.

### D) Local Booking Tool Contract Compatibility (`V2`)

**Files**
- `V2/src/functions/booking.ts`
- `V2/src/types/retell.ts`
- `V2/src/__tests__/functions/booking-response.test.ts` (new)

**Changes**
- Local `book_appointment` success responses now return both:
  - `booking_confirmed: true`
  - `booked: true`
- Added V2 test to lock this compatibility contract on mock fallback path.

**Why**
- Prevents local tool paths from reintroducing the same schema mismatch risk.

### E) `V3` Parity for Booking Drift Visibility + Contract Compatibility

**Files**
- `V3/src/extraction/booking-tool-result.ts` (new)
- `V3/src/types/retell.ts`
- `V3/src/server.ts`
- `V3/src/services/dashboard.ts`
- `V3/src/functions/booking.ts`

**Changes**
- Added `transcript_with_tool_calls` typing + `ToolCallEntry` typing to post-call data.
- Added booking trace audit helper (same drift signals as V2).
- Added post-call warnings for slot/urgency mismatch.
- Added dashboard job + call payload booking audit fields (same schema as V2).
- Added operator-visible `ai_summary` review note with exact booking mismatch values.
- Normalized local `book_appointment` success shape:
  - `booking_confirmed: true`
  - `booked: true`
  - `appointment_time`

**Why**
- Keeps `V3` operational observability in parity with `V2`.
- Reduces drift between backends during migrations/tests.

### F) QA / Operational Documentation

**Files**
- `voice-agent/TEST-SCENARIOS.md`
- `voice-agent/AGENT-STATUS.md`
- `voice-agent/deploy_retell_v10.sh`
- `scripts/verify_book_service_contract.sh`
- `scripts/prod_remediation_status.sh`
- `docs/plans/2026-02-26-call-c80d24d2-booking-audit-remediation-rollout.md` (new)

**Changes**
- Added Scenario 16 scripted regression for:
  - returning caller
  - existing appointment
  - backend slot substitution
  - required caller re-consent
  - dashboard payload/summary verification
- Added clarification in `AGENT-STATUS.md` that the Retell display label (`v6`) is stale and not a reliable source of active config truth.
- Added dry-run-safe Retell deploy helper script for update/publish/phone-bind verification flow.
- Added external `book_service` contract verifier script.
  - Supports explicit headers and Retell-style HMAC auth via `RETELL_API_KEY`.
  - Added strict auth validation mode (`--require-auth-pass`) so authenticated checks fail on `401/403` or auth-rejection messages.
- Added single-command production blocker status script.
- Added rollout checklist doc covering:
  - implemented changes
  - external dependency still pending
  - deployment order
  - QA pass criteria
  - quick verification commands

**Why**
- Makes this failure class reproducible and reviewable by QA/ops.
- Prevents future audit confusion from stale Retell UI labels.

## Validation Run (Completed)

### `V2`
- `npx vitest run src/__tests__/server/booking-backfill.test.ts` ✅
- `npx vitest run src/__tests__/sync/dashboard-fields.test.ts` ✅
- `npx vitest run src/__tests__/sync/card-summary.test.ts` ✅
- `npx vitest run src/__tests__/functions/booking-response.test.ts` ✅
- Combined targeted runs (dashboard + card + booking-backfill) ✅
- `npm run typecheck` ✅

### `V3`
- `npm ci` (local deps installed for validation) ✅
- `npm run typecheck` ✅

### `voice-agent`
- `voice-agent/retell-llm-v10-simplified.json` JSON parse validation ✅

## Important Remaining Work (Not in This Repo)

The audited call used an external `book_service` backend path (`app.calllock.co/api/retell/book-service`) not patched in this repo.

**Still recommended:**
- Return both `booked` and `booking_confirmed` from the external backend
- Preserve/emit exact booked slot + requested slot (if not already)
- Preserve urgency tier consistency (or log explicit override reason)

## Rollout / QA References

- Rollout checklist: `docs/plans/2026-02-26-call-c80d24d2-booking-audit-remediation-rollout.md`
- Scripted regression scenario: `voice-agent/TEST-SCENARIOS.md` (Scenario 16)

## Suggested PR Description (Short)

Harden booking flow against slot-substitution trust failures and booking schema drift:
- Prompt accepts `booked` or `booking_confirmed` and requires slot-change acknowledgment
- V2/V3 post-call parsing logs slot/urgency drift from tool traces
- V2/V3 dashboard payloads and summaries expose booking drift details
- V2/V3 local `book_appointment` responses normalized to return both success aliases
- Added regression tests + scripted QA scenario for the Feb 26, 2026 audited call pattern

## Notes for Reviewer

- `voice-agent/scripts/` appears as untracked in workspace state but was not modified as part of this work.
- Some changes are documentation-only and intended to reduce audit/operator confusion (`AGENT-STATUS`, rollout doc, test scenarios).
