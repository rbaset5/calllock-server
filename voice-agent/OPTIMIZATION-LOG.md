# OPTIMIZATION LOG

## 2026-02-12 — Patch #16: 5 UX Fixes from Call Analysis

### Problem
Call `call_5822a97bfc9c162cc7121ddc68e` (Jonas, 2m41s, v78) — Patches #15/#15c confirmed working (zero transition narration, no premature ending, safety question asked). But revealed 5 UX issues:
1. **Time mismatch**: Agent said "Locking in 7:30 AM" then "You're all set for 8:00 AM" — Cal.com snapped to closest slot, agent didn't acknowledge the change
2. **Silent appointment cancellation**: Jonas had existing 11:30 AM appointment. Backend `cancelExistingBookings()` silently cancelled it before booking 8:00 AM
3. **Double confirmation**: LLM went backward from pre_confirm → discovery → urgency → pre_confirm, re-asking for confirmation
4. **12-second dead air**: Caused by backward state flow (#3)
5. **Fabricated ZIP "787"**: LLM hallucinated partial ZIP from service_area rule

### Change
**Voice agent (retell-llm-v9-triage.json):**
- Booking state: generic execution_message required (no specific time), strengthened time-mismatch comparison rule
- Booking state: added `existing_appointment` response handler + `force_book` parameter for confirmed second visits
- Pre_confirm state: CRITICAL ROUTING RULE — after YES, ONLY → [booking], backward transitions explicitly prohibited
- Lookup state: explicit ZIP fabrication prohibition (must be exactly 5 digits or empty string)
- Service_area state: validates ZIP is exactly 5 digits before accepting

**Backend (calllock-dashboard book-service route):**
- Added `force_book` parameter to `book_service` tool
- Before cancelling existing bookings, checks for same-date conflicts
- Returns `{ booked: false, existing_appointment: { date, time } }` when conflict detected
- Voice agent asks caller: reschedule or add second visit

### Result
Pending test call + dashboard deploy. Voice agent config deployed to Retell.

### Key Learning
**Silent cancellation is worse than double-booking.** The `cancelExistingBookings()` function was designed to prevent duplicate bookings by cancelling old ones before creating new ones. But the customer doesn't know — they expect both appointments to exist. The fix adds a server-side guard that surfaces the conflict to the voice agent, letting the caller decide. Also: **LLMs route backward when they sense incomplete data** — the fabricated ZIP "787" may have triggered the backward flow from pre_confirm to discovery. Preventing both the backward routing and the data fabrication creates defense-in-depth.

## 2026-02-12 — Patch #15c: Complete Transition Word Purge + Local File Sync

### Problem
Call `call_4974ca9b729f1448f311aec587c` (Jonas, 2m47s) confirmed Patch #15 structural fix works (premature ending fixed, safety question asked, booking time match). But agent said "Transitioning now" 4 times — caller even echoed it back. Patch #15b replaced 43 "Transition to [state]" → "→ [state]" but left 22 instances of "transition" in edge descriptions and other instructional text.

### Change
- Completed the transition word purge: replaced all remaining instructional uses of "transition" in edge descriptions, state prompts, and tool descriptions
- Replacements: "Transition immediately" → "Proceed immediately", "TRANSITION to" → "PROCEED to", "transition speech" → "greeting", "during the transition" → "from the welcome state"
- Final count: 0 LLM-readable "transition" instances (19 total remain: 17 `speak_during_transition` API keys + 2 WORDS TO AVOID rule)
- Synced local `retell-llm-v9-triage.json` from deployed Retell config (was out of sync after undo)

### Result
Pending test call. With zero "transition" in LLM-readable text, the LLM has no source word to narrate. Same structural approach that fixed end_call (remove the trigger, don't rely on "don't do this" rules).

### Key Learning
**The transition purge must be complete.** Patch #15b caught the "Transition to [state]" pattern (43 instances) but missed "Transition immediately" in edge descriptions (15 instances) and other forms ("TRANSITION within", "transition speech"). Partial purges leave the same vulnerability — the LLM only needs one instance to narrate.

## 2026-02-11 — Patch #15: Structural Safety Fix (Remove end_call)

### Problem
Call `call_5e604543b07b26757cf5cc5f9fa` (Jonas, 37s) — agent saw existing appointment + callback and called `end_call` from safety state without asking safety question. Said "It seems like we have everything noted" and hung up. 3rd occurrence of premature ending (also Patches #12, #13). Prompt-based guards (Rule 15, "NEVER End Call From This State") are insufficient — LLM ignores them.

### Change
- **Removed `end_call` tool from safety state** — structural prevention, LLM cannot end calls from safety
- **Added `safety_emergency` state** — 14th state, terminal, only for confirmed 911 emergencies. Has `end_call` tool.
- **Added safety → safety_emergency transition edge** — for confirmed gas/burning/smoke/CO. The safety_emergency state delivers the 911 message and ends the call.
- **Updated safety prompt** — CONFIRMED YES handler now transitions to [safety_emergency] instead of calling end_call

### Result
Pending test call. With end_call physically removed, the LLM can only transition to [service_area] (safe) or [safety_emergency] (confirmed danger). No prompt-level guard needed — the constraint is structural.

### Key Learning
**Prompt-based tool restrictions don't work with GPT-4o.** When the LLM has a tool available, it will use it even if the description says not to. The only reliable guard is removing the tool entirely. This pattern should be applied to other states where premature ending is a concern.

## 2026-02-11 — Patch #14: Required Edge Parameters + Booking Time Mismatch Guard

### Problem
Call `call_60cc805bd6fbbe58bdc0aa329ee` (Jonas, return caller, 2m28s) showed v78 fixes partially worked — no transition language leak, no premature ending — but 2 issues persisted:
1. Agent still re-asked for ZIP and address despite recognizing Jonas. Root cause: edge parameters for `zip_code`, `service_address`, `customer_name` were optional, so GPT-4o silently omitted them.
2. Agent confirmed "5:00 PM" with caller but Cal.com booked 3:45 PM. Agent read the response verbatim without flagging the 1h15m time discrepancy.

### Change
- **lookup state prompt**: Moved pre-fill instruction to prominent position with explicit field mapping (`address` → `service_address`, `zipCode` → `zip_code`)
- **lookup → safety edge**: `zip_code`, `service_address`, `customer_name` now REQUIRED
- **safety → service_area edge**: `zip_code`, `service_address` now REQUIRED
- **service_area → discovery edge**: `service_address`, `customer_name` now REQUIRED
- **booking state prompt**: Added time mismatch sub-case — if booked time differs from pre_confirm, agent flags discrepancy before confirming

### Result
Test call `call_17edd4681fb16a8cbe9d8bcc780` confirmed: LLM now populates required params ✅ but set `service_address: "Not provided"` because backend returns no clean address for Jonas (garbled addresses filtered, recent booking not yet in Supabase).

## 2026-02-11 — Patch #14b: Backend Address Fallback + Sentinel Value Fix

### Problem
Patch #14 config fix works but data gap in backend: `lookup_caller` returns no address for Jonas because older jobs have garbled addresses and the most recent booking hasn't propagated to the jobs table. LLM used "Not provided" instead of empty string for missing values.

### Change
- **customer-history.ts**: Added "Not provided" to address filter alongside "TBD"; added fallback to extract address from upcoming appointment job records when no clean address found in recent jobs
- **lookup state prompt**: Explicitly prohibit "Not provided", "N/A", "unknown" as values — only empty string allowed for missing fields
- **discovery state prompt**: Added "Not provided" to sentinel value list (fields with this value are treated as unfilled)

### Result
Pending Render deploy + test call. Backend fallback will find addresses from upcoming appointment jobs. Sentinel fix prevents LLM from treating "Not provided" as a real address.

## 2026-02-11 — v78 Return Caller Data Leak + Urgency Guard

### Problem
Call `call_11881293afaa632e4028fa256a4` (Jonas, return caller) showed 3 regressions:
1. Agent re-asked for ZIP and address despite Jonas being a recognized return caller — `service_address` and `customer_name` were dropped at the `service_area → discovery` edge
2. Agent said "Let me move this forward" — process-narrating filler not on the WORDS TO AVOID list
3. Agent called `end_call` in urgency instead of transitioning to `pre_confirm`, skipping the booking flow entirely

### Change
- **service_area → discovery edge**: Added `service_address` + `customer_name` parameters with Data Passthrough instruction
- **WORDS TO AVOID**: Added "Let me move this forward" and 4 similar process-narrating phrases + general rule against describing own process
- **Rule 16 (URGENCY END_CALL GUARD)**: `end_call` in urgency requires prior `create_callback_request` response; otherwise must transition to `[pre_confirm]`
- **urgency end_call description**: PREREQUISITE enforcement + PROHIBITED for scheduling flows
- **urgency state_prompt**: SCHEDULING FLOW FIREWALL added to CRITICAL RULES

### Result
Return caller data now flows through service_area → discovery without loss. Process-narrating filler blocked. Urgency state can no longer end calls prematurely when caller wants to schedule — must route through pre_confirm → booking.

## 2026-02-11 — v76 Return Caller Address Fix

### Problem
Return callers (e.g., Jonas) were re-asked for ZIP and street address on every call despite being recognized. Three root causes found via call `call_8f4be5a1a3624a0954947d0bb3b`:
1. `service_area → discovery` edge only passed `zip_code` — `service_address` and `customer_name` were dropped at the handoff
2. `book_service` tool didn't capture `zip_code`, so no ZIP was stored in the database for future lookups
3. Garbled addresses like `"4599 Mustang or Franklin Road"` were stored without validation

### Change
- **Retell LLM**: Added `service_address` + `customer_name` params to `service_area → discovery` edge; added `zip_code` param to `book_service` tool; updated state prompts to pass data through
- **Backend**: `server.ts` appends ZIP to stored address (e.g., "4210 South Lamar Blvd, 78745"); `customer-history.ts` filters out garbled addresses containing "or"

### Result
Return callers with clean stored address + ZIP will skip both `service_area` and `discovery` address collection. New bookings will store ZIP alongside address for future lookups.

## 2026-02-06 — v4 → v5 Persona Transformation

### Problem
The current persona sounds casual/slangy, which can reduce trust on voice calls and make the agent feel fake.

### Change
Full rewrite to "Calm HVAC Dispatcher" persona:
- Removed slang + fake thinking sounds.
- Tightened cadence and acknowledgments.
- Made service-area language truthful for 787-only testing.
- Preserved topology/tools/keys; changed prompts and messaging only.

### Result
Pending testing (see TEST-SCENARIOS.md).

## 2026-02-07 — v5 → v6 Pre-Booking Confirmation Fix

### Problem
Real call (call_7dec270d9d3a298ef74...172) revealed the agent books appointments without asking the caller to confirm. Caller explicitly said: "I didn't confirm that, though. We just kinda scheduled it. Without asking me." and hung up dissatisfied. Secondary issues: safety state was skipped entirely, service address not collected, states executed out of order.

### Change
Added `pre_confirm` state (8-state flow) between urgency and booking:
- Reads back collected info (name, issue, address, timing) to the caller.
- Requires explicit approval ("Sound right?") before proceeding to book.
- Handles corrections (re-confirm just the changed detail).
- Handles declined (offer callback, clean exit with no booking).

Additional fixes:
- Strengthened welcome state to never skip safety.
- Added service address collection to discovery state.
- Added explicit state flow order + booking confirmation protocol to general prompt.
- Renamed `scheduling` → `booking` with "caller has CONFIRMED" preamble.

### Result
LLM config updated but agent was NOT published — `is_published` remained false. Test call (call_00e8150948d1091c4fe17bb86a5) ran on Version 15 (old 5-state config). Fixed: published via API on 2026-02-07, now Version 18 (live).

## 2026-02-07 — Booking Time Mismatch Fix

### Problem
Test call (call_00e8150948d1091c4fe17bb86a5) revealed three backend issues:

1. **Time regex bug**: `parsePreferredTime("Monday, February 9 at 2:45 PM")` matched "45 pm" instead of "2:45 pm", producing `specificHour=45` (nonsensical). Fell through to first available slot (2:30 PM) instead of requested 2:45 PM. Cal.com booked 2:30 PM while agent told caller 2:45 PM.
2. **No day-unavailable context**: When caller asked for Saturday (no openings) and got Monday alternatives, the message said "That time's not available" with no explanation of why the entire day was skipped. Caller was confused and perceived the agent as giving "attitude."
3. **Execution message leak**: LLM-generated `execution_message` tool argument was spoken aloud ("Booking service for Gator Breath...") instead of the static config message. Caused by running on v15 without `tool_call_strict_mode`.

### Change
1. Fixed regex from `/(\d{1,2})\s*(am|pm)/i` to `/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i` — now captures minutes.
2. Added `specificMinute` to `parsePreferredTime` return. Slot matching now tries exact (hour+minute), then closest.
3. Added day-gap detection: when alternatives are on a different day than requested, message says "We don't have any [Day] openings. The next available day is [Day]."
4. Published v6 agent (Version 18) — `tool_call_strict_mode: true` prevents execution_message leak.

### Result
All four fixes applied. Dashboard route.ts updated (separate repo). Agent published as Version 18.

## 2026-02-07 — v6 → v7 UX Refinement (Experience Evaluation)

### Problem
Experience evaluation identified 7 UX issues degrading call quality:
1. **Dead air latency**: 2-3 second gaps between caller finishing and agent responding.
2. **EQ mismatch**: "Cheerful Corporate" tone clashes with frustrated/annoyed callers.
3. **"Got it" loop**: Agent prefixes almost every turn with "Got it" or "Sure, I can help with that."
4. **Fragile opening**: "Sorry I didn't catch that" triggers too quickly on silence.
5. **Jargon echoing**: Agent repeats caller's exact words verbatim ("Blowing warm air, got it!").
6. **Static personality**: No local context or adaptive behavior.
7. **Robotic hand-off**: When preferred time unavailable, no apology before offering alternatives.

### Change
Applied 9 changes across general prompt (4), state prompts (4), and agent settings (1):

**General Prompt:**
1. Acknowledgments → rotation rule with skip option (kills "Got it" loop).
2. Empathy → tone-matching system that mirrors caller energy level.
3. Active listening → semantic paraphrasing with concrete examples.
4. New "Bridge Phrases" section for dead-air reduction.

**State Prompts:**
5. Welcome — patience for silence, "Hey — you still there?" instead of "didn't catch that."
6. Service Area — local trust phrases for Austin ZIP codes ("we're over there a lot").
7. Discovery — paraphrase instructions replace verbatim echo.
8. Booking — apologize-first language for unavailable times.

**Agent Settings:**
9. Enabled `enable_backchannel: true` for platform-level active listening sounds.

States unchanged: safety, urgency, pre_confirm, confirm.

### Result
Published as Version 22. Phone bound to v23. Config: retell-llm-v7-ux-refined.json.

## 2026-02-07 — Echo/Self-Hearing Mitigation (Audio Tuning)

### Problem
Test call (call_aa8dfb8966ac09af0045e7b4ed5) revealed the agent heard its own greeting as caller speech. STT transcribed the agent's "Thanks for calling" as user input, causing the agent to respond to itself ("Sure thing. Are you calling about HVAC service today?"). Caller (who said nothing) heard nonsense and hung up. Root cause: echo cancellation failure at the telephony layer, amplified by overly aggressive interruption sensitivity (0.8) and maximum responsiveness (1.0).

### Change
Reduced audio sensitivity settings to give echo cancellation more time to filter:

**Agent-level:**
- `interruption_sensitivity`: 0.8 → 0.5
- `responsiveness`: 1.0 → 0.7
- `backchannel_frequency`: 0.8 → 0.6

**LLM state-level interruption_sensitivity:**
- `welcome`: 0.8 → 0.4 (most critical — echo happens during greeting)
- `follow_up`, `manage_booking`, `service_area`, `discovery`, `urgency`, `pre_confirm`: 0.8 → 0.6
- `lookup`: 0.6 → 0.5
- `booking`, `confirm`: 0.7 → 0.6
- `safety`: 0.3 → 0.3 (unchanged)

### Result
Published as Version 29. Phone bound to v30. Pending test call to verify echo no longer triggers.
