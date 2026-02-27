# Call Quality Fixes Round 2 — Design

**Date:** 2026-02-24
**Call analyzed:** CA446d05699f041290d963302bc94587e9 (145.6s, ended in CONFIRM)
**Branch:** rbaset5/urgency-state-fixes

## Context

Round 1 fixes (PR #67) addressed: em dash in canned TTS, ambiguous "no" in CONFIRM close signals, StartFrame noise filter, callback promise data surfacing. This round addresses what worked, what didn't, and new bugs found from a production call.

## Round 1 Fix Status

| Fix | Status | Evidence |
|-----|--------|----------|
| Remove "no"/"nope"/"nah" from CONFIRM_CLOSE_SIGNALS | WORKS | User said "No." → routed to LLM, not canned close |
| Em dash removed from canned TTS strings | WORKS | No UTF-8 codec errors |
| Callback promise in KNOWN INFO | WORKS | Prompt contains callback data |
| StartFrame noise filter | BROKEN | 50+ StartFrame errors still flood logs; filter targets stdlib logging but pipecat uses loguru |
| Callback promise acknowledgment | BROKEN | SAFETY prompt says "after safety check" but state machine transitions before LLM can deliver |

## Bugs to Fix

### Bug 1: StartFrame noise filter targets wrong logging framework

**Symptom:** 50+ `StartFrame not received` ERROR lines per call in Fly.io logs.
**Root cause:** `bot.py` applies `logging.Filter` to stdlib `logging.getLogger("pipecat.processors.frame_processor")`. Pipecat uses loguru internally. The filter has zero effect.
**Fix:** Use loguru's native filter API. Add a filter function to loguru that suppresses messages containing "StartFrame not received" from the `pipecat.processors.frame_processor` module.

### Bug 2: Call ending is irrevocable after CONFIRM Turn 2

**Symptom:** User said "No" to "Anything else?" then wanted to ask a follow-up question. Agent was already speaking goodbye; call ended.
**Root cause:** `_handle_confirm` returns `Action(end_call=True, needs_llm=True)` on Turn 2. `_delayed_end_call(delay=3.0)` fires as a fire-and-forget asyncio task. No cancellation mechanism exists.
**Fix:** Store the delayed end task handle on the processor. If a new TranscriptionFrame arrives while the delay is active, cancel it, reset CONFIRM state to allow one more exchange, and process the new input.

### Bug 3: 27-second dead air between DISCOVERY and URGENCY question

**Symptom:** User said "Hello?" twice waiting for the urgency question. LLM wasted a turn generating a summary before asking.
**Root cause:** After DISCOVERY auto-transitions to URGENCY with canned "Got it." (`needs_llm=False`), the next user input triggers an LLM call. The LLM generates a recap instead of the urgency question, wasting a turn.
**Fix:** When DISCOVERY detects all fields collected and transitions to URGENCY, emit a canned urgency question directly: "Got it. How urgent is this - need someone today, or this week works?" This eliminates the LLM latency entirely.

### Bug 4: Callback promise acknowledgment never delivered

**Symptom:** Lookup returned `callbackPromise: {date: "today", issue: "being really loud"}`. Agent never mentioned it.
**Root cause:** SAFETY prompt says "acknowledge AFTER safety check" but state machine transitions to SERVICE_AREA immediately after "No." The LLM never gets another SAFETY turn.
**Fix:** Move callback acknowledgment to the URGENCY prompt. URGENCY is the first LLM-generated state after the deterministic SERVICE_AREA/DISCOVERY flow, making it the natural place for the acknowledgment.

### Bug 5: LLM-generated em dashes are a latent TTS crash risk

**Symptom:** LLM generated `—` in SAFETY and URGENCY responses. Inworld TTS processed them without error this time, but the UTF-8 chunk boundary issue is stochastic.
**Fix:** Add a text sanitizer in the processor that replaces `—` with `-` in all text before it reaches TTS. Apply to both LLM-generated text and any other text frames.

## Architecture

All fixes are in `pipecat-agent/src/calllock/`:

| File | Changes |
|------|---------|
| `bot.py` | Replace stdlib logging filter with loguru filter |
| `processor.py` | Cancellable `_delayed_end_call`; em dash sanitizer on outbound text |
| `state_machine.py` | DISCOVERY→URGENCY canned question; CONFIRM Turn 3 support |
| `prompts.py` | Move callback acknowledgment from SAFETY to URGENCY |

## Non-Goals

- Fixing ZIP code misinterpretation ("Five two one one" as address vs ZIP) — this is a transcription/UX issue, not a state machine bug
- Fixing the "wrap sound" transcription — Deepgram STT limitation
- Changing the two-turn CONFIRM flow fundamentally — the cancellable delay is sufficient
