# Prompt Eval Suite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a pytest-based eval harness that scores GPT-4o conversational responses against a 7-dimension rubric, enabling quantitative prompt tuning.

**Architecture:** Golden transcript snippets feed through the real `get_system_prompt()` → GPT-4o → GPT-4o-mini judge. Scores are asserted per-snippet. Runs manually via `pytest -m eval`.

**Tech Stack:** Python, pytest, httpx (OpenAI API calls), existing `prompts.py` + `session.py`

---

### Task 1: Register the `eval` pytest marker

**Files:**
- Modify: `pipecat-agent/pyproject.toml:30-32`

**Step 1: Add the marker registration**

In `pyproject.toml`, add a `markers` line to `[tool.pytest.ini_options]`:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
markers = [
    "eval: LLM tone quality evaluation tests (require OPENAI_API_KEY, run with -m eval)",
]
```

**Step 2: Verify existing tests still pass**

Run: `cd pipecat-agent && python -m pytest tests/ -v --co -q 2>&1 | tail -5`
Expected: All tests collected, no warnings about unknown markers.

**Step 3: Commit**

```bash
git add pipecat-agent/pyproject.toml
git commit -m "chore: register eval pytest marker for tone quality tests"
```

---

### Task 2: Create the rubric module

**Files:**
- Create: `pipecat-agent/tests/eval_data/__init__.py` (empty)
- Create: `pipecat-agent/tests/eval_data/rubric.py`

**Step 1: Create the eval_data directory and init file**

```bash
mkdir -p pipecat-agent/tests/eval_data
touch pipecat-agent/tests/eval_data/__init__.py
```

**Step 2: Write the rubric module**

Create `pipecat-agent/tests/eval_data/rubric.py`:

```python
"""Rubric for scoring voice agent conversational quality.

Seven dimensions scored 1-5 by an LLM judge. Weighted average
must meet PASS_THRESHOLD to pass.
"""

DIMENSIONS = {
    "brevity": 0.20,
    "paraphrasing": 0.15,
    "forbidden_words": 0.10,
    "state_compliance": 0.20,
    "persona_fidelity": 0.10,
    "tone_matching": 0.15,
    "spoken_flow": 0.10,
}

PASS_THRESHOLD = 3.5

# --- Judge prompt ---
# This prompt is sent to GPT-4o-mini along with the agent's response.
# It encodes what a 5/5 dispatcher response sounds like.
# USER CONTRIBUTION: Edit this prompt to match your domain knowledge.

JUDGE_PROMPT = """\
You are evaluating a response from an HVAC virtual receptionist. \
Score each dimension 1-5. Return ONLY valid JSON, no other text.

## Scoring rubric

**brevity** (1-5)
1: 3+ sentences, wordy, restates what the caller said then adds filler.
3: 2 sentences, slight filler but gets to the point.
5: 1-2 tight sentences. Acknowledgment (if any) is 5 words or fewer.

**paraphrasing** (1-5)
1: Parrots the caller's exact words back ("So your AC is blowing warm air").
3: Generic rephrase that doesn't add professional context.
5: Professional reframe that shows domain knowledge. \
"Blowing warm" becomes "cooling isn't kicking in." \
"Making a grinding noise" becomes "could be a motor or fan issue."

**forbidden_words** (1-5)
1: Uses "transition", "process", "handle this", "assist you", or similar AI-isms.
3: No forbidden words but uses filler like "absolutely", "certainly", "I understand".
5: Clean, direct language. No AI-isms, no corporate filler.

**state_compliance** (1-5)
1: Asks about something the state prompt says NOT to ask (e.g., timing in DISCOVERY).
3: Covers the right topic but includes extra info or questions beyond the state's scope.
5: Does exactly and only what the state prompt requires.

**persona_fidelity** (1-5)
1: Sounds like ChatGPT or a generic call center script.
3: Professional but generic — could be any service company.
5: Sounds like a real HVAC dispatcher who handles 50 calls a day. \
Confident, efficient, slightly informal. Would pass a Turing test over the phone.

**tone_matching** (1-5)
1: Same flat tone regardless of caller energy. Cheerful when caller is frustrated.
3: Acknowledges caller's mood but doesn't match intensity.
5: Mirrors caller energy precisely. Frustrated caller gets empathetic and direct. \
Calm caller gets efficient and relaxed.

**spoken_flow** (1-5)
1: Written-language constructions: lists, parentheticals, semicolons, long clauses.
3: Mostly speakable but has a phrase that would sound odd spoken aloud.
5: Every word sounds natural spoken aloud at conversational speed. \
No one would pause and think "that's a weird thing to say on the phone."

## Context

State: {state}
Known info about caller: {context}
Caller said: "{caller_utterance}"
Agent responded: "{agent_response}"
State prompt instructions: {state_prompt_summary}

## Output format

Return ONLY this JSON (no markdown, no explanation):
{{"brevity": N, "paraphrasing": N, "forbidden_words": N, "state_compliance": N, "persona_fidelity": N, "tone_matching": N, "spoken_flow": N}}
"""


def compute_weighted_score(scores: dict[str, int]) -> float:
    """Compute weighted average from dimension scores."""
    total = 0.0
    for dim, weight in DIMENSIONS.items():
        total += scores.get(dim, 1) * weight
    return round(total, 2)
```

**Step 3: Write a unit test for the scoring function**

Create `pipecat-agent/tests/test_rubric.py`:

```python
from tests.eval_data.rubric import compute_weighted_score, DIMENSIONS, PASS_THRESHOLD


class TestWeightedScore:
    def test_perfect_score(self):
        scores = {dim: 5 for dim in DIMENSIONS}
        assert compute_weighted_score(scores) == 5.0

    def test_minimum_score(self):
        scores = {dim: 1 for dim in DIMENSIONS}
        assert compute_weighted_score(scores) == 1.0

    def test_threshold_boundary(self):
        # All 4s except one 1 — should still pass
        scores = {dim: 4 for dim in DIMENSIONS}
        scores["forbidden_words"] = 1  # weight 0.10
        result = compute_weighted_score(scores)
        assert result >= PASS_THRESHOLD

    def test_missing_dimension_defaults_to_1(self):
        scores = {"brevity": 5}  # only one dimension provided
        result = compute_weighted_score(scores)
        # brevity=5*0.20 + all others=1*0.80 = 1.80
        assert result == 1.8

    def test_weights_sum_to_one(self):
        total = sum(DIMENSIONS.values())
        assert abs(total - 1.0) < 0.001
```

**Step 4: Run the test**

Run: `cd pipecat-agent && python -m pytest tests/test_rubric.py -v`
Expected: 5 tests PASS.

**Step 5: Commit**

```bash
git add pipecat-agent/tests/eval_data/ pipecat-agent/tests/test_rubric.py
git commit -m "feat: add eval rubric with 7-dimension scoring and judge prompt"
```

---

### Task 3: Create golden transcript fixtures

**Files:**
- Create: `pipecat-agent/tests/eval_data/golden_transcripts.json`

**Step 1: Write the golden transcript data**

Create `pipecat-agent/tests/eval_data/golden_transcripts.json` with 10 snippets covering the 5 most common decision states:

```json
[
  {
    "id": "welcome_service_intent",
    "state": "welcome",
    "session": {},
    "conversation": [
      {"role": "assistant", "content": "Thanks for calling ACE Cooling, how can I help you?"},
      {"role": "user", "content": "Yeah hi, my AC stopped working this morning"}
    ],
    "notes": "Standard service call opening. Should detect intent, say pulling up account."
  },
  {
    "id": "welcome_frustrated_caller",
    "state": "welcome",
    "session": {},
    "conversation": [
      {"role": "assistant", "content": "Thanks for calling ACE Cooling, how can I help you?"},
      {"role": "user", "content": "I've been trying to call you guys all day, nobody picks up, my house is 90 degrees"}
    ],
    "notes": "Frustrated caller. Should acknowledge frustration, not be cheerful."
  },
  {
    "id": "safety_clear_no",
    "state": "safety",
    "session": {"problem_description": "AC blowing warm air"},
    "conversation": [
      {"role": "user", "content": "No, nothing like that"}
    ],
    "notes": "Simple safety clear. Should be very brief: 'Okay, just had to check.'"
  },
  {
    "id": "safety_ambiguous",
    "state": "safety",
    "session": {"problem_description": "Furnace making noise"},
    "conversation": [
      {"role": "user", "content": "Well I mean the gas heater is on but I don't smell anything weird"}
    ],
    "notes": "Ambiguous safety response. Should ask one clarifying follow-up."
  },
  {
    "id": "discovery_need_name",
    "state": "discovery",
    "session": {"zip_code": "78745", "customer_name": "", "problem_description": "", "service_address": ""},
    "conversation": [
      {"role": "user", "content": "Yeah my AC's been blowing warm since yesterday morning"}
    ],
    "notes": "Has ZIP, missing everything else. Should paraphrase problem, ask for name next."
  },
  {
    "id": "discovery_need_address",
    "state": "discovery",
    "session": {"zip_code": "78745", "customer_name": "Maria", "problem_description": "Cooling not engaging", "service_address": ""},
    "conversation": [
      {"role": "user", "content": "It's been like this for two days now"},
    "notes": "Has name and problem. Should ask for street address. Should NOT re-ask problem."
  },
  {
    "id": "urgency_asap",
    "state": "urgency",
    "session": {"customer_name": "Jonas", "problem_description": "AC not cooling", "service_address": "4210 S Lamar"},
    "conversation": [
      {"role": "user", "content": "As soon as possible, it's brutal in here"}
    ],
    "notes": "Clear urgent timing. Should NOT ask about timing again. Should NOT say time 'works'."
  },
  {
    "id": "urgency_unclear",
    "state": "urgency",
    "session": {"customer_name": "Tom", "problem_description": "Thermostat not responding", "service_address": "1100 Congress Ave"},
    "conversation": [
      {"role": "user", "content": "Yeah whenever you can get someone out here"}
    ],
    "notes": "Flexible timing. Should confirm routine-ish without promising availability."
  },
  {
    "id": "pre_confirm_readback",
    "state": "pre_confirm",
    "session": {"customer_name": "Sarah", "problem_description": "Water leak from AC unit", "service_address": "2501 Lake Austin Blvd", "zip_code": "78703", "preferred_time": "tomorrow morning"},
    "conversation": [
      {"role": "user", "content": "Yep that's everything"}
    ],
    "notes": "All info present. Should read back and ask for confirmation. Concise."
  },
  {
    "id": "discovery_verbose_trap",
    "state": "discovery",
    "session": {"zip_code": "78748", "customer_name": "Dave", "problem_description": "", "service_address": ""},
    "conversation": [
      {"role": "user", "content": "So basically what happened is the outdoor unit started making this loud banging noise about three days ago and then yesterday it just completely stopped and now it's blowing warm air and my wife is pregnant and we really need this fixed"}
    ],
    "notes": "Long caller utterance. Agent must NOT match length. Should paraphrase briefly, ask for address."
  }
]
```

**Step 2: Validate the JSON is parseable**

Run: `python3 -c "import json; d=json.load(open('pipecat-agent/tests/eval_data/golden_transcripts.json')); print(f'{len(d)} snippets loaded')"`
Expected: `10 snippets loaded`

**Step 3: Commit**

```bash
git add pipecat-agent/tests/eval_data/golden_transcripts.json
git commit -m "feat: add 10 golden transcript snippets for eval suite"
```

---

### Task 4: Build the eval test harness

**Files:**
- Create: `pipecat-agent/tests/test_eval_tone.py`

This is the core file. It loads golden transcripts, calls GPT-4o with the real system prompt, judges with GPT-4o-mini, and asserts scores.

**Step 1: Write the eval test file**

Create `pipecat-agent/tests/test_eval_tone.py`:

```python
"""Tone quality evaluation tests.

Run manually: pytest tests/test_eval_tone.py -m eval -v
Requires: OPENAI_API_KEY environment variable set.
"""

import json
import os
from pathlib import Path

import httpx
import pytest

from calllock.prompts import get_system_prompt, STATE_PROMPTS
from calllock.session import CallSession
from calllock.states import State
from tests.eval_data.rubric import (
    JUDGE_PROMPT,
    DIMENSIONS,
    PASS_THRESHOLD,
    compute_weighted_score,
)

EVAL_DATA_DIR = Path(__file__).parent / "eval_data"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"


def load_golden_transcripts() -> list[dict]:
    path = EVAL_DATA_DIR / "golden_transcripts.json"
    with open(path) as f:
        return json.load(f)


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
    messages: list[dict],
    model: str = "gpt-4o",
    temperature: float = 0.0,
) -> str:
    """Make a real OpenAI API call. Returns assistant content."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        pytest.skip("OPENAI_API_KEY not set")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            OPENAI_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def generate_agent_response(snippet: dict) -> str:
    """Generate an agent response using the real system prompt."""
    session = build_session(snippet)
    system_prompt = get_system_prompt(session)

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(snippet["conversation"])

    return await call_openai(messages, model="gpt-4o", temperature=0.0)


async def judge_response(
    snippet: dict, agent_response: str
) -> dict[str, int]:
    """Score an agent response using GPT-4o-mini as judge."""
    session = build_session(snippet)
    state = snippet["state"]
    state_enum = State(state)

    # Build context string (same as prompts.py _build_context but simplified)
    context_parts = []
    session_data = snippet.get("session", {})
    for key, val in session_data.items():
        if val:
            context_parts.append(f"{key}: {val}")
    context = ", ".join(context_parts) if context_parts else "None"

    # Get the last caller utterance
    caller_msgs = [m for m in snippet["conversation"] if m["role"] == "user"]
    caller_utterance = caller_msgs[-1]["content"] if caller_msgs else ""

    # Summarize state prompt (first 200 chars to keep judge prompt reasonable)
    state_prompt_full = STATE_PROMPTS.get(state_enum, "")
    state_prompt_summary = state_prompt_full[:200] + "..." if len(state_prompt_full) > 200 else state_prompt_full

    filled_prompt = JUDGE_PROMPT.format(
        state=state,
        context=context,
        caller_utterance=caller_utterance,
        agent_response=agent_response,
        state_prompt_summary=state_prompt_summary,
    )

    raw = await call_openai(
        [{"role": "user", "content": filled_prompt}],
        model="gpt-4o-mini",
        temperature=0.0,
    )

    # Parse JSON from response (strip markdown fences if present)
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1]
        cleaned = cleaned.rsplit("```", 1)[0]

    scores = json.loads(cleaned)

    # Validate all dimensions present and in range
    for dim in DIMENSIONS:
        assert dim in scores, f"Judge missing dimension: {dim}"
        assert 1 <= scores[dim] <= 5, f"Score out of range for {dim}: {scores[dim]}"

    return scores


# --- Parametrized eval tests ---

SNIPPETS = load_golden_transcripts()


@pytest.mark.eval
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "snippet",
    SNIPPETS,
    ids=[s["id"] for s in SNIPPETS],
)
async def test_tone_quality(snippet):
    """Evaluate agent response quality for a golden transcript snippet."""
    agent_response = await generate_agent_response(snippet)
    scores = await judge_response(snippet, agent_response)
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
```

**Step 2: Verify the test file is syntactically valid**

Run: `python3 -c "import ast; ast.parse(open('pipecat-agent/tests/test_eval_tone.py').read()); print('OK')"`
Expected: `OK`

**Step 3: Verify tests are collected (but skipped without API key)**

Run: `cd pipecat-agent && python -m pytest tests/test_eval_tone.py -m eval --co -q`
Expected: 10 test items collected, one per snippet.

**Step 4: Commit**

```bash
git add pipecat-agent/tests/test_eval_tone.py
git commit -m "feat: add eval test harness with LLM-as-judge scoring"
```

---

### Task 5: Run the eval suite end-to-end

This task requires `OPENAI_API_KEY` to be set.

**Step 1: Run the full eval suite**

Run: `cd pipecat-agent && OPENAI_API_KEY=$OPENAI_API_KEY python -m pytest tests/test_eval_tone.py -m eval -v -s 2>&1 | tail -40`

Expected: 10 tests run, most pass (score >= 3.5). Some may fail — that's expected and useful. The output shows per-snippet scores.

**Step 2: Review any failures**

If any snippet fails, note which dimensions scored low. This is the eval suite working as intended — it's telling you which prompts need work.

**Step 3: Verify existing tests still pass**

Run: `cd pipecat-agent && python -m pytest tests/ -v --ignore=tests/test_eval_tone.py`
Expected: All ~291 existing tests pass. The eval tests are isolated.

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: adjust eval data after end-to-end validation"
```

---

### Task 6: Verify all tests pass together

**Step 1: Run the full test suite (excluding evals)**

Run: `cd pipecat-agent && python -m pytest tests/ -v -m "not eval"`
Expected: All existing tests pass, eval tests excluded.

**Step 2: Run evals separately**

Run: `cd pipecat-agent && python -m pytest tests/ -m eval -v -s`
Expected: Eval tests run with scores printed.

**Step 3: Document usage in a comment at the top of test_eval_tone.py**

The file already has a docstring with the run command. Verify it's accurate.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify eval suite integration with existing test suite"
```
