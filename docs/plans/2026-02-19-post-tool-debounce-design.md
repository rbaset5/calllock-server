# Post-Tool Debounce Buffer Design

**Date:** 2026-02-19
**Status:** Approved
**Call reference:** CA84af5e727660ea9bd82da5b986060779 (Jonas, repeat caller)

## Problem

When `lookup_caller` returns fast (653ms) and transitions LOOKUP→SAFETY, the processor immediately triggers the LLM via `force_llm=True`. The LLM generates the safety question and TTS starts — while the caller is still mid-sentence explaining their problem.

The caller hears partial agent audio overlapping with their own speech. This causes:
1. Overlapping speech (bad UX — feels like being interrupted)
2. Garbled STT ("air conditioning" becomes "air ticket" from crosstalk)
3. Interrupt/re-trigger loop (each fragment interrupts and re-generates)
4. Caller hangs up in frustration (19.7s, abandoned)

### Root cause

`processor.py` lines 126-131: after a tool call transitions state, `force_llm=True` pushes the transcription downstream immediately. There is no awareness of whether the caller is still speaking. Deepgram STT fragments arrive asynchronously — "Yeah. I'm" is finalized while the caller is still saying "...currently having a problem with my air conditioning."

## Solution

Add a **post-tool debounce buffer** in `StateMachineProcessor`. After a tool transition sets `force_llm=True`, the processor enters "buffer mode" instead of pushing to the LLM immediately. Incoming transcription fragments are accumulated. Once the caller finishes speaking (no new fragment for 1.5s), a single concatenated frame is pushed to the LLM.

## Design

### New processor state

```python
_buffer_mode: bool = False           # Are we accumulating?
_buffer_texts: list[str] = []        # Accumulated fragment texts
_buffer_timer: asyncio.Task | None   # Debounce timer handle
_buffer_frame: TranscriptionFrame    # Latest frame (used to push downstream)
BUFFER_DEBOUNCE_S = 1.5              # Wait this long after last fragment
BUFFER_MAX_S = 5.0                   # Maximum total buffer time
_buffer_start_time: float = 0        # When buffer mode started
```

### Modified flow in `_handle_transcription`

```
1. TranscriptionFrame arrives
2. Add to conversation_history + transcript_log (same as now)
3. Run state machine → get Action
4. Execute tool if needed; set force_llm if state changed

5. IF force_llm AND not already buffering:
   → Enter buffer mode
   → Store text in _buffer_texts
   → Start 1.5s debounce timer
   → Return (don't push downstream)

6. ELIF _buffer_mode:
   → Run state machine on text (for state logic — accumulates data)
   → Store text in _buffer_texts
   → Reset debounce timer
   → Check max buffer time (5s) — if exceeded, flush immediately
   → Return

7. ELSE (normal path — unchanged):
   → Push frame downstream if needs_llm or force_llm
```

### Debounce timer callback (`_flush_buffer`)

```
1. Set _buffer_mode = False
2. Concatenate _buffer_texts with spaces
3. Add combined text to context.messages as one user message
4. Push _buffer_frame downstream → triggers LLM with full context
5. Clear buffer state
```

### Concatenation rationale

The LLM sees `"Yeah. I'm currently having a problem with my air conditioning"` as one coherent message instead of 4 fragments. This produces a better, more contextually appropriate response.

During buffer mode, fragment texts are NOT added to context.messages individually (they go in conversation_history for extraction, but not in context.messages which feeds the LLM). On flush, the concatenated text is added once.

### Edge cases

| Scenario | Behavior |
|----------|----------|
| Caller says one word and stops | Buffer collects one fragment, timer fires at 1.5s, LLM responds |
| Caller talks for 10 seconds | Buffer accumulates fragments, max cap at 5s flushes early |
| Tool returns after caller already stopped | First fragment enters buffer, timer fires at 1.5s |
| `end_call` action during buffer | Flush buffer immediately, then process end_call |
| Another tool call during buffer | Flush buffer first, then execute tool |
| No fragments arrive after tool | Timer fires at 1.5s with initial text only |

## Files changed

| File | Change |
|------|--------|
| `pipecat-agent/src/calllock/processor.py` | Add buffer mode logic, `_flush_buffer` method |
| `pipecat-agent/tests/test_processor.py` | Tests: accumulation, timer flush, max cap, end_call bypass |

## What doesn't change

- State machine logic (states.py, state_machine.py)
- Pipeline assembly (pipeline.py)
- LLM prompts
- Turn detection / VAD configuration
