# Urgency State Fixes — Design Doc

**Date:** 2026-02-19
**Trigger:** Call CA76a150a stalled for 107s in URGENCY state, ended in callback
**Branch:** `rbaset5/pipecat-post-call`

## Problem

Call autopsy of CA76a150a revealed four bugs:

1. **"soonest available" not recognized as urgent.** The `urgent_signals` list has "as soon as" but not "soonest". The caller said "soonest available appointment" and fell through all signal checks.
2. **"the following day" not recognized as a time pattern.** The `time_patterns` list lacks "following" and "next day". The caller's preferred time fell through.
3. **No escape from URGENCY for rescheduling requests.** The caller (who had an existing appointment from lookup) asked to reschedule mid-service-flow. URGENCY has no tools and no transition to MANAGE_BOOKING or CALLBACK for this case. The LLM stalled for 43.8s then 63.2s.
4. **LLM surfaces appointment data in a state that can't act on it.** The prompt context includes appointment details in URGENCY. The LLM told the caller about their Thursday appointment, creating a rescheduling conversation the state machine couldn't service.

## Design Decision

**Compound requests (new service + appointment management) route to callback.** A human should handle multi-intent calls. The agent should not attempt to reschedule from URGENCY.

## Changes

### 1. Signal Gap Fixes — `state_machine.py`

Add "soonest" to `urgent_signals` in `_handle_urgency()`:

```python
urgent_signals = ["today", "asap", "right away", "as soon as", "emergency", "right now", "soonest"]
```

Add "following" and "next day" to `time_patterns`:

```python
time_patterns = [
    "tomorrow", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday", "morning", "afternoon", "evening",
    "following", "next day",
]
```

### 2. Reschedule Detection in URGENCY — `state_machine.py`

Add CALLBACK to URGENCY transitions:

```python
State.URGENCY: {State.PRE_CONFIRM, State.URGENCY_CALLBACK, State.CALLBACK},
```

Add reschedule detection at the top of `_handle_urgency()`, before urgency signal checks:

```python
# Compound request: caller wants to manage existing appointment mid-service-flow
if session.has_appointment:
    reschedule_signals = ["reschedule", "cancel", "move my appointment", "change my appointment"]
    if any(s in lower for s in reschedule_signals):
        _transition(session, State.CALLBACK)
        return Action(needs_llm=True)
```

Guard: only fires when `session.has_appointment` is True (set by lookup_caller result). No false positives for callers without appointments.

### 3. Suppress Appointment Context Past Discovery — `prompts.py`

In `_build_context()`, restrict appointment info to states where it's actionable:

```python
if session.has_appointment and session.state in (State.LOOKUP, State.FOLLOW_UP, State.MANAGE_BOOKING):
    appt = f"Caller has an existing appointment"
    if session.appointment_date:
        appt += f" on {session.appointment_date}"
    if session.appointment_time:
        appt += f" at {session.appointment_time}"
    parts.append(appt)
```

URGENCY, PRE_CONFIRM, BOOKING, and CONFIRM never see appointment context. The LLM won't mention an existing appointment in states that can't act on it.

### 4. Tests

New tests:
- `test_soonest_triggers_urgent` — "soonest available" → PRE_CONFIRM with urgency_tier "urgent"
- `test_following_day_triggers_time_pattern` — "the following day" → PRE_CONFIRM with preferred_time set
- `test_reschedule_in_urgency_routes_to_callback` — caller with appointment says "reschedule" in URGENCY → CALLBACK

Updated tests:
- Any test asserting `_build_context()` includes appointment info must account for the state filter.

## Files Modified

| File | Change |
|------|--------|
| `src/calllock/state_machine.py` | Signal lists, TRANSITIONS, `_handle_urgency()` |
| `src/calllock/prompts.py` | `_build_context()` appointment gating |
| `tests/test_state_machine.py` | Three new tests |
| `tests/test_prompts.py` | Update appointment context tests (if any) |

## What This Would Have Fixed in CA76a150a

With these changes, the call would have matched "soonest" at 68.8s → transitioned to PRE_CONFIRM → proceeded to BOOKING. The rescheduling conversation (85.9s–206.1s) would never have occurred. The 107s of stalling and two "Hello?" from the caller would have been eliminated.
