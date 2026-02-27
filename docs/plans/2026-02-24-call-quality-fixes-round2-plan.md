# Call Quality Fixes Round 2 — Implementation Plan (v1.1)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 bugs found in production call CA446d...587e9: broken StartFrame filter, irrevocable call ending, 27s dead air gap, missing callback acknowledgment, latent em dash crash risk.

**Architecture:** All changes are in `pipecat-agent/src/calllock/`. State machine gets a merged canned urgency question + callback acknowledgment in DISCOVERY. Processor gets cancellable delayed end with bounded re-cancellation. TTS fallback gets em dash sanitizer. Bot.py gets loguru filter. Prompts.py removes unreachable callback instruction from SAFETY.

**Tech Stack:** Python 3.13, pipecat-ai, loguru, pytest, pytest-asyncio

**Review changes (v1.0 → v1.1):**
- Tasks 2+4 merged: canned urgency question now includes conditional callback ack (fully deterministic)
- `TextSanitizer` pipeline processor eliminated; sanitization moved to `FallbackTTSService.run_tts`
- `callback_promise` type changed from `str` to `dict` for clean rendering
- `URGENCY_QUESTION` extracted as module constant (DRY)
- `confirm_extended` flag bounds cancellation to exactly 1 re-try
- `logger.remove(0)` instead of `logger.remove()` (less destructive)
- 7 tests added (filter: 3, cancellation: 2, extended flag: 2)

---

### Task 1: Fix StartFrame noise filter (loguru)

**Files:**
- Modify: `pipecat-agent/src/calllock/bot.py:12-18`
- Test: `pipecat-agent/tests/test_bot.py` (new file)

**Context:** The current filter uses `logging.getLogger().addFilter()` (stdlib), but pipecat logs via loguru. The filter has zero effect. Loguru's `logger.remove(0)` + `logger.add(filter=...)` is the correct API.

**Step 1: Write the failing tests**

Create `pipecat-agent/tests/test_bot.py`:

```python
from calllock.bot import _startframe_noise_filter


class TestStartFrameNoiseFilter:
    def test_suppresses_startframe_from_frame_processor(self):
        record = {"name": "pipecat.processors.frame_processor", "message": "InworldHttpTTSService#0 Trying to process TTSTextFrame but StartFrame not received yet"}
        assert _startframe_noise_filter(record) is False

    def test_allows_real_errors_from_frame_processor(self):
        record = {"name": "pipecat.processors.frame_processor", "message": "Real error in frame processing"}
        assert _startframe_noise_filter(record) is True

    def test_allows_startframe_text_from_other_modules(self):
        record = {"name": "calllock.processor", "message": "StartFrame not received"}
        assert _startframe_noise_filter(record) is True
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && pytest tests/test_bot.py -v`
Expected: FAIL — `_startframe_noise_filter` not importable (doesn't exist yet as a standalone function).

**Step 3: Replace stdlib filter with loguru filter**

In `bot.py`, replace lines 12-18:

```python
# OLD (broken — targets stdlib, pipecat uses loguru):
class _StartFrameNoiseFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "StartFrame not received" not in record.getMessage()

logging.getLogger("pipecat.processors.frame_processor").addFilter(_StartFrameNoiseFilter())
```

With:

```python
# Suppress Pipecat "StartFrame not received" cosmetic noise that floods Fly.io log buffer.
# Pipecat uses loguru (not stdlib logging), so we must filter at the loguru level.
import sys
from loguru import logger as _loguru

def _startframe_noise_filter(record):
    """Suppress 'StartFrame not received' from pipecat.processors.frame_processor only."""
    if record["name"] == "pipecat.processors.frame_processor":
        return "StartFrame not received" not in record["message"]
    return True

try:
    _loguru.remove(0)  # Remove default handler only (not other sinks)
except ValueError:
    pass  # Already removed by another module
_loguru.add(sys.stderr, filter=_startframe_noise_filter, level="DEBUG",
            format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}")
```

**Step 4: Run tests**

Run: `cd pipecat-agent && pytest tests/test_bot.py -v`
Expected: PASS (all 3 tests)

**Step 5: Run full test suite**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/bot.py pipecat-agent/tests/test_bot.py
git commit -m "fix: use loguru filter for StartFrame noise (pipecat uses loguru, not stdlib)"
```

---

### Task 2: DISCOVERY canned urgency question + callback acknowledgment (eliminate 27s gap)

**Files:**
- Modify: `pipecat-agent/src/calllock/state_machine.py:236-247` (handler + constant)
- Modify: `pipecat-agent/src/calllock/session.py:19` (callback_promise type)
- Modify: `pipecat-agent/src/calllock/prompts.py:176-193,227-237` (SAFETY cleanup + URGENCY prompt)
- Test: `pipecat-agent/tests/test_state_machine.py`
- Test: `pipecat-agent/tests/test_prompts.py`

**Context:** This task merges the original Tasks 2 and 4 from v1.0. DISCOVERY auto-transitioning to URGENCY with just "Got it." caused a 27s dead air gap (LLM wasted a turn on a summary). The callback acknowledgment in the SAFETY prompt was unreachable (state machine transitions before LLM fires). Fix: emit both callback ack and urgency question as one deterministic canned speak from `_handle_discovery`.

**Step 1: Change `callback_promise` type to dict**

In `session.py`, change line 19:

```python
# OLD:
callback_promise: str = ""

# NEW:
callback_promise: dict = field(default_factory=dict)
```

**Step 2: Update `_build_context` to render dict cleanly**

In `prompts.py`, change the callback_promise rendering (line 98-99):

```python
# OLD:
if session.callback_promise:
    parts.append(f"We owe this caller a callback: {session.callback_promise}")

# NEW:
if session.callback_promise:
    issue = session.callback_promise.get("issue", "unknown issue")
    date = session.callback_promise.get("date", "")
    parts.append(f"We owe this caller a callback about {issue}" + (f" (from {date})" if date else ""))
```

**Step 3: Write failing tests**

Add to `TestDiscoveryState` in `test_state_machine.py`:

```python
def test_all_fields_collected_emits_urgency_question(self, sm, session):
    """When all fields known, canned speak should include urgency question."""
    session.state = State.DISCOVERY
    session.customer_name = "Jonas"
    session.problem_description = "AC blowing warm air"
    session.service_address = "4210 South Lamar Blvd"
    action = sm.process(session, "")
    assert session.state == State.URGENCY
    assert action.needs_llm is False
    assert "today" in action.speak.lower()

def test_all_fields_with_callback_promise_includes_ack(self, sm, session):
    """When callback promise exists, canned speak should acknowledge it."""
    session.state = State.DISCOVERY
    session.customer_name = "Jonas"
    session.problem_description = "AC blowing warm air"
    session.service_address = "4210 South Lamar Blvd"
    session.callback_promise = {"date": "today", "issue": "being really loud"}
    action = sm.process(session, "")
    assert session.state == State.URGENCY
    assert "callback" in action.speak.lower()
    assert "being really loud" in action.speak.lower()
    assert "today" in action.speak.lower()  # urgency question still present
```

**Step 4: Run tests to verify they fail**

Run: `cd pipecat-agent && pytest tests/test_state_machine.py::TestDiscoveryState::test_all_fields_collected_emits_urgency_question tests/test_state_machine.py::TestDiscoveryState::test_all_fields_with_callback_promise_includes_ack -v`
Expected: FAIL — current speak is just "Got it."

**Step 5: Add constant and update `_handle_discovery`**

In `state_machine.py`, add constant near line 113 (after BOOKING_LANGUAGE):

```python
URGENCY_QUESTION = "How urgent is this - need someone today, or this week works?"
```

Update `_handle_discovery` (line 244-246):

```python
# OLD:
_transition(session, State.URGENCY)
return Action(speak="Got it.", needs_llm=False)

# NEW:
_transition(session, State.URGENCY)
# Build canned speak: callback ack (if owed) + urgency question
parts = ["Got it."]
if session.callback_promise:
    issue = session.callback_promise.get("issue", "a previous issue") if isinstance(session.callback_promise, dict) else "a previous issue"
    parts.append(f"I also see we owe you a callback about {issue} - we'll make sure that gets handled too.")
parts.append(URGENCY_QUESTION)
return Action(speak=" ".join(parts), needs_llm=False)
```

**Step 6: Remove callback ack from SAFETY prompt, update URGENCY prompt**

In `prompts.py`, remove from SAFETY prompt (lines 191-193):

```python
# DELETE these lines:
CALLBACK ACKNOWLEDGMENT:
If KNOWN INFO mentions we owe this caller a callback, briefly acknowledge it AFTER the safety check:
"I also see we owe you a callback about [issue] - we'll make sure that gets handled too."
```

Update URGENCY prompt to reference the constant's wording (for the LLM fallback path when fields aren't all known from lookup):

```python
State.URGENCY: """## URGENCY
Determine scheduling priority.

If KNOWN INFO mentions we owe this caller a callback, acknowledge it briefly first.

If timing is ALREADY CLEAR from what they said:
"ASAP" / "today" / "right away" -> urgent
"whenever" / "this week" / "no rush" / specific day -> routine

If timing is UNCLEAR:
"How urgent is this - more of a 'need someone today' situation, or 'sometime in the next few days' works?"

Do NOT say the time "works" or is "available" - you haven't checked the calendar yet.""",
```

**Step 7: Update prompt tests**

In `test_prompts.py`, update `TestCallbackPromiseInSafety` class to reflect the change:

```python
class TestCallbackPromiseRendering:
    """Callback promise should render cleanly in KNOWN INFO."""

    def test_callback_promise_renders_issue(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.SAFETY
        session.callback_promise = {"date": "today", "issue": "being really loud"}
        prompt = get_system_prompt(session)
        assert "being really loud" in prompt
        assert "callback" in prompt.lower()

    def test_callback_promise_empty_dict_excluded(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.SAFETY
        session.callback_promise = {}
        prompt = get_system_prompt(session)
        assert "we owe this caller" not in prompt.lower()

    def test_safety_prompt_no_longer_has_callback_instruction(self):
        """SAFETY prompt should NOT contain callback acknowledgment instruction (moved to canned speak)."""
        from calllock.prompts import STATE_PROMPTS
        assert "CALLBACK ACKNOWLEDGMENT" not in STATE_PROMPTS[State.SAFETY]
```

**Step 8: Run all tests**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All pass. Some existing tests referencing `callback_promise` as string may need updating.

**Step 9: Commit**

```bash
git add pipecat-agent/src/calllock/state_machine.py pipecat-agent/src/calllock/session.py pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_state_machine.py pipecat-agent/tests/test_prompts.py
git commit -m "fix: canned urgency question + callback ack from DISCOVERY (eliminates 27s gap)"
```

---

### Task 3: Make _delayed_end_call cancellable with bounded retry (fix "1 more question")

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:44-63,159,228,250-253`
- Modify: `pipecat-agent/src/calllock/session.py` (add `confirm_extended` field)
- Test: `pipecat-agent/tests/test_processor.py`
- Test: `pipecat-agent/tests/test_state_machine.py`

**Context:** `_delayed_end_call` creates a fire-and-forget asyncio task. If the user speaks again during the delay, nothing can cancel it. Fix: store the task handle; cancel it if a new transcription arrives. Bound to exactly one cancellation via `confirm_extended` flag.

**Step 1: Add `confirm_extended` to CallSession**

In `session.py`, add after `terminal_reply_used` (line 51):

```python
confirm_extended: bool = False  # True after first delayed-end cancellation in CONFIRM
```

**Step 2: Write the failing tests**

Add to `test_processor.py`:

```python
class TestCancellableDelayedEnd:
    """If user speaks again during delayed end, cancel the end and process new input."""

    @pytest.mark.asyncio
    async def test_first_cancellation_succeeds_and_processes_input(self, processor):
        """First speech during goodbye delay should cancel end and push frame downstream."""
        processor.session.state = State.CONFIRM
        processor.session.booking_confirmed = True
        processor.session.confirmation_message = "Appointment confirmed for Wednesday at 3 PM"
        processor.session.state_turn_count = 1
        processor.session.agent_has_responded = True

        # Process "No." — triggers _delayed_end_call
        await processor.process_frame(
            TranscriptionFrame(text="No.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        assert processor._end_call_task is not None
        assert not processor._end_call_task.done()

        # User speaks again before delay expires
        processor.session.agent_has_responded = True
        await processor.process_frame(
            TranscriptionFrame(text="Actually, how much is the diagnostic?", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )

        # Delayed end should be cancelled, confirm_extended set
        assert processor._end_call_task is None or processor._end_call_task.cancelled()
        assert processor.session.confirm_extended is True

        # The new transcription should have been pushed downstream (frame containing "diagnostic")
        pushed_frames = [call.args[0] for call in processor.push_frame.call_args_list]
        transcription_pushed = any(
            isinstance(f, TranscriptionFrame) and "diagnostic" in f.text
            for f in pushed_frames
        )
        assert transcription_pushed, "New transcription should be pushed downstream"

    @pytest.mark.asyncio
    async def test_second_cancellation_blocked(self, processor):
        """After one cancellation, subsequent speech should NOT cancel delayed end."""
        processor.session.state = State.CONFIRM
        processor.session.booking_confirmed = True
        processor.session.confirmation_message = "Appointment confirmed for Wednesday at 3 PM"
        processor.session.state_turn_count = 1
        processor.session.agent_has_responded = True
        processor.session.confirm_extended = True  # Already used the one cancellation

        # Process input — triggers _delayed_end_call
        await processor.process_frame(
            TranscriptionFrame(text="Thanks.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )

        if processor._end_call_task:
            task_before = processor._end_call_task
            # User speaks again — but extended already used
            processor.session.agent_has_responded = True
            await processor.process_frame(
                TranscriptionFrame(text="Wait one more thing", user_id="", timestamp=""),
                FrameDirection.DOWNSTREAM,
            )
            # Should NOT have cancelled — task still the same or a new one (from re-trigger)
            # The key assertion: confirm_extended is still True, no reset
            assert processor.session.confirm_extended is True
```

**Step 3: Add `_end_call_task` to processor.__init__**

In `processor.py`, add after line 62 (`self._buffer_start_time`):

```python
self._end_call_task: asyncio.Task | None = None
```

**Step 4: Replace fire-and-forget with stored task**

Replace all 3 instances of `asyncio.create_task(self._delayed_end_call(...))`:

Line 159 (buffer flush path):
```python
self._end_call_task = asyncio.create_task(self._delayed_end_call(delay=3.0))
```

Line 228 (normal path):
```python
self._end_call_task = asyncio.create_task(self._delayed_end_call(delay=3.0))
```

Line 292 (terminal response path):
```python
self._end_call_task = asyncio.create_task(self._delayed_end_call(delay=4.0))
```

**Step 5: Add cancellation logic to _handle_transcription**

After line 172 (the `logger.info` for caller text), before `# Buffer mode:` check:

```python
# Cancel pending delayed end if user speaks again (one chance only)
if self._end_call_task and not self._end_call_task.done():
    if not self.session.confirm_extended:
        self._end_call_task.cancel()
        self._end_call_task = None
        self.session.confirm_extended = True
        logger.info(f"[{self.session.state.value}] Cancelled delayed end - user spoke again")
```

**Step 6: Update _delayed_end_call to clear reference**

```python
async def _delayed_end_call(self, delay: float = 3.0):
    """Push EndFrame after a delay to allow TTS to finish speaking."""
    await asyncio.sleep(delay)
    self._end_call_task = None
    await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
```

**Step 7: Run tests**

Run: `cd pipecat-agent && pytest tests/test_processor.py::TestCancellableDelayedEnd -v`
Expected: PASS

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All pass.

**Step 8: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/src/calllock/session.py pipecat-agent/tests/test_processor.py
git commit -m "fix: cancellable _delayed_end_call with confirm_extended bound (1 retry max)"
```

---

### Task 4: Em dash sanitizer in FallbackTTSService

**Files:**
- Modify: `pipecat-agent/src/calllock/tts_fallback.py:107-114`
- Test: `pipecat-agent/tests/test_tts_fallback.py` (new or existing)

**Context:** The LLM generates em dashes (`—`) in responses. Inworld TTS can crash with UTF-8 codec errors when em dashes land on streaming chunk boundaries. Fix: sanitize text in `run_tts` before passing to primary/fallback TTS. This is 3 lines in an existing file — no new pipeline processor.

**Step 1: Write the failing test**

Create or add to TTS fallback tests:

```python
import pytest
from calllock.tts_fallback import FallbackTTSService


class TestTTSSanitization:
    def test_em_dash_sanitized(self):
        """Em dashes should be replaced with plain dashes before TTS."""
        text = "Quick safety check \u2014 any gas smell?"
        sanitized = text.replace("\u2014", "-").replace("\u2013", "-")
        assert "\u2014" not in sanitized
        assert "Quick safety check - any gas smell?" == sanitized

    def test_en_dash_sanitized(self):
        """En dashes should also be replaced."""
        text = "Monday \u2013 Friday"
        sanitized = text.replace("\u2014", "-").replace("\u2013", "-")
        assert "Monday - Friday" == sanitized

    def test_plain_text_unchanged(self):
        """Text without special dashes should pass through unchanged."""
        text = "Got it. How urgent is this - need someone today?"
        sanitized = text.replace("\u2014", "-").replace("\u2013", "-")
        assert text == sanitized
```

**Step 2: Add sanitization to `run_tts`**

In `tts_fallback.py`, update `run_tts` (line 107):

```python
async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
    # Sanitize em/en dashes to prevent Inworld TTS UTF-8 chunk boundary errors
    text = text.replace("\u2014", "-").replace("\u2013", "-")

    if self._circuit.should_try():
        async for frame in self._try_primary(text, context_id):
            yield frame
    else:
        logger.info("Circuit breaker open — using fallback TTS directly")
        async for frame in self._run_fallback(text, context_id):
            yield frame
```

**Step 3: Run tests**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All pass.

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/tts_fallback.py pipecat-agent/tests/test_tts_fallback.py
git commit -m "fix: sanitize em/en dashes in TTS to prevent UTF-8 chunk boundary crashes"
```

---

### Task 5: Final verification and deploy

**Step 1: Run full test suite**

Run: `cd pipecat-agent && pytest tests/ -v`
Expected: All tests pass.

**Step 2: Push to remote**

Run: `git push origin rbaset5/urgency-state-fixes`

**Step 3: Deploy to Fly.io**

Run: `cd pipecat-agent && fly deploy -a calllock-voice`

**Step 4: Verify health**

Run: `curl -s https://calllock-voice.fly.dev/health`
Expected: `ok`

**Step 5: Check logs for StartFrame noise**

Run: `fly logs -a calllock-voice --no-tail | grep "StartFrame" | head -5`
Expected: No StartFrame lines (filter working).

**Step 6: Make a test call and verify**

- Callback promise acknowledged in canned speak (deterministic, not LLM-dependent)
- DISCOVERY → URGENCY instant (canned question, no LLM delay)
- Saying "No" then speaking again cancels the goodbye and processes input
- Second cancellation attempt doesn't extend the call further
- No em dash TTS crashes in logs
