import pytest
import httpx
import respx
from calllock.tools import V2Client


BASE_URL = "https://test-server.example.com"


class TestV2ClientAuth:
    @pytest.mark.asyncio
    async def test_sends_api_key_header(self):
        """V2Client should send X-API-Key header on all requests."""
        with respx.mock:
            client = V2Client(base_url=BASE_URL, api_key="test-key-123")
            route = respx.post(f"{BASE_URL}/webhook/retell/lookup_caller").mock(
                return_value=httpx.Response(200, json={"found": False})
            )
            await client.lookup_caller("+15125551234", "call_123")
            assert route.called
            req = route.calls[0].request
            assert req.headers.get("x-api-key") == "test-key-123"

    @pytest.mark.asyncio
    async def test_no_api_key_still_works(self):
        """V2Client should work without API key (for dev/testing)."""
        with respx.mock:
            client = V2Client(base_url=BASE_URL)
            route = respx.post(f"{BASE_URL}/webhook/retell/lookup_caller").mock(
                return_value=httpx.Response(200, json={"found": False})
            )
            await client.lookup_caller("+15125551234", "call_123")
            assert route.called


class TestBookServiceEndpoint:
    @pytest.mark.asyncio
    async def test_calls_correct_booking_endpoint(self):
        """book_service should call /webhook/retell/book_appointment, not /api/retell/book-service."""
        with respx.mock:
            client = V2Client(base_url=BASE_URL)
            route = respx.post(f"{BASE_URL}/webhook/retell/book_appointment").mock(
                return_value=httpx.Response(200, json={"booked": True, "booking_time": "2026-02-17T10:00:00Z"})
            )
            result = await client.book_service(
                customer_name="Test", problem="AC broken", address="123 Main St",
                preferred_time="tomorrow morning", phone="+15125551234"
            )
            assert route.called
            assert result["booked"] is True


@pytest.mark.asyncio
async def test_lookup_caller_returns_result():
    with respx.mock:
        client = V2Client(base_url=BASE_URL)
        respx.post(f"{BASE_URL}/webhook/retell/lookup_caller").mock(
            return_value=httpx.Response(200, json={
                "found": True,
                "customerName": "Jonas",
                "zipCode": "78745",
            })
        )
        result = await client.lookup_caller("+15125551234", "call_123")
        assert result["found"] is True
        assert result["customerName"] == "Jonas"


@pytest.mark.asyncio
async def test_lookup_caller_handles_failure():
    with respx.mock:
        client = V2Client(base_url=BASE_URL)
        respx.post(f"{BASE_URL}/webhook/retell/lookup_caller").mock(
            return_value=httpx.Response(500)
        )
        result = await client.lookup_caller("+15125551234", "call_123")
        assert result["found"] is False


@pytest.mark.asyncio
async def test_book_service_success():
    with respx.mock:
        client = V2Client(base_url=BASE_URL)
        respx.post(f"{BASE_URL}/webhook/retell/book_appointment").mock(
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


@pytest.mark.asyncio
async def test_create_callback_success():
    with respx.mock:
        client = V2Client(base_url=BASE_URL)
        respx.post(f"{BASE_URL}/webhook/retell/create_callback").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        result = await client.create_callback(
            phone="+15125551234",
            callback_type="service",
            reason="Caller wants to schedule",
        )
        assert result["success"] is True


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
