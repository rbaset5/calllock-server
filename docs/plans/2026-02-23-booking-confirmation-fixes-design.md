# Booking Confirmation Fixes — Design

**Date:** 2026-02-23
**Status:** Approved
**Branch:** TBD (from `rbaset5/urgency-state-fixes`)

## Problem

Production test call (full WELCOME → CONFIRM flow, booking confirmed) revealed 3 issues:

1. **Invalid Date in confirmation** — `book_service` returns `"Appointment confirmed for Invalid Date at Invalid Date"` because Pipecat sends `preferred_time` ("ASAP") but V2 reads `args.date_time` (undefined → Invalid Date)
2. **CONFIRM state hallucination** — Agent says "Does that work for you?" after booking is already confirmed because the tool result's `confirmationMessage` is never injected into the LLM context
3. **Address number mangling** — STT transcribes "fifty three eleven" as "53 Eleven" instead of "5311"; `validate_address` doesn't normalize mixed number-word sequences

## Fix 1: Resolve preferred_time to ISO Datetime

**Root cause:** Two-layer mismatch:
- Field name: Pipecat sends `preferred_time`, V2 reads `args.date_time`
- Format: V2 expects ISO datetime, Pipecat sends human text ("ASAP", "today")

**Fix:** Add `resolve_booking_time(preferred_time: str) -> str` in `validation.py`.

Maps human text to ISO datetime strings:
- "ASAP" / "today" / "right away" / "soonest" → next even hour from now (or +2h if past business hours)
- "tomorrow" / "tomorrow morning" → 9:00 AM next day
- "this afternoon" → 2:00 PM today (or tomorrow if past 2PM)
- "this week" / "whenever" / empty → 9:00 AM next business day

Timezone: `America/Chicago` (Austin, TX).

In `tools.py`, send `"date_time": resolve_booking_time(preferred_time)` instead of `"preferred_time": preferred_time`.

V2 backend stays unchanged.

## Fix 2: Inject Booking Confirmation into LLM Context

**Root cause:** When `book_service` succeeds, the tool result handler transitions BOOKING → CONFIRM and sets `session.booking_confirmed = True`. But the `confirmationMessage` from the tool result is never added to the LLM's `context.messages`. The CONFIRM prompt says "Read the booking details" but no details exist in context.

**Fix:** In `processor.py`'s `_execute_tool()`, after `book_service` returns with `booking_confirmed=True`:
- Extract `confirmationMessage` from the tool result
- Append `{"role": "user", "content": f"[System: {confirmationMessage}]"}` to `self.context.messages`

Uses "user" role because Pipecat's OpenAI context expects user/assistant alternation. The `[System: ...]` wrapper clearly marks it as non-caller text.

## Fix 3: Address Number-Word Normalization

**Root cause:** Deepgram STT transcribes "fifty three eleven" as mixed "53 Eleven". The `validate_address` function doesn't handle compound number-word sequences in street numbers.

**Fix:** Add number-word normalization to `validate_address()` in `validation.py`:
1. Split address into tokens
2. Convert leading number-words: "53 Eleven" → "5311", "Fifty Three Eleven" → "5311"
3. Uses `WORD_TO_DIGIT` mapping (moved from `state_machine.py` to `validation.py` as shared utility)
4. Stop converting at first non-number token (street name starts)

Scope: Street number normalization only. "Hundred"/"thousand" compounds are out of scope.

## Files Changed

| File | Change |
|------|--------|
| `pipecat-agent/src/calllock/validation.py` | Add `resolve_booking_time()`, enhance `validate_address()` with number-word normalization, add `WORD_TO_DIGIT` |
| `pipecat-agent/src/calllock/tools.py` | Send `date_time` instead of `preferred_time` in `book_service` payload |
| `pipecat-agent/src/calllock/processor.py` | Inject `confirmationMessage` into LLM context after successful booking |
| `pipecat-agent/src/calllock/state_machine.py` | Import `WORD_TO_DIGIT` from `validation.py` instead of defining locally |
| `pipecat-agent/tests/test_validation.py` | Tests for `resolve_booking_time()` and address number normalization |
| `pipecat-agent/tests/test_processor.py` | Test for confirmation message injection |
| `pipecat-agent/tests/test_state_machine.py` | Verify `WORD_TO_DIGIT` import still works |

## Testing

- Unit tests for each fix
- Full test suite must pass
- Deploy to Fly.io and verify with a test call
