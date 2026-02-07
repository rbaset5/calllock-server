# OPTIMIZATION LOG

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
