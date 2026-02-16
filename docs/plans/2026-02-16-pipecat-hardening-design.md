# Design: Pipecat Agent — Targeted Critical Fixes

## Context

The Pipecat voice agent is in R&D phase, tested via manual phone calls. A production readiness audit identified 20 issues across severity levels. This design covers the 5 targeted critical fixes that prevent silent failures and confusing behavior during test calls.

## Scope

Fix the things that would cause silent failures or stuck calls. Defer Dockerfile optimization, metrics, docs, graceful shutdown — those matter for production traffic, not R&D.

---

## Fix 1: Env Var Validation at Startup

**Problem:** Missing API keys cause mid-call failures instead of startup errors. `V2_BACKEND_URL` defaults to empty string so tool calls go nowhere.

**Design:** New `config.py` module with `validate_config()` called in `bot.py` at import time. Process exits with a clear error listing missing vars if any required key is absent.

Required (crash if missing):
- `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `INWORLD_API_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `V2_BACKEND_URL`

Optional (warn but continue):
- `DASHBOARD_WEBHOOK_URL`, `DASHBOARD_WEBHOOK_SECRET`, `DASHBOARD_USER_EMAIL`
- `INWORLD_VOICE_ID`, `DEEPGRAM_TTS_VOICE` (have defaults)

**Files:** new `config.py`, modify `bot.py`

---

## Fix 2: Dashboard Sync — Fix 400 Errors + Retry + Separate URLs

**Problem:** Deploy logs show `400 Bad Request` for `/api/webhook/jobs` and `/api/webhook/calls`. Dashboard sync is fire-and-forget — failed leads are silently lost. URLs are derived via fragile string replacement.

**Design:**
- Diagnose the 400s by reading dashboard webhook handlers to understand expected payload vs what we send.
- Add 1 retry with 2s backoff on failure (not a full queue — overkill for R&D).
- Replace string-replace URL hack with 3 separate env vars: `DASHBOARD_JOBS_URL`, `DASHBOARD_CALLS_URL`, `DASHBOARD_ALERTS_URL`. This matches the target architecture in CLAUDE.md.

**Files:** `dashboard_sync.py`, `post_call.py`, `.env.example`

---

## Fix 3: Max Turn Limits

**Problem:** `session.turn_count` and `session.state_turn_count` increment but are never checked. Calls can loop indefinitely if LLM gets confused or caller keeps repeating.

**Design:**
- Per-state limit: 5 turns. If exceeded, force transition to callback state with message "Let me have someone from the team call you back."
- Per-call limit: 30 turns total. If exceeded, same escalation to callback then end call.
- Check happens in `StateMachineProcessor.process_frame()` before running the state machine.

**Files:** `state_machine.py`, `processor.py`, tests

---

## Fix 4: Structured Logging

**Problem:** All modules use `logging.getLogger(__name__)` but no `logging.basicConfig()` is called. Logs are inconsistent and hard to filter in `fly logs`.

**Design:** Add `logging.basicConfig()` in `bot.py` before any other imports. Configure:
- Level from `LOG_LEVEL` env var (default `INFO`)
- Format: `%(asctime)s | %(levelname)s | %(name)s | %(message)s`
- No external dependencies. Just readable, filterable output.

**Files:** `bot.py`

---

## Fix 5: V2 Backend Circuit Breaker

**Problem:** `V2Client` calls the V2 backend for `lookup_caller`, `book_appointment`, `create_callback`. If V2 is down, each tool call waits 10s before timing out. The state machine gets stuck.

**Design:**
- Extract the existing `CircuitBreaker` dataclass from `tts_fallback.py` into its own `circuit_breaker.py` module. Both TTS fallback and V2Client reuse it.
- Wrap V2Client methods: after 3 consecutive failures, skip V2 calls for 60s and return graceful fallback responses (lookup returns unknown caller, booking returns failure which routes to callback state).

**Files:** new `circuit_breaker.py`, modify `tools.py`, modify `tts_fallback.py` (import from new location)

---

## Summary

| # | Fix | Severity | Files |
|---|-----|----------|-------|
| 1 | Env var validation | Critical | new `config.py`, `bot.py` |
| 2 | Dashboard sync fix + retry | Critical | `dashboard_sync.py`, `post_call.py`, `.env.example` |
| 3 | Max turn limits | High | `state_machine.py`, `processor.py`, tests |
| 4 | Structured logging | Critical | `bot.py` |
| 5 | V2 circuit breaker | High | new `circuit_breaker.py`, `tools.py`, `tts_fallback.py` |

## Out of Scope (deferred)

- Dockerfile optimization
- Prometheus metrics / observability
- Graceful shutdown on deploy
- Health check that verifies dependencies
- Configurable service area
- Call recording metadata
- README documentation