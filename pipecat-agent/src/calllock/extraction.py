import json
import httpx
import os
import logging

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """Extract structured data from this conversation. Return ONLY valid JSON.
Fields to extract: customer_name, problem_description, service_address, zip_code, preferred_time.
If a field is not mentioned, use empty string "".
Do not guess or fabricate values. Only extract what the caller explicitly said."""


async def extract_fields(conversation: list[dict]) -> dict:
    """Call GPT-4o-mini to extract structured fields from conversation."""
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
                        *conversation[-10:],  # Last 10 turns for context
                    ],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception as e:
        logger.error(f"extraction failed: {e}")
        return {}
