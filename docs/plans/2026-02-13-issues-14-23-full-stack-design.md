# Full-Stack Design: Issues #14–#23

**Date:** 2026-02-13
**Status:** Approved
**Scope:** Voice agent (Retell), V2 backend, Dashboard — 10 open issues

---

## Problem Summary

10 open GitHub issues affecting call integrity and data quality. Most root causes are upstream (voice agent or V2 backend), not in the dashboard.

## Approach

- **Tier 1 (Critical + High):** Structural enforcement in voice agent config + minimal V2 backend support
- **Tier 2 (Medium):** V2 backend classification fixes + dashboard display updates
- **Principle:** Structural enforcement over prompt guards (prompt guards have 0% success rate with GPT-4o per optimization log)

---

## Tier 1: Conversation Integrity (Critical + High)

### #17 — Consent Gate (Critical)

**Problem:** Agent books appointments without explicit customer approval.

**Fix — Voice Agent Config:**
- Add required `consent_given: true` parameter on `pre_confirm → booking` edge
- Agent must read back collected info and get explicit "yes" before the edge fires
- If customer says "no" or wants changes, loop back to `discovery`

**Files changed:** `voice-agent/retell-llm-v9-triage.json` (edge config)

---

### #21 — Booking Confabulation Gate (Critical)

**Problem:** Agent says "you're booked" when book_service actually failed.

**Fix — V2 Backend:**
- `book_service` response always includes explicit `"booking_confirmed": true` or `"booking_confirmed": false`
- Never omit this field

**Fix — Voice Agent Config:**
- `booking → confirm` edge requires `booking_result=success` parameter (set from tool response)
- `booking → booking_failed` edge is the default path if tool returns failure
- `confirm` state is the ONLY state with booking-confirmation language
- `booking` state prompt: defense-in-depth prohibition on words "booked/confirmed/scheduled"

**Files changed:**
- `V2/src/functions/booking.ts` (add `booking_confirmed` field)
- `voice-agent/retell-llm-v9-triage.json` (edge parameter + state prompts)

---

### #20 — Discovery Field Requirements (High)

**Problem:** Agent skips to booking without collecting name, problem, address.

**Fix — Voice Agent Config:**
- Make `customer_name`, `problem_description`, `service_address` all **required** (non-optional) on `discovery → urgency` edge
- Agent cannot transition until all three are populated with non-empty values
- If Retell doesn't enforce non-empty natively, add a pre-urgency validation state

**Files changed:** `voice-agent/retell-llm-v9-triage.json` (edge parameters)

---

### #23 — Time Preference Required (High)

**Problem:** Agent books without asking when the customer wants the appointment.

**Fix — Voice Agent Config:**
- Add required `preferred_time` parameter on `urgency → pre_confirm` edge
- Valid: any non-empty string ("ASAP", "tomorrow morning", "this week", "Monday at 2pm")
- Urgency state already asks about timing — ensure the answer is captured and passed

**Files changed:** `voice-agent/retell-llm-v9-triage.json` (edge parameter)

---

### #19 — State Loop / Repetition Guardrails (High)

**Problem:** Agent gets stuck repeating the same state/phrases without progressing.

**Fix — V2 Backend:**
- Add `state_visit_counter: Record<string, number>` to `ConversationState`
- Each tool call increments counter for current state
- If any state visited >3 times, tool response includes `"force_transition": true`
- After 3 forced transitions with no progress, trigger `end_call` with reason `"system_timeout"`

**Fix — Voice Agent Config:**
- Each state's prompt includes: "If you receive force_transition=true, immediately transition to the next state"

**Files changed:**
- `V2/src/types/retell.ts` (state_visit_counter on ConversationState)
- `V2/src/server.ts` (increment counter on each tool call, inject force_transition)
- `voice-agent/retell-llm-v9-triage.json` (state prompts)

---

### #18 — Privacy: Phone/Name Identity Only (High)

**Problem:** V2's lookup_caller returns address to agent, agent reads it back to caller. Privacy violation if address belongs to a different person sharing the phone.

**Fix — V2 Backend:**
- Split `lookup_caller` response into two objects:
  - `visible_to_agent`: `{ name, has_existing_appointment, appointment_time, last_call_summary }`
  - `passthrough_data`: `{ address, zip_code }` — stored in state silently, never shown to agent
- `book_service` pulls address from `passthrough_data` in state (customer can override during discovery)

**Fix — Voice Agent Config:**
- Lookup state prompt only references `visible_to_agent` fields
- Agent greets by name but never mentions address unprompted

**Files changed:**
- `V2/src/services/customer-history.ts` (split response)
- `V2/src/server.ts` (passthrough_data handling)
- `voice-agent/retell-llm-v9-triage.json` (lookup state prompt)

---

## Tier 2: Data Classification Quality (Medium)

### #14 — Missing Taxonomy Tags in Webhook (Medium)

**Problem:** V2 sometimes omits `tags` field in webhook payload.

**Fix — V2 Backend:**
- In `transformToDashboardPayload()`, always include `tags` field
- If classifier returns empty → send `tags: {}` (explicit empty, not omitted)
- Add log warning when tags are empty

**Fix — Dashboard:**
- Jobs webhook handler: if `tags` is empty/missing, display "No tags" indicator on card

**Files changed:**
- `V2/src/services/dashboard.ts` (null-check on tags)
- `calllock-dashboard/src/app/api/webhook/jobs/route.ts` (empty-state handling)
- `calllock-dashboard/src/components/` (empty tags display)

---

### #15 — 4-Level Urgency (Medium)

**Problem:** Binary urgent/non-urgent mapping loses nuance.

**Fix — V2 Backend:**
- Replace `mapUrgencyLevel()` with 4-level mapping:
  - `emergency`: Gas leak, CO, fire, flood, health risk
  - `high`: System down, no heat/cool, water leak, ASAP requests
  - `medium`: Standard repairs, diagnostics, "this week"
  - `low`: Maintenance, tune-ups, estimates, "whenever"
- Tag classifier auto-upgrades: HAZARD tags → force `emergency`; RECOVERY tags + sentiment ≤ 2 → floor at `high`

**Fix — Dashboard:**
- `getUrgencyBadgeProps()`: add `low` variant (neutral/gray styling)
- `urgency-reclassification.ts`: expand to handle all 4 levels as inputs
  - Add downgrade: `high → medium` for maintenance, `medium → low` for estimates

**Files changed:**
- `V2/src/server.ts` or `V2/src/services/dashboard.ts` (mapUrgencyLevel rewrite)
- `calllock-dashboard/src/components/ui/badge-unified.tsx` (low urgency badge)
- `calllock-dashboard/src/lib/urgency-reclassification.ts` (4-level support)

---

### #16 — Evidence-Based Hazard Rules (Medium)

**Problem:** Routine repairs trigger HAZARD tags (e.g., "gas furnace" → GAS_LEAK).

**Fix — V2 Backend:**
- Update hazard tag rules in `tag-classifier.ts` with evidence requirements:
  - GAS_LEAK: requires "gas leak" or "smell gas" — "gas furnace" alone is not a hazard
  - CO_EVENT: requires "CO detector/alarm" or "carbon monoxide alarm" — mention alone is not hazard
  - ELECTRICAL_FIRE: requires "sparking" + electrical context — "fire up the furnace" is not hazard
  - ACTIVE_FLOODING: requires "flooding" or "water everywhere" — "water heater" alone is not hazard
- Add `confidence` field to each tag: `high` (multi-word match), `medium` (word + context), `low` (single word)

**Fix — Dashboard:**
- HAZARD archetype only displays if at least one HAZARD tag has `confidence >= medium`
- Low-confidence hazard tags show as warnings, not primary archetype

**Files changed:**
- `V2/src/services/tag-classifier.ts` (phrase lists + confidence scoring)
- `calllock-dashboard/src/lib/velocity.ts` (confidence threshold for HAZARD archetype)

---

### #22 — Missing Equipment Type (Medium)

**Problem:** Agent skips equipment type discovery; backend has no fallback extraction.

**Fix — Voice Agent Config:**
- Add `equipment_type` as recommended (not required) parameter on `discovery → urgency` edge
- If caller mentions equipment naturally, capture it; if not, agent asks

**Fix — V2 Backend:**
- Before sending webhook, if `equipment_type` is empty:
  1. Run regex on `call_transcript` (AC, furnace, heat pump, boiler, thermostat, duct, mini-split, water heater)
  2. If found → populate; if not → send `equipment_type: "unknown"`

**Fix — Dashboard:**
- Display "Equipment: Unknown" on cards when type is unknown (signals to owner to ask during callback)

**Files changed:**
- `voice-agent/retell-llm-v9-triage.json` (optional edge parameter)
- `V2/src/services/dashboard.ts` (transcript extraction fallback)
- `calllock-dashboard/src/components/` (unknown equipment display)

---

## Implementation Order

Severity-first, within each tier:

### Tier 1 (Critical + High) — One PR per issue
1. **#17** Consent gate (voice agent config)
2. **#21** Confabulation gate (V2 + voice agent)
3. **#20** Discovery field requirements (voice agent config)
4. **#23** Time preference required (voice agent config)
5. **#18** Privacy — address passthrough (V2 + voice agent)
6. **#19** State loop guardrails (V2 + voice agent)

### Tier 2 (Medium) — Can batch into fewer PRs
7. **#14** Tags always populated (V2 + dashboard)
8. **#15** 4-level urgency (V2 + dashboard)
9. **#16** Evidence-based hazard rules (V2 + dashboard)
10. **#22** Equipment type extraction (voice agent + V2 + dashboard)

---

## Testing Strategy

Each Tier 1 fix requires a real phone call test:
- Call the agent → verify the structural gate works (e.g., can't book without consent)
- Pull transcript from Retell API → verify state transitions
- Check dashboard → verify data arrived correctly

Tier 2 fixes can be tested with webhook payloads:
- Send test payloads to dashboard webhook endpoints
- Verify urgency mapping, tag display, equipment extraction

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Agent config changes (Tier 1) | Low — restricting capabilities, not adding | Each fix is independently deployable and testable |
| V2 response format changes (#21, #18) | Medium — breaking change for agent | Deploy V2 + agent config together |
| Urgency mapping (#15) | Medium — changes how existing calls display | Dashboard reclassification as safety net |
| Hazard evidence rules (#16) | Medium — could under-classify real hazards | Start with `medium` confidence threshold, tune based on audit |
| State visit counter (#19) | Low — additive, doesn't break existing flow | Counter resets per call; force_transition is advisory |
