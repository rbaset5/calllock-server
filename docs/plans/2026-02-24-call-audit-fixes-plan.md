# Call Audit Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 10 regressions found in the Feb 24 call audit (3 critical, 5 moderate, 2 minor).

**Architecture:** Three buckets deployed sequentially. Bucket A: 4 data fixes in post_call.py. Bucket B: booking flow fixes across V2 backend and Pipecat agent. Bucket C: new LLM classification pipeline in post-call processing.

**Tech Stack:** Python (Pipecat agent), TypeScript (V2 backend), pytest with respx mocking, OpenAI GPT-4o-mini for classification.

**Design doc:** `docs/plans/2026-02-24-call-audit-fixes-design.md`

---

## Bucket A: Data Fixes

### Task 1: Fix urgency mismap — "urgent" → "high"

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py:17-23`
- Test: `pipecat-agent/tests/test_post_call.py`

**Step 1: Write the failing test**

Add to `TestUrgencyMapping` class in `test_post_call.py`:

```python
def test_urgent_maps_to_high(self, completed_session):
    completed_session.urgency_tier = "urgent"
    payload = build_job_payload(completed_session, end_time=1015.0, user_email="o@t.com")
    assert payload["urgency"] == "high"
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestUrgencyMapping::test_urgent_maps_to_high -v`
Expected: FAIL — `assert 'low' == 'high'`

**Step 3: Write minimal implementation**

In `post_call.py`, add `"urgent": "high"` to `_URGENCY_MAP`:

```python
_URGENCY_MAP = {
    "routine": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "urgent": "high",
    "emergency": "emergency",
}
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestUrgencyMapping -v`
Expected: All pass including new test.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/post_call.py pipecat-agent/tests/test_post_call.py
git commit -m "fix: map 'urgent' to 'high' in dashboard urgency enum"
```

---

### Task 2: Fix call sync — omit null lead_id/job_id, add job_id support

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py:105-131` (build_call_payload)
- Modify: `pipecat-agent/src/calllock/post_call.py:181-242` (handle_call_ended)
- Test: `pipecat-agent/tests/test_post_call.py`

**Step 1: Write failing tests**

Replace the existing `TestCallLeadLinking` class and add tests for null omission + job_id support:

```python
class TestCallLeadLinking:
    def test_call_payload_includes_lead_id_when_present(self):
        s = CallSession(phone_number="+15125551234")
        s.customer_name = "Jonas"
        s.start_time = 1000.0
        payload = build_call_payload(s, end_time=1070.0, user_email="test@test.com", lead_id="abc-123")
        assert payload["lead_id"] == "abc-123"

    def test_call_payload_omits_lead_id_when_none(self):
        s = CallSession(phone_number="+15125551234")
        s.start_time = 1000.0
        payload = build_call_payload(s, end_time=1070.0, user_email="test@test.com")
        assert "lead_id" not in payload

    def test_call_payload_includes_job_id_when_present(self):
        s = CallSession(phone_number="+15125551234")
        s.start_time = 1000.0
        payload = build_call_payload(s, end_time=1070.0, user_email="test@test.com", job_id="job-456")
        assert payload["job_id"] == "job-456"

    def test_call_payload_omits_job_id_when_none(self):
        s = CallSession(phone_number="+15125551234")
        s.start_time = 1000.0
        payload = build_call_payload(s, end_time=1070.0, user_email="test@test.com")
        assert "job_id" not in payload
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestCallLeadLinking -v`
Expected: `test_call_payload_omits_lead_id_when_none` FAILS (lead_id is present as None), `test_call_payload_includes_job_id_when_present` FAILS (no job_id param).

**Step 3: Write minimal implementation**

Modify `build_call_payload` signature to accept `job_id` param, and conditionally add both fields:

```python
def build_call_payload(session: CallSession, end_time: float, user_email: str, lead_id: str | None = None, job_id: str | None = None) -> dict:
    # ... existing code building payload dict ...
    payload = {
        "call_id": session.call_sid,
        "phone_number": session.phone_number or "unknown",
        "customer_name": session.customer_name,
        "user_email": user_email,
        "started_at": start_dt,
        "ended_at": end_dt,
        "duration_seconds": duration,
        "direction": "inbound",
        "outcome": _derive_end_call_reason(session),
        "urgency_tier": _map_urgency(session.urgency_tier),
        "problem_description": session.problem_description,
        "booking_status": _derive_booking_status(session),
        "transcript_object": [
            e for e in to_json_array(session.transcript_log)
            if e.get("role") in ("agent", "user")
        ],
    }
    if lead_id:
        payload["lead_id"] = lead_id
    if job_id:
        payload["job_id"] = job_id
    return payload
```

Also update `handle_call_ended` to extract and pass `job_id`:

```python
lead_id = job_result.get("lead_id") if isinstance(job_result, dict) else None
job_id = job_result.get("job_id") if isinstance(job_result, dict) else None

call_payload = build_call_payload(session, end_time, user_email, lead_id=lead_id, job_id=job_id)
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestCallLeadLinking -v`
Expected: All 4 tests pass.

**Step 5: Run full test suite to verify no regressions**

Run: `cd pipecat-agent && pytest tests/test_post_call.py -v`
Expected: All pass. Note: `urgency_tier` fix in call payload also happens here (was item #9 — the raw urgency_tier line is now using `_map_urgency()`).

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/post_call.py pipecat-agent/tests/test_post_call.py
git commit -m "fix: omit null lead_id/job_id from call payload, add job_id support"
```

---

### Task 3: Add is_ai_booked to job payload

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py:53-102` (build_job_payload)
- Test: `pipecat-agent/tests/test_post_call.py`

**Step 1: Write failing test**

Add to `TestBuildJobPayload`:

```python
def test_booking_confirmed_sets_is_ai_booked(self, completed_session):
    payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
    assert payload["is_ai_booked"] is True

def test_callback_session_no_is_ai_booked(self):
    s = CallSession(phone_number="+15125551234")
    s.call_sid = "CA_test_789"
    s.start_time = 1000.0
    s.state = State.CALLBACK
    payload = build_job_payload(s, end_time=1015.0, user_email="owner@test.com")
    assert payload.get("is_ai_booked") is None
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestBuildJobPayload::test_booking_confirmed_sets_is_ai_booked -v`
Expected: FAIL — KeyError or assertion on None.

**Step 3: Write minimal implementation**

In `build_job_payload`, add after line 96 (after the conditional fields section):

```python
if session.booking_confirmed:
    payload["is_ai_booked"] = True
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestBuildJobPayload -v`
Expected: All pass.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/post_call.py pipecat-agent/tests/test_post_call.py
git commit -m "fix: set is_ai_booked=true on job payload when booking confirmed"
```

---

## Bucket B: Booking Flow Fixes

### Task 4: V2 backend — return structured appointment_time in booking response

**Files:**
- Modify: `V2/src/functions/booking.ts:132-137` (bookAppointment return)
- Modify: `V2/src/functions/booking.ts:162-167` (mock booking return)
- Modify: `V2/src/types/retell.ts:188-192` (BookAppointmentResult interface)

**Step 1: Add appointment_time to the BookAppointmentResult interface**

In `V2/src/types/retell.ts`:

```typescript
export interface BookAppointmentResult {
  success: boolean;
  booking_confirmed: boolean;
  appointmentId?: string;
  confirmationMessage: string;
  appointment_time?: string;  // ISO 8601 datetime
}
```

**Step 2: Add appointment_time to real booking response**

In `V2/src/functions/booking.ts` at line 132-137, add `appointment_time`:

```typescript
return {
  success: true,
  booking_confirmed: true,
  appointmentId: data.data.uid,
  confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
  appointment_time: data.data.startTime,  // ISO from Cal.com
};
```

**Step 3: Add appointment_time to mock booking response**

In `V2/src/functions/booking.ts` at line 162-167:

```typescript
return {
  success: true,
  booking_confirmed: true,
  appointmentId,
  confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
  appointment_time: params.dateTime,  // ISO from request
};
```

**Step 4: Commit**

```bash
git add V2/src/functions/booking.ts V2/src/types/retell.ts
git commit -m "feat: return structured appointment_time in booking response"
```

---

### Task 5: Pipecat — read appointment_time from booking result

**Files:**
- Modify: `pipecat-agent/src/calllock/state_machine.py:350-359` (_tool_result_book_service)
- Test: `pipecat-agent/tests/test_state_machine.py`

**Step 1: Write failing test**

Find the existing booking tool result tests. Add:

```python
def test_book_service_stores_appointment_time(self):
    session = CallSession(phone_number="+15125551234")
    session.state = State.BOOKING
    session.booking_attempted = True
    sm = StateMachine()
    sm.handle_tool_result(session, "book_service", {
        "booking_confirmed": True,
        "appointmentId": "apt_123",
        "confirmationMessage": "Appointment confirmed for Wednesday, February 25 at 3:00 PM",
        "appointment_time": "2026-02-25T15:00:00-06:00",
    })
    assert session.booking_confirmed is True
    assert session.booked_time == "2026-02-25T15:00:00-06:00"
    assert session.state == State.CONFIRM
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_state_machine.py -k "test_book_service_stores_appointment_time" -v`
Expected: FAIL — `assert '' == '2026-02-25T15:00:00-06:00'`

**Step 3: Write minimal implementation**

In `_tool_result_book_service` at `state_machine.py:354`, change the booked_time line:

```python
def _tool_result_book_service(self, session: CallSession, result: dict):
    booked = result.get("booked") or result.get("booking_confirmed")
    if booked:
        session.booking_confirmed = True
        session.booked_time = result.get("appointment_time") or result.get("booking_time", "")
        session.appointment_id = result.get("appointmentId", "")
        _transition(session, State.CONFIRM)
    else:
        session.booking_confirmed = False
        _transition(session, State.BOOKING_FAILED)
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_state_machine.py -k "book_service" -v`
Expected: All pass.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/state_machine.py pipecat-agent/tests/test_state_machine.py
git commit -m "fix: read appointment_time from booking result into session.booked_time"
```

---

### Task 6: Fix CONFIRM prompt — inject booking details into state prompt

**Files:**
- Modify: `pipecat-agent/src/calllock/prompts.py:44-47,250-258`
- Test: `pipecat-agent/tests/test_prompts.py`

**Step 1: Write failing test**

Add to `test_prompts.py`:

```python
def test_confirm_prompt_includes_booking_details():
    session = CallSession(phone_number="+15125551234")
    session.state = State.CONFIRM
    session.booking_confirmed = True
    session.confirmation_message = "Appointment confirmed for Wednesday, February 25 at 3:00 PM"
    prompt = get_system_prompt(session)
    assert "Wednesday, February 25 at 3:00 PM" in prompt
    # Verify it's in the state prompt section, not just KNOWN INFO
    assert "BOOKING CONFIRMED:" in prompt or "Appointment confirmed for" in prompt
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_prompts.py::test_confirm_prompt_includes_booking_details -v`
Expected: FAIL — the static CONFIRM prompt doesn't include dynamic booking details.

**Step 3: Write minimal implementation**

Modify `get_system_prompt` in `prompts.py` to handle dynamic prompts:

```python
def get_system_prompt(session: CallSession) -> str:
    state_prompt = STATE_PROMPTS.get(session.state, "")
    # Dynamic prompts: inject session data into state prompt text
    if session.state == State.CONFIRM and session.confirmation_message:
        state_prompt = _confirm_prompt(session.confirmation_message)
    context = _build_context(session)
    return f"{PERSONA}\n\n{context}\n\n{state_prompt}"
```

Add the dynamic prompt function:

```python
def _confirm_prompt(confirmation_message: str) -> str:
    return f"""## CONFIRM
Wrap up after successful booking.

BOOKING CONFIRMED: {confirmation_message}

Tell the caller their appointment details from the booking above. Then add: "The tech will call about 30 minutes before heading over."

Price question: "It's an $89 diagnostic, and if you go ahead with the repair we knock that off."
"What should I do until then?" — give practical advice (close blinds, grab a fan, put a bucket).

Close: "Anything else? ... Alright, thanks for calling ACE Cooling — stay cool out there." """
```

**Step 4: Run test to verify it passes**

Run: `cd pipecat-agent && pytest tests/test_prompts.py -v`
Expected: All pass including new test.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_prompts.py
git commit -m "fix: inject booking details into CONFIRM state prompt to prevent LLM hallucination"
```

---

## Bucket C: Post-Call Classification Pipeline

### Task 7: Add classify_call function to classification.py

**Files:**
- Modify: `pipecat-agent/src/calllock/classification.py`
- Create: (tests added to existing test file) `pipecat-agent/tests/test_classification.py`

**Step 1: Write failing test**

Add new test class to `test_classification.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from calllock.classification import classify_call
from calllock.session import CallSession
from calllock.states import State


class TestClassifyCall:
    @pytest.mark.asyncio
    @patch("calllock.classification.httpx.AsyncClient")
    async def test_returns_all_fields(self, mock_client_cls):
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "choices": [{
                "message": {
                    "content": '{"ai_summary": "Customer called about AC not cooling.", "card_headline": "AC Not Blowing Cold", "card_summary": "Jonas called about AC unit not blowing cold air at 5211 Chain Road. Wants same-day service. Appointment booked.", "call_type": "SERVICE", "call_subtype": "REPAIR_AC", "sentiment_score": 4}'
                }
            }]
        }
        mock_response.raise_for_status = AsyncMock()
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value = mock_client

        session = CallSession(phone_number="+15125551234")
        session.state = State.CONFIRM
        session.customer_name = "Jonas"
        session.booking_confirmed = True
        result = await classify_call(session, "Customer called about AC issue.")

        assert result["ai_summary"] == "Customer called about AC not cooling."
        assert result["card_headline"] == "AC Not Blowing Cold"
        assert result["call_type"] == "SERVICE"
        assert result["sentiment_score"] == 4

    @pytest.mark.asyncio
    @patch("calllock.classification.httpx.AsyncClient")
    async def test_returns_empty_on_api_failure(self, mock_client_cls):
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(side_effect=Exception("API timeout"))
        mock_client_cls.return_value = mock_client

        session = CallSession(phone_number="+15125551234")
        result = await classify_call(session, "Some transcript")

        assert result == {}

    @pytest.mark.asyncio
    @patch("calllock.classification.httpx.AsyncClient")
    async def test_clamps_sentiment_score(self, mock_client_cls):
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "choices": [{
                "message": {
                    "content": '{"ai_summary": "Test.", "card_headline": "Test", "card_summary": "Test.", "call_type": "SERVICE", "call_subtype": null, "sentiment_score": 7}'
                }
            }]
        }
        mock_response.raise_for_status = AsyncMock()
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value = mock_client

        session = CallSession(phone_number="+15125551234")
        result = await classify_call(session, "Transcript text")

        assert result["sentiment_score"] == 5  # clamped to max
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && pytest tests/test_classification.py::TestClassifyCall -v`
Expected: FAIL — `classify_call` doesn't exist yet.

**Step 3: Write implementation**

Add to `classification.py`:

```python
import httpx
import json
import os

CALL_TYPE_ENUM = [
    "SERVICE", "ESTIMATE", "MAINTENANCE", "EXISTING_CUSTOMER",
    "RETURNING_CONTACT", "COMPLAINT", "JOB_SEEKER", "VENDOR_SUPPLIER",
    "SPAM_JUNK", "WRONG_NUMBER", "HANGUP_NO_MESSAGE", "UNKNOWN",
]

CLASSIFY_PROMPT = """Analyze this HVAC service call transcript and return a JSON object with these fields:

- ai_summary: 2-3 sentence summary of what happened on the call (who called, what they needed, what was the outcome)
- card_headline: Punchy 5-8 word headline for a dashboard card (e.g., "AC Not Blowing Cold — Same Day")
- card_summary: 2-3 sentence dispatch summary a technician would read before heading to the job
- call_type: One of: {call_types}
- call_subtype: Specific subtype like "REPAIR_AC", "REPAIR_HEATING", "DIAGNOSTIC_NOISE", or null if not applicable
- sentiment_score: 1-5 integer (1=very negative, 3=neutral, 5=very positive) based on how the caller felt during the call

Context:
- Customer: {customer_name}
- Final state: {final_state}
- Booking: {booking_status}
- Urgency: {urgency}

Transcript:
{transcript}

Return ONLY valid JSON, no markdown fences."""


async def classify_call(session: CallSession, transcript_text: str) -> dict:
    """Single LLM call to classify the call and generate display fields.

    Returns dict with ai_summary, card_headline, card_summary, call_type,
    call_subtype, sentiment_score. Returns empty dict on failure.
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key or not transcript_text.strip():
        return {}

    booking_status = "confirmed" if session.booking_confirmed else (
        "attempted_failed" if session.booking_attempted else "not_requested"
    )

    prompt = CLASSIFY_PROMPT.format(
        call_types=", ".join(CALL_TYPE_ENUM),
        customer_name=session.customer_name or "Unknown",
        final_state=session.state.value,
        booking_status=booking_status,
        urgency=session.urgency_tier,
        transcript=transcript_text[:3000],  # Limit transcript size
    )

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": "gpt-4o-mini",
                    "temperature": 0.2,
                    "max_tokens": 500,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": "You classify HVAC service calls. Return only JSON."},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            data = json.loads(content)

            # Validate and clamp
            result = {}
            if data.get("ai_summary"):
                result["ai_summary"] = str(data["ai_summary"])[:500]
            if data.get("card_headline"):
                result["card_headline"] = str(data["card_headline"])[:100]
            if data.get("card_summary"):
                result["card_summary"] = str(data["card_summary"])[:500]
            if data.get("call_type") in CALL_TYPE_ENUM:
                result["call_type"] = data["call_type"]
            if data.get("call_subtype"):
                result["call_subtype"] = str(data["call_subtype"])
            if isinstance(data.get("sentiment_score"), (int, float)):
                result["sentiment_score"] = max(1, min(5, int(data["sentiment_score"])))

            return result

    except Exception as e:
        logger.warning(f"classify_call failed: {e}")
        return {}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && pytest tests/test_classification.py -v`
Expected: All pass.

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/classification.py pipecat-agent/tests/test_classification.py
git commit -m "feat: add classify_call LLM pipeline for ai_summary, call_type, sentiment"
```

---

### Task 8: Integrate classify_call into post-call pipeline

**Files:**
- Modify: `pipecat-agent/src/calllock/post_call.py:181-242` (handle_call_ended)
- Test: `pipecat-agent/tests/test_post_call.py`

**Step 1: Write failing test**

Add to `test_post_call.py`:

```python
class TestClassificationIntegration:
    @respx.mock
    @pytest.mark.asyncio
    async def test_classification_fields_merged_into_job_payload(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_JOBS_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_CALLS_URL", "https://app.example.com/api/webhook/calls")
        monkeypatch.setenv("DASHBOARD_ALERTS_URL", "https://app.example.com/api/webhook/emergency-alerts")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        # Mock classify_call to return known values
        mock_classification = {
            "ai_summary": "Jonas called about AC not cooling.",
            "card_headline": "AC Not Blowing Cold",
            "card_summary": "Service call for AC repair.",
            "call_type": "SERVICE",
            "call_subtype": "REPAIR_AC",
            "sentiment_score": 4,
        }
        monkeypatch.setattr(
            "calllock.post_call.classify_call",
            AsyncMock(return_value=mock_classification),
        )

        captured_payload = {}
        def capture_job(request):
            import json
            captured_payload.update(json.loads(request.content))
            return httpx.Response(200, json={"success": True, "job_id": "job-123"})

        respx.post("https://app.example.com/api/webhook/jobs").mock(side_effect=capture_job)
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(completed_session)

        assert captured_payload.get("ai_summary") == "Jonas called about AC not cooling."
        assert captured_payload.get("card_headline") == "AC Not Blowing Cold"
        assert captured_payload.get("call_type") == "SERVICE"
        assert captured_payload.get("sentiment_score") == 4
```

**Step 2: Run test to verify it fails**

Run: `cd pipecat-agent && pytest tests/test_post_call.py::TestClassificationIntegration -v`
Expected: FAIL — classify_call not imported/called in post_call.py.

**Step 3: Write minimal implementation**

In `post_call.py`, add import and integrate:

```python
from calllock.classification import classify_tags, detect_priority, estimate_revenue_tier, classify_call
```

In `handle_call_ended`, add after building transcript_text but before build_job_payload:

```python
# Run LLM classification for display fields
classification = await classify_call(session, transcript_text)

# Build payloads
job_payload = build_job_payload(session, end_time, user_email)

# Merge classification fields (non-None only)
for key in ("ai_summary", "card_headline", "card_summary", "call_type", "call_subtype", "sentiment_score"):
    if classification.get(key) is not None:
        job_payload[key] = classification[key]
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && pytest tests/test_post_call.py -v`
Expected: All pass.

**Step 5: Run full test suite**

Run: `cd pipecat-agent && pytest tests/ -v`
Expected: All ~291+ tests pass.

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/post_call.py pipecat-agent/tests/test_post_call.py
git commit -m "feat: integrate classify_call into post-call pipeline for dashboard enrichment"
```

---

## Deployment

### Deploy Bucket A + C (Pipecat agent)

```bash
cd pipecat-agent
fly deploy -a calllock-voice
curl -s https://calllock-voice.fly.dev/health
```

### Deploy Bucket B (V2 backend first, then Pipecat)

V2 deploys automatically from `main` on Render. Push V2 changes to the calllock-server repo, verify deploy, then deploy Pipecat.

### Verify with test call

Make a test call and run `/audit-call last` to verify all 10 issues are resolved.
