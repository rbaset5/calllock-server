# Design Review Outcome: book_service Payload + booking_status Fix

**Date:** 2026-02-20
**Trigger:** Call audit of Jonas call (CAa8f3a8bb42f75385e430f5f609d44164) revealed booking failure

## Overall Verdict

Tight review for a tight fix. The design review confirmed the two bugs are surgical — no architectural changes needed, no new abstractions. The main value was rejecting three scope-creep opportunities (V2 endpoint refactor, all-methods test coverage, TTS log tuning) that would have turned a 30-line fix into a multi-file project.

## What It Nailed

### The Over-Engineering Trap Avoided

Three escalation paths were explicitly presented and rejected:
1. **Refactoring V2 to Pipecat-native endpoints** (Architecture, Option C) — would have touched every endpoint in `server.ts`, added new routes, new validation schemas, and broken backward compatibility with Retell.
2. **Adding request-body assertions for ALL V2Client methods** (Tests, Option C) — ~50 lines across all 6 methods. Valuable but classic scope creep disguised as thoroughness.
3. **Adding a V2 compatibility layer** (Architecture, Option B) — would have coupled the V2 backend to knowing about Pipecat's payload quirks.

### The Key Insight

The `book_service` bug isn't an architecture problem — it's a copy-paste omission. Five out of six methods in `tools.py` already use the correct `{ call, args }` format. The fix is making the outlier consistent. Similarly, `booking_attempted` already exists on `CallSession` for exactly the purpose `_derive_booking_status` needs — the field was just never wired in.

### The Delta (Before vs. After)

No delta between v1.0 and v1.1 — the initial plan was already minimal. The review confirmed minimalism was correct and rejected three plausible escalations. Total scope: ~26 lines across 4 files, no new files, no new abstractions, no migrations.

## The Final Plan (v1.1)

1. `tools.py:84-92` — Wrap `book_service` payload in `{ call, args }` format matching all other methods
2. `post_call.py:48-49` — Replace narrow `state == CALLBACK and caller_confirmed` check with `session.booking_attempted`
3. `test_tools.py` — Add request-body assertion to `book_service` test validating `call` and `args` keys
4. `test_post_call.py` — Add test for `state=BOOKING_FAILED, booking_attempted=True` asserting `booking_status == "attempted_failed"`
5. TDD order: write failing tests first, then apply fixes

## Scope Boundaries

| NOT in scope | Why | When it might matter |
|---|---|---|
| V2 Pipecat-native endpoints | Retell wrapper is the established contract; one outlier is a bug, not architecture | When Retell support is fully dropped |
| Request-body assertions for all V2Client methods | Good hygiene but unrelated to these bugs | Separate PR |
| Inworld TTS log tuning | One data point, fallback worked | If pattern appears across multiple calls |
| Transcript fragmentation in early states | Debounce buffer is post-tool only by design | If caller feedback indicates confusion |
