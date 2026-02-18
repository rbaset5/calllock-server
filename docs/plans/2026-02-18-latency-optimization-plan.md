# Latency Optimization + Dead-Air Bug Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce end-to-end voice response latency from ~1,300ms to ~640ms and fix the post-tool dead-air bug that causes 26+ seconds of silence after lookup_caller.

**Architecture:** Four independent changes — (1) fix post-tool dead-air by triggering LLM after tool-driven state transitions, (2) replace custom debounce with Pipecat's Smart Turn analyzer, (3) switch pipeline LLM to gpt-4o-mini, (4) add connection pooling to V2Client. All changes are independently revertable.

**Tech Stack:** Pipecat 0.0.102 (LocalSmartTurnAnalyzerV3), OpenAI gpt-4o-mini, httpx AsyncClient pooling.

**Design doc:** `docs/plans/2026-02-18-latency-optimization-design.md`

---

### Task 1: Fix post-tool dead-air bug

After tool execution transitions the state machine to a new state, the processor must trigger an LLM response. Currently, if the original Action had `needs_llm=False`, the LLM is never invoked after the tool — causing indefinite dead air.

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:104-156`
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Write the failing test**

Add to `tests/test_processor.py`:

```python
class TestPostToolLLMTrigger:
    """After tool execution transitions state, LLM must be triggered."""

    @pytest.mark.asyncio
    async def test_lookup_triggers_llm_response_after_transition(self, processor):
        """WELCOME → LOOKUP → SAFETY: after lookup_caller returns,
        the LLM must be invoked to greet the caller in SAFETY state.

        Bug: lookup returns needs_llm=False, so the LLM was never
        triggered after the tool result transitioned to SAFETY.
        This caused 26s of dead air in production.
        """
        processor._debounce_seconds = 0.05

        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling"},
        ]

        await processor.process_frame(
            TranscriptionFrame(text="my AC is broken", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.15)

        # After WELCOME → LOOKUP → (tool) → SAFETY, the LLM must be triggered.
        # The transcription frame (or an LLMMessagesFrame) must be pushed downstream.
        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]

        # TTSSpeakFrame ("One moment.") should be there
        assert "TTSSpeakFrame" in pushed_types, f"Expected speak frame, got: {pushed_types}"

        # After tool completes and state transitions, a frame must trigger LLM
        # Either TranscriptionFrame or LLMMessagesFrame
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after tool-driven state transition. "
            f"Pushed frames: {pushed_types}"
        )

    @pytest.mark.asyncio
    async def test_booking_triggers_llm_after_confirmation(self, processor):
        """BOOKING → (tool) → CONFIRM: after book_service returns success,
        the LLM must generate a confirmation message."""
        processor._debounce_seconds = 0.05
        processor.session.state = State.BOOKING
        processor.session.booking_attempted = False
        processor.tools.book_service.return_value = {
            "booked": True,
            "booking_time": "Tomorrow 9 AM",
        }

        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        await processor.process_frame(
            TranscriptionFrame(text="yes please", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.15)

        # State should have transitioned to CONFIRM
        assert processor.session.state == State.CONFIRM

        # LLM must be triggered to say "You're all set" (or similar)
        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after booking confirmation. "
            f"Pushed frames: {pushed_types}"
        )
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolLLMTrigger -v`
Expected: FAIL — "LLM was not triggered after tool-driven state transition"

**Step 3: Implement the fix**

In `processor.py`, modify `_handle_transcription` to track state before/after tool execution:

```python
async def _handle_transcription(self, frame: TranscriptionFrame):
    # ... (existing code: capture agent responses, log, conversation history) ...

    # Run state machine
    action = self.machine.process(self.session, text)

    # Speak canned message immediately
    if action.speak:
        await self.push_frame(TTSSpeakFrame(text=action.speak), FrameDirection.DOWNSTREAM)

    # Handle tool calls — track state change
    if action.call_tool:
        state_before = self.session.state
        await self._execute_tool(action)
        # If tool result transitioned us to a new state, force LLM response
        if self.session.state != state_before:
            action.needs_llm = True

    # ... (rest of existing code unchanged) ...
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolLLMTrigger -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All 246+ tests pass (some debounce tests may need updating — see Task 2)

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "fix: trigger LLM response after tool-driven state transitions

After lookup_caller/book_service complete and transition state, the
processor now forces needs_llm=True so the LLM generates a response.
Fixes 26s dead-air bug discovered in call CAd2b972dccb4d528021a371bf."
```

---

### Task 2: Replace debounce with Smart Turn

Remove the custom 400ms debounce and add Pipecat's `LocalSmartTurnAnalyzerV3` which handles utterance coalescing via ML instead of a fixed timer.

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:10-84`
- Modify: `pipecat-agent/src/calllock/processor.py:1-82`
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Update tests — replace debounce tests with direct-processing tests**

In `tests/test_processor.py`, replace `TestTranscriptionDebounce` and `TestDebounceWindow`:

```python
class TestDirectTranscriptionProcessing:
    """With Smart Turn handling coalescing, transcription frames go straight through."""

    @pytest.mark.asyncio
    async def test_transcription_processed_immediately(self, processor):
        """TranscriptionFrame should trigger state machine without debounce delay."""
        await processor.process_frame(
            TranscriptionFrame(text="my AC is broken", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        # No sleep needed — processing is immediate
        assert processor.session.turn_count == 1

    @pytest.mark.asyncio
    async def test_multiple_frames_are_separate_turns(self, processor):
        """Each TranscriptionFrame is its own turn (Smart Turn handles coalescing upstream)."""
        processor.session.state = State.SAFETY
        processor.tools.lookup_caller.return_value = {"found": False}

        await processor.process_frame(
            TranscriptionFrame(text="no gas smell", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await processor.process_frame(
            TranscriptionFrame(text="everything is fine", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        assert processor.session.turn_count == 2
```

Also update any test that references `processor._debounce_seconds` — remove those lines. Tests that used `await asyncio.sleep(0.1)` for debounce can have the sleep removed.

**Step 2: Run tests to verify they fail (debounce still exists)**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestDirectTranscriptionProcessing -v`
Expected: May pass or fail depending on debounce interaction. The key validation is after implementation.

**Step 3: Remove debounce from processor.py**

In `processor.py`:

1. Remove from `__init__`:
   - `self._debounce_seconds = 0.4`
   - `self._debounce_task: asyncio.Task | None = None`
   - `self._debounce_buffer: list[str] = []`

2. Remove the `_debounce_fire` method entirely.

3. Simplify `process_frame` to call `_handle_transcription` directly:

```python
async def process_frame(self, frame: Frame, direction: FrameDirection):
    await super().process_frame(frame, direction)

    if isinstance(frame, TranscriptionFrame) and frame.text.strip():
        await self._handle_transcription(frame)
    elif isinstance(frame, InterimTranscriptionFrame):
        await self.push_frame(frame, direction)
    else:
        await self.push_frame(frame, direction)
```

**Step 4: Add Smart Turn to pipeline.py**

In `pipeline.py`, add import and configure transport:

```python
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
```

Change the transport params:

```python
transport = FastAPIWebsocketTransport(
    websocket=websocket,
    params=FastAPIWebsocketParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        add_wav_header=False,
        vad_analyzer=SileroVADAnalyzer(
            params=VADParams(
                confidence=0.85,
                start_secs=0.2,     # Was 0.4 — Smart Turn handles the rest
                stop_secs=0.2,      # Was 0.3 — Smart Turn decides when turn is complete
                min_volume=0.8,
            ),
        ),
        turn_analyzer=LocalSmartTurnAnalyzerV3(),
        serializer=serializer,
    ),
)
```

**Step 5: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass. Fix any tests that still reference `_debounce_seconds`.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/src/calllock/pipeline.py pipecat-agent/tests/test_processor.py
git commit -m "feat: replace 400ms debounce with Smart Turn analyzer

LocalSmartTurnAnalyzerV3 handles utterance coalescing via ML instead
of a fixed 400ms timer. VAD stop_secs drops from 0.3 to 0.2.
Expected latency savings: ~500ms off critical path."
```

---

### Task 3: Switch pipeline LLM to gpt-4o-mini

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:89-92`

**Step 1: No new test needed**

This is a one-line config change. Existing tests mock the LLM service. Functional validation happens via smoke test after deploy.

**Step 2: Change the model**

In `pipeline.py` line 91:

```python
llm = OpenAILLMService(
    api_key=os.getenv("OPENAI_API_KEY"),
    model="gpt-4o-mini",     # Was "gpt-4o" — faster TTFT for conversation
)
```

**Step 3: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass (LLM is mocked in tests).

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "perf: switch pipeline LLM to gpt-4o-mini for faster TTFT

LLM only generates conversational text (never controls flow).
gpt-4o-mini TTFT ~150ms vs gpt-4o ~350ms. One-line revert if needed."
```

---

### Task 4: Connection pooling for V2Client

Currently creates a new `httpx.AsyncClient` per HTTP request, paying TCP+TLS setup costs each time.

**Files:**
- Modify: `pipecat-agent/src/calllock/tools.py`
- Modify: `pipecat-agent/src/calllock/pipeline.py` (pass client lifecycle)
- Test: `pipecat-agent/tests/test_tools.py` (if exists, otherwise existing tests)

**Step 1: Write the failing test**

Add to `tests/test_tools.py` (or create if needed):

```python
import pytest
from calllock.tools import V2Client


class TestV2ClientPooling:
    def test_client_has_shared_session(self):
        """V2Client should use a shared httpx.AsyncClient, not create per-request."""
        client = V2Client(base_url="https://example.com", api_key="test")
        assert hasattr(client, "_client"), "V2Client should have a shared _client"

    @pytest.mark.asyncio
    async def test_close_cleans_up(self):
        """close() should cleanly shut down the shared client."""
        client = V2Client(base_url="https://example.com", api_key="test")
        await client.close()
        assert client._client.is_closed
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && python -m pytest tests/test_tools.py::TestV2ClientPooling -v`
Expected: FAIL — `V2Client` has no `_client` attribute or `close()` method.

**Step 3: Implement connection pooling**

Rewrite `tools.py` to use a shared client:

```python
class V2Client:
    def __init__(self, base_url: str, api_key: str = "", timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._circuit = CircuitBreaker(
            failure_threshold=3,
            cooldown_seconds=60.0,
            label="V2 backend",
        )
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
        )

    async def close(self):
        """Close the shared HTTP client. Call at end of call."""
        await self._client.aclose()
```

Then update each method to use `self._client` instead of creating a new one:

```python
async def lookup_caller(self, phone: str, call_id: str) -> dict:
    if not self._circuit.should_try():
        ...
    try:
        resp = await self._client.post(
            "/webhook/retell/lookup_caller",
            json={...},
        )
        ...
```

Remove the old `_headers()` method and all `async with httpx.AsyncClient(...)` blocks.

**Step 4: Update pipeline.py to close V2Client**

In `pipeline.py`, after the pipeline finishes, close the client:

```python
runner = PipelineRunner()
await runner.run(task)
await http_session.close()
await tools.close()  # Add this line
```

**Step 5: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass. Existing tool tests that mock `httpx` may need updating since the client is now persistent (check `test_tools.py` mocking strategy — tests that use `respx` should work with the shared client).

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/tools.py pipecat-agent/src/calllock/pipeline.py pipecat-agent/tests/test_tools.py
git commit -m "perf: connection pooling for V2Client

Shared httpx.AsyncClient avoids TCP+TLS handshake per request.
Reduces tool call overhead, especially for lookup_caller."
```

---

### Task 5: Final validation and cleanup

**Step 1: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass.

**Step 2: Check for stale debounce references**

Run: `grep -r "debounce" pipecat-agent/src/ pipecat-agent/tests/`
Expected: No references remain (except possibly in comments explaining why it was removed).

**Step 3: Verify imports are clean**

Run: `cd pipecat-agent && python -c "from calllock.pipeline import create_pipeline; print('OK')"`
Expected: "OK" (no import errors)

**Step 4: Final commit (if any cleanup needed)**

```bash
git add -A pipecat-agent/
git commit -m "chore: clean up stale debounce references and imports"
```

**Step 5: Summary of changes**

| Change | File | Latency Savings |
|--------|------|-----------------|
| Post-tool LLM trigger | processor.py | Fixes 26s dead-air bug |
| Smart Turn (remove debounce) | processor.py, pipeline.py | ~500ms |
| gpt-4o-mini | pipeline.py | ~100-200ms |
| Connection pooling | tools.py, pipeline.py | ~50-100ms |
| **Total** | | **~650-800ms saved** |

Expected end-to-end: **~550-700ms** (down from ~1,300ms)
