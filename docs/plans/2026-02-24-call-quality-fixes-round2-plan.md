# Call Quality Fixes Round 2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 bugs found in production call CA446d...587e9: broken StartFrame filter, irrevocable call ending, 27s dead air gap, missing callback acknowledgment, latent em dash crash risk.

**Architecture:** All changes are in `pipecat-agent/src/calllock/`. State machine gets two behavioral changes (DISCOVERY canned urgency question, CONFIRM cancellable end). Processor gets cancellable delayed end + em dash sanitizer. Bot.py gets loguru filter. Prompts.py moves callback acknowledgment.

**Tech Stack:** Python 3.13, pipecat-ai, loguru, pytest, pytest-asyncio

---

### Task 1: Fix StartFrame noise filter (loguru)

**Files:**
- Modify: `pipecat-agent/src/calllock/bot.py:12-18`

**Context:** The current filter uses `logging.getLogger().addFilter()` (stdlib), but pipecat logs via loguru. The filter has zero effect. Loguru's `logger.remove()` + `logger.add(filter=...)` is the correct API.

**Step 1: Write the failing test**

No unit test needed — this is a logging configuration fix. The "test" is verifying loguru filter behavior inline.

**Step 2: Replace stdlib filter with loguru filter**

In `bot.py`, replace lines 12-18:

```python
# OLD (broken — targets stdlib, pipecat uses loguru):
# Suppress Pipecat "StartFrame not received" cosmetic noise that floods Fly.io log buffer.
# Uses a targeted filter (not setLevel) to preserve real frame processor errors.
class _StartFrameNoiseFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "StartFrame not received" not in record.getMessage()

logging.getLogger("pipecat.processors.frame_processor").addFilter(_StartFrameNoiseFilter())
```

```python
# NEW (targets loguru, which pipecat actually uses):
import sys
from loguru import logger as _loguru

def _startframe_noise_filter(record):
    """Suppress Pipecat 'StartFrame not received' cosmetic noise from Fly.io log buffer."""
    if record["name"] == "pipecat.processors.frame_processor":
        return "StartFrame not received" not in record["message"]
    return True

_loguru.remove()  # Remove default handler (ID 0)
_loguru.add(sys.stderr, filter=_startframe_noise_filter, level="DEBUG", format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}")
```

**Step 3: Run existing tests to verify no regression**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All tests pass (no change to business logic).

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/bot.py
git commit -m "fix: use loguru filter for StartFrame noise (pipecat uses loguru, not stdlib)"
```

---

### Task 2: DISCOVERY → URGENCY canned question (eliminate 27s gap)

**Files:**
- Modify: `pipecat-agent/src/calllock/state_machine.py:236-247`
- Test: `pipecat-agent/tests/test_state_machine.py`

**Context:** When DISCOVERY detects all fields collected, it transitions to URGENCY with canned "Got it." and `needs_llm=False`. The next user input triggers an LLM call in URGENCY, but the LLM wastes a turn generating a summary instead of asking the urgency question. Fix: combine "Got it." with the urgency question in one canned speak.

**Step 1: Write the failing test**

Add to `TestDiscoveryState` class in `test_state_machine.py`:

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
    assert "urgent" in action.speak.lower() or "today" in action.speak.lower()
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_state_machine.py::TestDiscoveryState::test_all_fields_collected_emits_urgency_question -v`
Expected: FAIL — current `action.speak` is just "Got it." which doesn't contain "urgent" or "today".

**Step 3: Update _handle_discovery**

In `state_machine.py`, change `_handle_discovery` (line 246):

```python
# OLD:
return Action(speak="Got it.", needs_llm=False)

# NEW:
return Action(
    speak="Got it. How urgent is this - need someone today, or this week works?",
    needs_llm=False,
)
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_state_machine.py::TestDiscoveryState::test_all_fields_collected_emits_urgency_question -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All tests pass. The existing `test_all_fields_routes_to_urgency` still passes (it only checks state, not speak).

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/state_machine.py pipecat-agent/tests/test_state_machine.py
git commit -m "fix: emit canned urgency question from DISCOVERY to eliminate 27s dead air gap"
```

---

### Task 3: Make _delayed_end_call cancellable (fix "1 more question")

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:44-63,159,228,250-253`
- Test: `pipecat-agent/tests/test_processor.py`

**Context:** `_delayed_end_call` creates a fire-and-forget asyncio task. If the user speaks again during the delay, nothing can cancel it. Fix: store the task handle; cancel it if a new transcription arrives; re-enter the state machine with the new input.

**Step 1: Write the failing test**

Add to `test_processor.py`:

```python
class TestCancellableDelayedEnd:
    """If user speaks again during delayed end, cancel the end and process new input."""

    @pytest.mark.asyncio
    async def test_new_transcription_cancels_delayed_end(self, processor):
        """Speech during goodbye delay should cancel the end and process the new input."""
        # Set up CONFIRM state, turn 2 (end_call=True, needs_llm=True)
        processor.session.state = State.CONFIRM
        processor.session.booking_confirmed = True
        processor.session.confirmation_message = "Appointment confirmed for Wednesday at 3 PM"
        # Simulate first turn
        processor.session.state_turn_count = 1
        processor.session.agent_has_responded = True

        # Process "No." — this triggers _delayed_end_call
        await processor.process_frame(
            TranscriptionFrame(text="No.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )

        # Verify delayed end task was created
        assert processor._end_call_task is not None
        assert not processor._end_call_task.done()

        # Now user speaks again before delay expires
        await processor.process_frame(
            TranscriptionFrame(text="Actually, how much is the diagnostic?", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )

        # The old delayed end should be cancelled
        assert processor._end_call_task is None or processor._end_call_task.cancelled()
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_processor.py::TestCancellableDelayedEnd::test_new_transcription_cancels_delayed_end -v`
Expected: FAIL — `processor._end_call_task` attribute doesn't exist.

**Step 3: Implement cancellable delayed end**

In `processor.py`:

3a. Add `_end_call_task` to `__init__` (after line 62):
```python
self._end_call_task: asyncio.Task | None = None
```

3b. Replace all `asyncio.create_task(self._delayed_end_call(...))` calls (lines 159, 228, 292) with:
```python
self._end_call_task = asyncio.create_task(self._delayed_end_call(delay=3.0))
```
(Keep the 4.0 delay on line 292 for terminal responses.)

3c. Add cancellation logic at the top of `_handle_transcription` (after line 172, before state machine call):
```python
# Cancel pending delayed end if user speaks again
if self._end_call_task and not self._end_call_task.done():
    self._end_call_task.cancel()
    self._end_call_task = None
    logger.info(f"[{self.session.state.value}] Cancelled delayed end — user spoke again")
```

3d. Update `_delayed_end_call` to clear the reference after firing (line 250-253):
```python
async def _delayed_end_call(self, delay: float = 3.0):
    """Push EndFrame after a delay to allow TTS to finish speaking."""
    await asyncio.sleep(delay)
    self._end_call_task = None
    await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_processor.py::TestCancellableDelayedEnd -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "fix: make _delayed_end_call cancellable so user can still speak during goodbye"
```

---

### Task 4: Move callback acknowledgment from SAFETY to URGENCY prompt

**Files:**
- Modify: `pipecat-agent/src/calllock/prompts.py:176-193,227-237`
- Test: `pipecat-agent/tests/test_prompts.py`

**Context:** SAFETY prompt says "acknowledge callback AFTER safety check" but the state machine transitions to SERVICE_AREA immediately after the user answers "No." The LLM never gets another SAFETY turn. URGENCY is the first LLM-generated state after the deterministic SERVICE_AREA/DISCOVERY flow.

**Step 1: Write the failing test**

Add to `test_prompts.py`:

```python
def test_urgency_prompt_includes_callback_acknowledgment(self):
    """URGENCY prompt should acknowledge pending callback promise."""
    session = CallSession(phone_number="+15125551234")
    session.state = State.URGENCY
    session.callback_promise = {"date": "today", "issue": "being really loud"}
    prompt = get_system_prompt(session)
    assert "callback" in prompt.lower()
    assert "being really loud" in prompt.lower() or "callback" in prompt.lower()
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_prompts.py::test_urgency_prompt_includes_callback_acknowledgment -v`
Expected: FAIL — URGENCY prompt doesn't mention callbacks. (Note: the callback data IS in KNOWN INFO via `_build_context`, but the URGENCY state prompt doesn't instruct the LLM to acknowledge it.)

Actually, looking at the code again — `_build_context` (line 98-99) already includes `"We owe this caller a callback: ..."` in KNOWN INFO for ALL states. So the data is present. The issue is the URGENCY prompt doesn't tell the LLM to acknowledge it. Let me refine:

```python
def test_urgency_prompt_instructs_callback_acknowledgment(self):
    """URGENCY state prompt text should tell LLM to acknowledge pending callback."""
    session = CallSession(phone_number="+15125551234")
    session.state = State.URGENCY
    session.callback_promise = {"date": "today", "issue": "being really loud"}
    prompt = get_system_prompt(session)
    # The STATE_PROMPTS[URGENCY] text (not just KNOWN INFO) should mention callback
    assert "callback" in STATE_PROMPTS[State.URGENCY].lower() or "owe" in STATE_PROMPTS[State.URGENCY].lower()
```

**Step 3: Update prompts**

3a. Remove callback acknowledgment section from SAFETY prompt (lines 191-193):
```python
# REMOVE from State.SAFETY prompt:
# CALLBACK ACKNOWLEDGMENT:
# If KNOWN INFO mentions we owe this caller a callback, briefly acknowledge it AFTER the safety check:
# "I also see we owe you a callback about [issue] - we'll make sure that gets handled too."
```

3b. Add callback acknowledgment to URGENCY prompt (line 237):
```python
State.URGENCY: """## URGENCY
Determine scheduling priority.

If KNOWN INFO mentions we owe this caller a callback, acknowledge it first:
"I also see we owe you a callback about [issue] - we'll make sure that gets handled too."
Then ask about urgency.

If timing is ALREADY CLEAR from what they said:
"ASAP" / "today" / "right away" -> urgent
"whenever" / "this week" / "no rush" / specific day -> routine

If timing is UNCLEAR:
"How urgent is this - more of a 'need someone today' situation, or 'sometime in the next few days' works?"

Do NOT say the time "works" or is "available" - you haven't checked the calendar yet.""",
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_prompts.py -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_prompts.py
git commit -m "fix: move callback acknowledgment from SAFETY to URGENCY prompt where LLM can deliver it"
```

---

### Task 5: Em dash sanitizer for LLM-generated TTS text

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:64-75`
- Test: `pipecat-agent/tests/test_processor.py`

**Context:** The LLM generates em dashes (`—`) in responses. Inworld TTS can crash with UTF-8 codec errors when em dashes land on streaming chunk boundaries. Fix: intercept all text going to TTS and replace em dashes with plain dashes.

**Step 1: Write the failing test**

Add to `test_processor.py`:

```python
class TestEmDashSanitizer:
    """Em dashes in LLM output should be replaced before reaching TTS."""

    @pytest.mark.asyncio
    async def test_em_dash_replaced_in_tts_speak_frame(self, processor):
        """TTSSpeakFrame text should have em dashes replaced with plain dashes."""
        from pipecat.frames.frames import TTSSpeakFrame

        processor.session.state = State.SAFETY
        # Simulate a transcription that triggers a canned speak with em dash
        # We test via process_frame pushing a TTSSpeakFrame through
        frames_pushed = []
        original_push = processor.push_frame

        async def capture_push(frame, direction=FrameDirection.DOWNSTREAM):
            frames_pushed.append(frame)
            # Don't actually push downstream

        processor.push_frame = capture_push

        # Process a transcription that would generate a response
        await processor.process_frame(
            TranscriptionFrame(text="no gas smell", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )

        # Check that any TTSSpeakFrame pushed has no em dashes
        for frame in frames_pushed:
            if isinstance(frame, TTSSpeakFrame):
                assert "\u2014" not in frame.text  # em dash
                assert "\u2013" not in frame.text  # en dash
```

**Step 2: Run test to verify current behavior**

Run: `cd pipecat-agent && pytest tests/test_processor.py::TestEmDashSanitizer -v`
Expected: May pass if no canned speaks have em dashes (they were already fixed). But the sanitizer protects against LLM-generated em dashes too.

**Step 3: Add sanitizer to process_frame**

In `processor.py`, add a helper method and modify `process_frame` to sanitize outbound text frames:

3a. Add helper (after `__init__`):
```python
@staticmethod
def _sanitize_tts_text(text: str) -> str:
    """Replace em/en dashes with plain dashes to prevent Inworld TTS UTF-8 chunk errors."""
    return text.replace("\u2014", "-").replace("\u2013", "-")
```

3b. Override `push_frame` to sanitize TTSSpeakFrame text before pushing:

Actually, the cleaner approach is to sanitize at the two points where we create TTSSpeakFrame:
- Line 202: `await self.push_frame(TTSSpeakFrame(text=action.speak), ...)`
- Line 276: `await self.push_frame(TTSSpeakFrame(text=reply), ...)`
- Line 285: `await self.push_frame(TTSSpeakFrame(text=canned), ...)`

Replace each `TTSSpeakFrame(text=X)` with `TTSSpeakFrame(text=self._sanitize_tts_text(X))`.

But we also need to catch LLM-generated text. The LLM output flows downstream as TextFrame through the context aggregator → LLM → TTS, bypassing this processor. So the sanitizer needs to be in the pipeline AFTER the LLM and BEFORE TTS.

Simpler approach: add a small `TextSanitizer` frame processor between LLM and TTS in the pipeline. Let's add it to `pipeline.py` instead.

**Revised approach — sanitize in pipeline.py:**

3c. Create a simple sanitizer processor. Add to `processor.py` (bottom of file):

```python
class TextSanitizer(FrameProcessor):
    """Replace em/en dashes in all text frames to prevent TTS UTF-8 errors."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TextFrame) and frame.text:
            frame = TextFrame(text=frame.text.replace("\u2014", "-").replace("\u2013", "-"))
        elif isinstance(frame, TTSSpeakFrame) and frame.text:
            frame = TTSSpeakFrame(text=frame.text.replace("\u2014", "-").replace("\u2013", "-"))
        await self.push_frame(frame, direction)
```

3d. Insert `TextSanitizer()` in the pipeline between LLM and TTS in `pipeline.py`. Find where the pipeline list is assembled and add it after the LLM output.

**Step 4: Run tests**

Run: `cd pipecat-agent && pytest tests/ -x -q`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/src/calllock/pipeline.py pipecat-agent/tests/test_processor.py
git commit -m "fix: sanitize em/en dashes before TTS to prevent UTF-8 chunk boundary crashes"
```

---

### Task 6: Final verification and deploy

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

- Call should acknowledge callback promise during urgency question
- DISCOVERY → URGENCY should be instant (canned question, no LLM delay)
- Saying "No" then speaking again should cancel the goodbye
- No em dash TTS crashes in logs
