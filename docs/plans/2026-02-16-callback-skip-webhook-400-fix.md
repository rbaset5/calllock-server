# Callback Skip + Webhook 400 Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two production bugs — false callback escalation from leaked `state_turn_count` and dashboard webhook 400s from schema mismatches.

**Architecture:** Four targeted changes: (1) reset `state_turn_count` on every state transition, (2) debounce rapid STT transcription fragments in the processor, (3) map urgency at the payload boundary, (4) filter tool entries from transcript payloads.

**Tech Stack:** Python 3.13, pytest, pytest-asyncio, asyncio

---

## Task 1: State Machine — Reset `state_turn_count` on all transitions

**Files:**
- Modify: `pipecat-agent/src/calllock/state_machine.py:139-222`
- Test: `pipecat-agent/tests/test_state_machine.py`

### Step 1: Write failing tests

Add this class to `pipecat-agent/tests/test_state_machine.py`:

```python
class TestStateTurnCountReset:
    """state_turn_count must reset to 0 on every state transition."""

    def test_welcome_to_lookup_resets(self, sm, session):
        session.state_turn_count = 3
        sm.process(session, "my AC is broken")
        assert session.state == State.LOOKUP
        assert session.state_turn_count == 0

    def test_welcome_to_callback_resets(self, sm, session):
        session.state_turn_count = 3
        sm.process(session, "I have a billing question")
        assert session.state == State.CALLBACK
        assert session.state_turn_count == 0

    def test_safety_to_service_area_resets(self, sm, session):
        session.state = State.SAFETY
        session.state_turn_count = 4
        sm.process(session, "no")
        assert session.state == State.SERVICE_AREA
        assert session.state_turn_count == 0

    def test_safety_to_safety_exit_resets(self, sm, session):
        session.state = State.SAFETY
        session.state_turn_count = 3
        sm.process(session, "yes I smell gas")
        assert session.state == State.SAFETY_EXIT
        assert session.state_turn_count == 0

    def test_discovery_to_confirm_resets(self, sm, session):
        session.state = State.DISCOVERY
        session.state_turn_count = 4
        session.customer_name = "Jonas"
        session.problem_description = "AC broken"
        session.service_address = "123 Main St"
        sm.process(session, "")
        assert session.state == State.CONFIRM
        assert session.state_turn_count == 0

    def test_confirm_to_booking_resets(self, sm, session):
        session.state = State.CONFIRM
        session.state_turn_count = 3
        sm.process(session, "yes schedule me")
        assert session.state == State.BOOKING
        assert session.state_turn_count == 0

    def test_confirm_to_callback_resets(self, sm, session):
        session.state = State.CONFIRM
        session.state_turn_count = 3
        sm.process(session, "just have someone call me back")
        assert session.state == State.CALLBACK
        assert session.state_turn_count == 0

    def test_safety_fragments_dont_leak_into_service_area(self, sm, session):
        """Reproduces the actual bug from call CA2dbef953072c9722864a35abc3639b22.

        3 transcription fragments in SAFETY inflated state_turn_count to 4.
        After transition to SERVICE_AREA, 2 more turns pushed it to 6,
        exceeding MAX_TURNS_PER_STATE (5) and falsely escalating to CALLBACK.
        """
        # Simulate: enter SAFETY after lookup
        session.state = State.SAFETY
        session.state_turn_count = 0

        # 3 fragments from Deepgram STT
        sm.process(session, "Yeah.")
        sm.process(session, "Mhmm.")
        sm.process(session, "Yeah. It's a broken cover.")
        assert session.state == State.SAFETY  # still in SAFETY

        # Actual safety response
        sm.process(session, "No.")
        assert session.state == State.SERVICE_AREA
        assert session.state_turn_count == 0  # BUG: was 5 before fix

        # Two SERVICE_AREA turns should NOT trigger turn limit
        sm.process(session, "Combat Road")
        assert session.state == State.SERVICE_AREA

        sm.process(session, "seven eight seven zero one")
        assert session.state == State.DISCOVERY  # BUG: was CALLBACK before fix

    def test_turn_limit_still_fires_within_state(self, sm, session):
        """Turn limit must still work when turns accumulate in a single state."""
        session.state = State.SAFETY
        session.state_turn_count = 0

        # 6 turns in SAFETY (exceeds MAX_TURNS_PER_STATE=5)
        for _ in range(5):
            sm.process(session, "what do you mean?")
        assert session.state == State.SAFETY

        sm.process(session, "what?")
        assert session.state == State.CALLBACK  # turn limit fires
```

### Step 2: Run tests to verify they fail

Run: `cd pipecat-agent && python -m pytest tests/test_state_machine.py::TestStateTurnCountReset -v`

Expected: Multiple failures — `state_turn_count` is not 0 after transitions, and `test_safety_fragments_dont_leak_into_service_area` ends up in CALLBACK instead of DISCOVERY.

### Step 3: Fix state machine handlers

In `pipecat-agent/src/calllock/state_machine.py`, add `session.state_turn_count = 0` to each handler that transitions:

**`_handle_welcome` (line ~139):** Add `session.state_turn_count = 0` after both `session.state = State.CALLBACK` and before `return Action(call_tool="lookup_caller", ...)`.

```python
def _handle_welcome(self, session: CallSession, text: str) -> Action:
    intent = classify_intent(text)
    if intent == "non_service":
        session.state = State.CALLBACK
        session.state_turn_count = 0
        return Action(needs_llm=True)
    session.state = State.LOOKUP
    session.state_turn_count = 0
    return Action(call_tool="lookup_caller", needs_llm=False)
```

**`_handle_safety` (line ~150):**

```python
def _handle_safety(self, session: CallSession, text: str) -> Action:
    if detect_safety_emergency(text):
        session.state = State.SAFETY_EXIT
        session.state_turn_count = 0
        return Action(needs_llm=True)
    lower = text.lower()
    no_signals = ["no", "nope", "nah", "nothing like that", "we're fine", "all good"]
    if any(signal in lower for signal in no_signals):
        session.state = State.SERVICE_AREA
        session.state_turn_count = 0
        return Action(needs_llm=True)
    return Action(needs_llm=True)
```

**`_handle_discovery` (line ~191):**

```python
def _handle_discovery(self, session: CallSession, text: str) -> Action:
    session.customer_name = validate_name(session.customer_name)
    if all([session.customer_name, session.problem_description, session.service_address]):
        session.state = State.CONFIRM
        session.state_turn_count = 0
    return Action(needs_llm=True)
```

**`_handle_confirm` (line ~199):**

```python
def _handle_confirm(self, session: CallSession, text: str) -> Action:
    lower = text.lower()

    callback_signals = ["call me back", "callback", "just call", "have someone call"]
    if any(signal in lower for signal in callback_signals):
        session.state = State.CALLBACK
        session.state_turn_count = 0
        return Action(needs_llm=True)

    if detect_high_ticket(text):
        session.lead_type = "high_ticket"

    yes_signals = ["yes", "yeah", "yep", "sounds right", "sounds good", "schedule", "book"]
    if any(signal in lower for signal in yes_signals):
        session.caller_confirmed = True
        if session.lead_type == "high_ticket":
            session.state = State.CALLBACK
            session.state_turn_count = 0
            return Action(call_tool="send_sales_lead_alert", needs_llm=True)
        session.state = State.BOOKING
        session.state_turn_count = 0
        return Action(needs_llm=True)

    return Action(needs_llm=True)
```

### Step 4: Run tests to verify they pass

Run: `cd pipecat-agent && python -m pytest tests/test_state_machine.py -v`

Expected: ALL tests pass, including the new `TestStateTurnCountReset` class and all existing tests.

### Step 5: Commit

```bash
cd pipecat-agent
git add src/calllock/state_machine.py tests/test_state_machine.py
git commit -m "fix: reset state_turn_count on all state transitions

Prevents false callback escalation when Deepgram STT fragments a single
utterance into multiple TranscriptionFrames. The turn count was leaking
across state boundaries because 4 handlers didn't reset it on transition.

Fixes: call CA2dbef953072c9722864a35abc3639b22 skipping to callback"
```

---

## Task 2: Post-Call Urgency Mapping

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py`
- Test: `pipecat-agent/tests/test_post_call.py`

### Step 1: Write failing tests

Add to `pipecat-agent/tests/test_post_call.py`:

```python
class TestUrgencyMapping:
    def test_routine_maps_to_low(self, completed_session):
        completed_session.urgency_tier = "routine"
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert payload["urgency"] == "low"

    def test_low_stays_low(self, completed_session):
        completed_session.urgency_tier = "low"
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert payload["urgency"] == "low"

    def test_high_stays_high(self, completed_session):
        completed_session.urgency_tier = "high"
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert payload["urgency"] == "high"

    def test_emergency_stays_emergency(self, completed_session):
        completed_session.urgency_tier = "emergency"
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert payload["urgency"] == "emergency"

    def test_unknown_defaults_to_low(self, completed_session):
        completed_session.urgency_tier = "banana"
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert payload["urgency"] == "low"

    def test_empty_defaults_to_low(self, completed_session):
        completed_session.urgency_tier = ""
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert payload["urgency"] == "low"
```

### Step 2: Run tests to verify they fail

Run: `cd pipecat-agent && python -m pytest tests/test_post_call.py::TestUrgencyMapping -v`

Expected: `test_routine_maps_to_low` fails — urgency is `"routine"` not `"low"`.

### Step 3: Add urgency mapping to post_call.py

Add this function near the top of `pipecat-agent/src/calllock/post_call.py` (after the imports):

```python
# Dashboard expects: low | medium | high | emergency
# Pipecat internal: routine | low | medium | high | emergency
_URGENCY_MAP = {
    "routine": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "emergency": "emergency",
}

def _map_urgency(internal: str) -> str:
    """Map Pipecat internal urgency to dashboard enum."""
    return _URGENCY_MAP.get(internal, "low")
```

Then in `build_job_payload()`, change:

```python
"urgency": session.urgency_tier,
```

to:

```python
"urgency": _map_urgency(session.urgency_tier),
```

### Step 4: Run tests to verify they pass

Run: `cd pipecat-agent && python -m pytest tests/test_post_call.py -v`

Expected: ALL pass.

### Step 5: Commit

```bash
cd pipecat-agent
git add src/calllock/post_call.py tests/test_post_call.py
git commit -m "fix: map urgency 'routine' to 'low' for dashboard webhook

Dashboard Zod schema expects low|medium|high|emergency but Pipecat
session defaults to 'routine'. Map at the payload boundary."
```

---

## Task 3: Filter Tool Entries from Calls Transcript

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py`
- Test: `pipecat-agent/tests/test_post_call.py`

### Step 1: Write failing tests

Add to `pipecat-agent/tests/test_post_call.py`:

```python
class TestTranscriptFiltering:
    def test_calls_payload_excludes_tool_entries(self, completed_session):
        """Calls webhook schema only accepts role: agent|user."""
        payload = build_call_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        roles = {entry["role"] for entry in payload["transcript_object"]}
        assert "tool" not in roles
        assert roles <= {"agent", "user"}

    def test_calls_payload_preserves_agent_and_user(self, completed_session):
        payload = build_call_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert len(payload["transcript_object"]) == 3  # 2 agent + 1 user (tool filtered)
        assert payload["transcript_object"][0]["role"] == "agent"
        assert payload["transcript_object"][1]["role"] == "user"
        assert payload["transcript_object"][2]["role"] == "agent"

    def test_jobs_transcript_plain_text_includes_tools(self, completed_session):
        """Jobs uses plain text transcript which should still mention tools."""
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
        assert "[Tool:" in payload["call_transcript"]
```

### Step 2: Run tests to verify they fail

Run: `cd pipecat-agent && python -m pytest tests/test_post_call.py::TestTranscriptFiltering -v`

Expected: `test_calls_payload_excludes_tool_entries` fails — `"tool"` is in roles.

### Step 3: Filter tool entries in build_call_payload

In `pipecat-agent/src/calllock/post_call.py`, change `build_call_payload()`:

Replace:

```python
"transcript_object": to_json_array(session.transcript_log),
```

With:

```python
"transcript_object": [
    e for e in to_json_array(session.transcript_log)
    if e.get("role") in ("agent", "user")
],
```

### Step 4: Run tests to verify they pass

Run: `cd pipecat-agent && python -m pytest tests/test_post_call.py -v`

Expected: ALL pass.

### Step 5: Commit

```bash
cd pipecat-agent
git add src/calllock/post_call.py tests/test_post_call.py
git commit -m "fix: filter tool entries from calls webhook transcript

Dashboard callsWebhookSchema only accepts role: agent|user.
to_json_array() includes role: tool entries which caused 400s."
```

---

## Task 4: Guard `started_at` Empty String

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py`
- Test: `pipecat-agent/tests/test_post_call.py`

### Step 1: Write failing test

Add to `pipecat-agent/tests/test_post_call.py`:

```python
class TestDatetimeGuards:
    def test_started_at_never_empty_string(self):
        s = CallSession(phone_number="+15125551234")
        s.call_sid = "CA_test_zero"
        s.start_time = 0.0  # default / unset
        s.state = State.CALLBACK
        payload = build_call_payload(s, end_time=1015.0, user_email="o@t.com")
        assert payload["started_at"] != ""
        assert "T" in payload["started_at"]  # ISO format

    def test_ended_at_never_empty_string(self):
        s = CallSession(phone_number="+15125551234")
        s.call_sid = "CA_test_zero"
        s.start_time = 0.0
        s.state = State.CALLBACK
        payload = build_call_payload(s, end_time=0.0, user_email="o@t.com")
        assert payload["ended_at"] != ""
        assert "T" in payload["ended_at"]
```

### Step 2: Run tests to verify they fail

Run: `cd pipecat-agent && python -m pytest tests/test_post_call.py::TestDatetimeGuards -v`

Expected: `started_at` and `ended_at` are `""`, assertion fails.

### Step 3: Fix datetime fallback

In `pipecat-agent/src/calllock/post_call.py`, change `build_call_payload()`:

Replace:

```python
start_dt = datetime.fromtimestamp(session.start_time, tz=timezone.utc).isoformat() if session.start_time > 0 else ""
end_dt = datetime.fromtimestamp(end_time, tz=timezone.utc).isoformat() if end_time > 0 else ""
```

With:

```python
now_dt = datetime.now(timezone.utc).isoformat()
start_dt = datetime.fromtimestamp(session.start_time, tz=timezone.utc).isoformat() if session.start_time > 0 else now_dt
end_dt = datetime.fromtimestamp(end_time, tz=timezone.utc).isoformat() if end_time > 0 else now_dt
```

### Step 4: Run tests to verify they pass

Run: `cd pipecat-agent && python -m pytest tests/test_post_call.py -v`

Expected: ALL pass.

### Step 5: Commit

```bash
cd pipecat-agent
git add src/calllock/post_call.py tests/test_post_call.py
git commit -m "fix: guard started_at/ended_at from empty strings

Dashboard callsWebhookSchema requires z.string().datetime() — empty
strings fail validation. Fall back to current time if start_time is 0."
```

---

## Task 5: Transcription Debounce in Processor

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py`
- Create: `pipecat-agent/tests/test_processor.py`

### Step 1: Write failing tests

Create `pipecat-agent/tests/test_processor.py`:

```python
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from calllock.processor import StateMachineProcessor
from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.states import State

# Minimal mock for Pipecat frames
class FakeTranscriptionFrame:
    def __init__(self, text):
        self.text = text

class FakeTextFrame:
    def __init__(self, text):
        self.text = text


@pytest.fixture
def processor():
    session = CallSession(phone_number="+15125551234")
    machine = StateMachine()
    tools = AsyncMock()
    context = MagicMock()
    context.messages = [{"role": "system", "content": "test prompt"}]
    proc = StateMachineProcessor(
        session=session,
        machine=machine,
        tools=tools,
        context=context,
    )
    # Mock push_frame to capture output
    proc.push_frame = AsyncMock()
    # Mock _run_extraction to avoid LLM calls
    proc._run_extraction = AsyncMock()
    return proc


class TestTranscriptionDebounce:
    @pytest.mark.asyncio
    async def test_rapid_frames_coalesced(self, processor):
        """Frames arriving within 400ms should be coalesced into one turn."""
        processor._debounce_seconds = 0.05  # 50ms for fast tests

        from pipecat.processors.frame_processor import FrameDirection
        from pipecat.frames.frames import TranscriptionFrame

        # Send 3 rapid frames
        await processor.process_frame(TranscriptionFrame(text="Yeah.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await processor.process_frame(TranscriptionFrame(text="Mhmm.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await processor.process_frame(TranscriptionFrame(text="It's broken.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)

        # Wait for debounce to fire
        await asyncio.sleep(0.1)

        # State machine should have been called once, not three times
        assert processor.session.turn_count == 1

    @pytest.mark.asyncio
    async def test_slow_frames_processed_separately(self, processor):
        """Frames arriving >debounce apart should be separate turns."""
        processor._debounce_seconds = 0.05

        from pipecat.processors.frame_processor import FrameDirection
        from pipecat.frames.frames import TranscriptionFrame

        await processor.process_frame(TranscriptionFrame(text="Yeah.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.1)  # Wait for first debounce to fire

        await processor.process_frame(TranscriptionFrame(text="No.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.1)  # Wait for second debounce to fire

        assert processor.session.turn_count == 2

    @pytest.mark.asyncio
    async def test_coalesced_text_is_concatenated(self, processor):
        """Coalesced text should join fragments with space."""
        processor._debounce_seconds = 0.05

        from pipecat.processors.frame_processor import FrameDirection
        from pipecat.frames.frames import TranscriptionFrame

        await processor.process_frame(TranscriptionFrame(text="Yeah.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await processor.process_frame(TranscriptionFrame(text="It's broken.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)

        await asyncio.sleep(0.1)

        # Check the last user entry in conversation_history
        user_entries = [e for e in processor.session.conversation_history if e["role"] == "user"]
        assert len(user_entries) == 1
        assert "Yeah." in user_entries[0]["content"]
        assert "It's broken." in user_entries[0]["content"]
```

### Step 2: Run tests to verify they fail

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py -v`

Expected: FAIL — no debounce logic exists yet; each frame triggers `process()` independently.

### Step 3: Add debounce to processor

In `pipecat-agent/src/calllock/processor.py`, modify `StateMachineProcessor`:

Add to `__init__`:

```python
self._debounce_seconds = 0.4  # 400ms
self._debounce_task: asyncio.Task | None = None
self._debounce_buffer: list[str] = []
```

Replace the `TranscriptionFrame` handling in `process_frame`:

```python
if isinstance(frame, TranscriptionFrame) and frame.text.strip():
    self._debounce_buffer.append(frame.text.strip())
    if self._debounce_task and not self._debounce_task.done():
        self._debounce_task.cancel()
    self._debounce_task = asyncio.create_task(self._debounce_fire(frame))
```

Add a new method:

```python
async def _debounce_fire(self, original_frame: TranscriptionFrame):
    """Wait for debounce period, then process coalesced text."""
    await asyncio.sleep(self._debounce_seconds)
    text = " ".join(self._debounce_buffer)
    self._debounce_buffer.clear()
    # Create a synthetic frame with coalesced text
    coalesced = TranscriptionFrame(text=text, user_id=original_frame.user_id, timestamp=original_frame.timestamp)
    await self._handle_transcription(coalesced)
```

### Step 4: Run tests to verify they pass

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py -v`

Expected: ALL pass.

### Step 5: Run full test suite

Run: `cd pipecat-agent && python -m pytest tests/ -v`

Expected: ALL 166+ tests pass (existing + new).

### Step 6: Commit

```bash
cd pipecat-agent
git add src/calllock/processor.py tests/test_processor.py
git commit -m "feat: debounce rapid STT transcriptions into single turns

Coalesces TranscriptionFrames arriving within 400ms into one turn,
preventing inflated turn counts and redundant LLM/extraction calls
from Deepgram STT speech fragmentation."
```

---

## Task 6: Full Integration Verification

### Step 1: Run full test suite

Run: `cd pipecat-agent && python -m pytest tests/ -v --tb=short`

Expected: ALL tests pass. Count should be 166 + ~15 new = ~181 tests.

### Step 2: Verify no regressions in existing tests

Specifically check:
- `test_state_machine.py` — all existing transition tests still pass
- `test_post_call.py` — `test_has_required_fields` still passes (urgency is now "low" not "routine")

Note: The existing `test_has_required_fields` test does NOT assert `urgency` value, so it won't break. But the `test_includes_classification` test checks `payload["tags"]` which uses `urgency_tier` internally — verify classification still works with "routine" internally.

### Step 3: Commit all together if needed

If all green, no additional commit needed — each task already committed.

---

## Summary of Changes

| File | Change | Lines |
|------|--------|-------|
| `state_machine.py` | Add `state_turn_count = 0` to 4 handlers (8 locations) | ~8 |
| `processor.py` | Add debounce mechanism | ~20 |
| `post_call.py` | Urgency mapping + transcript filter + datetime guard | ~15 |
| `test_state_machine.py` | Turn count reset tests + regression test | ~60 |
| `test_post_call.py` | Urgency, transcript, datetime tests | ~45 |
| `test_processor.py` | Debounce tests (new file) | ~75 |

**Total:** ~45 lines of production code, ~180 lines of tests.
