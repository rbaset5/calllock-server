"""Tone quality evaluation tests.

Run manually: pytest tests/test_eval_tone.py -m eval -v -s
Requires: OPENAI_API_KEY environment variable set.
"""

import json
import os
from pathlib import Path

import httpx
import pytest

from calllock.prompts import get_system_prompt, _build_context, STATE_PROMPTS
from calllock.session import CallSession
from calllock.states import State
from tests.eval_data.rubric import (
    JUDGE_PROMPT,
    PASS_THRESHOLD,
    compute_weighted_score,
    parse_judge_scores,
)

EVAL_DATA_DIR = Path(__file__).parent / "eval_data"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"


# --- Lazy loading (design review #1: don't break test collection) ---

_golden_transcripts_cache: list[dict] | None = None


def load_golden_transcripts() -> list[dict]:
    global _golden_transcripts_cache
    if _golden_transcripts_cache is None:
        path = EVAL_DATA_DIR / "golden_transcripts.json"
        with open(path) as f:
            _golden_transcripts_cache = json.load(f)
    return _golden_transcripts_cache


def pytest_collection_modifyitems(config, items):
    """Skip eval data loading errors when not running eval tests."""
    pass  # Marker filtering handles this; lazy load prevents import-time crashes


# --- Fixtures ---

@pytest.fixture(scope="session")
def openai_client():
    """Shared httpx client for all eval tests (design review #4)."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        pytest.skip("OPENAI_API_KEY not set")
    client = httpx.AsyncClient(
        timeout=30.0,
        headers={"Authorization": f"Bearer {api_key}"},
    )
    yield client
    # Client closed after session ends (sync close is fine in teardown)


# --- Helpers ---

def build_session(snippet: dict) -> CallSession:
    """Build a CallSession from snippet session data."""
    session_data = snippet.get("session", {})
    state = State(snippet["state"])
    session = CallSession(phone_number="+15125550000", state=state)
    for key, value in session_data.items():
        if hasattr(session, key):
            setattr(session, key, value)
    return session


async def call_openai(
    client: httpx.AsyncClient,
    messages: list[dict],
    model: str = "gpt-4o",
    temperature: float = 0.0,
) -> str:
    """Make a real OpenAI API call. Returns assistant content."""
    resp = await client.post(
        OPENAI_URL,
        json={
            "model": model,
            "messages": messages,
            "temperature": temperature,
        },
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


async def generate_agent_response(
    client: httpx.AsyncClient, snippet: dict
) -> str:
    """Generate an agent response using the real system prompt."""
    session = build_session(snippet)
    system_prompt = get_system_prompt(session)

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(snippet["conversation"])

    return await call_openai(client, messages, model="gpt-4o", temperature=0.0)


async def judge_response(
    client: httpx.AsyncClient, snippet: dict, agent_response: str
) -> dict[str, int]:
    """Score an agent response using GPT-4o-mini as judge."""
    session = build_session(snippet)
    state = snippet["state"]
    state_enum = State(state)

    # Reuse real _build_context for consistent context (design review #2)
    context = _build_context(session) or "None"

    # Get the last caller utterance
    caller_msgs = [m for m in snippet["conversation"] if m["role"] == "user"]
    caller_utterance = caller_msgs[-1]["content"] if caller_msgs else ""

    # Summarize state prompt (first 200 chars to keep judge prompt reasonable)
    state_prompt_full = STATE_PROMPTS.get(state_enum, "")
    state_prompt_summary = (
        state_prompt_full[:200] + "..."
        if len(state_prompt_full) > 200
        else state_prompt_full
    )

    filled_prompt = JUDGE_PROMPT.format(
        state=state,
        context=context,
        caller_utterance=caller_utterance,
        agent_response=agent_response,
        state_prompt_summary=state_prompt_summary,
    )

    raw = await call_openai(
        client,
        [{"role": "user", "content": filled_prompt}],
        model="gpt-4o-mini",
        temperature=0.0,
    )

    # Use parse_judge_scores helper (design review #3)
    return parse_judge_scores(raw)


# --- Parametrized eval tests ---
# Lazy-load: pytest collects IDs at parametrize time but the file
# is only read when this module is actually imported for eval runs.

def _get_snippet_params():
    """Load snippets for parametrize. Returns empty if file missing."""
    try:
        snippets = load_golden_transcripts()
        return snippets
    except (FileNotFoundError, json.JSONDecodeError):
        return []


SNIPPETS = _get_snippet_params()


@pytest.mark.eval
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "snippet",
    SNIPPETS,
    ids=[s["id"] for s in SNIPPETS] if SNIPPETS else [],
)
async def test_tone_quality(snippet, openai_client):
    """Evaluate agent response quality for a golden transcript snippet."""
    agent_response = await generate_agent_response(openai_client, snippet)
    scores = await judge_response(openai_client, snippet, agent_response)
    weighted = compute_weighted_score(scores)

    # Print detailed scores for debugging
    print(f"\n{'='*60}")
    print(f"Snippet: {snippet['id']} (state: {snippet['state']})")
    print(f"Agent said: {agent_response!r}")
    print(f"Scores: {scores}")
    print(f"Weighted: {weighted:.2f} (threshold: {PASS_THRESHOLD})")
    print(f"{'='*60}")

    assert weighted >= PASS_THRESHOLD, (
        f"Tone quality below threshold for '{snippet['id']}': "
        f"{weighted:.2f} < {PASS_THRESHOLD}\n"
        f"Agent response: {agent_response!r}\n"
        f"Dimension scores: {scores}"
    )
