# Post-Tool Debounce Buffer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After a tool call transitions state (force_llm=True), buffer incoming transcription fragments for 1.5s before triggering the LLM, so the caller finishes their thought before the agent responds.

**Architecture:** Add buffer mode to `StateMachineProcessor`. When `force_llm=True`, enter buffer mode: accumulate transcription texts, reset a 1.5s debounce timer on each new fragment, flush concatenated text to LLM when timer fires. Everything else (state machine, extraction, transcript logging) runs normally during buffering. End-call actions bypass the buffer.

**Tech Stack:** Python asyncio (timers via `asyncio.create_task` + `asyncio.sleep`), Pipecat `TranscriptionFrame`.

---

### Task 1: Write failing tests for buffer mode entry and flush

**Files:**
- Modify: `pipecat-agent/tests/test_processor.py`

**Step 1: Write the failing tests**

Add a new test class `TestPostToolDebounce` at the end of the file:

```python
class TestPostToolDebounce:
    """After tool transitions (force_llm), buffer fragments before triggering LLM."""

    @pytest.mark.asyncio
    async def test_force_llm_enters_buffer_mode(self, processor):
        """After WELCOME→LOOKUP→SAFETY, processor should NOT push immediately."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Should NOT have pushed TranscriptionFrame yet (buffering)
        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" not in pushed_types, (
            f"TranscriptionFrame pushed immediately — should be buffered. Got: {pushed_types}"
        )
        assert processor._buffer_mode is True

    @pytest.mark.asyncio
    async def test_buffer_flushes_after_debounce(self, processor):
        """After debounce timeout, buffered text should be pushed to LLM."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Wait for debounce to fire
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" in pushed_types, (
            f"TranscriptionFrame not pushed after debounce. Got: {pushed_types}"
        )
        assert processor._buffer_mode is False

    @pytest.mark.asyncio
    async def test_buffer_accumulates_fragments(self, processor):
        """Multiple fragments during buffer mode should be concatenated on flush."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        # First fragment triggers WELCOME→LOOKUP→SAFETY (enters buffer mode)
        f1 = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(f1)

        # Second fragment arrives during buffer mode (in SAFETY state)
        f2 = TranscriptionFrame(text="it's blowing warm air", user_id="u1", timestamp="t1")
        await processor._handle_transcription(f2)

        # Wait for debounce
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        # Find the pushed TranscriptionFrame and check concatenated text
        pushed_frames = [c.args[0] for c in processor.push_frame.call_args_list]
        transcription_frames = [f for f in pushed_frames if isinstance(f, TranscriptionFrame)]
        assert len(transcription_frames) == 1
        assert "my AC is broken" in transcription_frames[0].text
        assert "blowing warm air" in transcription_frames[0].text
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolDebounce -v`
Expected: FAIL — `_buffer_mode` attribute does not exist.

**Step 3: Commit test stubs**

```bash
git add pipecat-agent/tests/test_processor.py
git commit -m "test: failing tests for post-tool debounce buffer mode"
```

---

### Task 2: Implement buffer mode in processor

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py`

**Step 1: Add buffer state to `__init__`**

After `self._context_capture_idx = 1`, add:

```python
# Post-tool debounce buffer: accumulate fragments after tool transitions
# before triggering LLM, so the caller finishes their thought first.
self._buffer_mode = False
self._buffer_texts: list[str] = []
self._buffer_timer: asyncio.Task | None = None
self._buffer_frame: TranscriptionFrame | None = None
self._buffer_start_time: float = 0.0
BUFFER_DEBOUNCE_S = 1.5  # Wait this long after last fragment
BUFFER_MAX_S = 5.0       # Maximum total buffer time
```

Move `BUFFER_DEBOUNCE_S` and `BUFFER_MAX_S` to class-level constants:

```python
class StateMachineProcessor(FrameProcessor):
    BUFFER_DEBOUNCE_S = 1.5
    BUFFER_MAX_S = 5.0
```

**Step 2: Add `_start_buffer`, `_reset_buffer_timer`, `_flush_buffer`, `_cancel_buffer` methods**

```python
def _start_buffer(self, text: str, frame: TranscriptionFrame):
    """Enter buffer mode after a tool transition."""
    self._buffer_mode = True
    self._buffer_texts = [text]
    self._buffer_frame = frame
    self._buffer_start_time = time.time()
    self._reset_buffer_timer()

def _reset_buffer_timer(self):
    """Reset the debounce timer."""
    if self._buffer_timer and not self._buffer_timer.done():
        self._buffer_timer.cancel()
    self._buffer_timer = asyncio.create_task(self._buffer_debounce_wait())

async def _buffer_debounce_wait(self):
    """Wait for debounce period, then flush."""
    await asyncio.sleep(self.BUFFER_DEBOUNCE_S)
    await self._flush_buffer()

async def _flush_buffer(self):
    """Push accumulated fragments to LLM as one concatenated message."""
    if not self._buffer_mode:
        return
    self._buffer_mode = False
    combined_text = " ".join(self._buffer_texts)
    combined_frame = TranscriptionFrame(
        text=combined_text,
        user_id=self._buffer_frame.user_id if self._buffer_frame else "",
        timestamp=self._buffer_frame.timestamp if self._buffer_frame else "",
    )
    logger.info(
        f"[{self.session.state.value}] Buffer flush: {len(self._buffer_texts)} fragments → "
        f"'{combined_text[:80]}...'" if len(combined_text) > 80 else
        f"[{self.session.state.value}] Buffer flush: {len(self._buffer_texts)} fragments → "
        f"'{combined_text}'"
    )
    self._buffer_texts = []
    self._buffer_frame = None
    if self._buffer_timer and not self._buffer_timer.done():
        self._buffer_timer.cancel()
    self._buffer_timer = None
    await self.push_frame(combined_frame, FrameDirection.DOWNSTREAM)

def _cancel_buffer(self):
    """Cancel buffer without flushing (used before end_call)."""
    self._buffer_mode = False
    self._buffer_texts = []
    self._buffer_frame = None
    if self._buffer_timer and not self._buffer_timer.done():
        self._buffer_timer.cancel()
    self._buffer_timer = None
```

**Step 3: Modify `_handle_transcription` to use buffer mode**

Replace the section starting at line 121 (`# Speak canned message...`) through the end of the method with:

```python
        # Speak canned message immediately (e.g., "One moment" before a slow tool call)
        if action.speak:
            await self.push_frame(TTSSpeakFrame(text=action.speak), FrameDirection.DOWNSTREAM)

        # Handle tool calls — track state change to force LLM if state transitions
        force_llm = False
        if action.call_tool:
            state_before = self.session.state
            await self._execute_tool(action)
            if self.session.state != state_before:
                force_llm = True

        # Update system prompt for current state
        self.context.messages[0]["content"] = get_system_prompt(self.session)

        # Run extraction in background — results only matter for the next turn
        if self.session.state.value in ("service_area", "discovery", "urgency", "pre_confirm"):
            asyncio.create_task(self._safe_extraction())

        # End the call if needed — bypasses buffer
        if action.end_call:
            if self._buffer_mode:
                await self._flush_buffer()
            if action.needs_llm or force_llm:
                await self.push_frame(frame, FrameDirection.DOWNSTREAM)
                asyncio.create_task(self._delayed_end_call(delay=3.0))
            else:
                await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
            return

        # Post-tool debounce: buffer fragments so caller finishes their thought
        if force_llm and not self._buffer_mode:
            self._start_buffer(text, frame)
            return

        if self._buffer_mode:
            self._buffer_texts.append(text)
            self._buffer_frame = frame  # Keep latest frame for flush
            # Check max buffer time
            if time.time() - self._buffer_start_time >= self.BUFFER_MAX_S:
                logger.info(f"[{self.session.state.value}] Buffer max time reached, flushing")
                await self._flush_buffer()
            else:
                self._reset_buffer_timer()
            return

        # Normal path: pass transcription downstream if LLM should generate response
        if action.needs_llm:
            t_push = time.time()
            logger.info(
                f"[{self.session.state.value}] Processing: {(t_push - t_start)*1000:.0f}ms "
                f"(transcription→LLM push, force_llm={force_llm})"
            )
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)
        else:
            # Preserve user text in LLM context even when LLM won't respond.
            self.context.messages.append({"role": "user", "content": text})
```

**Step 4: Run the Task 1 tests to verify they pass**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolDebounce -v`
Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py
git commit -m "feat: post-tool debounce buffer to prevent agent interrupting caller"
```

---

### Task 3: Update existing tests for buffer behavior

**Files:**
- Modify: `pipecat-agent/tests/test_processor.py`

The following existing tests expect immediate push after tool transitions. They need to account for the debounce delay.

**Step 1: Update `test_user_text_reaches_llm_after_tool_transition`**

Replace the test body with:

```python
    @pytest.mark.asyncio
    async def test_user_text_reaches_llm_after_tool_transition(self, processor):
        """When WELCOME→LOOKUP→SAFETY, the post-tool debounce buffer
        accumulates the transcription and pushes to LLM after the
        debounce period, so the caller finishes their thought first.
        """
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling, how can I help you?"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Buffer mode entered — not pushed yet
        assert processor._buffer_mode is True

        # Wait for debounce to fire
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        # Now the TranscriptionFrame should be pushed downstream
        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" in pushed_types, (
            f"TranscriptionFrame should be pushed after debounce. "
            f"Pushed: {pushed_types}"
        )
```

**Step 2: Update `test_lookup_triggers_llm_response_after_transition`**

Replace the test body with:

```python
    @pytest.mark.asyncio
    async def test_lookup_triggers_llm_response_after_transition(self, processor):
        """WELCOME → LOOKUP → SAFETY: after lookup_caller returns,
        the debounce buffer waits for caller to finish, then triggers LLM.

        Bug history: lookup returns needs_llm=False, so the LLM was never
        triggered after the tool result transitioned to SAFETY.
        This caused 26s of dead air in production (call CAd2b972dc).
        The force_llm fix solved dead air; the debounce buffer prevents
        the agent from interrupting the caller mid-sentence.
        """
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Wait for debounce to fire
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]

        # No canned speak — lookup runs silently
        assert "TTSSpeakFrame" not in pushed_types, f"Unexpected speak frame: {pushed_types}"

        # After debounce, a frame must trigger LLM
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after debounce. "
            f"Pushed frames: {pushed_types}"
        )
```

**Step 3: Update `test_lookup_failure_still_triggers_llm`**

Replace the test body with:

```python
    @pytest.mark.asyncio
    async def test_lookup_failure_still_triggers_llm(self, processor):
        """When V2 backend returns failure dict, state should still
        transition and LLM should still respond after debounce."""
        processor.tools.lookup_caller.return_value = {
            "found": False, "message": "V2 backend unavailable"
        }
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        assert processor.session.state == State.SAFETY

        # Wait for debounce
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" in pushed_types or "TTSSpeakFrame" in pushed_types
```

**Step 4: Update `test_booking_triggers_llm_after_confirmation`**

The BOOKING state tool call (book_service) also triggers force_llm when transitioning to CONFIRM. Update:

```python
    @pytest.mark.asyncio
    async def test_booking_triggers_llm_after_confirmation(self, processor):
        """BOOKING → (tool) → CONFIRM: after book_service returns success,
        the LLM must generate a confirmation message after debounce."""
        processor.session.state = State.BOOKING
        processor.session.booking_attempted = False
        processor.tools.book_service.return_value = {
            "booked": True,
            "booking_time": "Tomorrow 9 AM",
        }
        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="yes please", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        assert processor.session.state == State.CONFIRM

        # Wait for debounce
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        # TTSSpeakFrame for "Let me check..." is also expected (from PRE_CONFIRM→BOOKING speak)
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after booking confirmation debounce. "
            f"Pushed frames: {pushed_types}"
        )
```

**Step 5: Run updated tests**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py -v`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add pipecat-agent/tests/test_processor.py
git commit -m "test: update existing tests for post-tool debounce buffer behavior"
```

---

### Task 4: Write edge case tests

**Files:**
- Modify: `pipecat-agent/tests/test_processor.py`

**Step 1: Add edge case tests to `TestPostToolDebounce`**

```python
    @pytest.mark.asyncio
    async def test_end_call_flushes_buffer(self, processor):
        """If end_call is triggered during buffer mode, flush buffer first."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        # Enter buffer mode via lookup transition
        f1 = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(f1)
        assert processor._buffer_mode is True

        # Simulate end_call scenario: manually set state to CONFIRM
        processor.session.state = State.CONFIRM

        f2 = TranscriptionFrame(text="thanks bye", user_id="", timestamp="")
        await processor._handle_transcription(f2)

        # Buffer should have been flushed
        assert processor._buffer_mode is False

    @pytest.mark.asyncio
    async def test_max_buffer_time_flushes(self, processor):
        """Buffer should flush when max time is exceeded."""
        # Use a very short max time for testing
        processor.BUFFER_MAX_S = 0.1

        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        f1 = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(f1)
        assert processor._buffer_mode is True

        # Wait past max buffer time, then send another fragment
        await asyncio.sleep(0.15)

        f2 = TranscriptionFrame(text="it's blowing warm air", user_id="u1", timestamp="t1")
        await processor._handle_transcription(f2)

        # Max time exceeded — should have flushed
        assert processor._buffer_mode is False

    @pytest.mark.asyncio
    async def test_normal_needs_llm_not_buffered(self, processor):
        """Regular needs_llm=True (no tool transition) should push immediately."""
        processor.session.state = State.SAFETY
        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="no gas smell", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Should push immediately (no buffer mode)
        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" in pushed_types
        assert processor._buffer_mode is False

    @pytest.mark.asyncio
    async def test_debounce_resets_on_new_fragment(self, processor):
        """Each new fragment during buffer mode should reset the debounce timer."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        # Enter buffer mode
        f1 = TranscriptionFrame(text="my AC", user_id="", timestamp="")
        await processor._handle_transcription(f1)
        assert processor._buffer_mode is True

        # Wait 1 second (less than debounce), send another fragment
        await asyncio.sleep(1.0)
        f2 = TranscriptionFrame(text="is broken", user_id="", timestamp="")
        await processor._handle_transcription(f2)

        # Should still be buffering (timer was reset)
        assert processor._buffer_mode is True

        # Wait another 1 second — still less than debounce from last fragment
        await asyncio.sleep(1.0)
        assert processor._buffer_mode is True

        # Wait the full debounce from the last fragment
        await asyncio.sleep(0.7)

        pushed_frames = [c.args[0] for c in processor.push_frame.call_args_list]
        transcription_frames = [f for f in pushed_frames if isinstance(f, TranscriptionFrame)]
        assert len(transcription_frames) >= 1
        assert "my AC" in transcription_frames[-1].text
        assert "is broken" in transcription_frames[-1].text
```

**Step 2: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py -v`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add pipecat-agent/tests/test_processor.py
git commit -m "test: edge cases for post-tool debounce — max time, end_call, timer reset"
```

---

### Task 5: Run full test suite

**Step 1: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All ~291+ tests PASS.

**Step 2: If failures, fix them**

Any test that expects immediate TranscriptionFrame push after a tool transition needs the debounce sleep added.

**Step 3: Final commit if any fixes**

```bash
git add -A
git commit -m "fix: adjust remaining tests for post-tool debounce behavior"
```

---

### Task 6: Deploy and verify

**Step 1: Deploy to Fly.io**

```bash
cd pipecat-agent
fly deploy -a calllock-voice
```

**Step 2: Verify health**

```bash
curl -s https://calllock-voice.fly.dev/health
```

**Step 3: Test with a call**

Make a test call. Verify:
- Agent greets normally
- After saying your issue, the agent waits for you to finish before asking the safety question
- No overlapping audio
- Full conversation flows through all states correctly

**Step 4: Check logs**

```bash
fly logs -a calllock-voice --no-tail | grep "Buffer flush"
```

Should see logs like: `[safety] Buffer flush: 3 fragments → 'my AC is broken it's blowing warm air...'`

**Step 5: Final commit with deployment note**

```bash
git commit --allow-empty -m "deploy: post-tool debounce buffer live on calllock-voice"
```
