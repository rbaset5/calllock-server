# Fix: Callback Skip + Dashboard Webhook 400s

**Date:** 2026-02-16
**Branch:** rbaset5/pipecat-post-call
**Status:** Design approved, ready for implementation

## Problem

Two bugs discovered in the Pipecat agent from the most recent test call (`CA2dbef953072c9722864a35abc3639b22`):

### Bug 1: Call skipped discovery/confirm/booking, went straight to callback

**Root cause:** `state_turn_count` not reset on state transitions in 4 of 8 state handlers.

The state machine increments `state_turn_count` at the top of `process()` before any handler runs. When Deepgram STT fragmented a single utterance into 3 separate `TranscriptionFrame`s ("Yeah.", "Mhmm.", "Yeah. It's a broken cover."), each triggered `process()` independently, inflating the count to 4 while still in SAFETY. The `_handle_safety` handler transitioned to SERVICE_AREA without resetting `state_turn_count`. Two more turns in SERVICE_AREA pushed the count to 6, exceeding `MAX_TURNS_PER_STATE` (5), and the turn limit check escalated to CALLBACK before ZIP extraction could run.

**Affected handlers** (don't reset `state_turn_count`):
- `_handle_welcome` → transitions to LOOKUP, CALLBACK
- `_handle_safety` → transitions to SERVICE_AREA, SAFETY_EXIT
- `_handle_discovery` → transitions to CONFIRM
- `_handle_confirm` → transitions to BOOKING, CALLBACK

**Contributing factor:** Deepgram STT sends rapid-fire transcription fragments for a single utterance, inflating turn counts and triggering unnecessary LLM/extraction calls.

### Bug 2: Dashboard webhook POSTs return 400 Bad Request

**Root cause:** Three schema mismatches between Pipecat payloads and dashboard Zod schemas.

1. **`urgency: "routine"`** — `session.urgency_tier` defaults to `"routine"`, but `urgencySchema` requires `z.enum(['low', 'medium', 'high', 'emergency'])`.
2. **`transcript_object` contains `role: "tool"`** — `to_json_array()` includes tool invocation entries, but `transcriptMessageSchema` only accepts `role: z.enum(['agent', 'user'])`.
3. **`started_at: ""`** (edge case) — if `session.start_time == 0`, an empty string is sent, failing `z.string().datetime()`.

## Design

### Fix 1: Reset `state_turn_count` on all state transitions

Add `session.state_turn_count = 0` in every handler that changes `session.state`:
- `_handle_welcome`: after setting LOOKUP or CALLBACK
- `_handle_safety`: after setting SERVICE_AREA or SAFETY_EXIT
- `_handle_discovery`: after setting CONFIRM
- `_handle_confirm`: after setting BOOKING or CALLBACK

**Files:** `state_machine.py`

### Fix 2: Transcription debounce in processor

Add a 400ms debounce in `StateMachineProcessor._handle_transcription()`:

1. On `TranscriptionFrame`, buffer text and start/restart a 400ms `asyncio.Task`
2. If another frame arrives within 400ms, append text and restart timer
3. On timer expiry, feed coalesced text as single turn to `machine.process()`

**Why 400ms:** Deepgram final transcription fragments for one utterance arrive within 200-300ms. 400ms gives margin without perceptible conversational latency (human pauses are 600-1200ms).

**Impact:** Reduces inflated turn counts, eliminates redundant LLM/extraction calls. Adds ≤400ms latency to first response per utterance.

**Files:** `processor.py`

### Fix 3a: Urgency mapping at payload boundary

Add `_map_urgency()` in `post_call.py`:

| Pipecat internal | Dashboard enum |
|-----------------|----------------|
| `"routine"` | `"low"` |
| `"low"` | `"low"` |
| `"medium"` | `"medium"` |
| `"high"` | `"high"` |
| `"emergency"` | `"emergency"` |

Applied in `build_job_payload()`. Internal `session.urgency_tier` unchanged.

**Files:** `post_call.py`

### Fix 3b: Filter tool entries from transcript

In `build_call_payload()`, filter `to_json_array()` output to only include `role: "agent"` and `role: "user"` entries before setting `transcript_object`.

**Files:** `post_call.py`

### Fix 3c: Guard `started_at` empty string

If `session.start_time == 0`, use `datetime.now(timezone.utc).isoformat()` as fallback instead of empty string.

**Files:** `post_call.py`

## Test Plan

1. **State machine turn count reset:** Test that `state_turn_count` resets to 0 after every state transition path. Test that turn limit still fires correctly within a single state.
2. **Debounce:** Test that rapid transcription frames within 400ms are coalesced. Test that frames >400ms apart are processed separately. Test that the debounce timer doesn't block `EndFrame` processing.
3. **Urgency mapping:** Test all input values map correctly. Test unknown values default to `"low"`.
4. **Transcript filtering:** Test that `role: "tool"` entries are removed from calls payload but preserved in jobs payload's `call_transcript` (plain text).
5. **DateTime guard:** Test that `started_at` is never an empty string.

## Files Changed

| File | Changes |
|------|---------|
| `state_machine.py` | Add `state_turn_count = 0` to 4 handlers |
| `processor.py` | Add debounce mechanism (~25 lines) |
| `post_call.py` | Add urgency mapping, transcript filter, datetime guard (~20 lines) |
| `tests/test_state_machine.py` | Turn count reset tests |
| `tests/test_processor.py` | Debounce tests |
| `tests/test_post_call.py` | Payload validation tests |
