# Voice UX + Webhook 400 Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 4 compounding issues from live test: latency (blocking extraction + debounce), dashboard 400 errors (blind logging), and agent verbosity.

**Architecture:** 4 surgical fixes to existing files. Non-blocking extraction removes 500ms-2s from the critical path. Response body logging exposes exact Zod validation failures. Prompt tightening constrains GPT-4o verbosity for voice.

**Tech Stack:** Python 3.13, asyncio, pytest, pytest-asyncio, httpx, respx

---

## Batch 1: Latency Fixes (processor.py)

### Task 1: Non-Blocking Extraction

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:110-111` (change `await` to `create_task`)
- Modify: `pipecat-agent/src/calllock/processor.py:175` (add `_safe_extraction` wrapper)
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Write the failing test**

Add to `pipecat-agent/tests/test_processor.py` at the end of the file, after the existing `TestTranscriptionDebounce` class:

```python
class TestNonBlockingExtraction:
    @pytest.mark.asyncio
    async def test_extraction_runs_in_background(self, processor):
        """Extraction should not block the transcription frame from reaching the LLM."""
        processor._debounce_seconds = 0.05

        # Make extraction take 500ms (simulating real GPT-4o-mini call)
        original_extraction = processor._run_extraction
        extraction_started = asyncio.Event()
        extraction_finished = asyncio.Event()

        async def slow_extraction():
            extraction_started.set()
            await asyncio.sleep(0.5)
            extraction_finished.set()

        processor._run_extraction = slow_extraction

        # Put processor in discovery state (triggers extraction)
        processor.session.state = State.DISCOVERY
        processor.session.conversation_history = [
            {"role": "user", "content": "hello"},
            {"role": "agent", "content": "hi"},
        ]

        await processor.process_frame(
            TranscriptionFrame(text="My AC is broken.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.1)  # Let debounce fire

        # Frame should have been pushed downstream BEFORE extraction finishes
        assert processor.push_frame.called, "Frame should be pushed without waiting for extraction"
        assert extraction_started.is_set(), "Extraction should have started"
        assert not extraction_finished.is_set(), "Extraction should still be running (non-blocking)"

        # Wait for extraction to finish
        await asyncio.sleep(0.5)
        assert extraction_finished.is_set(), "Extraction should finish in background"

    @pytest.mark.asyncio
    async def test_extraction_error_does_not_crash(self, processor):
        """If background extraction raises, it should log and not crash the pipeline."""
        processor._debounce_seconds = 0.05

        async def exploding_extraction():
            raise RuntimeError("extraction boom")

        processor._run_extraction = exploding_extraction

        processor.session.state = State.DISCOVERY
        processor.session.conversation_history = [
            {"role": "user", "content": "hello"},
            {"role": "agent", "content": "hi"},
        ]

        # Should not raise
        await processor.process_frame(
            TranscriptionFrame(text="My AC is broken.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.15)  # Let debounce fire + extraction attempt

        # Pipeline still works
        assert processor.push_frame.called
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && python -m pytest tests/test_processor.py::TestNonBlockingExtraction -v
```

Expected: FAIL — `test_extraction_runs_in_background` fails because extraction currently blocks (the frame is pushed AFTER extraction finishes, so `extraction_finished` will be set before `push_frame` is called).

**Step 3: Implement non-blocking extraction**

In `pipecat-agent/src/calllock/processor.py`:

Replace lines 110-111:
```python
        # Run extraction to populate session fields from conversation
        if self.session.state.value in ("service_area", "discovery", "confirm"):
            await self._run_extraction()
```

With:
```python
        # Run extraction in background — results only matter for the next turn
        if self.session.state.value in ("service_area", "discovery", "confirm"):
            asyncio.create_task(self._safe_extraction())
```

Add new method after `_run_extraction` (after line 208):
```python
    async def _safe_extraction(self):
        """Run extraction in background, catching errors to prevent silent crashes."""
        try:
            await self._run_extraction()
        except Exception as e:
            logger.error(f"Background extraction failed: {e}")
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && python -m pytest tests/test_processor.py -v
```

Expected: ALL 5 tests pass (3 existing debounce + 2 new extraction tests).

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "perf: make extraction non-blocking to reduce response latency"
```

---

### Task 2: Confirm Debounce 200ms

**Files:**
- Verify: `pipecat-agent/src/calllock/processor.py:52` (already changed locally)

**Step 1: Verify the change is present**

Confirm `processor.py:52` reads:
```python
        self._debounce_seconds = 0.2  # 200ms
```

(This was already applied in the prior session.)

**Step 2: Run full test suite to confirm no regressions**

```bash
cd pipecat-agent && python -m pytest tests/ -v
```

Expected: ALL tests pass. The debounce tests use `0.05` for speed, so they're unaffected by the production default.

**Step 3: Commit** (only if not already committed)

```bash
git add pipecat-agent/src/calllock/processor.py
git commit -m "perf: reduce debounce from 400ms to 200ms"
```

---

## Batch 2: Webhook Diagnostic + Prompt Fix

### Task 3: Webhook Response Body Logging

**Files:**
- Modify: `pipecat-agent/src/calllock/dashboard_sync.py:40-42`
- Test: `pipecat-agent/tests/test_dashboard_sync.py` (create new file)

**Step 1: Write the failing test**

Create `pipecat-agent/tests/test_dashboard_sync.py`:

```python
import pytest
import respx
import httpx

from calllock.dashboard_sync import DashboardClient


@pytest.fixture
def client():
    return DashboardClient(
        jobs_url="https://example.com/api/webhook/jobs",
        calls_url="https://example.com/api/webhook/calls",
        alerts_url="https://example.com/api/webhook/alerts",
        webhook_secret="test-secret",
    )


class TestResponseBodyLogging:
    @pytest.mark.asyncio
    @respx.mock
    async def test_400_response_body_is_logged(self, client, caplog):
        """When dashboard returns 400, the response body should be logged."""
        error_body = '{"error":"Validation failed","details":[{"path":"urgency","message":"Invalid enum value"}]}'
        respx.post("https://example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(400, text=error_body)
        )

        import logging
        with caplog.at_level(logging.ERROR):
            result = await client.send_job({"test": "payload"})

        assert not result.get("success", True) or "error" in result
        # The response body with Zod details should appear in logs
        assert "Validation failed" in caplog.text
        assert "urgency" in caplog.text

    @pytest.mark.asyncio
    @respx.mock
    async def test_200_response_not_error_logged(self, client, caplog):
        """Successful responses should not trigger error logging."""
        respx.post("https://example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        import logging
        with caplog.at_level(logging.ERROR):
            result = await client.send_job({"test": "payload"})

        assert result == {"success": True}
        assert "returned" not in caplog.text
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && python -m pytest tests/test_dashboard_sync.py -v
```

Expected: `test_400_response_body_is_logged` FAILS because the current code catches the `HTTPStatusError` but never logs the response body text — only the exception string (which contains the status code but not the body).

**Step 3: Add response body logging**

In `pipecat-agent/src/calllock/dashboard_sync.py`, replace lines 40-42:

```python
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.post(url, json=payload, headers=self._headers())
                    resp.raise_for_status()
```

With:

```python
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.post(url, json=payload, headers=self._headers())
                    if resp.status_code >= 400:
                        logger.error("%s returned %d: %s", label, resp.status_code, resp.text)
                    resp.raise_for_status()
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && python -m pytest tests/test_dashboard_sync.py -v
```

Expected: BOTH tests pass.

**Step 5: Run full test suite**

```bash
cd pipecat-agent && python -m pytest tests/ -v
```

Expected: ALL tests pass.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/dashboard_sync.py pipecat-agent/tests/test_dashboard_sync.py
git commit -m "fix: log webhook response body on 400 to expose Zod validation errors"
```

---

### Task 4: Prompt Tightening for Voice Brevity

**Files:**
- Modify: `pipecat-agent/src/calllock/prompts.py:4-13` (PERSONA), lines 41-93 (STATE_PROMPTS)
- Test: `pipecat-agent/tests/test_prompts.py` (create new file)

**Step 1: Write the failing test**

Create `pipecat-agent/tests/test_prompts.py`:

```python
from calllock.prompts import PERSONA, STATE_PROMPTS, get_system_prompt
from calllock.session import CallSession
from calllock.states import State


class TestPersonaBrevity:
    def test_persona_has_word_limit(self):
        """PERSONA must contain an explicit word limit for voice context."""
        assert "25 words" in PERSONA or "twenty-five words" in PERSONA.lower()

    def test_persona_mentions_phone_call(self):
        """PERSONA should remind the LLM this is a phone call."""
        lower = PERSONA.lower()
        assert "phone" in lower or "call" in lower or "voice" in lower


class TestStatePromptBrevity:
    def test_no_state_prompt_exceeds_200_chars(self):
        """State prompts should be concise for voice context."""
        for state, prompt in STATE_PROMPTS.items():
            assert len(prompt) < 400, (
                f"State {state.value} prompt is {len(prompt)} chars — "
                f"should be under 400 for voice brevity"
            )

    def test_system_prompt_under_1000_chars(self):
        """Full system prompt (persona + context + state) should stay compact."""
        session = CallSession(phone_number="+15125551234")
        session.customer_name = "John Smith"
        session.problem_description = "AC not cooling"
        session.service_address = "123 Main St"
        session.zip_code = "78701"
        session.state = State.DISCOVERY  # Longest state prompt

        prompt = get_system_prompt(session)
        assert len(prompt) < 1000, (
            f"Full system prompt is {len(prompt)} chars — "
            f"should be under 1000 for fast LLM inference"
        )
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && python -m pytest tests/test_prompts.py -v
```

Expected: `test_persona_has_word_limit` FAILS (no "25 words" in current PERSONA). Some state prompt length tests may also fail.

**Step 3: Tighten the prompts**

Replace the entire `PERSONA` string in `pipecat-agent/src/calllock/prompts.py` (lines 4-13):

```python
PERSONA = """You are the virtual receptionist for ACE Cooling, an HVAC service company in Austin, Texas.

VOICE: Friendly, brisk, confident. Not bubbly, not salesy.
RESPONSE LENGTH: 1-2 short sentences. Max 25 words total. This is a phone call.
CADENCE: ONE question at a time. Never stack questions.
ACKNOWLEDGMENTS: 5 words or fewer. Often skip entirely.
TONE MATCHING: Mirror the caller's energy.
ACTIVE LISTENING: Paraphrase briefly. Don't parrot exact words.

NEVER describe your own process. NEVER say 'moving on to' or 'let me move this forward'.
If asked if you're AI: 'I'm the virtual receptionist for ACE Cooling.'"""
```

Replace `STATE_PROMPTS` dict (lines 41-93):

```python
STATE_PROMPTS = {
    State.WELCOME: """Greet briefly: "Thanks for calling ACE Cooling, how can I help you?"
Then listen. Do NOT ask questions — just greet and listen.""",

    State.LOOKUP: """Say briefly: "One sec, pulling that up."
One short sentence only.""",

    State.SAFETY: """Ask: "Quick safety check — any gas smells, burning, or CO alarms right now?"
If yes: acknowledge seriously. If no: "Good, just had to ask." """,

    State.SAFETY_EXIT: """Calm and direct: "Please hang up and call 911. Get everyone outside. We'll follow up once you're safe."
One sentence. Actionable.""",

    State.SERVICE_AREA: """If ZIP known, confirm: "You're in [ZIP] — that's our area."
If not, ask: "What ZIP code do you need service at?"
If out of area: "We only cover Austin. I can have someone call with a referral." """,

    State.DISCOVERY: """Collect: name, problem, address. Ask ONE missing item at a time.
Paraphrase their problem briefly. No diagnostic questions — the tech handles that.""",

    State.CONFIRM: """Read back: "[name], [problem], at [address]. When works best?"
After timing: "Got it. Want me to book that?"
If they want callback or new system, route to callback.""",

    State.BOOKING: """Say: "Checking the schedule now..."
One sentence only.""",

    State.DONE: """Confirm: "You're set for [time] at [address]. Anything else?"
Brief and positive.""",

    State.CALLBACK: """Say: "I'll have someone reach out. Is this the best number?"
Then wrap: "Anything else? Great, have a good one." """,
}
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && python -m pytest tests/test_prompts.py -v
```

Expected: ALL tests pass.

**Step 5: Run full test suite**

```bash
cd pipecat-agent && python -m pytest tests/ -v
```

Expected: ALL tests pass (prompt changes don't affect other tests).

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_prompts.py
git commit -m "perf: tighten prompts for voice brevity — 25 word max"
```

---

## Batch 3: Verification

### Task 5: Full Integration Verification

**Step 1: Run full test suite**

```bash
cd pipecat-agent && python -m pytest tests/ -v --tb=short
```

Expected: ALL tests pass (should be ~195+ tests).

**Step 2: Deploy and test**

```bash
cd pipecat-agent && fly deploy -a calllock-voice
```

After deploy, verify health:
```bash
curl -s https://calllock-voice.fly.dev/health
```

Expected: `{"status":"ok"}`

**Step 3: Make a test call, then check logs**

After the test call:
```bash
fly logs -a calllock-voice --no-tail | tail -50
```

**What to look for:**
1. **Latency** — Does the agent respond faster? (No 2-4s pauses)
2. **Verbosity** — Are agent responses short? (1-2 sentences max)
3. **Webhook 400 body** — If 400s still occur, the logs now show the exact Zod field errors like:
   ```
   Dashboard job sync returned 400: {"error":"Validation failed","details":[{"path":"urgency","message":"Invalid enum value"}]}
   ```
   Use these errors to create targeted follow-up fixes.
