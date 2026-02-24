# Call Audit Fixes — Design Doc

**Date:** 2026-02-24
**Trigger:** End-to-end audit of call CA1444bcd7af2176d7d46adf994bacc384 (Jonas, Feb 24 15:45 UTC)
**Branch:** `rbaset5/urgency-state-fixes`

## Problem

The audit uncovered 10 regressions across 4 layers: 3 CRITICAL, 5 MODERATE, 2 MINOR. The most impactful: every successful booking call is invisible in the Calls tab (sync failure), every "urgent" caller gets labeled low-priority (urgency mismap), and the LLM spoke "[insert available time here]" to a caller (template leak).

## Design — 3 Buckets

### Bucket A: Data Fixes (post_call.py)

Four value fixes. Zero architectural change.

**#1 Call sync `lead_id: null`**
- `build_call_payload` sends `"lead_id": None` → Zod rejects null on `z.string().optional()`
- Fix: Build payload without `lead_id`/`job_id`, then conditionally add them only when non-None
- Also add `job_id` param (currently missing — booking calls create jobs, not leads)
- File: `pipecat-agent/src/calllock/post_call.py` — `build_call_payload`

**#2 Urgency mismap `"urgent"` → `"low"`**
- `_URGENCY_MAP` lacks `"urgent"` key, fallback is `"low"`
- Fix: Add `"urgent": "high"` to `_URGENCY_MAP`
- File: `pipecat-agent/src/calllock/post_call.py:17-23`

**#5 Missing `is_ai_booked`**
- Job payload never includes this field
- Fix: Add `"is_ai_booked": True` to payload when `session.booking_confirmed`
- File: `pipecat-agent/src/calllock/post_call.py` — `build_job_payload`

**#9 Raw `urgency_tier` in call payload**
- Call payload sends `session.urgency_tier` directly ("urgent") instead of mapped value ("high")
- Fix: Use `_map_urgency(session.urgency_tier)` in `build_call_payload`
- File: `pipecat-agent/src/calllock/post_call.py` — `build_call_payload`

### Bucket B: Booking Flow Fixes

**#3 LLM template leak — "[insert available time here]"**
- The CONFIRM prompt says "Read the booking details" but the LLM ignored KNOWN INFO
- Fix: Make CONFIRM prompt dynamic — inject `session.confirmation_message` directly into the state prompt text
- Approach: Add CONFIRM to a `DYNAMIC_PROMPTS` dict of functions, or use string formatting in `get_system_prompt`
- File: `pipecat-agent/src/calllock/prompts.py`

**#4 Missing `scheduled_at`**
- V2 booking returns `confirmationMessage` (human string) but no structured `appointment_time`
- Fix (V2): Add `appointment_time: startTime.toISOString()` to booking response
- Fix (Pipecat): Read `result.get("appointment_time")` in `_tool_result_book_service` → `session.booked_time`
- Files: `V2/src/functions/booking.ts`, `pipecat-agent/src/calllock/state_machine.py:354`

### Bucket C: Post-Call Classification Pipeline

**#6 Missing `ai_summary`, `card_headline`, `card_summary`**
**#7 Missing `call_type`, `call_subtype`**
**#8 Missing `sentiment_score`**

All solved by one new function: `classify_call(session, transcript_text)` in `classification.py`.

**Design:**
- Single LLM call (GPT-4o-mini, JSON mode) generates all 6 fields at once
- Prompt includes: full transcript, final state, booking status, urgency, session data
- Returns dict with `ai_summary`, `card_headline`, `card_summary`, `call_type`, `call_subtype`, `sentiment_score`
- `call_type` uses dashboard enum: SERVICE, ESTIMATE, MAINTENANCE, EXISTING_CUSTOMER, etc.
- `sentiment_score` uses 1-5 scale matching dashboard schema
- Fallback: if LLM fails, all fields default to None (no regression from current behavior)

**Integration:**
- Called in `handle_call_ended` before `build_job_payload`
- Classification fields merged into payload: `payload.update({k: v for k, v in classification.items() if v is not None})`

**Why one call:** Each LLM round-trip is ~500ms. Six calls = ~3s. One call = ~1s. Post-call latency doesn't affect caller experience but affects dashboard freshness.

### Not Fixed

**#10 TTS "StartFrame not received" errors**
- Pipecat framework issue — Inworld TTS receives frames before setup propagation
- Cosmetic noise (documented in CLAUDE.md)
- Requires upstream Pipecat fix, not application-level change

## Testing

- Each bucket gets its own test file or test additions
- Bucket A: Unit tests for `_map_urgency`, `build_call_payload` null handling, `build_job_payload` with booking
- Bucket B: Unit tests for CONFIRM prompt with confirmation_message, V2 booking response shape
- Bucket C: Unit test for `classify_call` with mock LLM response, integration test for payload merge

## Deployment Order

1. Bucket A (pipecat-agent only) — deploy to Fly.io
2. Bucket B (V2 backend + pipecat-agent) — deploy V2 to Render first, then pipecat to Fly.io
3. Bucket C (pipecat-agent only) — deploy to Fly.io
