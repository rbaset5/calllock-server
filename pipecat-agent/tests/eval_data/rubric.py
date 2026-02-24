"""Rubric for scoring voice agent conversational quality.

Seven dimensions scored 1-5 by an LLM judge. Weighted average
must meet PASS_THRESHOLD to pass.
"""

import json

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


def parse_judge_scores(raw: str) -> dict[str, int]:
    """Parse and validate judge response JSON.

    Handles: clean JSON, markdown-fenced JSON, extra whitespace.
    Raises ValueError for malformed or missing dimensions.
    """
    cleaned = raw.strip()

    # Strip markdown code fences if present
    if cleaned.startswith("```"):
        lines = cleaned.split("\n", 1)
        if len(lines) > 1:
            cleaned = lines[1]
        cleaned = cleaned.rsplit("```", 1)[0].strip()

    try:
        scores = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"Judge returned invalid JSON: {e}\nRaw: {raw!r}")

    if not isinstance(scores, dict):
        raise ValueError(f"Judge returned {type(scores).__name__}, expected dict")

    for dim in DIMENSIONS:
        if dim not in scores:
            raise ValueError(f"Judge missing dimension: {dim}")
        if not isinstance(scores[dim], (int, float)):
            raise ValueError(f"Non-numeric score for {dim}: {scores[dim]!r}")
        if not 1 <= scores[dim] <= 5:
            raise ValueError(f"Score out of range for {dim}: {scores[dim]}")

    return scores
