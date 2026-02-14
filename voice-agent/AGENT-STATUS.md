# AGENT STATUS

- Version: v9-triage (15-state) — deployed Feb 12 2026 (Patch #18)
- Previous: v9-triage Patch #17
- Agent ID: agent_4fb753a447e714064e71fadc6d
- LLM ID: llm_4621893c9db9478b431a418dc2b6
- Retell Phone Number Version: 78 (bound to +13126463816)
- Retell Published Version: 78
- Agent Name: CallSeal - 8 State v6
- Deployment status: LIVE — Patch #18: Urgency state split (structural booking-skip fix). 15 states.
- Backchannel: Enabled (frequency 0.6)
- Interruption Sensitivity: 0.5 (agent-level), per-state overrides below
- Responsiveness: 0.7 (reduced from 1.0 to mitigate echo)
- LESSON: Phone number was pinned to version 15. Publishing new versions does NOT update the phone binding. Must update via PATCH /update-phone-number.
- Config file: retell-llm-v9-triage.json

## Feb 12 Patch #18 — Urgency State Split (Structural Booking-Skip Fix)

Call `call_f363ef11dc899c050ced367ec03` (Jonas, 56s) — Patch #17 fixed lead_type misclassification but agent STILL skipped booking. Agent called end_call from urgency without determining timing, without attempting booking, and without calling create_callback_request (violating Rule 16). Prompt-based guards failed again.

### Root Cause:
end_call tool available in urgency state. LLM preferred end_call over the transition edge to pre_confirm. Same class of bug as Patches #5-#7, #10, #13 — prompt-based guards have 0% success rate for this pattern.

### Structural Fix:
- **Removed ALL tools from urgency state** — LLM can only route via edges (same pattern as Patch #7)
- **Added urgency_callback state** (15th state, terminal) — has end_call, create_callback_request, send_sales_lead_alert
- **Urgency now pure triage** — determine timing, route to pre_confirm (default) or urgency_callback (callbacks only)

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM (via API PATCH, 15 states)
- [ ] Test call needed: "broken thermostat" should reach booking
- [ ] Test call needed: "I need a new AC" should reach urgency_callback
- [ ] Test call needed: "just call me back" should reach urgency_callback

## Feb 12 Patch #17 — Booking Skip Prevention + Sentiment Fix

Call `call_80b30d25205a5a3b479a173cd7c` revealed voice agent incorrectly classified "broken thermostat cover" as `high_ticket`, skipping booking flow and forcing a sales callback. Also discovered `sentiment_score` always null due to case sensitivity.

### Root Cause (Agent):
Discovery state set `lead_type="high_ticket"` for "broken thermostat cover" — a simple repair, not a replacement. This triggered the urgency state's sales lead path (Rule 14), which calls `create_callback_request` instead of transitioning to `pre_confirm` → `booking`.

### Voice Agent Changes:
1. **Discovery state prompt**: Added explicit negative examples for high-ticket detection — "broken", "not working", "cover", "noise", "leak" are REPAIR indicators, not replacement signals.
2. **Urgency state prompt**: Added VALIDATION guardrail — before taking the sales lead path, verify `problem_description` actually describes replacement/new equipment, not a repair.
3. **Discovery → urgency edge**: Tightened `lead_type` parameter description with concrete examples ("broken thermostat = '', I need a new AC = high_ticket") and default-to-empty instruction.

### V2 Backend Changes:
4. **`mapSentimentToScore()`**: Now calls `.toLowerCase()` before matching. Retell sends "Negative" (title case), function expected "negative" (lowercase).
5. **`user_sentiment` type**: Widened from `"positive" | "neutral" | "negative"` to `string` for API resilience.

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM (via API PATCH)
- [x] V2 backend merged to main (PR #18) — Render deploying
- [ ] Test call needed: "broken thermostat" should proceed to booking
- [ ] Test call needed: "new AC system" should route to sales callback
- [ ] Verify sentiment_score populated on next call

## Feb 12 Patch #16 — 5 UX Fixes from Call Analysis

Call `call_5822a97bfc9c162cc7121ddc68e` (Jonas, 2m41s) — Patches #15/#15c confirmed working (zero transition narration, no premature ending, safety question asked). But revealed 5 new UX issues:

### Issues Fixed:

1. **Time mismatch** — Agent said "Locking in your 7:30 AM" then "You're all set for 8:00 AM" without acknowledging the change. Cal.com snapped to closest slot.
   - **Fix:** Booking state now requires GENERIC execution_message (no specific time). Strengthened time-mismatch comparison rule — agent MUST acknowledge any time difference.

2. **Existing appointment silently cancelled** — Jonas had 11:30 AM appointment. Backend `cancelExistingBookings()` silently cancelled it before booking 8:00 AM. Customer unaware.
   - **Fix:** Backend now checks for same-date existing bookings BEFORE cancelling. Returns `existing_appointment` data with warning. Voice agent asks caller to choose: reschedule or add second visit. `force_book` parameter bypasses check when caller confirms second visit.

3. **Double confirmation** — LLM called `transition_to_discovery` (backward) from pre_confirm instead of `transition_to_booking` (forward), causing a second pass through discovery → urgency → pre_confirm with a re-confirmation question.
   - **Fix:** Added CRITICAL ROUTING RULE to pre_confirm: after YES, ONLY → [booking]. Explicitly prohibits backward transitions.

4. **12-second dead air** — Symptom of #3. Backward state flow created silent gap during transitions. Resolved by Fix #3.

5. **Fabricated ZIP "787"** — LLM hallucinated partial ZIP from service_area rule "ZIP must start with 787". No ZIP in customer record.
   - **Fix:** Lookup state now explicitly prohibits ZIP fabrication. Service_area state validates ZIP is exactly 5 digits before accepting.

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM (14 states)
- [ ] Dashboard deploy needed for duplicate booking backend guard (calllock-dashboard book-service route)
- [ ] Test call needed to verify all 5 fixes

## Feb 12 Patch #15c — Complete Transition Word Purge + Local File Sync

Call `call_4974ca9b729f1448f311aec587c` (Jonas, 2m47s) — Patch #15 structural fix confirmed working (full flow, safety question asked, booking time match). BUT agent said "Transitioning now" 4 times — the LLM was narrating its instruction text.

**Root cause:** State prompts and edge descriptions contained ~45 instances of "Transition to [state]" and "Transition immediately". LLM read these aloud as "Transitioning now". WORDS TO AVOID rule was ignored (same pattern as end_call — prompt-based guards don't work).

**Fix (Patches #15b + #15c):**
- Replaced all "Transition to [state]" → "→ [state]" in state prompts (43 instances)
- Replaced all "Transition immediately" → "Proceed immediately" in edge descriptions (~15 instances)
- Replaced instructional uses: "TRANSITION to next state" → "PROCEED", "transition speech" → "greeting", etc.
- Strengthened WORDS TO AVOID: "NEVER say the word 'transition' or 'transitioning' in any form"
- **Final count: 0 LLM-readable "transition" instances** (only API keys `speak_during_transition` and the WORDS TO AVOID rule remain)
- **Synced local file** from deployed Retell config — local file was out of sync after previous undo

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM (14 states)
- [ ] Render deploy pending for backend address fixes
- [ ] Test call needed to verify transition narration is resolved

## Feb 11 Patch #15 — Structural Safety Fix (Remove end_call from Safety State)

Call `call_5e604543b07b26757cf5cc5f9fa` (Jonas, 37s) — agent saw existing appointment + callback and called `end_call` from safety state without asking the safety question. 3rd recurrence of premature ending bug despite Rules 15, 16, and prompt guards.

**Root cause:** `end_call` tool is physically available in the safety state. Prompt-based guards don't work — LLM ignores them when context is rich (appointment + callback + multiple recent calls).

**Structural fix:**
- **Removed `end_call` tool from safety state entirely** — LLM physically cannot end calls from this state
- **Added `safety_emergency` state** (14th state) — terminal state with end_call, only reachable via transition from safety after confirmed 911 emergency
- **Added safety → safety_emergency edge** for confirmed gas/burning/smoke/CO emergencies
- **Updated safety prompt** — "CONFIRMED YES" now transitions to [safety_emergency] instead of calling end_call directly

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM (14 states)
- [ ] Render deploy pending for backend address fixes

## Feb 11 Patch #14 — Required Edge Parameters + Booking Time Mismatch Guard

Call `call_60cc805bd6fbbe58bdc0aa329ee` (Jonas, return caller, 2m28s) revealed 2 remaining issues:

### Root cause analysis:
1. **Address/ZIP still re-asked despite v78 fix** — Edge parameters for `zip_code`, `service_address`, and `customer_name` were optional (not `required`). GPT-4o silently omitted them during transitions, so service_area and discovery received empty values and re-asked.
2. **Booking time mismatch not flagged** — Agent confirmed "5:00 PM" with caller, but Cal.com booked 3:45 PM (nearest available). Agent read the response verbatim without flagging the 1h15m discrepancy. Caller may not have noticed.

### Voice Agent Changes:
- **lookup state prompt**: Moved pre-fill instruction to prominent position right after Step 2, with explicit field mapping (`address` → `service_address`, `zipCode` → `zip_code`, `customerName` → `customer_name`). Old buried instruction replaced with brief reminder.
- **lookup → safety edge**: Made `zip_code`, `service_address`, `customer_name` required (was only `caller_known`).
- **safety → service_area edge**: Made `zip_code`, `service_address` required (was only `safety_clear`).
- **service_area → discovery edge**: Made `service_address`, `customer_name` required (was only `zip_code`).
- **booking state prompt**: Added time mismatch sub-case — if `booked: true` but time differs from pre_confirm, agent flags discrepancy and asks caller to re-confirm before transitioning.

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM
- [x] Patch #14 verified: LLM populates required params ✅ but data gap in backend

### Patch #14b — Backend Address Fallback + Sentinel Value Fix

Test call `call_17edd4681fb16a8cbe9d8bcc780` confirmed Patch #14 config changes work (LLM populates required params) but `service_address: "Not provided"` because backend has no clean address for Jonas.

**Root cause:** Older jobs have garbled addresses filtered by "or" filter. Most recent booking not yet in Supabase. LLM used "Not provided" instead of empty string.

### Changes:
- **customer-history.ts**: Added "Not provided" to address filter; added fallback to extract address from upcoming appointment job records
- **lookup state prompt**: Explicitly prohibit "Not provided", "N/A", "unknown" — only empty string for missing values
- **discovery state prompt**: Added "Not provided" to sentinel value list

### Deploy Status:
- [x] Voice agent config deployed to Retell LLM
- [ ] V2 backend needs manual deploy to Render
- [ ] Test call needed to verify

## Feb 11 Patch #13 (v78) — Return Caller Data Leak, Duplicate Speech, Premature End Call

Call `call_11881293afaa632e4028fa256a4` (Jonas, return caller) revealed 3 issues:

### Root cause analysis:
1. **Data lost at service_area → discovery** — Edge only passed `zip_code`; `service_address` and `customer_name` were dropped, causing the agent to re-ask for address and ZIP despite being a known caller.
2. **"Let me move this forward" spoken aloud** — Process-narrating phrase not on the WORDS TO AVOID blocklist. GPT-4o generated it as filler during transitions.
3. **Premature end_call in urgency** — Agent called `end_call` instead of transitioning to `pre_confirm`, skipping the entire booking flow. No `create_callback_request` was called first.

### Voice Agent Changes:
- **service_area → discovery edge**: Added `service_address` and `customer_name` parameters so return caller data flows through the transition.
- **service_area state_prompt**: Added "Data Passthrough" section instructing agent to carry through `service_address` and `customer_name` silently.
- **general_prompt WORDS TO AVOID**: Added "Let me move this forward", "Moving this forward", "Let me move forward", "Let me handle this", "Let me process this" and a rule against process-narrating filler phrases.
- **general_prompt Rule 16**: URGENCY END_CALL GUARD — `end_call` in urgency may ONLY be called AFTER `create_callback_request` has returned. Otherwise, the ONLY exit is the transition edge to `[pre_confirm]`.
- **urgency end_call description**: Updated to require `create_callback_request` as a PREREQUISITE. Explicitly PROHIBITS `end_call` for scheduling flows.
- **urgency state_prompt**: Added SCHEDULING FLOW FIREWALL — if caller wants to schedule, the ONLY valid exit is the transition edge to `[pre_confirm]`.

### Deploy Status:
- [x] Voice agent v78 deployed to Retell
- [x] Phone number re-bound to v78

## Feb 11 Patch #12 (v76) — Return Caller Fixes (Transition Leak, Premature Ending, Garbled Address)

Call `call_b7454c272786915f31c6399378f` (Jonas, 44s) revealed 3 issues with return caller handling.

### Root cause analysis:
1. **"Transitioning now" spoken aloud** — GPT-4o interpreted state prompt instructions ("Transition to [safety]") as speech, generating "Transitioning now" during `speak_during_transition`. Happened at lookup→safety and safety→service_area edges.
2. **Premature call ending** — Agent reached service_area, saw Jonas had an existing appointment (Wed Feb 11 @ 3:15 PM), and called end_call with "you're all set" instead of asking what he actually needed. Violated end_call's own restriction (ZIP-out-of-area only) and Rule 11 (BOOKING FIREWALL).
3. **Garbled address** — Lookup returned `"4599 Mustang or Franklin Road"` from jobs table — ambiguous address stored from a previous call without validation.

### Voice Agent Changes:
- **general_prompt WORDS TO AVOID**: Added "NEVER say 'Transitioning now', 'Transitioning', 'Let me transition', or any internal process language."
- **general_prompt Rule 15**: "EXISTING APPOINTMENT ≠ CALLER HANDLED" — having an upcoming appointment does NOT mean the caller's needs are met. ALWAYS continue the flow.
- **service_area end_call description**: Added "NEVER end the call because the caller has an existing appointment — that is NOT a valid reason to end."
- **service_area → discovery edge**: Added `service_address` and `customer_name` parameters so return caller data stops getting dropped at handoff.
- **service_area state prompt**: Added pass-through instruction for `{{service_address}}` and `{{customer_name}}` when transitioning.
- **book_service tool**: Added `zip_code` parameter so ZIP is captured at booking time.
- **booking state prompt**: Added `zip_code` to the list of values passed to `book_service`.

### V2 Backend Changes:
- **customer-history.ts**: Address validation filter — skip addresses containing word "or" (ambiguous alternatives from AI). Agent will ask fresh instead of using garbled data.
- **server.ts**: Post-call extraction appends `zip_code` from `book_service` args to stored address (e.g., "4210 South Lamar Blvd, 78745") so future lookups can extract ZIP.

### Deploy Status:
- [x] Voice agent v76 deployed to Retell
- [x] Phone number re-bound to v76
- [ ] V2 backend deployed to Render (for address + ZIP fix)

## v9 Triage Release (v71) — 5-Feature Upgrade (Feb 11 2026)

Major release adding 5 features across 3 tiers. 13 states (up from 11).

### Feature 1: High-Ticket Sales Lead Detection
- Discovery state detects replacement/quote/estimate keywords → sets `lead_type="high_ticket"`
- Urgency state routes high-ticket leads to comfort advisor callback (NEVER books diagnostic)
- `send_sales_lead_alert` tool added to urgency state for immediate SMS to owner
- Backend: `send_sales_lead_alert` handler now sets `endCallReason = "sales_lead"` for proper dashboard status

### Feature 2: Ghost Lead Recovery (Backend Only)
- `extractStateFromPostCallData()` mines transcript for caller name ("my name is X")
- Ghost lead logging: abandoned calls (user_hangup + no booking + >10s) are explicitly logged
- Existing pipeline already creates RED priority leads for abandoned calls — no voice agent changes needed

### Feature 3: Early Intent Triage
- **New state: `non_service`** — handles billing/warranty, vendors, job applicants, pricing inquiries
- Welcome state expanded with non-service intent detection (billing, vendor, applicant, pricing keywords)
- New edge: welcome → non_service (skips safety/service_area/discovery entirely)
- Billing/warranty → create_callback_request → end_call (no safety question)
- Vendors → polite decline → end_call
- Job applicants → email redirect → end_call
- Pricing → $89 diagnostic answer + offer to schedule → safety (if yes) / end_call (if no)

### Feature 4: Callback Type Flavoring
- `callback_type` parameter added to `create_callback_request` tool in non_service, urgency, follow_up states
- Values: billing, warranty, estimate, service, follow_up, general
- Backend: SMS formatted as "BILLING callback: ..." instead of generic "Callback requested: ..."
- Dashboard: maps to `call_subtype` field (already exists)

### Feature 5: Property Manager / Landlord Logic
- Discovery state detects PM/landlord language → asks "Will you be at the property?"
- Captures `site_contact_name` and `site_contact_phone` for on-site coordination
- Booking state appends site contact to issue_description
- Backend: `isThirdParty` detection from transcript, new ConversationState fields
- Dashboard: `site_contact_name/phone` passed through to leads/jobs tables

### Backend Changes (V2 — requires Render deploy)
- `server.ts`: sales_lead endCallReason, transcript name mining, ghost lead logging, callback_type, PM detection
- `types/retell.ts`: callbackType, siteContact*, isThirdParty fields on ConversationState
- `dashboard.ts`: site_contact_name/phone, is_third_party, third_party_type in payload

### Dashboard Changes (requires Vercel deploy)
- `webhook-schemas.ts`: site_contact_name, site_contact_phone added
- `webhook/jobs/route.ts`: passes site contact fields through at all 4 insert/update points
- Migration `0030_site_contact_fields.sql`: adds columns to leads and jobs tables

### Deploy Status
- [x] Voice agent v9 deployed to Retell (v71)
- [x] Phone number re-bound to v71
- [ ] V2 backend deployed to Render
- [ ] Dashboard deployed to Vercel
- [ ] DB migration 0030 applied

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

## State Flow (v9 — 15 states)

### All 15 states:
```
1. welcome          — Greet, detect intent (service / non-service / existing customer)
2. non_service      — Billing, vendor, applicant, pricing (terminal or → safety)
3. lookup           — Auto-lookup caller by phone (lookup_caller tool)
4. follow_up        — Callback promise fulfillment (create_callback_request + end_call)
5. manage_booking   — Reschedule/cancel/status check (manage_appointment + end_call)
6. safety           — Safety screening (no tools — edges only)
7. safety_emergency — Terminal: confirmed 911 emergency (end_call only)
8. service_area     — ZIP validation (end_call for out-of-area)
9. discovery        — Collect problem, address, name (no tools — edges only)
10. urgency         — Triage timing/priority (no tools — edges only)
11. urgency_callback — Terminal: callbacks + sales leads (create_callback_request, send_sales_lead_alert, end_call)
12. pre_confirm     — Summarize and confirm before booking (no tools — edges only)
13. booking         — Execute booking (book_service tool)
14. booking_failed  — Terminal: booking fallback (create_callback_request + end_call)
15. confirm         — Terminal: appointment confirmed (end_call only)
```

### New caller / new issue:
```
welcome → lookup → safety → service_area → discovery → urgency → pre_confirm → booking → confirm
```

### Non-service caller (billing, vendor, applicant, pricing):
```
welcome → non_service → (callback or end_call)
welcome → non_service → safety (if pricing caller says "yes, schedule me")
```

### High-ticket sales lead (replacement/quote/estimate):
```
welcome → lookup → safety → service_area → discovery → urgency → urgency_callback → end_call
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

### Safety emergency:
```
(any state with safety edge) → safety → safety_emergency → end_call
```

### Booking failure:
```
booking → booking_failed → (callback or end_call)
```

## Testing Status (v9 — 15 states)

| # | State | Type | Status |
|---|---|---|---|
| 1 | welcome | Modified (new intents) | Untested |
| 2 | non_service | NEW (v9) | Untested |
| 3 | lookup | Core | Untested |
| 4 | follow_up | Modified (callback_type) | Untested |
| 5 | manage_booking | Core | Untested |
| 6 | safety | Structural (no tools, Patch #15) | Untested |
| 7 | safety_emergency | NEW (Patch #15) | Untested |
| 8 | service_area | Core | Untested |
| 9 | discovery | Modified (high-ticket + PM) | Untested |
| 10 | urgency | Structural (no tools, Patch #18) | Untested |
| 11 | urgency_callback | NEW (Patch #18) | Untested |
| 12 | pre_confirm | Core | Untested |
| 13 | booking | Modified (site contact) | Untested |
| 14 | booking_failed | Core | Untested |
| 15 | confirm | Core | Untested |

## New Tools

| Tool | Endpoint | Purpose |
|------|----------|---------|
| lookup_caller | V2: /webhook/retell/lookup_caller | Auto-lookup caller by phone at call start |
| manage_appointment | V2: /webhook/retell/manage_appointment | Reschedule, cancel, or status check |

## Test Scenarios (v9)

### v9 New Scenarios
1. Billing caller → "I have a billing question" → callback with type=billing, NO safety question
2. Vendor caller → "I'm a parts supplier" → polite decline, end_call
3. Job applicant → "Are you hiring?" → email redirect, end_call
4. Pricing inquiry → "How much do you charge?" → $89 answer + offer to schedule
5. Pricing → schedule → "yes" → transitions to safety (normal booking flow)
6. High-ticket lead → "I want a whole new AC system" → comfort advisor callback, NOT diagnostic
7. High-ticket pushback → caller insists on diagnostic → still callback ("you really want our comfort advisor")
8. Property manager → "I'm a PM, tenant's AC is out" → asked about site contact → captures name/phone
9. PM at property → "I'll be there" → proceeds normally, is_third_party=false

### Returning Caller Scenarios (v8, must still pass)
10. Known caller + new issue → name confirmed, ZIP/address skipped
11. Known caller + follow-up → history acknowledged, callback offered
12. Known caller + booking management → appointment found, reschedule/cancel works
13. Known caller + intent switch → start booking mgmt, add new issue mid-call

### Core Scenarios (must still pass)
14. New caller: full flow works unchanged
15. Safety emergency: 911 flow
16. Out of area: ZIP rejection
17. Booking: full booking + pre_confirm flow

### Edge Cases
18. Lookup times out → graceful fallback to normal flow
19. Caller says "my appointment" but has none → offer to schedule
20. Caller has callback promise but wants to book instead → transition to safety
21. Ambiguous intent (could be billing or service) → defaults to service (lookup)

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
