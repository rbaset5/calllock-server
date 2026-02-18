import json
import httpx
import os
import logging

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """Extract structured data from this conversation between a caller and a receptionist.
Return ONLY valid JSON. Only extract what the CALLER explicitly said — ignore what the receptionist said.

Fields:
- customer_name: The caller's name only. Must be a real human name. Not a phone number, not an address. Only extract from CALLER utterances.
- problem_description: What HVAC service issue the caller described.
- service_address: Street address for service. Do NOT include the customer name. Format: "123 Street Name".
- zip_code: 5-digit ZIP code.
- preferred_time: When the caller wants service (e.g., "ASAP", "tomorrow morning", "this week").
- problem_duration: How long the problem has been going on (e.g., "2 days", "since yesterday", "a few weeks").
- equipment_type: Type of HVAC equipment mentioned (AC, furnace, heat pump, thermostat, etc.).

If a field is not mentioned by the CALLER, use empty string "".
Do not guess or fabricate values. Only extract what the caller explicitly said.
NEVER mix customer_name into service_address or vice versa."""


def categorize_duration(duration: str) -> str:
    """Map problem duration to category: acute (<24h), recent (1-7d), ongoing (>7d)."""
    if not duration:
        return ""
    lower = duration.lower()
    acute_signals = ["today", "this morning", "tonight", "just", "hour", "few hours", "started"]
    recent_signals = ["yesterday", "couple days", "few days", "2 days", "3 days", "since"]
    ongoing_signals = ["week", "weeks", "month", "months", "long time", "a while"]

    if any(s in lower for s in acute_signals):
        return "acute"
    if any(s in lower for s in ongoing_signals):
        return "ongoing"
    if any(s in lower for s in recent_signals):
        return "recent"
    return ""


async def extract_fields(conversation: list[dict]) -> dict:
    """Call GPT-4o-mini to extract structured fields from conversation."""
    # Filter to only caller utterances for extraction context
    caller_turns = [msg for msg in conversation[-10:] if msg.get("role") == "user"]
    if not caller_turns:
        return {}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}"},
                json={
                    "model": "gpt-4o-mini",
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": EXTRACTION_PROMPT},
                        *conversation[-10:],
                    ],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception as e:
        logger.error(f"extraction failed: {e}")
        return {}
