# AGENT STATUS

- Version: v8-returning-callers (11-state) — patched Feb 9 2026 (v41)
- Previous: v7-ux-refined (8-state)
- Agent ID: agent_4fb753a447e714064e71fadc6d
- LLM ID: llm_4621893c9db9478b431a418dc2b6
- Retell Phone Number Version: 41 (bound to +13126463816)
- Retell Published Version: 41
- Agent Name: CallSeal - 8 State v6
- Deployment status: LIVE — comprehensive fix Feb 9 2026
- Backchannel: Enabled (frequency 0.6)
- Interruption Sensitivity: 0.5 (agent-level), per-state overrides below
- Responsiveness: 0.7 (reduced from 1.0 to mitigate echo)
- LESSON: Phone number was pinned to version 15. Publishing new versions does NOT update the phone binding. Must update via PATCH /update-phone-number.
- Config file: retell-llm-v8-returning-callers.json

## Feb 9 Patch #4 (v41) — Comprehensive 14-Issue Fix

Fix from call_3e059f1d5330b54e35f9556365b analysis (6 agent + 4 backend + 4 dashboard):

### Voice Agent (A1-A6):
- **A1: Pre_confirm template guard** — BLOCKING check that customer_name is a real name, not `{{customer_name}}`, phone number, or placeholder. Agent must ask if missing.
- **A2: Booking tool-first enforcement** — Rewritten to same pattern as welcome→lookup fix. "Your FIRST and ONLY action is to call book_service. Do NOT generate ANY text before calling it." NEVER fabricate confirmations.
- **A3: Discovery name gate** — BLOCKING REQUIREMENT: must have real name before ANY other questions. Edge description enforces name requirement.
- **A4: Lookup identity statements** — Replaced "Hey — is this {{customer_name}}?" questions with statements ("Good to hear from you again, {{customer_name}}.") because speak_during_transition fires immediately without waiting for a response.
- **A5: Appointment awareness** — If lookup returns upcoming_appointment AND caller_intent is hvac_issue, agent MUST mention existing appointment to prevent double-booking.
- **A6: No redundant lookups** — Added rule to booking, confirm, and general_prompt: "NEVER call lookup_caller more than once per call."

### V2 Backend (B1-B4):
- **B1: appointmentBooked conservative fallback** — Changed from `call_analysis.call_successful` to `false` when no saved session exists (safer: creates Lead instead of false-positive Job)
- **B2: Customer name no phone fallback** — Removed phone number from name fallback chain, now defaults to "Unknown Caller"
- **B3: Tag classifier word boundaries** — Added `containsPhrase()` helper with word boundary regex for short keywords. Refined SNOW_ICE and LEGAL_MENTION to multi-word patterns to prevent false matches on "service", "issue", "price"
- **B4: Calls webhook booking_status** — Added booking_status field to calls webhook payload

### Dashboard (C1-C4):
- **C1: is_ai_booked derived** — Changed from hard-coded `true` to `Boolean(body.scheduled_at)` — only marks AI-booked when booking actually exists
- **C2: Customer name sanitization** — Added `sanitizeCustomerName()` helper that rejects phone numbers as names, applied at all 4 insert/update sites
- **C3: Tag category validation** — Tightened Zod schema to validate against 9 known taxonomy categories
- **C4: Calls webhook classification** — Added booking_status, caller_type, primary_intent to calls schema and handler

## Feb 9 Patch #3 (v39/40) — Lookup State Tool-First Fix

Fix from call_8cf70e9be98d9e862898c209542 analysis:
- **Lookup state_prompt rewritten for tool-first execution** — "Your FIRST action MUST be calling lookup_caller. Do NOT generate any text before calling it."
- **execution_message changed** — "One sec, let me pull up your account..." → "Pulling that up now..." to avoid double-speak with welcome transition
- **found=true/no-name case strengthened** — Say EXACTLY "I see some history on your number", not "is this the right number?"
- Root cause: Same as welcome — LLM chose text generation over tool call because prompt had text-generation instructions before the tool call directive.

## Feb 9 Patch #2 (v38/39) — Welcome State Transition Fix

Fix from call_9e749f103c3a789182802a61c6b analysis:
- **CRITICAL: Welcome→lookup edge now has `parameters`** (caller_intent, problem_summary) — makes the edge a compelling tool call so the LLM invokes it instead of generating text
- **Edge description rewritten as imperative** — "Transition immediately — do not respond with text first"
- **Welcome state_prompt simplified** — removed text-generation instructions that competed with edge tool call; LLM now uses `speak_during_transition` for speech
- **interruption_sensitivity lowered** — 0.8 → 0.5 to reduce echo-triggered false speech
- Root cause: Retell edges are internally LLM tool calls. GPT-4o-mini produces text OR a tool call, not both. Old prompt encouraged text generation, so the edge never fired.

## Feb 9 Patch #1 (v36/37)

Fixes from call_34883974e5d7ef5804ba49ce98c analysis:
- **CRITICAL: Moved `book_service` from `general_tools` to `booking` state tools only** — prevents state machine bypass (agent was skipping safety, pre_confirm, and booking directly from lookup)
- **Welcome state anti-repetition rules** — immediate transition after acknowledging issue, background noise guard, never re-ask rule
- **Lookup state context continuity** — reference the issue already described in welcome, no repeat of "let me look you up"
- **Brevity tightening** — max 1 sentence for acknowledgments, 5 words or fewer
- **customer_phone description** — changed from "TBD" to "auto" for consistency
- **Cal.com lookup returns attendee name** — prevents re-asking name when Cal.com booking already has it

## What's New in v8

- **Automatic caller recognition** via `lookup_caller` tool at call start
- **Returning caller fast-track**: skip ZIP, name, address for known callers (~45s saved)
- **Follow-up handling**: acknowledge callback promises and past call history
- **Booking management**: reschedule, cancel, or status check via `manage_appointment` tool
- **Intent switching**: any branch can exit into new-issue flow with pre-filled data

## State Flow

### New caller / new issue:
```
welcome → lookup → safety → service_area → discovery → urgency → pre_confirm → booking → confirm
```

### Known caller with new issue (fast-track):
```
welcome → lookup → safety → service_area* → discovery* → urgency → pre_confirm → booking → confirm
```
*service_area skipped if ZIP known; discovery skips name/address if pre-filled

### Follow-up / callback promise:
```
welcome → lookup → follow_up → (resolve or → safety flow)
```

### Manage existing booking:
```
welcome → lookup → manage_booking → confirm (or → safety flow for new issue)
```

## Testing Status

| # | State | Type | Status |
|---|---|---|---|
| 1 | welcome | Core | Untested |
| 2 | lookup | NEW | Untested |
| 3 | follow_up | NEW | Untested |
| 4 | manage_booking | NEW | Untested |
| 5 | safety | Core | Untested |
| 6 | service_area | Modified | Untested |
| 7 | discovery | Modified | Untested |
| 8 | urgency | Core | Untested |
| 9 | pre_confirm | Core | Untested |
| 10 | booking | Core | Untested |
| 11 | confirm | Modified | Untested |

## New Tools

| Tool | Endpoint | Purpose |
|------|----------|---------|
| lookup_caller | V2: /webhook/retell/lookup_caller | Auto-lookup caller by phone at call start |
| manage_appointment | V2: /webhook/retell/manage_appointment | Reschedule, cancel, or status check |

## Test Scenarios (v8)

### Returning Caller Scenarios
1. Known caller + new issue → name confirmed, ZIP/address skipped
2. Known caller + follow-up → history acknowledged, callback offered
3. Known caller + booking management → appointment found, reschedule/cancel works
4. Known caller + intent switch → start booking mgmt, add new issue mid-call

### Existing Scenarios (must still pass)
5. New caller: full flow works unchanged
6. Safety emergency: 911 flow
7. Out of area: ZIP rejection
8. Booking: full booking + pre_confirm flow

### Edge Cases
9. Lookup times out → graceful fallback to normal flow
10. Caller says "my appointment" but has none → offer to schedule
11. Caller has callback promise but wants to book instead → transition to safety

## Golden Rules (Calm HVAC Dispatcher — v8 Returning Callers)

- Calm, capable dispatcher voice (friendly, brisk, confident).
- ONE question at a time; max 2 sentences before a question.
- Tone matching: mirror caller's energy (never more cheerful than the caller).
- Semantic paraphrasing: rephrase caller's words, don't parrot them verbatim.
- Acknowledgment rotation: vary phrases, often skip acknowledgment entirely.
- Bridge phrases for dead air: "Let me see..." / "One second..." (sparingly).
- Backchannel enabled at platform level for active listening sounds.
- Safety first: gas/burning/smoke/CO/sparks -> safety-critical flow.
- NEVER book without caller's explicit approval (pre_confirm state).
- Never claim booking confirmed unless booking tool returns SUCCESS.
- Known caller recognition: confirm name only, silently pre-fill address/ZIP.
- Callback promise acknowledgment: "I see we owe you a callback" (empathetic, no excuses).
- Service area testing: ZIP prefix 787 only.
- Pricing: $89 diagnostic, credited if repair proceeds.
