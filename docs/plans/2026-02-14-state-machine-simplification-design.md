# Voice Agent State Machine Simplification

**Date:** 2026-02-14
**Status:** Approved
**Approach:** Collapse 15-state agent to 10 states using structural enforcement principle

## Problem

The voice agent has grown from 8 to 15 states through 18 reactive patches in 5 days. Each patch fixes one LLM bypass but creates new surface area for the next. The whack-a-mole cycle stems from two root causes:

1. **Prompt-based guards have 0% success rate** — every rule added to prevent LLM misbehavior was ignored under context pressure (Patches #5, #6, #10, #13).
2. **Structural fixes have 100% success rate** — removing tools from states mechanically prevents the undesired behavior (Patches #7, #15, #18). None regressed.

The current 15-state machine has too many states, too many edges, and too many places where the LLM can take shortcuts. Five of the 15 states exist only as patches for bugs in other states.

## Design Principle

**States that make decisions have no tools. States that take actions have specific tools. Terminal states handle end_call.**

Every bug in the project history follows the same pattern: the LLM was in a decision-making state, saw a tool it could call, and took a shortcut. The fix every time was removing the tool. This redesign applies that principle uniformly.

## State Reduction: 15 → 10

### States Cut Entirely

| State | Why it existed | Replacement |
|-------|---------------|-------------|
| non_service | Billing, vendor, applicant routing | welcome routes directly to callback terminal |
| follow_up | Callback promise fulfillment | lookup routes to callback terminal |
| manage_booking | Reschedule/cancel existing | lookup routes to callback terminal |

These three states all end the same way: create a callback and end the call. One universal callback terminal replaces all of them.

### States Merged

| Old States | New State | Rationale |
|-----------|-----------|-----------|
| urgency + urgency_callback + pre_confirm | confirm | All three ask questions and route. One state: summarize, determine urgency, get consent, route to booking or callback. |
| booking_failed | callback | Booking failure is just another reason for a callback. Same terminal. |
| confirm (old terminal) | done | Renamed for clarity. |

## The 10-State Machine

```
DECISION states (no tools — edges only):
  safety       — safety screening, routes to service_area or safety_exit
  discovery    — collect problem + address + name, routes to confirm
  confirm      — summarize, triage urgency, get consent, routes to booking or callback

ACTION states (specific tools only):
  welcome      — entry point, routes to lookup or callback
  lookup       — lookup_caller tool, routes via edges based on result
  booking      — book_service tool ONLY (no end_call), routes to done or callback

TERMINAL states (end_call available):
  safety_exit  — 911 emergencies only (end_call)
  service_area — out-of-area rejection (end_call), otherwise routes to discovery
  done         — successful booking confirmation (end_call)
  callback     — universal exit: create_callback_request + send_sales_lead_alert + end_call
```

### Tool Assignments

| State | Tools | Edges To |
|-------|-------|----------|
| welcome | (none — routing only) | lookup, callback |
| lookup | lookup_caller | safety, callback |
| safety | (none) | service_area, safety_exit |
| safety_exit | end_call | — |
| service_area | end_call (out-of-area only) | discovery |
| discovery | (none) | confirm |
| confirm | (none) | booking, callback |
| booking | book_service | done, callback |
| done | end_call | — |
| callback | create_callback_request, send_sales_lead_alert, end_call | — |

### Structural Guarantees

- **booking has NO end_call** — agent cannot hang up after a failed booking. Must route to done or callback.
- **confirm has NO tools** — agent cannot skip ahead to booking or end the call. Must transition via edges.
- **discovery has NO tools** — same guarantee.
- **safety has NO tools** — proven in Patch #15.
- **ALL non-happy-path exits converge to ONE terminal: callback.** No scattered exit points.

## Call Flows

### New Caller — Happy Path (Demo Flow)

```
welcome → lookup → safety → service_area → discovery → confirm → booking → done
```

### Booking Failure

```
... → booking → callback (create_callback_request fires, SMS sent) → end_call
```

### Non-Service Caller (Vendor, Billing, Spam)

```
welcome → callback → end_call
```

### Returning Caller (Fast-Track)

```
welcome → lookup → safety → service_area* → discovery* → confirm → booking → done
```

*service_area auto-validates if ZIP known via edge params; discovery skips address if pre-filled.

### Safety Emergency

```
... → safety → safety_exit → end_call
```

### High-Ticket Sales Lead

```
... → confirm → callback (send_sales_lead_alert fires) → end_call
```

## Confirm State Design

The new `confirm` state replaces urgency + urgency_callback + pre_confirm. It has three responsibilities:

1. **Summarize** — repeat back problem, address, and caller name for verification
2. **Triage** — ask about timing preference (soonest available, specific day, just a callback)
3. **Route** — based on response:
   - "Yes, schedule me" → transition_to_booking
   - "Just call me back" → transition_to_callback
   - High-ticket signals (replacement, new system, quote) → transition_to_callback with sales lead alert

Edge parameters to booking: `confirmed: true, preferred_time: string`
Edge parameters to callback: `callback_type: string, reason: string`

## Backend Safety Net (Unchanged)

The PR #46 inference pattern stays as belt-and-suspenders:

- Infer callbackType when agent reaches callback terminal but doesn't call create_callback_request
- Fire SMS on inferred callback path
- Set booking_status from tool invocation detection (attempted_failed / not_requested / confirmed)
- Build scorecard for data completeness logging
- Generate card_summary and card_headline

The structural enforcement means the backend safety net should rarely trigger, but it remains for edge cases.

## Migration Plan

### Step 1: Quick Win (30 minutes)

Remove end_call from current booking state via Retell API PATCH. Fixes the immediate bug from call_398d540d6a48dd733499d81698d. Zero risk, proven pattern from Patches #7, #15, #18.

### Step 2: Build New Config (1 day)

Create `voice-agent/retell-llm-v10-simplified.json` as a NEW file. Build the 10-state machine from scratch using v9 config as reference. Do not edit the existing config — keep it as fallback.

Key changes vs v9:
- Remove 5 states (non_service, follow_up, manage_booking, urgency_callback, booking_failed)
- Merge urgency + pre_confirm into new confirm state
- Rename old confirm → done
- Update all edge connections
- Apply structural tool assignments per table above
- Carry over all WORDS TO AVOID rules, golden rules, backchannel settings

### Step 3: Test with 3 Scripted Calls (half day)

| Scenario | Tests | Success Criteria |
|----------|-------|-----------------|
| New caller → booking succeeds | Happy path end-to-end | Appointment appears on dashboard, SMS confirmation |
| New caller → booking fails → callback | Failure recovery | callback terminal entered, create_callback_request called, SMS to owner |
| Vendor/spam → callback | Short path | Agent politely declines, end_call from callback terminal |

Record all three calls. Best booking call becomes the demo recording.

### Step 4: Deploy and Monitor (half day)

- Push v10 config to Retell LLM via API
- Bind phone number to new version
- Make 2-3 additional test calls
- Verify dashboard shows correct data
- Verify SMS fires on callbacks
- If any failures: revert to v9 config (still available)

### Total Effort: ~2 days

## Success Criteria

| Metric | Before (v9, 15 states) | Target (v10, 10 states) |
|--------|----------------------|------------------------|
| State count | 15 | 10 |
| States with end_call that shouldn't | 3 (booking, discovery at times, others) | 0 |
| Decision states with tools | Multiple | 0 |
| Terminal states | 5 scattered | 4 clear (safety_exit, service_area, done, callback) |
| Demo booking success rate | ~60% (fails unpredictably) | >90% on scripted scenario |
| Patches needed per week | ~9 | Target <2 |

## Non-Goals

- No new features (no PM detection, no callback type flavoring in the simplified version)
- No backend decomposition (Phase 2 of stabilization plan can follow separately)
- No test automation (manual test calls are sufficient for MVP demo)
- No multi-tenant changes
