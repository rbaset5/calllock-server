# Design Review Outcome — Call Quality Fixes Round 2

**Date:** 2026-02-24
**Plan reviewed:** `docs/plans/2026-02-24-call-quality-fixes-round2-plan.md`
**Review type:** BIG CHANGE (4 sections, interactive)

---

## Overall Verdict

The review caught a critical architecture conflict where two fixes would have silently cancelled each other out, eliminated an unnecessary pipeline component, fixed a type mismatch that would have made the canned acknowledgment hacky, and added 7 missing tests. The v1.0 plan had 5 independently-reasonable fixes that, when composed, contained a logical contradiction. The review caught it before implementation.

## What It Nailed

### The Architecture Conflict Caught

v1.0 proposed Task 2 (canned urgency question from DISCOVERY with `needs_llm=False`) and Task 4 (callback acknowledgment moved to the URGENCY prompt, which is LLM-dependent) as independent fixes. In the happy path — user answers with "today" keyword — `_handle_urgency` catches the keyword deterministically and transitions to PRE_CONFIRM without ever calling the LLM. The URGENCY prompt, with its carefully-worded callback acknowledgment instruction, never fires. Two "fixes" that each looked correct in isolation would combine to guarantee the callback promise was never acknowledged — reproducing the exact bug they were supposed to fix.

### The Key Insight

Both the callback acknowledgment and the urgency question are deterministic data. We know the callback promise exists (from lookup result). We know the urgency question needs asking (all discovery fields collected). Neither requires LLM generation. Folding both into a single conditional canned speak from `_handle_discovery` matches the project's core principle perfectly: "code controls flow, LLM generates words." The callback acknowledgment becomes code-guaranteed delivery, not prompt-compliance-dependent.

### The Over-Engineering Avoided

v1.0 proposed a `TextSanitizer` — a full `FrameProcessor` subclass inserted into the 9-node pipeline between LLM and TTS — to replace em and en dashes with plain dashes. This new processor would have called `isinstance()` on every frame in the pipeline, including audio frames arriving at 50/sec, to do a 2-character string replacement on the occasional text frame. The review identified that `FallbackTTSService.run_tts()` already wraps every TTS call and is the natural single point for sanitization — 3 lines, no new class, no pipeline change.

### The Delta (Before vs. After)

| Aspect | v1.0 | v1.1 |
|--------|------|------|
| New classes | 1 (`TextSanitizer` pipeline processor) | 0 |
| Pipeline nodes | 10 (added 1) | 9 (unchanged) |
| Conflicting fixes | 2 (Task 2 + Task 4 silently cancel) | 0 (merged into single mechanism) |
| Tests in plan | 3 | 10 (filter: 3, cancellation: 4, edge case: 1, callback: 2) |
| `callback_promise` type | `str` storing a dict, ugly prompt rendering | `dict` with proper rendering |
| `logger.remove()` blast radius | All loguru handlers | Handler ID 0 only |
| Em dash sanitizer location | New pipeline processor (every frame) | Inside existing `run_tts` (text only) |
| Cancellation bound | Unbounded (infinite re-trigger possible) | Exactly 1 via `confirm_extended` flag |

## The Final Plan (v1.1)

1. **Loguru filter** — `logger.remove(0)` with try/except + `logger.add(filter=...)`. 3 unit tests for filter function.

2. **Canned urgency question with conditional callback ack** — `_handle_discovery` emits callback acknowledgment + urgency question as one canned speak when all fields known. `URGENCY_QUESTION` extracted as module constant. `callback_promise` type changed from `str` to `dict` with clean rendering in `_build_context`. SAFETY prompt callback instruction removed (unreachable).

3. **Cancellable delayed end with `confirm_extended` flag** — `_end_call_task` stored on processor, cancelled on new transcription. First cancellation allowed (sets `confirm_extended=True`), second cancellation blocked (call ends). 4 tests: succeed, blocked, downstream push verified, race edge case documented.

4. **Em dash sanitizer in `FallbackTTSService.run_tts`** — `text = text.replace("\u2014", "-").replace("\u2013", "-")` before passing to primary/fallback. No new class.

5. **Remove callback ack from SAFETY prompt** — instruction was unreachable (state machine transitions before LLM fires).

## Scope Boundaries

| Not in scope | Why | When it might matter |
|-------------|-----|---------------------|
| ZIP code misinterpretation ("5211" as ZIP) | Transcription/UX issue, not state machine bug | If misrouting shows up frequently in call analytics |
| "Wrap sound" transcription quality | Deepgram STT limitation, not fixable in our code | When Deepgram ships telephony-optimized models |
| Redundant urgency question when already expressed | Extraction runs async, may not be done; 2s redundancy acceptable | When extraction becomes synchronous or guaranteed-complete |
| CONFIRM Turn 3+ redesign | One cancellation covers "changed my mind"; per-state limit catches abuse | If analytics show frequent multi-question close sequences |
| Pipecat loguru deprecation warnings | Cosmetic, from pipecat's internal API migration | When upgrading pipecat to next major version |
| StartFrame errors (cosmetic) | Prior review proved these are non-functional; `run_tts` yields via generators, bypassing `push_frame` | When Pipecat fixes inner-service StartFrame propagation |
