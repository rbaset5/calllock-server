# Design Review Outcome — Booking Confirmation Fixes

**Date:** 2026-02-23
**Plan reviewed:** `docs/plans/2026-02-23-booking-confirmation-fixes-plan.md`

## Overall Verdict

The review worked well. It caught a second field mismatch hiding in plain sight (`issue_description` → `problem_description`), eliminated a fragile LLM context injection pattern in favor of the existing system prompt pipeline, removed dead code and an impossible test case, and simplified the datetime resolution logic. The delta between v1.0 and v1.1 is meaningful — not a scope collapse (v1.0 was already tight), but a quality upgrade that prevents subtle bugs the original plan would have shipped.

## What It Nailed

**The Architecture Smell Caught:**
v1.0 injected booking details as a fake `{"role": "user", "content": "[System: ...]"}` message into the LLM context. This was fragile — it relied on the LLM recognizing a made-up convention, polluted the conversation history with non-caller messages, and could be stripped by future code that filters user messages. The review identified that `_build_context()` in `prompts.py` already renders session fields into the system prompt every turn, and the CONFIRM state prompt literally says "read the booking details." The natural fix is to put booking details where the prompt already looks for them.

**The Hidden Bug Found:**
The Pipecat agent sends `"issue_description"` but V2 reads `args.problem_description` — a second field mismatch in the exact same payload as the `preferred_time`/`date_time` bug. Same bug class, same file, same function. v1.0 would have fixed one mismatch while leaving the other silently dropping the problem description from Cal.com bookings.

**The Key Insight:**
The system prompt is rebuilt every turn from session state (`get_system_prompt` → `_build_context`). Any data that needs to reach the LLM should go through session fields, not through injected messages. This is consistent with the project's core principle: code controls flow, LLM generates words.

**The Delta (Before vs. After):**
- v1.0: 6 tasks, `[System:]` message injection, even-hour rounding, dead hyphen check, impossible "twenty" test, one of two field mismatches fixed
- v1.1: 6 tasks (same count), system prompt approach via `_build_context()`, simplified datetime logic, clean `_normalize_address_number`, correct test scope, both field mismatches fixed, new `test_prompts.py` for prompt rendering

## The Final Plan (v1.1)

1. **Task 1:** Add `resolve_booking_time()` — maps "ASAP"/"today"/"tomorrow" to ISO datetime. Simple `now + 2h` truncated, no rounding. Includes `"same day"` and `"morning"` keywords.
2. **Task 2:** Fix both `tools.py` field mismatches — `preferred_time` → `date_time` AND `issue_description` → `problem_description`. Resolve datetime before sending.
3. **Task 3:** Store `confirmation_message` on `CallSession`, set it in `_execute_tool` after booking, render via `_build_context()` in CONFIRM state. 4 targeted tests across processor and prompts.
4. **Task 4:** Move `WORD_TO_DIGIT` + `words_to_digits` from state_machine.py to validation.py (shared utility).
5. **Task 5:** Add `_normalize_address_number` to `validate_address()` — converts "53 Eleven" → "5311". Single-digit words only.
6. **Task 6:** Full test suite + deploy to Fly.io.

## Scope Boundaries

- **"Twenty"/"thirty"/compound number words** — NOT in scope. `WORD_TO_DIGIT` only maps single digits. The realistic STT artifact is "53 Eleven" not "One Twenty Three." Adding tens-words would require compound parsing ("twenty three" → "23") which is real complexity for a hypothetical case.
- **Cal.com slot availability validation** — NOT in scope. `resolve_booking_time` is a hint. Cal.com picks the real slot and returns it in its response. The local resolution just prevents `undefined`/`Invalid Date`.
- **V2 backend changes** — NOT in scope. V2 already handles ISO datetimes and returns formatted confirmation messages. All fixes are Pipecat-side.
- **CONFIRM state as terminal/canned** — NOT in scope. CONFIRM benefits from LLM flexibility for follow-up questions ("What should I do until then?"). It stays as a decision state with LLM generation.
