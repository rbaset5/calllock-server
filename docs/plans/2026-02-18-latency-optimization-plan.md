# Latency Optimization + Dead-Air Bug Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce end-to-end voice response latency from ~1,300ms to ~640ms and fix the post-tool dead-air bug that causes 26+ seconds of silence after lookup_caller.

**Architecture:** Four independent changes — (1) fix post-tool dead-air by triggering LLM after tool-driven state transitions, (2) replace custom debounce with Pipecat's Smart Turn analyzer, (3) switch pipeline LLM to gpt-4o-mini, (4) add connection pooling to V2Client. All changes are independently revertable.

**Tech Stack:** Pipecat 0.0.102 (LocalSmartTurnAnalyzerV3), OpenAI gpt-4o-mini, httpx AsyncClient pooling.

**Design doc:** `docs/plans/2026-02-18-latency-optimization-design.md`

**Review findings applied:** Architecture (4 issues), Code Quality (4), Tests (4), Performance (4). See conversation for full review.

**Known issue (out of scope):** BOOKING state waits for user input before calling book_service, but the caller already confirmed in PRE_CONFIRM. The agent should book automatically. Track separately.

---

### Task 1: Fix post-tool dead-air bug

After tool execution transitions the state machine to a new state, the processor must trigger an LLM response. Currently, if the original Action had `needs_llm=False`, the LLM is never invoked after the tool — causing indefinite dead air.

**Key design decision (from review C1):** Use a separate `force_llm` boolean instead of mutating the Action dataclass. This keeps the state machine's return value immutable and makes the override explicitly visible.

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:104-156`
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Write the failing tests**

Add to `tests/test_processor.py`. Note: tests call `_handle_transcription` directly (review C4) to avoid dependency on debounce, which Task 2 will remove.

```python
from pipecat.frames.frames import LLMMessagesFrame

class TestPostToolLLMTrigger:
    """After tool execution transitions state, LLM must be triggered."""

    @pytest.mark.asyncio
    async def test_lookup_triggers_llm_response_after_transition(self, processor):
        """WELCOME → LOOKUP → SAFETY: after lookup_caller returns,
        the LLM must be invoked to greet the caller in SAFETY state.

        Bug: lookup returns needs_llm=False, so the LLM was never
        triggered after the tool result transitioned to SAFETY.
        This caused 26s of dead air in production (call CAd2b972dc).
        """
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]

        # TTSSpeakFrame ("One moment.") should be there
        assert "TTSSpeakFrame" in pushed_types, f"Expected speak frame, got: {pushed_types}"

        # After tool completes and state transitions, a frame must trigger LLM
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after tool-driven state transition. "
            f"Pushed frames: {pushed_types}"
        )

    @pytest.mark.asyncio
    async def test_booking_triggers_llm_after_confirmation(self, processor):
        """BOOKING → (tool) → CONFIRM: after book_service returns success,
        the LLM must generate a confirmation message."""
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

        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after booking confirmation. "
            f"Pushed frames: {pushed_types}"
        )

    @pytest.mark.asyncio
    async def test_lookup_failure_still_triggers_llm(self, processor):
        """When V2 backend returns failure dict, state should still
        transition and LLM should still respond (review T1)."""
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
        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TTSSpeakFrame" in pushed_types or "TranscriptionFrame" in pushed_types

    @pytest.mark.asyncio
    async def test_context_preserved_when_tool_doesnt_transition(self, processor):
        """When tool call doesn't change state, user text must still
        be in LLM context via manual append (review T4)."""
        processor.session.state = State.CALLBACK
        processor.session.callback_created = False
        processor.session.callback_attempts = 0
        processor.tools.create_callback.return_value = {"error": "timeout"}

        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="please call me back", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # create_callback failure sets callback_created=False but
        # doesn't transition state (stays in CALLBACK).
        # force_llm should be False, so user text is manually appended.
        user_msgs = [m for m in processor.context.messages if m.get("role") == "user"]
        assert any("call me back" in m["content"] for m in user_msgs)
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolLLMTrigger -v`
Expected: FAIL — "LLM was not triggered after tool-driven state transition"

**Step 3: Implement the fix**

In `processor.py`, modify `_handle_transcription`. Use `force_llm` boolean (review C1):

```python
import time

async def _handle_transcription(self, frame: TranscriptionFrame):
    t_start = time.time()

    # Capture any agent responses from previous turn
    self._capture_agent_responses()

    text = frame.text.strip()
    logger.info(f"[{self.session.state.value}] Caller: {text}")

    # Add to conversation history
    self.session.conversation_history.append({"role": "user", "content": text})

    # Add to transcript log for post-call processing
    self.session.transcript_log.append({
        "role": "user",
        "content": text,
        "timestamp": _time.time(),
    })

    # Run state machine
    action = self.machine.process(self.session, text)

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

    # End the call if needed
    if action.end_call:
        if action.needs_llm or force_llm:
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)
            asyncio.create_task(self._delayed_end_call(delay=3.0))
        else:
            await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
        return

    # Pass transcription downstream if LLM should generate response
    if action.needs_llm or force_llm:
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

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolLLMTrigger -v`
Expected: PASS (all 4 tests)

**Step 5: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All 246+ tests pass.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "fix: trigger LLM response after tool-driven state transitions

After lookup_caller/book_service complete and transition state, the
processor now sets force_llm=True so the LLM generates a response.
Also adds latency timing logs for production monitoring.

Fixes 26s dead-air bug discovered in call CAd2b972dccb4d528021a371bf."
```

---

### Task 2: Replace debounce with Smart Turn

Remove the custom 400ms debounce and add Pipecat's `LocalSmartTurnAnalyzerV3` which handles utterance coalescing via ML instead of a fixed timer.

**Key design decisions (from review):**
- Keep `start_secs=0.4` (review A1) — no latency benefit from lowering, and 0.2 risks false triggers on 8kHz telephone audio.
- Add deprecation comment for `vad_analyzer` location (review A3).
- Add arrival log for Smart Turn verification (review T2).

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:10-84`
- Modify: `pipecat-agent/src/calllock/processor.py:1-82`
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Update tests — replace debounce tests with direct-processing tests**

In `tests/test_processor.py`, delete `TestTranscriptionDebounce` and `TestDebounceWindow` classes entirely.

Add replacement:

```python
class TestDirectTranscriptionProcessing:
    """With Smart Turn handling coalescing upstream, transcription frames go straight through."""

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

Also update ALL existing tests that reference `processor._debounce_seconds` or `await asyncio.sleep(0.1)` for debounce timing — remove those lines. Tests in `TestNonBlockingExtraction`, `TestEndCallAfterLLM`, `TestTranscriptLogging`, and `TestContextPreservation` all have `_debounce_seconds = 0.05` and debounce sleeps that must be removed. Replace `process_frame(...)` + `sleep(0.1)` with direct `_handle_transcription(...)` calls where appropriate.

**Step 2: Remove debounce from processor.py**

In `processor.py`:

1. Remove from `__init__`:
   - `self._debounce_seconds = 0.4`
   - `self._debounce_task: asyncio.Task | None = None`
   - `self._debounce_buffer: list[str] = []`

2. Remove the `_debounce_fire` method entirely.

3. Simplify `process_frame` to call `_handle_transcription` directly. Add arrival log (review T2):

```python
async def process_frame(self, frame: Frame, direction: FrameDirection):
    await super().process_frame(frame, direction)

    if isinstance(frame, TranscriptionFrame) and frame.text.strip():
        logger.debug(f"TranscriptionFrame arrived: '{frame.text.strip()}'")
        await self._handle_transcription(frame)
    elif isinstance(frame, InterimTranscriptionFrame):
        await self.push_frame(frame, direction)
    else:
        await self.push_frame(frame, direction)
```

**Step 3: Add Smart Turn to pipeline.py**

In `pipeline.py`, add import:

```python
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
```

Change the transport params. Keep `start_secs=0.4` (review A1), only lower `stop_secs`:

```python
transport = FastAPIWebsocketTransport(
    websocket=websocket,
    params=FastAPIWebsocketParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        add_wav_header=False,
        # NOTE: vad_analyzer on transport is deprecated in pipecat >=0.0.100.
        # Will need to move to LLMUserAggregator when upgrading. (review A3)
        vad_analyzer=SileroVADAnalyzer(
            params=VADParams(
                confidence=0.85,
                start_secs=0.4,     # Keep at 0.4 for 8kHz telephone noise filtering
                stop_secs=0.2,      # Was 0.3 — Smart Turn decides when turn is complete
                min_volume=0.8,
            ),
        ),
        turn_analyzer=LocalSmartTurnAnalyzerV3(),
        serializer=serializer,
    ),
)
```

**Step 4: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass. If any test still references `_debounce_seconds`, fix it.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/src/calllock/pipeline.py pipecat-agent/tests/test_processor.py
git commit -m "feat: replace 400ms debounce with Smart Turn analyzer

LocalSmartTurnAnalyzerV3 handles utterance coalescing via ML instead
of a fixed 400ms timer. VAD stop_secs drops from 0.3 to 0.2.
start_secs kept at 0.4 for telephone noise filtering.
Expected latency savings: ~500ms off critical path."
```

---

### Task 3: Switch pipeline LLM to gpt-4o-mini

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:89-92`

**Step 1: No new test needed**

This is a one-line config change. Existing tests mock the LLM service. Functional validation happens via smoke test after deploy.

**Step 2: Change the model and add logging (review P3)**

In `pipeline.py`:

```python
llm = OpenAILLMService(
    api_key=os.getenv("OPENAI_API_KEY"),
    model="gpt-4o-mini",     # Was "gpt-4o" — faster TTFT for conversation
)
```

Also add a log line so model is visible in production logs:

```python
logger.info(f"Pipeline LLM model: gpt-4o-mini")
```

**Step 3: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass (LLM is mocked in tests).

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "perf: switch pipeline LLM to gpt-4o-mini for faster TTFT

LLM only generates conversational text (never controls flow).
gpt-4o-mini TTFT ~150ms vs gpt-4o ~350ms. One-line revert if needed.
Model name logged for post-deploy quality monitoring."
```

---

### Task 4: Connection pooling for V2Client

Currently creates a new `httpx.AsyncClient` per HTTP request, paying TCP+TLS setup costs each time.

**Key design decisions (from review):**
- Use dependency injection for httpx client (review C2) — accepts optional `client` parameter for testability.
- Wrap cleanup in try/finally (review C3) — prevents resource leaks on pipeline crash.
- Correct estimate: ~30ms savings per tool call (review P2), not 50-100ms.

**Files:**
- Modify: `pipecat-agent/src/calllock/tools.py`
- Modify: `pipecat-agent/src/calllock/pipeline.py`
- Modify: `pipecat-agent/tests/test_tools.py`

**Step 1: Write the failing test**

Add to `tests/test_tools.py`:

```python
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

    def test_accepts_injected_client(self):
        """V2Client should accept a pre-configured httpx client for testing (review C2)."""
        mock_client = httpx.AsyncClient(base_url="https://injected.local")
        v2 = V2Client(base_url="https://example.com", api_key="test", client=mock_client)
        assert v2._client is mock_client
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && python -m pytest tests/test_tools.py::TestV2ClientPooling -v`
Expected: FAIL — `V2Client` has no `_client` attribute or `close()` method.

**Step 3: Implement connection pooling with dependency injection**

Rewrite `tools.py`:

```python
import httpx
import logging

from calllock.circuit_breaker import CircuitBreaker

logger = logging.getLogger(__name__)


class V2Client:
    """HTTP client for the V2 backend tool endpoints.

    Wraps each call with a circuit breaker: after 3 consecutive failures,
    V2 calls are skipped for 60s and graceful fallback responses are returned
    so the state machine can route to callback instead of hanging.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        timeout: float = 10.0,
        client: httpx.AsyncClient | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._circuit = CircuitBreaker(
            failure_threshold=3,
            cooldown_seconds=60.0,
            label="V2 backend",
        )
        if client is not None:
            self._client = client
        else:
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

    async def lookup_caller(self, phone: str, call_id: str) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning unknown caller")
            return {"found": False, "message": "V2 backend unavailable — proceeding without history."}
        try:
            resp = await self._client.post(
                "/webhook/retell/lookup_caller",
                json={
                    "call": {
                        "call_id": call_id,
                        "from_number": phone,
                        "metadata": {},
                    },
                    "args": {},
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("lookup_caller failed: %s", e)
            return {"found": False, "message": "Lookup failed — proceeding without history."}

    async def book_service(
        self,
        customer_name: str,
        problem: str,
        address: str,
        preferred_time: str,
        phone: str,
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning booking failure")
            return {"booked": False, "error": "V2 backend unavailable"}
        try:
            resp = await self._client.post(
                "/webhook/retell/book_appointment",
                json={
                    "customer_name": customer_name,
                    "customer_phone": phone,
                    "issue_description": problem,
                    "service_address": address,
                    "preferred_time": preferred_time,
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("book_service failed: %s", e)
            return {"booked": False, "error": str(e)}

    async def create_callback(
        self,
        phone: str,
        call_id: str = "pipecat_call",
        callback_type: str = "service",
        reason: str = "",
        customer_name: str = "",
        urgency: str = "normal",
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning callback failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            resp = await self._client.post(
                "/webhook/retell/create_callback",
                json={
                    "call": {
                        "call_id": call_id,
                        "from_number": phone,
                        "metadata": {},
                    },
                    "args": {
                        "reason": reason or "Callback requested",
                        "callback_type": callback_type,
                        "customer_name": customer_name,
                        "urgency": urgency,
                    },
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("create_callback failed: %s", e)
            return {"success": False, "error": str(e)}

    async def send_sales_lead_alert(self, phone: str, reason: str = "") -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning alert failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            resp = await self._client.post(
                "/webhook/retell/send_sales_lead_alert",
                json={
                    "call": {"from_number": phone, "metadata": {}},
                    "args": {"execution_message": reason},
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("send_sales_lead_alert failed: %s", e)
            return {"success": False, "error": str(e)}

    async def manage_appointment(
        self,
        action: str,
        phone: str,
        call_id: str = "pipecat_call",
        booking_uid: str = "",
        reason: str = "",
        new_time: str = "",
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning appointment failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            args = {"action": action}
            if booking_uid:
                args["booking_uid"] = booking_uid
            if reason:
                args["reason"] = reason
            if new_time:
                args["new_date_time"] = new_time

            resp = await self._client.post(
                "/webhook/retell/manage_appointment",
                json={
                    "call": {
                        "call_id": call_id,
                        "from_number": phone,
                        "metadata": {},
                    },
                    "args": args,
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("manage_appointment failed: %s", e)
            return {"success": False, "error": str(e)}
```

**Step 4: Update existing tests for connection pooling**

The existing tests use `respx.mock` decorator/context manager. With a persistent client, mocking must happen at the client level. Update the fixture and tests in `test_tools.py`:

For tests that create `V2Client` inside `with respx.mock:`, they continue to work because the client is created inside the mock context. For the fixture-based tests (decorated with `@respx.mock`), the fixture creates the client before the mock is active. Fix by creating clients inside the test or using the DI parameter:

```python
@pytest.fixture
def client():
    """Create V2Client with base_url for testing.
    Tests that need respx mocking should create the client inside the mock context."""
    return V2Client(base_url="https://test-server.example.com")
```

For tests using the `@respx.mock` decorator, move client creation inside the test body within the mock context, OR use `respx.mock(base_url=...)` router mode.

**Step 5: Update pipeline.py — try/finally for cleanup (review C3)**

In `pipeline.py`, wrap the pipeline run in try/finally:

```python
runner = PipelineRunner()
try:
    await runner.run(task)
finally:
    await http_session.close()
    await tools.close()

# Flush final agent responses to transcript before post-call processing
sm_processor.flush_transcript()

# Post-call: classify and sync to dashboard
try:
    await handle_call_ended(session)
except Exception as e:
    logger.error(f"Post-call handler failed: {e}")

logger.info(f"Call ended: {call_sid}")
```

**Step 6: Run all tests**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add pipecat-agent/src/calllock/tools.py pipecat-agent/src/calllock/pipeline.py pipecat-agent/tests/test_tools.py
git commit -m "perf: connection pooling for V2Client with dependency injection

Shared httpx.AsyncClient avoids TCP+TLS handshake per request (~30ms
savings). Accepts optional client parameter for test injection.
Pipeline cleanup wrapped in try/finally to prevent resource leaks."
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

**Step 5: Post-deploy smoke test checklist (review T2)**

After deploying to Fly.io, make test calls verifying:

1. **Split utterance resolved:** Say "I have a problem with my air... conditioning unit" — should be one turn, not two lookup_caller calls. Check `fly logs -a calllock-voice` for single `[welcome] Caller:` entry.

2. **Short utterances work:** Say "yes" and "no" — should not be swallowed by Smart Turn.

3. **No dead air after lookup:** After saying your issue, listen for safety question within 2 seconds. No 26-second gap.

4. **gpt-4o-mini quality:** Review 10-20 transcripts in dashboard. Check for naturalness, correct safety questions, proper booking flow.

5. **Latency logs visible:** Check `fly logs` for `Processing: XXms` entries. Target: <100ms processing time (state machine + tool overhead). Total end-to-end target: ~640ms.

**Step 6: Summary of changes**

| Change | File | Latency Savings |
|--------|------|-----------------|
| Post-tool LLM trigger + timing logs | processor.py | Fixes 26s dead-air bug |
| Smart Turn (remove debounce) | processor.py, pipeline.py | ~500ms |
| gpt-4o-mini | pipeline.py | ~100-200ms |
| Connection pooling + try/finally | tools.py, pipeline.py | ~30ms |
| **Total** | | **~630-730ms saved** |

Expected end-to-end: **~570-700ms** (down from ~1,300ms)

**Follow-up items (out of scope):**
- BOOKING auto-execute: agent should call book_service immediately after PRE_CONFIRM confirmation, not wait for user input
- Render cold-start mitigation: keep-alive ping during greeting or upgrade to paid tier
- Pipecat deprecation migration: move vad_analyzer to LLMUserAggregator when upgrading pipecat
