import pytest
import httpx
import respx
from calllock.dashboard_sync import DashboardClient


@pytest.fixture
def dashboard():
    return DashboardClient(
        jobs_url="https://app.example.com/api/webhook/jobs",
        calls_url="https://app.example.com/api/webhook/calls",
        alerts_url="https://app.example.com/api/webhook/emergency-alerts",
        webhook_secret="test-secret-123",
    )


class TestDashboardClient:
    def test_urls_set_correctly(self, dashboard):
        assert dashboard.jobs_url == "https://app.example.com/api/webhook/jobs"
        assert dashboard.calls_url == "https://app.example.com/api/webhook/calls"
        assert dashboard.alerts_url == "https://app.example.com/api/webhook/emergency-alerts"


class TestSendJob:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_job_payload(self, dashboard):
        route = respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True, "job_id": "j_123"})
        )
        result = await dashboard.send_job({"customer_name": "Jonas", "call_id": "call_1"})
        assert result["success"] is True
        # Verify secret header was sent
        assert route.calls[0].request.headers["X-Webhook-Secret"] == "test-secret-123"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_failure(self, dashboard):
        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(500)
        )
        result = await dashboard.send_job({"customer_name": "Jonas"})
        assert result["success"] is False


class TestSendCall:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_call_record(self, dashboard):
        route = respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        result = await dashboard.send_call({"call_id": "call_1", "phone_number": "+15125551234"})
        assert result["success"] is True
        assert route.calls[0].request.headers["X-Webhook-Secret"] == "test-secret-123"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_failure(self, dashboard):
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(500)
        )
        result = await dashboard.send_call({"call_id": "call_1"})
        assert result["success"] is False


class TestSendEmergencyAlert:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_alert(self, dashboard):
        route = respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        result = await dashboard.send_emergency_alert({
            "phone_number": "+15125551234",
            "problem_description": "Gas leak",
        })
        assert result["success"] is True
        assert route.calls[0].request.headers["X-Webhook-Secret"] == "test-secret-123"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_failure(self, dashboard):
        respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(500)
        )
        result = await dashboard.send_emergency_alert({"phone_number": "+15125551234"})
        assert result["success"] is False
