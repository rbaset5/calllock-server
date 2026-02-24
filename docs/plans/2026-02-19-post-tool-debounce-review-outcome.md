# Design Review Outcome: Post-Tool Debounce Buffer

**Date:** 2026-02-19
**Review type:** SMALL CHANGE (4 sections, 1 issue each)
**All recommendations accepted:** A, A, A, A

## Overall Verdict
The review caught a real bug (turn_count inflation + silent state transitions during buffer mode), a DRY violation, a missing safety-critical test, and a 10-second test suite slowdown. The key architectural fix fundamentally simplified the buffer's contract.

## What It Nailed

### The Hidden Bug Avoided
The v1.0 plan ran `machine.process()` on every fragment during buffer mode:
- `session.turn_count` incremented 3-4 times for one logical user turn (premature 30-turn limit)
- `_handle_safety()` ran on each fragment — "gas smell" would silently transition to SAFETY_EXIT while the buffer kept accumulating
- Required `_cancel_buffer` and end_call+buffer interaction code to patch the desync

### The Key Insight
Buffer mode means "the caller is still talking — do nothing until they're done." Passive accumulation only. The flush becomes the single point where everything happens: state machine, extraction, prompt update, end_call detection. One entry, one exit.

### The Delta (v1.0 → v1.1)
- Removed: `_cancel_buffer`, end_call+buffer flush interaction, state machine during buffer
- Added: state machine + extraction + end_call in `_flush_buffer` (self-contained)
- Net: simpler contract, fewer code paths
- Tests: ~10s faster (0.05s debounce in fixture)
- Coverage: +1 safety-critical test (emergency during buffer mode)

## The Final Plan (v1.1)
1. **Buffer entry**: `force_llm=True` after tool transition → store text, start 1.5s debounce timer
2. **During buffer**: Skip state machine. Accumulate text, reset timer, check max time (5s)
3. **On flush**: Run state machine once on concatenated text. Update prompt. Extraction. Handle end_call. Push single TranscriptionFrame.
4. **Normal path**: Unchanged

## Scope Boundaries
- VAD-aware deferral: emulated events fire per-fragment, defeating tracking
- Dynamic BUFFER_DEBOUNCE_S tuning: no production data yet
- STT fragmentation at source: separate concern (Deepgram endpointing)
- Pipeline-level interruption suppression: buffer only affects post-tool transitions
