# Prompt Eval Suite Design

**Date:** 2026-02-22
**Status:** Approved
**Problem:** No systematic way to measure whether prompt changes improve or degrade conversational tone quality. Current feedback loop is manual spot-checking of call recordings.

## Context

CallLock's voice agent uses GPT-4o as a text generator within a deterministic state machine. The LLM never controls flow — it only generates conversational responses. Quality depends entirely on how well `prompts.py` (PERSONA + STATE_PROMPTS) produces dispatcher-like speech.

Current quality assessment: listen to recordings, spot-check, gut feel. No way to answer "did this prompt change make things better or worse?" quantitatively.

## Approach: Local Pytest Eval Suite

Build a lightweight eval harness that:
1. Feeds real call transcript snippets through `prompts.py` → GPT-4o
2. Scores responses with GPT-4o-mini as judge against a rubric
3. Runs via `pytest -m eval` (manually, not in CI)

### Why not OpenAI's evals repo?

The `github.com/openai/evals` repo is effectively abandoned (last code change Sep 2024, OpenAI now points users to their hosted dashboard). The concepts are sound but the tooling is dead. A local pytest harness is simpler, uses existing infrastructure, and tests the actual `get_system_prompt()` function.

### Why not a full eval framework (Braintrust, Promptfoo)?

Overkill for a 16-state voice agent with one persona. Setup cost measured in days, not hours. Can upgrade later if the pattern proves valuable.

## Components

### 1. Golden Transcripts (`tests/eval_data/golden_transcripts.json`)

Curated state-specific conversation snippets from real calls. Each entry:

```json
{
  "id": "discovery_verbose_fail",
  "state": "discovery",
  "session": {
    "customer_name": "",
    "zip_code": "78745",
    "problem_description": "",
    "service_address": ""
  },
  "conversation": [
    {"role": "user", "content": "Yeah my AC's been blowing warm since yesterday morning"}
  ],
  "expect": {
    "max_sentences": 2,
    "must_paraphrase": true,
    "forbidden_words": ["transition", "process", "handle"],
    "should_ask": "name"
  }
}
```

Start with 10-15 snippets covering the most common states (WELCOME, DISCOVERY, SAFETY, URGENCY, PRE_CONFIRM). Add snippets whenever a spot-checked call reveals tone issues.

### 2. Rubric (`tests/eval_data/rubric.py`)

Seven dimensions scored 1-5:

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| Brevity | 20% | 1-2 sentences max, no filler |
| Paraphrasing | 15% | Professional reframe, not parrot |
| Forbidden words | 10% | No AI-isms, no forbidden words |
| State compliance | 20% | Asks exactly what the state requires |
| Persona fidelity | 10% | Sounds like a dispatcher, not a chatbot |
| Tone matching | 15% | Mirrors caller energy |
| Spoken flow | 10% | Natural spoken aloud, no written-language constructions |

**Pass threshold:** Weighted average >= 3.5

The judge prompt instructs GPT-4o-mini to score each dimension and return structured JSON. The user writes/edits the judge prompt since it encodes domain knowledge of what real dispatchers sound like.

### 3. Eval Test Harness (`tests/test_eval_tone.py`)

```python
@pytest.mark.eval
@pytest.mark.asyncio
async def test_tone_quality(snippet):
    # 1. Build session from snippet data
    # 2. Call get_system_prompt(session) — real prompts.py
    # 3. Send to GPT-4o (temperature=0) — real API call
    # 4. Send response to GPT-4o-mini judge with rubric
    # 5. Assert weighted_score >= 3.5
```

- Uses `@pytest.mark.eval` — skipped by default, run with `pytest -m eval -v`
- Real API calls (~2-3s per snippet, ~$0.01 per run)
- Temperature 0 for both agent and judge (still ~10% variance)
- Parametrized over all snippets in golden_transcripts.json

### 4. Pytest Config

Register the `eval` marker in `pyproject.toml` to suppress warnings.

## File Layout

```
pipecat-agent/
  tests/
    eval_data/
      golden_transcripts.json    # ~100 lines (data)
      rubric.py                  # ~80 lines
    test_eval_tone.py            # ~120 lines
  pyproject.toml                 # +3 lines (marker)
```

**Total:** ~300 lines of new code.

## What This Enables

- Run `pytest tests/ -m eval -v` after any prompt change
- Per-snippet, per-dimension scores in terminal output
- Fail if any snippet drops below threshold
- Growing corpus of "known good/bad" conversations

## What This Intentionally Omits

- No CI integration (manual runs only)
- No A/B comparison dashboard (terminal output)
- No transcript ingestion pipeline (paste snippets by hand)
- No TTS evaluation (text quality only, not audio)

These are future upgrades once the core feedback loop proves valuable.

## User Contribution

The judge prompt — the 10-15 lines that define what a 5/5 dispatcher response sounds like — will be written/edited by the user. A starting draft will be provided as scaffolding.
