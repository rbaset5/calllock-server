# Urgency State Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix four bugs found in call CA76a150a where the URGENCY state stalled for 107s due to missing signal keywords and a rescheduling dead-end.

**Architecture:** Add missing keywords to urgency signal lists, detect reschedule requests in URGENCY and route to CALLBACK, suppress appointment context from prompts in states that can't act on it.

**Tech Stack:** Python, pytest, CallLock pipecat-agent state machine

**Design doc:** `docs/plans/2026-02-19-urgency-state-fixes-design.md`

---

### Task 1: Add "soonest" to urgent signals (TDD)

**Files:**
- Modify: `tests/test_state_machine.py` (TestUrgencyState class, around line 286)
- Modify: `src/calllock/state_machine.py:252` (urgent_signals list)

**Step 1: Write the failing test**

Add to `TestUrgencyState` class in `tests/test_state_machine.py`:

```python
def test_soonest_triggers_urgent(self, sm, session):
    session.state = State.URGENCY
    action = sm.process(session, "I was looking for the soonest available appointment")
    assert session.urgency_tier == "urgent"
    assert session.state == State.PRE_CONFIRM
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/test_state_machine.py::TestUrgencyState::test_soonest_triggers_urgent -v`
Expected: FAIL — session stays in URGENCY because "soonest" isn't recognized.

**Step 3: Add "soonest" to urgent_signals**

In `src/calllock/state_machine.py`, `_handle_urgency()` method, line 252:

```python
# Before:
urgent_signals = ["today", "asap", "right away", "as soon as", "emergency", "right now"]

# After:
urgent_signals = ["today", "asap", "right away", "as soon as", "emergency", "right now", "soonest"]
```

**Step 4: Run test to verify it passes**

Run: `pytest tests/test_state_machine.py::TestUrgencyState::test_soonest_triggers_urgent -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/test_state_machine.py src/calllock/state_machine.py
git commit -m "fix: add 'soonest' to urgency signal detection"
```

---

### Task 2: Add "following day" / "next day" to time patterns (TDD)

**Files:**
- Modify: `tests/test_state_machine.py` (TestUrgencyState class)
- Modify: `src/calllock/state_machine.py:268` (time_patterns list)

**Step 1: Write the failing test**

Add to `TestUrgencyState` class in `tests/test_state_machine.py`:

```python
def test_following_day_triggers_time_pattern(self, sm, session):
    session.state = State.URGENCY
    action = sm.process(session, "the following day, same time")
    assert session.urgency_tier == "routine"
    assert session.preferred_time == "the following day, same time"
    assert session.state == State.PRE_CONFIRM

def test_next_day_triggers_time_pattern(self, sm, session):
    session.state = State.URGENCY
    action = sm.process(session, "next day would be fine")
    assert session.urgency_tier == "routine"
    assert session.state == State.PRE_CONFIRM
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_state_machine.py::TestUrgencyState::test_following_day_triggers_time_pattern tests/test_state_machine.py::TestUrgencyState::test_next_day_triggers_time_pattern -v`
Expected: FAIL — "following" and "next day" aren't in time_patterns.

**Step 3: Add keywords to time_patterns**

In `src/calllock/state_machine.py`, `_handle_urgency()` method, line 268:

```python
# Before:
time_patterns = [
    "tomorrow", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday", "morning", "afternoon", "evening",
]

# After:
time_patterns = [
    "tomorrow", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday", "morning", "afternoon", "evening",
    "following", "next day",
]
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_state_machine.py::TestUrgencyState -v`
Expected: All URGENCY tests pass including the two new ones.

**Step 5: Commit**

```bash
git add tests/test_state_machine.py src/calllock/state_machine.py
git commit -m "fix: add 'following day' and 'next day' to time pattern detection"
```

---

### Task 3: Detect reschedule in URGENCY → route to CALLBACK (TDD)

**Files:**
- Modify: `tests/test_state_machine.py` (TestUrgencyState class)
- Modify: `src/calllock/state_machine.py:33` (TRANSITIONS) and `_handle_urgency()` method

**Step 1: Write the failing test**

Add to `TestUrgencyState` class in `tests/test_state_machine.py`:

```python
def test_reschedule_with_appointment_routes_to_callback(self, sm, session):
    session.state = State.URGENCY
    session.has_appointment = True
    action = sm.process(session, "Can I reschedule for something later?")
    assert session.state == State.CALLBACK

def test_reschedule_without_appointment_stays_in_urgency(self, sm, session):
    """No false positive: 'reschedule' without an existing appointment should not trigger."""
    session.state = State.URGENCY
    session.has_appointment = False
    action = sm.process(session, "Can I reschedule for something later?")
    assert session.state == State.URGENCY  # no appointment, no redirect
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_state_machine.py::TestUrgencyState::test_reschedule_with_appointment_routes_to_callback tests/test_state_machine.py::TestUrgencyState::test_reschedule_without_appointment_stays_in_urgency -v`
Expected: First test FAILS (no transition to CALLBACK from URGENCY). Second test may PASS already.

**Step 3: Add CALLBACK to URGENCY transitions and add detection logic**

In `src/calllock/state_machine.py`, update TRANSITIONS (line 43):

```python
# Before:
State.URGENCY: {State.PRE_CONFIRM, State.URGENCY_CALLBACK},

# After:
State.URGENCY: {State.PRE_CONFIRM, State.URGENCY_CALLBACK, State.CALLBACK},
```

In `_handle_urgency()`, add reschedule detection after `lower = text.lower()` and before the callback request check (around line 240):

```python
def _handle_urgency(self, session: CallSession, text: str) -> Action:
    lower = text.lower()

    # Compound request: caller wants to manage existing appointment mid-service-flow
    if session.has_appointment:
        reschedule_signals = ["reschedule", "cancel my", "move my appointment", "change my appointment"]
        if any(s in lower for s in reschedule_signals):
            _transition(session, State.CALLBACK)
            return Action(needs_llm=True)

    # Check for explicit callback request (existing code continues below)
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_state_machine.py::TestUrgencyState -v`
Expected: All URGENCY tests pass.

**Step 5: Run full test suite for regressions**

Run: `pytest tests/ -v`
Expected: All tests pass. Check that the structural test `test_transitions_are_valid` still passes with the new CALLBACK transition.

**Step 6: Commit**

```bash
git add tests/test_state_machine.py src/calllock/state_machine.py
git commit -m "fix: detect reschedule requests in URGENCY and route to callback"
```

---

### Task 4: Suppress appointment context in URGENCY prompt (TDD)

**Files:**
- Modify: `tests/test_prompts.py`
- Modify: `src/calllock/prompts.py:60-67` (`_build_context()`)

**Step 1: Write the failing test**

Add to `tests/test_prompts.py`:

```python
def test_appointment_info_hidden_in_urgency():
    session = CallSession(phone_number="+15125551234")
    session.state = State.URGENCY
    session.has_appointment = True
    session.appointment_date = "2026-02-20"
    session.appointment_time = "10:00 AM"
    prompt = get_system_prompt(session)
    assert "2026-02-20" not in prompt
    assert "10:00 AM" not in prompt


def test_appointment_info_hidden_in_pre_confirm():
    session = CallSession(phone_number="+15125551234")
    session.state = State.PRE_CONFIRM
    session.has_appointment = True
    session.appointment_date = "2026-02-20"
    session.appointment_time = "10:00 AM"
    prompt = get_system_prompt(session)
    assert "2026-02-20" not in prompt
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_prompts.py::test_appointment_info_hidden_in_urgency tests/test_prompts.py::test_appointment_info_hidden_in_pre_confirm -v`
Expected: FAIL — appointment info currently appears in all states.

**Step 3: Gate appointment context in `_build_context()`**

In `src/calllock/prompts.py`, modify the appointment block in `_build_context()` (around line 60):

```python
# Before:
if session.has_appointment:
    appt = f"Caller has an existing appointment"
    if session.appointment_date:
        appt += f" on {session.appointment_date}"
    if session.appointment_time:
        appt += f" at {session.appointment_time}"
    parts.append(appt)

# After:
if session.has_appointment and session.state in (
    State.LOOKUP, State.FOLLOW_UP, State.MANAGE_BOOKING, State.CALLBACK,
):
    appt = f"Caller has an existing appointment"
    if session.appointment_date:
        appt += f" on {session.appointment_date}"
    if session.appointment_time:
        appt += f" at {session.appointment_time}"
    parts.append(appt)
```

Note: Include `State.CALLBACK` in the allowed list so the callback handler can mention the appointment when wrapping up (the CALLBACK prompt says "If caller has existing appointment, mention it").

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_prompts.py -v`
Expected: All prompt tests pass — including the existing `test_prompt_includes_appointment_info` (which uses State.MANAGE_BOOKING, still in the allow list).

**Step 5: Run full test suite**

Run: `pytest tests/ -v`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add tests/test_prompts.py src/calllock/prompts.py
git commit -m "fix: suppress appointment context in states that cannot act on it"
```

---

### Task 5: Regression test for call CA76a150a scenario

**Files:**
- Modify: `tests/test_state_machine.py`

**Step 1: Write the regression test**

Add a new test class at the end of `tests/test_state_machine.py`:

```python
class TestRegressionCA76a150a:
    """Regression test for call CA76a150a: caller says 'soonest available'
    then asks to reschedule existing appointment in URGENCY state."""

    def test_soonest_available_reaches_pre_confirm(self, sm, session):
        """The primary fix: 'soonest available' should route to PRE_CONFIRM
        instead of leaving the caller stuck in URGENCY."""
        session.state = State.URGENCY
        sm.process(session, "I was looking for the soonest available appointment")
        assert session.state == State.PRE_CONFIRM
        assert session.urgency_tier == "urgent"

    def test_reschedule_after_urgency_prompt_routes_to_callback(self, sm, session):
        """Secondary fix: if the agent mentions the appointment and the caller
        asks to reschedule, route to CALLBACK immediately."""
        session.state = State.URGENCY
        session.has_appointment = True
        session.appointment_date = "2026-02-19"
        session.appointment_time = "3:45 PM"
        sm.process(session, "Can I reschedule for something later?")
        assert session.state == State.CALLBACK
```

**Step 2: Run regression tests**

Run: `pytest tests/test_state_machine.py::TestRegressionCA76a150a -v`
Expected: PASS (both tests should already pass from Tasks 1 and 3).

**Step 3: Run full suite one final time**

Run: `pytest tests/ -v`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add tests/test_state_machine.py
git commit -m "test: regression test for call CA76a150a urgency state stall"
```
