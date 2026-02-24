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

After tool execution transitions the state machine to a new state, the processor must trigger an LLM response. Currently, if the original Action had `needs_llm=False`, the LLM is never invoked — causing indefinite dead air.

**Key design decision (from review C1):** Use a separate `force_llm` boolean instead of mutating the Action dataclass. Keeps the state machine's return value immutable.

**Files:** `processor.py:104-156`, `tests/test_processor.py`

**Step 1: Write the failing tests**

Add `TestPostToolLLMTrigger` to `tests/test_processor.py`. Tests call `_handle_transcription` directly (review C4) to avoid dependency on debounce, which Task 2 removes.

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

        user_msgs = [m for m in processor.context.messages if m.get("role") == "user"]
        assert any("call me back" in m["content"] for m in user_msgs)
```

**Step 2: Run tests — expect failure**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestPostToolLLMTrigger -v`

**Step 3: Implement the fix**

Surgical edit to `processor.py:_handle_transcription`. Do NOT rewrite the method — apply these edits:

1. Add `import time` at file top.
2. Add `t_start = time.time()` as first line of `_handle_transcription`.
3. Before the `if action.call_tool:` block (line 129), add `force_llm = False`.
4. Wrap the tool call to track state change:
   ```python
   if action.call_tool:
       state_before = self.session.state
       await self._execute_tool(action)
       if self.session.state != state_before:
           force_llm = True
   ```
5. Change both `if action.needs_llm:` (lines 141, 150) to `if action.needs_llm or force_llm:`.
6. Add timing log before `push_frame(frame, ...)` in the non-end-call path:
   ```python
   t_push = time.time()
   logger.info(
       f"[{self.session.state.value}] Processing: {(t_push - t_start)*1000:.0f}ms "
       f"(transcription→LLM push, force_llm={force_llm})"
   )
   ```

**Step 4:** Run `pytest tests/test_processor.py::TestPostToolLLMTrigger -v` — expect PASS.

**Step 5:** Run `pytest tests/ -v` — all tests pass.

**Step 6: Commit**

```
fix: trigger LLM response after tool-driven state transitions

After lookup_caller/book_service complete and transition state, the
processor now sets force_llm=True so the LLM generates a response.
Also adds latency timing logs for production monitoring.

Fixes 26s dead-air bug discovered in call CAd2b972dccb4d528021a371bf.
```

---

### Task 2: Replace debounce with Smart Turn

Remove the custom 400ms debounce and add Pipecat's `LocalSmartTurnAnalyzerV3` for ML-based utterance coalescing.

**Key decisions:** Keep `start_secs=0.4` (review A1 — 0.2 risks false triggers on 8kHz telephone audio). Add deprecation comment for `vad_analyzer` location (review A3).

**Files:** `processor.py`, `pipeline.py`, `tests/test_processor.py`

**Step 1: Update tests**

In `tests/test_processor.py`:

1. Delete `TestTranscriptionDebounce` and `TestDebounceWindow` classes entirely.
2. Remove all `processor._debounce_seconds = 0.05` lines and `await asyncio.sleep(0.1)` debounce waits from remaining test classes (`TestNonBlockingExtraction`, `TestEndCallAfterLLM`, `TestTranscriptLogging`, `TestContextPreservation`). Replace any `process_frame(...)` + `sleep` patterns with direct `_handle_transcription(...)` calls.
3. Add replacement class:

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

**Step 2: Remove debounce from processor.py**

Surgical edits:

1. In `__init__`: delete the three debounce attrs (`_debounce_seconds`, `_debounce_task`, `_debounce_buffer`).
2. Delete the entire `_debounce_fire` method (lines 73-81).
3. Simplify `process_frame`: replace the debounce buffer/cancel/create_task block with a direct call. Add arrival log (review T2):
   ```python
   if isinstance(frame, TranscriptionFrame) and frame.text.strip():
       logger.debug(f"TranscriptionFrame arrived: '{frame.text.strip()}'")
       await self._handle_transcription(frame)
   ```

**Step 3: Add Smart Turn to pipeline.py**

Surgical edits:

1. Add import: `from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3`
2. In transport params, add deprecation comment and `turn_analyzer`:
   ```python
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
   ```

**Step 4:** Run `pytest tests/ -v` — all tests pass. If any test still references `_debounce_seconds`, fix it.

**Step 5: Commit**

```
feat: replace 400ms debounce with Smart Turn analyzer

LocalSmartTurnAnalyzerV3 handles utterance coalescing via ML instead
of a fixed 400ms timer. VAD stop_secs drops from 0.3 to 0.2.
start_secs kept at 0.4 for telephone noise filtering.
Expected latency savings: ~500ms off critical path.
```

---

### Task 3: Switch pipeline LLM to gpt-4o-mini

**File:** `pipeline.py:89-92`

**Step 1:** No new test needed. Existing tests mock the LLM. Functional validation via smoke test.

**Step 2:** Two edits in `pipeline.py`:
- Line 91: change `model="gpt-4o"` to `model="gpt-4o-mini"`
- After the LLM creation, add: `logger.info("Pipeline LLM model: gpt-4o-mini")`

**Step 3:** Run `pytest tests/ -v` — all pass.

**Step 4: Commit**

```
perf: switch pipeline LLM to gpt-4o-mini for faster TTFT

LLM only generates conversational text (never controls flow).
gpt-4o-mini TTFT ~150ms vs gpt-4o ~350ms. One-line revert if needed.
Model name logged for post-deploy quality monitoring.
```

---

### Task 4: Connection pooling for V2Client

Currently creates a new `httpx.AsyncClient` per request, paying TCP+TLS setup each time.

**Key decisions:** Dependency injection for testability (review C2). try/finally for resource safety (review C3). ~30ms savings per tool call (review P2).

**Files:** `tools.py`, `pipeline.py`, `tests/test_tools.py`

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

**Step 2:** Run `pytest tests/test_tools.py::TestV2ClientPooling -v` — expect FAIL.

**Step 3: Implement — surgical edits to tools.py**

Do NOT rewrite the class. The JSON payloads, error handling, and circuit breaker logic are unchanged. Apply these edits only:

1. **`__init__` signature:** add `client: httpx.AsyncClient | None = None` parameter.
2. **`__init__` body:** after `self._circuit = ...`, add client initialization:
   ```python
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
   ```
3. **Delete `_headers()` method** (lines 27-32) — headers now live on the shared client.
4. **Add `close()` method:**
   ```python
   async def close(self):
       """Close the shared HTTP client. Call at end of call."""
       await self._client.aclose()
   ```
5. **Each of the 5 methods** — same mechanical transformation:
   - Replace `async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers()) as client:` → delete the context manager line entirely
   - Replace `resp = await client.post(f"{self.base_url}/path",` → `resp = await self._client.post("/path",`
   - Dedent the body that was inside the `async with` block

   This affects: `lookup_caller`, `book_service`, `create_callback`, `send_sales_lead_alert`, `manage_appointment`.

**Step 4: Update existing tests**

For tests using `@respx.mock` decorator where the fixture creates the client before the mock is active: either move client creation inside the test body within the mock context, or use `respx.mock(base_url=...)` router mode.

**Step 5: Update pipeline.py — try/finally for cleanup (review C3)**

Wrap the pipeline run (line 174 onwards):

```python
runner = PipelineRunner()
try:
    await runner.run(task)
finally:
    await http_session.close()
    await tools.close()
```

Move the post-call block (`flush_transcript`, `handle_call_ended`) after the `finally`.

**Step 6:** Run `pytest tests/ -v` — all pass.

**Step 7: Commit**

```
perf: connection pooling for V2Client with dependency injection

Shared httpx.AsyncClient avoids TCP+TLS handshake per request (~30ms
savings). Accepts optional client parameter for test injection.
Pipeline cleanup wrapped in try/finally to prevent resource leaks.
```

---

### Task 5: Final validation and cleanup

**Step 1:** Run `pytest tests/ -v` — all pass.

**Step 2:** `grep -r "debounce" pipecat-agent/src/ pipecat-agent/tests/` — no stale references.

**Step 3:** `python -c "from calllock.pipeline import create_pipeline; print('OK')"` — no import errors.

**Step 4:** Commit cleanup if needed.

**Step 5: Post-deploy smoke test checklist**

After `fly deploy -a calllock-voice`, make test calls verifying:

1. **Split utterance resolved:** Say "I have a problem with my air... conditioning unit" — should be one turn. Check `fly logs` for single `[welcome] Caller:` entry.
2. **Short utterances work:** Say "yes" and "no" — should not be swallowed by Smart Turn.
3. **No dead air after lookup:** After stating your issue, safety question should come within 2s. No 26s gap.
4. **gpt-4o-mini quality:** Review 10-20 transcripts. Check naturalness, correct safety questions, booking flow.
5. **Latency logs visible:** Check `fly logs` for `Processing: XXms` entries. Target: <100ms processing time.

**Summary**

| Change | File | Diff size | Latency savings |
|--------|------|-----------|-----------------|
| Post-tool LLM trigger + timing logs | processor.py | ~8 lines | Fixes 26s dead-air bug |
| Smart Turn (remove debounce) | processor.py, pipeline.py | ~20 lines removed, ~5 added | ~500ms |
| gpt-4o-mini | pipeline.py | 2 lines | ~100-200ms |
| Connection pooling + try/finally | tools.py, pipeline.py | ~30 lines | ~30ms |
| **Total** | | **~65 lines of production diff** | **~630-730ms saved** |

Expected end-to-end: **~570-700ms** (down from ~1,300ms)

**NOT in scope:**
- BOOKING auto-execute: agent should call book_service immediately after PRE_CONFIRM. Independent feature, not a latency fix.
- Render cold-start mitigation: keep-alive ping or paid tier. Infrastructure change, not agent code.
- Pipecat deprecation migration: move vad_analyzer to LLMUserAggregator. Separate upgrade PR when pipecat version bumps.
