import pytest
import httpx
import respx
import time
from calllock.post_call import handle_call_ended, build_job_payload, build_call_payload
from calllock.session import CallSession
from calllock.states import State


@pytest.fixture
def completed_session():
    """A session that went through a full happy-path call."""
    s = CallSession(phone_number="+15125551234")
    s.call_sid = "CA_test_123"
    s.start_time = 1000.0
    s.state = State.DONE
    s.caller_known = True
    s.customer_name = "Jonas"
    s.zip_code = "78745"
    s.service_address = "4210 South Lamar Blvd"
    s.problem_description = "AC blowing warm air"
    s.preferred_time = "morning"
    s.booking_confirmed = True
    s.booked_time = "2026-02-20T10:00:00"
    s.urgency_tier = "routine"
    s.transcript_log = [
        {"role": "agent", "content": "Thanks for calling ACE Cooling.", "timestamp": 1000.0},
        {"role": "user", "content": "My AC is blowing warm air.", "timestamp": 1002.0},
        {"role": "tool", "name": "book_service", "result": {"booked": True}, "timestamp": 1010.0},
        {"role": "agent", "content": "You're all set for tomorrow morning.", "timestamp": 1012.0},
    ]
    return s


@pytest.fixture
def safety_session():
    """A session that hit safety exit."""
    s = CallSession(phone_number="+15125559876")
    s.call_sid = "CA_test_456"
    s.start_time = 2000.0
    s.state = State.SAFETY_EXIT
    s.customer_name = "Maria"
    s.transcript_log = [
        {"role": "agent", "content": "Any safety concerns?", "timestamp": 2000.0},
        {"role": "user", "content": "I smell gas in my house", "timestamp": 2002.0},
        {"role": "agent", "content": "Please call 911 immediately.", "timestamp": 2003.0},
    ]
    return s


class TestBuildJobPayload:
    def test_has_required_fields(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert payload["customer_name"] == "Jonas"
        assert payload["customer_phone"] == "+15125551234"
        assert payload["customer_address"] == "4210 South Lamar Blvd"
        assert payload["service_type"] == "hvac"
        assert payload["call_id"] == "CA_test_123"
        assert payload["user_email"] == "owner@test.com"

    def test_booking_confirmed_has_scheduled_at(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert payload["scheduled_at"] == "2026-02-20T10:00:00"
        assert payload["booking_status"] == "confirmed"

    def test_callback_session_no_scheduled_at(self):
        s = CallSession(phone_number="+15125551234")
        s.call_sid = "CA_test_789"
        s.start_time = 1000.0
        s.state = State.CALLBACK
        payload = build_job_payload(s, end_time=1015.0, user_email="owner@test.com")
        assert payload.get("scheduled_at") is None
        assert payload["booking_status"] == "not_requested"

    def test_includes_transcript(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert "Agent:" in payload["call_transcript"]
        assert isinstance(payload["transcript_object"], list)

    def test_includes_classification(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert isinstance(payload["tags"], dict)
        assert "HAZARD" in payload["tags"]
        assert isinstance(payload["priority_color"], str)
        assert isinstance(payload["revenue_tier"], str)


class TestBuildCallPayload:
    def test_has_required_fields(self, completed_session):
        payload = build_call_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert payload["call_id"] == "CA_test_123"
        assert payload["phone_number"] == "+15125551234"
        assert payload["user_email"] == "owner@test.com"
        assert payload["duration_seconds"] == 15

    def test_has_transcript_object(self, completed_session):
        payload = build_call_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert isinstance(payload["transcript_object"], list)


class TestHandleCallEnded:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_job_and_call(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_JOBS_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_CALLS_URL", "https://app.example.com/api/webhook/calls")
        monkeypatch.setenv("DASHBOARD_ALERTS_URL", "https://app.example.com/api/webhook/emergency-alerts")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        job_route = respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        call_route = respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(completed_session)

        assert job_route.called
        assert call_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_safety_exit_sends_emergency_alert(self, safety_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_JOBS_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_CALLS_URL", "https://app.example.com/api/webhook/calls")
        monkeypatch.setenv("DASHBOARD_ALERTS_URL", "https://app.example.com/api/webhook/emergency-alerts")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        alert_route = respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(safety_session)

        assert alert_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_non_safety_does_not_send_alert(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_JOBS_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_CALLS_URL", "https://app.example.com/api/webhook/calls")
        monkeypatch.setenv("DASHBOARD_ALERTS_URL", "https://app.example.com/api/webhook/emergency-alerts")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        alert_route = respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(completed_session)

        assert not alert_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_survives_webhook_failure(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_JOBS_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_CALLS_URL", "https://app.example.com/api/webhook/calls")
        monkeypatch.setenv("DASHBOARD_ALERTS_URL", "https://app.example.com/api/webhook/emergency-alerts")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(500)
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(500)
        )

        # Should not raise
        await handle_call_ended(completed_session)


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
