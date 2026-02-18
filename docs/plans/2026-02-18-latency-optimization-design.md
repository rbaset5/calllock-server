# Latency Optimization + Dead-Air Bug Fix

**Date:** 2026-02-18
**Branch:** `rbaset5/latency-optimization`
**Goal:** Reduce end-to-end voice response latency from ~1,300ms to ~550-700ms and fix a 26-second dead-air bug after lookup_caller completes.

## Problem Statement

### Latency
End-to-end voice latency (user stops speaking → first audio byte back) averages ~1,300ms. The two largest contributors are:

| Stage | Current Cost |
|---|---|
| VAD silence detection (`stop_secs=0.3`) | 300ms |
| Custom debounce buffer (`_debounce_seconds=0.4`) | 400ms |
| **Total dead time before processing starts** | **700ms** |

### Dead-Air Bug (Critical)
Discovered in call `CAd2b972dccb4d528021a371bf63529198` (2026-02-18). After WELCOME → LOOKUP → SAFETY transitions via tool result, no LLM response is triggered. The agent goes silent for 26 seconds until the caller says "Hello?"

**Root cause:** The WELCOME handler returns `Action(needs_llm=False)` because it's handing off to lookup_caller. After the tool completes and `_tool_result_lookup_caller` transitions to SAFETY, the processor never pushes a frame downstream because the original Action's `needs_llm` was False.

**Contributing factor:** The debounce failed to coalesce "I am having a problem with my air" + "conditioning unit." — a natural speech pause > 400ms caused a split utterance, which triggered a duplicate lookup_caller.

## Design

### Change 1: Fix post-tool dead-air bug

**File:** `processor.py`

After `_execute_tool` completes, check if the state changed (tool result handlers can transition state). If the new state is a decision state that expects conversation, override `needs_llm=True` so the LLM generates a response for the new state.

Logic:
```python
state_before = self.session.state
await self._execute_tool(action)
state_after = self.session.state

# If tool transitioned us to a new state that needs conversation,
# force an LLM response even if original action had needs_llm=False
if state_after != state_before and state_after.is_decision:
    action.needs_llm = True
```

This ensures the caller hears a greeting/question after lookup completes, rather than silence.

### Change 2: Smart Turn replaces debounce

**Files:** `pipeline.py`, `processor.py`

Replace the custom 400ms debounce + 300ms VAD with Pipecat's `LocalSmartTurnAnalyzerV3`:

- **pipeline.py:** Add `turn_analyzer=LocalSmartTurnAnalyzerV3()` to transport params. Drop `stop_secs` from 0.3 to 0.2.
- **processor.py:** Remove `_debounce_seconds`, `_debounce_buffer`, `_debounce_task`, and `_debounce_fire()`. TranscriptionFrames go directly to `_handle_transcription`.

Smart Turn uses an ML model (ONNX, local CPU inference) that understands semantic turn completion. It handles utterance coalescing natively — "my air... conditioning unit" would be held as incomplete until the full phrase arrives.

**Expected savings:** ~500ms off critical path.

### Change 3: gpt-4o-mini for conversation

**File:** `pipeline.py`

Change `model="gpt-4o"` → `model="gpt-4o-mini"` for the pipeline LLM service. The LLM only generates natural conversational text (it never controls flow, invokes tools, or makes decisions). gpt-4o-mini produces equally natural output at ~100-150ms TTFT vs gpt-4o's ~300-500ms.

Extraction (extraction.py) already uses gpt-4o-mini. No change needed there.

**Expected savings:** ~100-200ms additional.

### Change 4: Connection pooling for V2Client

**File:** `tools.py`

Currently creates a new `httpx.AsyncClient` per request. Move to a shared client with connection pooling to avoid TCP+TLS handshake overhead on each tool call.

```python
class V2Client:
    def __init__(self, base_url, api_key="", timeout=10.0):
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers=self._build_headers(api_key),
            timeout=timeout,
        )
```

Add `async def close()` for cleanup at call end.

## Latency Budget (Before vs After)

| Stage | Before | After |
|---|---|---|
| VAD + turn detection | 300 + 400 = **700ms** | **200ms** (Smart Turn) |
| STT finalization | ~75ms | ~75ms |
| State machine | ~0ms | ~0ms |
| LLM TTFT | ~350ms (gpt-4o) | ~150ms (gpt-4o-mini) |
| TTS TTFB | ~200ms | ~200ms |
| Transport | ~15ms | ~15ms |
| **Total** | **~1,340ms** | **~640ms** |

## Files Touched

| File | Changes |
|------|---------|
| `pipeline.py` | Smart Turn, lower VAD, gpt-4o-mini |
| `processor.py` | Remove debounce, post-tool LLM trigger |
| `tools.py` | Connection pooling |
| Tests | Update debounce tests, add post-tool tests |

## What Stays the Same

- State machine logic (`state_machine.py`)
- Prompts (`prompts.py`)
- TTS configuration
- Extraction (`extraction.py`)
- Session dataclass (`session.py`)
- Post-call handling

## Rollback

Each change is independently revertable:
- Smart Turn: revert pipeline.py transport params + restore debounce
- gpt-4o-mini: change one line back to gpt-4o
- Connection pooling: revert to per-request clients
- Post-tool fix: revert processor.py state check

## Testing

1. All 166 existing tests must pass
2. New tests for post-tool LLM trigger (WELCOME → LOOKUP → SAFETY triggers response)
3. Smoke test: real call verifying no dead air after lookup
4. Latency observation via logs (timestamp at transcription arrival vs frame push)
