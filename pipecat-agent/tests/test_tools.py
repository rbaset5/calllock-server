import pytest
import httpx
import respx
from calllock.tools import V2Client


@pytest.fixture
def client():
    return V2Client(base_url="https://test-server.example.com")


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
    respx.post("https://test-server.example.com/api/retell/book-service").mock(
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
