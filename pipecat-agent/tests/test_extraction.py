import pytest
import httpx
import respx
import json
from calllock.extraction import extract_fields


@respx.mock
@pytest.mark.asyncio
async def test_extraction_returns_structured_data(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    respx.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps({
                "customer_name": "Jonas",
                "problem_description": "AC blowing warm air",
                "service_address": "4210 South Lamar Blvd",
                "zip_code": "78745",
                "preferred_time": "morning",
            })}}],
        })
    )
    result = await extract_fields([
        {"role": "user", "content": "This is Jonas, my AC is blowing warm at 4210 South Lamar 78745"},
    ])
    assert result["customer_name"] == "Jonas"
    assert result["zip_code"] == "78745"


@respx.mock
@pytest.mark.asyncio
async def test_extraction_handles_api_failure(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    respx.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(500)
    )
    result = await extract_fields([{"role": "user", "content": "test"}])
    assert result == {}
