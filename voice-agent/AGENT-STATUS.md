# AGENT STATUS

- Version: v8-returning-callers (11-state) — patched Feb 10 2026 (v67)
- Previous: v8-returning-callers (v65)
- Agent ID: agent_4fb753a447e714064e71fadc6d
- LLM ID: llm_4621893c9db9478b431a418dc2b6
- Retell Phone Number Version: 67 (bound to +13126463816)
- Retell Published Version: 67
- Agent Name: CallSeal - 8 State v6
- Deployment status: LIVE — premature hangup fix Feb 10 2026
- Backchannel: Enabled (frequency 0.6)
- Interruption Sensitivity: 0.5 (agent-level), per-state overrides below
- Responsiveness: 0.7 (reduced from 1.0 to mitigate echo)
- LESSON: Phone number was pinned to version 15. Publishing new versions does NOT update the phone binding. Must update via PATCH /update-phone-number.
- Config file: retell-llm-v8-returning-callers.json

## Feb 10 Patch #11 (v67) — Premature Hangup Fix

v66 call (call_f3f5e563a6431e7bf3ccea5eb54) — agent hung up on caller after 38 seconds.

### Root cause:
1. Lookup state asked a question during transition speech ("is this about that, or a new issue?") but transition fires instantly — user cannot answer
2. Safety state received silence (transition speech still playing) and called end_call with "misunderstanding or disconnection" — violating end_call's own description (911 only)

### Voice Agent Changes:
- **lookup state**: Changed appointment mention from question to STATEMENT: "I also see you have an appointment on [date] at [time]." No questions during transitions since they fire immediately.
- **safety state**: Added "NEVER End Call From This State (unless 911)" rule. If caller says something unrelated, treat as CLEAR NO and proceed. Never say "misunderstanding" or "disconnection."

## Feb 10 Patch #10 (v65) — Booking Firewall + State Boundary + Anti-Fabrication

v64 call (call_46d1911b03cad41204e56f464f7) revealed 4 regressions:
1. **STATE COLLAPSE**: Agent stayed in service_area for 62 seconds after ZIP validation, performing discovery + urgency + pre_confirm work without transitioning (repeat of v60/Patch #6)
2. **FABRICATED BOOKING**: Agent said "appointment is all set/confirmed" but NEVER called book_service. Used create_callback_request with custom execution_message to fake a booking confirmation (repeat of v57/Patch #5)
3. **ADDRESS NEVER COLLECTED**: service_address ended as "TBD" — discovery was effectively bypassed
4. **FAST-TRACK FAILED**: Lookup returned empty arrays (Supabase service role key not yet set in Render)

### Voice Agent Changes:
- **general_prompt Rule 7**: Strengthened to "Do NOT perform the next state's job inside the current state"
- **general_prompt Rule 11 (BOOKING FIREWALL)**: Reinstated global prohibition on booking language without successful book_service. Covers execution_message text passed to any tool.
- **general_prompt Rule 12 (STATE BOUNDARY)**: Each state has ONE job → IMMEDIATELY call transition edge after completing it
- **general_prompt Rule 13 (CALLBACK GUARD)**: create_callback_request is for CALLBACKS ONLY. NEVER pass booking language in execution_message.
- **service_area state**: Added CRITICAL enforcement — after valid ZIP, ONLY action is transition edge. No extra questions. MAX 2 exchanges.
- **discovery state**: Added BLOCKING requirement for real street address before transition. Added explicit "do NOT ask about timing" (urgency's job) and "do NOT read back summary" (pre_confirm's job).
- **urgency state**: Added 4 anti-fabrication rules — create_callback_request is not a booking substitute, never pass booking language in execution_message, must transition to pre_confirm for scheduling.

### Root Cause Analysis:
v61 removed Rules 11-16 and relied on structural enforcement (end_call removal from key states). But structural enforcement didn't account for create_callback_request's execution_message being used to fake booking confirmations. The LLM found a new escape path: stay in service_area doing all downstream work, then use create_callback_request with custom execution_message to speak booking language.

### Remaining Issue:
SUPABASE_SERVICE_ROLE_KEY still needs to be set in Render dashboard for returning caller fast-track to work.

## Feb 10 Patch #9 (v64) — Discovery Transition Enforcement + Supabase RLS Fix

v63 call (call_3bd9f25109243b8968322c64b12) revealed two issues:
1. Discovery asked follow-up diagnostic question after having all 3 required fields (name, problem, address)
2. Supabase RLS blocked ALL V2 backend reads — `lookup_caller` returns empty arrays for jobs/calls/notes for ALL callers

### Voice Agent Changes:
- **discovery state prompt**: Added "CRITICAL: Once you have all three, transition IMMEDIATELY. Do NOT ask follow-up diagnostic questions." Enforces that the tech diagnoses on-site, not the receptionist.

### V2 Backend Changes:
- **customer-history.ts**: Changed from `SUPABASE_ANON_KEY` to `SUPABASE_SERVICE_ROLE_KEY` (with anon fallback). The anon key was blocked by RLS on jobs, calls, and customer_notes tables. This was silently returning empty arrays for ALL callers since the returning-caller feature was deployed.
- **render.yaml**: Added `SUPABASE_SERVICE_ROLE_KEY` env var
- **REQUIRES**: Set `SUPABASE_SERVICE_ROLE_KEY` in Render dashboard (from Supabase Settings > API > service_role)

### Impact:
Once the service role key is set in Render, `lookup_caller` will return:
- Past call history (recentCalls)
- Job/booking history (pastAppointments)
- Service address and ZIP code (address, zipCode) — enabling fast-track for returning callers
- Operator notes (operatorNotes)
- Callback promises (callbackPromise)

## Feb 10 Patch #8 (v62) — Fast-Track Edge Parameters for Returning Callers

v61 structural fix validated on call_76d741d12544cc86f0f7c892ad0 (perfect state flow, real booking, positive sentiment). However, known callers were still asked for ZIP and address because edge parameters didn't carry lookup data through the state machine.

### Root cause:
- Backend `lookup_caller` ALREADY returns `address` and `zipCode` from jobs table
- service_area prompt ALREADY handles `{{zip_code}}` pre-fill
- discovery prompt ALREADY checks for pre-filled `{{service_address}}`
- BUT: lookup→safety and safety→service_area edges didn't pass these fields, so dynamic variables were never set

### Changes:
- **lookup→safety edge**: Added `zip_code` and `service_address` optional parameters
- **lookup state prompt**: Added "Pre-fill from Lookup Data" instruction to pass zip/address from lookup result
- **safety→service_area edge**: Added `zip_code` and `service_address` pass-through parameters
- **safety state prompt**: Added "Data Passthrough" instruction to carry zip/address through

### Expected behavior for returning callers with job history:
- service_area auto-transitions without asking ZIP ({{zip_code}} already set)
- discovery skips address question ({{service_address}} already set)
- ~15-20s saved per returning caller call

## Feb 10 Patch #7 (v61) — Structural State Enforcement (end_call removal + prompt stripping)

v60 anti-fabrication rules FAILED on call_7d33db930c795570683772823e9. Agent still collapsed flow into service_area (60s), skipped urgency/pre_confirm/booking, called end_call from discovery with "We'll get this scheduled" — book_service never called. Natural-language rules proven ineffective across v57, v59, v60.

### Architectural changes (structural, not prompt-based):
- **end_call removed from general_tools** — no longer available globally in all states
- **end_call added to 9 specific states only**: welcome, safety, service_area, follow_up, manage_booking, urgency, booking, booking_failed, confirm
- **end_call NOT available in**: lookup, discovery, pre_confirm — these states MUST transition forward (mechanically enforced)
- **service_area prompt stripped to bare minimum** — only ZIP validation, no downstream concepts (problem, timing, booking)
- **discovery prompt stripped** — removed timing engagement, anti-fabrication rules, state boundary text. Just: collect name + problem + address, transition.
- **Rules 11-16 removed from general_prompt** — proven ineffective; structural enforcement replaces them

### Why this is different from v60:
v60 added TEXT telling the LLM what not to do. v61 REMOVES THE TOOLS the LLM needs to do the wrong thing. The agent literally cannot call end_call from discovery or pre_confirm — it's not in their tools array.

## Feb 10 Patch #6 (v60) — State Collapse Prevention & Booking Firewall

Fix from call_712a467c4c9956897baccdd547a analysis (Carl's second fake booking):
- Agent collapsed entire booking flow into service_area state (97 seconds without transitioning)
- Asked diagnostic questions, collected timing, read back confirmation, said "you're all set" — all within service_area
- Never reached discovery, urgency, pre_confirm, or booking states
- book_service was never called; booking was fabricated
- State-specific anti-fabrication rules never applied because those states were never entered

### Changes:
- **Rule 15: BOOKING FIREWALL** — Global prohibition on booking language ('booked', 'scheduled', 'confirmed', 'all set', 'locked in', 'finalized') in ALL states except confirm. This catches fabrication regardless of which state the agent is stuck in.
- **Rule 16: STATE BOUNDARY ENFORCEMENT** — After completing a state's primary action, MUST transition before doing anything else. No follow-up questions, no extra info collection.
- **service_area: CRITICAL STATE BOUNDARY** — Explicit list of forbidden actions (asking about problem, timing, scheduling, reading back details). Max 2 exchanges. Transition immediately after ZIP validation.
- **discovery: STATE BOUNDARY** — Max 3 questions. Do NOT ask about timing (urgency's job). Transition immediately when info is complete.
- **end_call: FINAL CHECK** — Before ending, verify: if scheduling was discussed, was book_service called and did it return booked: true? If not, offer callback instead.

## Feb 9 Patch #5 (v57) — Anti-Fabrication Booking Guard

Fix from call_f59a05d3858fa4664a04b2bafc1 analysis (Carl's fake booking):
- Agent said "I'll get that scheduled for Thursday at 10:30 AM" but NEVER called book_service
- current_agent_state was stuck at "discovery" — agent never progressed past it
- Zero tool calls in transcript — entire booking was fabricated

### Voice Agent Changes:
- **A7: Discovery anti-fabrication rule** — Explicit prohibition against saying 'scheduled', 'booked', 'confirmed', 'finalized', or 'locked in' in discovery state. Caller's preferred time must be stored and transitioned to urgency, not acted on.
- **A8: General rule 13** — Global anti-fabrication rule: "The ONLY way an appointment is booked is through the book_service tool returning booked: true."
- **A9: Urgency state time handling** — When caller gives specific time, transition to pre_confirm IMMEDIATELY without saying the time is 'available' or 'confirmed' — calendar hasn't been checked yet.

### Dashboard Changes:
- **D1: Call type includes call_summary/sentiment** — Added missing fields to Call TypeScript interface
- **D2: AI Summary card on call detail page** — Shows Retell's call_summary between header and Call Details
- **D3: Sentiment badge** — Displayed in header area next to outcome badge (green/gray/red)
- **D4: Revenue tier badge fix** — Fixed broken `replace(/\$/g, '').length` logic that mapped $$$$/$$$ to 'diagnostic'. Now correctly counts $ signs.

### Backend Changes:
- **B5: Smart problem_description fallback** — When dynamic vars problem_summary is < 30 chars (vague), prefer Retell's call_analysis.call_summary instead

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
