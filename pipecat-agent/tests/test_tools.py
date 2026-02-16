import pytest
import httpx
import respx
from calllock.tools import V2Client


@pytest.fixture
def client():
    return V2Client(base_url="https://test-server.example.com")


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


@respx.mock
@pytest.mark.asyncio
async def test_lookup_caller_returns_result(client):
    respx.post("https://test-server.example.com/webhook/retell/lookup_caller").mock(
        return_value=httpx.Response(200, json={
            "found": True,
            "customerName": "Jonas",
            "zipCode": "78745",
        })
    )
    result = await client.lookup_caller("+15125551234", "call_123")
    assert result["found"] is True
    assert result["customerName"] == "Jonas"


@respx.mock
@pytest.mark.asyncio
async def test_lookup_caller_handles_failure(client):
    respx.post("https://test-server.example.com/webhook/retell/lookup_caller").mock(
        return_value=httpx.Response(500)
    )
    result = await client.lookup_caller("+15125551234", "call_123")
    assert result["found"] is False


@respx.mock
@pytest.mark.asyncio
async def test_book_service_success(client):
    respx.post("https://test-server.example.com/webhook/retell/book_appointment").mock(
        return_value=httpx.Response(200, json={
            "booked": True,
            "booking_time": "2026-02-15T10:00:00",
        })
    )
    result = await client.book_service(
        customer_name="Jonas",
        problem="AC blowing warm",
        address="4210 South Lamar",
        preferred_time="morning",
        phone="+15125551234",
    )
    assert result["booked"] is True


@respx.mock
@pytest.mark.asyncio
async def test_create_callback_success(client):
    respx.post("https://test-server.example.com/webhook/retell/create_callback").mock(
        return_value=httpx.Response(200, json={"success": True})
    )
    result = await client.create_callback(
        phone="+15125551234",
        callback_type="service",
        reason="Caller wants to schedule",
    )
    assert result["success"] is True
