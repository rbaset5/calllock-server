# Call Audit — 11 Issues Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 11 issues found in call audit CA1e1edabef6a7b67a7d645bf0aa3e16c2 — 5 bugs and 6 UX issues.

**Architecture:** Fixes are grouped into 5 batches ordered by dependency chain. Batch 1 unblocks data flow (phone extraction + V2 auth). Batch 2 prevents lying to customers. Batch 3 fixes call lifecycle. Batch 4 improves voice quality. Batch 5 fixes data quality.

**Tech Stack:** Python (pipecat-agent), TypeScript (V2 backend), pytest, httpx, respx

---

## Batch 1: Data Flow — Phone Extraction + V2 Auth (#51, #52)

### Task 1: Log Twilio handshake data for debugging

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:40-45`

**Step 1: Add call_data debug logging**

In `pipeline.py`, after `parse_telephony_websocket`, log the full call_data structure:

```python
# Parse Twilio WebSocket handshake
transport_type, call_data = await parse_telephony_websocket(websocket)
logger.info(f"Twilio handshake: transport={transport_type}, keys={list(call_data.keys())}")
logger.debug(f"Twilio call_data: {call_data}")
stream_sid = call_data["stream_id"]
call_sid = call_data["call_id"]
caller_phone = call_data.get("body", {}).get("From", "")
if not caller_phone:
    logger.warning(f"No caller phone extracted. call_data body keys: {list(call_data.get('body', {}).keys())}")
```

**Step 2: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "debug: log Twilio handshake structure to diagnose empty phone number"
```

### Task 2: Fix V2 backend auth — add API key support for Pipecat calls

**Files:**
- Modify: `pipecat-agent/src/calllock/tools.py:17-24,31-42`
- Test: `pipecat-agent/tests/test_tools.py`

The V2 backend uses Retell webhook signature auth (`X-Retell-Signature`) on `/webhook/retell/*` routes. The Pipecat agent is not a Retell webhook — it needs to use API key auth instead. The V2 backend already has a `combinedAuth` middleware that accepts either auth method.

**Step 1: Write the failing test**

Add to `tests/test_tools.py`:

```python
class TestV2ClientAuth:
    @pytest.mark.asyncio
    async def test_sends_api_key_header(self):
        """V2Client should send X-API-Key header on all requests."""
        client = V2Client(base_url="http://test.local", api_key="test-key-123")
        with respx.mock:
            route = respx.post("http://test.local/webhook/retell/lookup_caller").mock(
                return_value=httpx.Response(200, json={"found": False})
            )
            await client.lookup_caller("+15125551234", "call_123")
            assert route.called
            req = route.calls[0].request
            assert req.headers.get("x-api-key") == "test-key-123"

    @pytest.mark.asyncio
    async def test_no_api_key_still_works(self):
        """V2Client should work without API key (for dev/testing)."""
        client = V2Client(base_url="http://test.local")
        with respx.mock:
            route = respx.post("http://test.local/webhook/retell/lookup_caller").mock(
                return_value=httpx.Response(200, json={"found": False})
            )
            await client.lookup_caller("+15125551234", "call_123")
            assert route.called
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_tools.py::TestV2ClientAuth -v
```

Expected: FAIL — `V2Client.__init__() got an unexpected keyword argument 'api_key'`

**Step 3: Add API key support to V2Client**

Modify `tools.py`:

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

    def _headers(self) -> dict:
        """Build auth headers for V2 backend requests."""
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers
```

Then update every `httpx.AsyncClient` call to include headers. For example in `lookup_caller`:

```python
async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers()) as client:
```

Apply the same pattern to all 4 methods: `lookup_caller`, `book_service`, `create_callback`, `send_sales_lead_alert`.

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_tools.py::TestV2ClientAuth -v
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/tools.py pipecat-agent/tests/test_tools.py
git commit -m "fix: add API key auth header to V2Client for Pipecat-to-V2 calls (#51)"
```

### Task 3: Fix booking endpoint URL

**Files:**
- Modify: `pipecat-agent/src/calllock/tools.py:65`
- Test: `pipecat-agent/tests/test_tools.py`

The Pipecat agent calls `/api/retell/book-service` but the V2 backend endpoint is `/webhook/retell/book_appointment`.

**Step 1: Write the failing test**

```python
class TestBookServiceEndpoint:
    @pytest.mark.asyncio
    async def test_calls_correct_booking_endpoint(self):
        """book_service should call /webhook/retell/book_appointment, not /api/retell/book-service."""
        client = V2Client(base_url="http://test.local")
        with respx.mock:
            route = respx.post("http://test.local/webhook/retell/book_appointment").mock(
                return_value=httpx.Response(200, json={"booked": True, "booking_time": "2026-02-17T10:00:00Z"})
            )
            result = await client.book_service(
                customer_name="Test", problem="AC broken", address="123 Main St",
                preferred_time="tomorrow morning", phone="+15125551234"
            )
            assert route.called
            assert result["booked"] is True
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_tools.py::TestBookServiceEndpoint -v
```

Expected: FAIL — request goes to wrong URL

**Step 3: Fix the endpoint URL**

In `tools.py`, change line 65:

```python
# Before:
resp = await client.post(f"{self.base_url}/api/retell/book-service", ...)
# After:
resp = await client.post(f"{self.base_url}/webhook/retell/book_appointment", ...)
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_tools.py::TestBookServiceEndpoint -v
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/tools.py pipecat-agent/tests/test_tools.py
git commit -m "fix: correct booking endpoint URL from /api/retell/book-service to /webhook/retell/book_appointment (#51)"
```

### Task 4: Wire API key into pipeline

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:52`
- Modify: `pipecat-agent/src/calllock/config.py` (if env var validation exists)

**Step 1: Pass V2_API_KEY to V2Client**

In `pipeline.py`, update the V2Client initialization:

```python
tools = V2Client(
    base_url=os.getenv("V2_BACKEND_URL", ""),
    api_key=os.getenv("V2_API_KEY", ""),
)
```

**Step 2: Run full test suite**

```bash
cd pipecat-agent && pytest tests/ -v
```

Expected: All tests pass

**Step 3: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "fix: wire V2_API_KEY env var into V2Client for authenticated backend calls (#51)"
```

### Task 5: Update V2 backend to accept API key on webhook routes

**Files:**
- Modify: `V2/src/server.ts` (route middleware)

**Step 1: Check if combinedAuth already exists**

The V2 backend has a `combinedAuth` function in `V2/src/middleware/auth.ts`. Change webhook routes to use `combinedAuth` instead of `retellWebhookAuth`:

In `server.ts`, replace:
```typescript
app.use("/webhook/retell", retellWebhookAuth);
```
With:
```typescript
app.use("/webhook/retell", combinedAuth);
```

This allows either `X-Retell-Signature` (for Retell platform) or `X-API-Key` (for Pipecat agent) auth.

**Step 2: Test locally**

```bash
cd V2 && npm test
```

**Step 3: Commit**

```bash
git add V2/src/server.ts
git commit -m "fix: use combinedAuth on webhook routes to accept API key from Pipecat agent (#51)"
```

---

## Batch 2: Trust & Safety (#55, #60)

### Task 6: Fix fabricated availability — add LLM guardrail

**Files:**
- Modify: `pipecat-agent/src/calllock/prompts.py:62-64`
- Test: `pipecat-agent/tests/test_prompts.py`

**Step 1: Write the failing test**

```python
class TestConfirmPromptGuardrails:
    def test_confirm_prompt_prohibits_fabricated_dates(self):
        """CONFIRM state prompt must explicitly ban stating specific dates/times."""
        prompt = STATE_PROMPTS[State.CONFIRM]
        assert "NEVER" in prompt and ("date" in prompt.lower() or "time" in prompt.lower() or "availability" in prompt.lower())

    def test_confirm_prompt_has_availability_fallback(self):
        """CONFIRM prompt should redirect availability questions."""
        prompt = STATE_PROMPTS[State.CONFIRM]
        assert "confirm timing" in prompt.lower() or "when they" in prompt.lower()
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_prompts.py::TestConfirmPromptGuardrails -v
```

Expected: FAIL

**Step 3: Update CONFIRM prompt**

In `prompts.py`, replace the State.CONFIRM entry:

```python
State.CONFIRM: """Read back: "[name], [problem], at [address]. When works best?"
After timing: "Got it. Want me to book that?"
NEVER state specific dates, times, or availability. You have NO calendar access.
If asked about availability: "The team will confirm timing when they reach out."
If they want callback or new system, route to callback.""",
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_prompts.py::TestConfirmPromptGuardrails -v
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_prompts.py
git commit -m "fix: add guardrail to prevent LLM from fabricating appointment availability (#55)"
```

### Task 7: Fix callback_created — respect tool failure

**Files:**
- Modify: `pipecat-agent/src/calllock/state_machine.py:264-265`
- Test: `pipecat-agent/tests/test_state_machine.py`

**Step 1: Write the failing test**

```python
class TestCallbackToolResult:
    def test_callback_created_true_on_success(self, sm, session):
        session.state = State.CALLBACK
        sm.handle_tool_result(session, "create_callback", {"success": True})
        assert session.callback_created is True

    def test_callback_created_false_on_failure(self, sm, session):
        session.state = State.CALLBACK
        sm.handle_tool_result(session, "create_callback", {"success": False, "error": "401 Unauthorized"})
        assert session.callback_created is False

    def test_callback_created_false_on_error_key(self, sm, session):
        session.state = State.CALLBACK
        sm.handle_tool_result(session, "create_callback", {"error": "V2 backend unavailable"})
        assert session.callback_created is False
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_state_machine.py::TestCallbackToolResult -v
```

Expected: FAIL — `callback_created` is always True

**Step 3: Fix the handler**

In `state_machine.py`, replace:

```python
def _tool_result_create_callback(self, session: CallSession, result: dict):
    session.callback_created = True
```

With:

```python
def _tool_result_create_callback(self, session: CallSession, result: dict):
    if result.get("error"):
        session.callback_created = False
    else:
        session.callback_created = True
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_state_machine.py::TestCallbackToolResult -v
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/state_machine.py pipecat-agent/tests/test_state_machine.py
git commit -m "fix: callback_created respects tool failure instead of always true (#60)"
```

---

## Batch 3: Call Lifecycle (#57, #53)

### Task 8: Fix call termination — schedule EndFrame after LLM goodbye

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:120-129`
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Write the failing test**

```python
class TestEndCallAfterLLM:
    @pytest.mark.asyncio
    async def test_end_call_with_llm_schedules_endframe(self, processor):
        """When end_call=True and needs_llm=True, EndFrame should be scheduled after delay."""
        processor.session.state = State.CALLBACK
        processor.session.callback_created = True  # triggers end_call=True, needs_llm=True

        frame = TranscriptionFrame(text="Thanks bye", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Wait for delayed EndFrame
        await asyncio.sleep(4.0)

        # Check that EndFrame was pushed
        pushed_frames = [call.args[0] for call in processor.push_frame.call_args_list]
        frame_types = [type(f).__name__ for f in pushed_frames]
        assert "EndFrame" in frame_types, f"EndFrame not found in pushed frames: {frame_types}"
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_processor.py::TestEndCallAfterLLM -v
```

Expected: FAIL — EndFrame never pushed

**Step 3: Implement delayed EndFrame**

In `processor.py`, add the method:

```python
async def _delayed_end_call(self, delay: float = 3.0):
    """Push EndFrame after a delay to allow TTS to finish speaking."""
    await asyncio.sleep(delay)
    await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
```

Then update the end_call handling in `_handle_transcription`:

```python
# End the call if needed
if action.end_call:
    if action.needs_llm:
        # Let LLM generate a farewell, then end after TTS finishes
        await self.push_frame(frame, FrameDirection.DOWNSTREAM)
        asyncio.create_task(self._delayed_end_call(delay=3.0))
    else:
        await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
    return
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_processor.py::TestEndCallAfterLLM -v
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "fix: schedule EndFrame after LLM goodbye to terminate call cleanly (#57)"
```

### Task 9: Fix post-call timing — terminate pipeline on WebSocket disconnect

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:156-163`

**Step 1: Add on_client_disconnected handler**

After the existing `on_connected` handler in `pipeline.py`, add:

```python
@transport.event_handler("on_client_disconnected")
async def on_disconnected(transport, client):
    logger.info(f"Client disconnected, ending pipeline for {call_sid}")
    await task.queue_frames([EndFrame()])
```

Also import EndFrame at the top if not already imported (check line 21 — it's already imported).

**Step 2: Run full test suite**

```bash
cd pipecat-agent && pytest tests/ -v
```

Expected: All tests pass

**Step 3: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "fix: terminate pipeline immediately on WebSocket disconnect instead of waiting for idle timeout (#53)"
```

---

## Batch 4: Voice Quality (#56)

### Task 10: Fix double response — increase debounce window

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:52`
- Modify: `pipecat-agent/tests/test_processor.py`

**Step 1: Update existing debounce test**

The existing test `test_rapid_frames_coalesced` already tests debouncing. Verify the debounce constant changed:

```python
class TestDebounceWindow:
    def test_debounce_window_exceeds_vad_stop(self, processor):
        """Debounce window (400ms) must exceed VAD stop_secs (300ms) to prevent split utterances."""
        assert processor._debounce_seconds >= 0.4
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_processor.py::TestDebounceWindow -v
```

Expected: FAIL — current value is 0.2

**Step 3: Increase debounce to 400ms**

In `processor.py`, change line 52:

```python
self._debounce_seconds = 0.4  # Must exceed VAD stop_secs (0.3) to prevent split utterances
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_processor.py -v
```

Expected: All processor tests pass

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "fix: increase debounce to 400ms to prevent double responses from split STT utterances (#56)"
```

---

## Batch 5: Data Quality (#58, #54, #59)

### Task 11: Fix address extraction — improve extraction prompt

**Files:**
- Modify: `pipecat-agent/src/calllock/extraction.py:8-11`
- Test: `pipecat-agent/tests/test_extraction.py`

**Step 1: Write the failing test**

```python
class TestExtractionPrompt:
    def test_extraction_prompt_separates_name_and_address(self):
        """Extraction prompt must explicitly instruct separation of name and address."""
        assert "name" in EXTRACTION_PROMPT.lower()
        assert "address" in EXTRACTION_PROMPT.lower()
        assert "do not" in EXTRACTION_PROMPT.lower() or "never" in EXTRACTION_PROMPT.lower()
```

**Step 2: Run test to verify it fails**

```bash
cd pipecat-agent && pytest tests/test_extraction.py::TestExtractionPrompt -v
```

**Step 3: Improve extraction prompt**

In `extraction.py`, replace the EXTRACTION_PROMPT:

```python
EXTRACTION_PROMPT = """Extract structured data from this conversation. Return ONLY valid JSON.

Fields:
- customer_name: The caller's name only. Do NOT include addresses, numbers, or locations.
- problem_description: What service issue the caller described.
- service_address: Street address only. Do NOT include the customer name. Format: "123 Street Name".
- zip_code: 5-digit ZIP code.
- preferred_time: When the caller wants service.

If a field is not mentioned, use empty string "".
Do not guess or fabricate values. Only extract what the caller explicitly said.
NEVER mix customer_name into service_address or vice versa."""
```

**Step 4: Run test to verify it passes**

```bash
cd pipecat-agent && pytest tests/test_extraction.py -v
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/extraction.py pipecat-agent/tests/test_extraction.py
git commit -m "fix: improve extraction prompt to prevent name/address field mixing (#58)"
```

### Task 12: Investigate Inworld TTS — log StartFrame propagation

**Files:**
- Modify: `pipecat-agent/src/calllock/tts_fallback.py`

This is an investigation task. The Inworld TTS service errors on every TTSTextFrame with "StartFrame not received yet". The FallbackTTSService wraps Inworld, so StartFrame may not be propagating correctly.

**Step 1: Add diagnostic logging**

In `tts_fallback.py`, add logging in the `setup()` or `start()` method to confirm StartFrame is forwarded to the primary TTS:

```python
async def process_frame(self, frame, direction):
    if isinstance(frame, StartFrame):
        logger.info("FallbackTTSService received StartFrame — forwarding to primary")
    await super().process_frame(frame, direction)
```

**Step 2: Deploy and test**

This needs a live call to verify. Deploy to staging, make a test call, check if the StartFrame log appears.

**Step 3: Commit**

```bash
git add pipecat-agent/src/calllock/tts_fallback.py
git commit -m "debug: log StartFrame propagation in FallbackTTSService to diagnose Inworld TTS failure (#54)"
```

### Task 13: Run full test suite and deploy

**Step 1: Run all tests**

```bash
cd pipecat-agent && pytest tests/ -v
```

Expected: All tests pass

**Step 2: Deploy to production**

```bash
cd pipecat-agent && fly deploy -a calllock-voice
```

**Step 3: Set V2_API_KEY secret on Fly.io**

```bash
fly secrets set V2_API_KEY=<value from V2 backend API_SECRET_KEY> -a calllock-voice
```

**Step 4: Also deploy V2 backend if Task 5 changed server.ts**

```bash
cd V2 && git push  # triggers Render auto-deploy
```

**Step 5: Verify health**

```bash
curl -s https://calllock-voice.fly.dev/health
```

**Step 6: Make a test call and verify in logs**

```bash
fly logs -a calllock-voice
```

Check for:
- Twilio handshake log showing phone number
- V2 backend calls returning 200 (not 401)
- Post-call firing within seconds of disconnect (not minutes)
- No fabricated dates in LLM responses
