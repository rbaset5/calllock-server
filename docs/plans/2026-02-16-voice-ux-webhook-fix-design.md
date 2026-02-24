# Voice UX + Webhook 400 Fix Design

**Date:** 2026-02-16
**Branch:** `rbaset5/pipecat-post-call`
**Context:** Post-deploy test call revealed 4 compounding issues

## Problem Statement

After deploying the callback-skip + webhook-400 fixes, a live test call revealed:
1. **Awkward pauses** — 2-4.5s silence between user speech and agent response
2. **Fragmented LLM context** — user utterances split across multiple `user` messages
3. **Dashboard 400s persist** — both jobs and calls webhooks still rejected
4. **Agent verbosity** — responses too long for a phone conversation

## Root Cause Analysis

### A. Latency Chain (2-4.5s dead air)

| Step | Time | Source |
|------|------|--------|
| VAD stop_secs | 300ms | `pipeline.py:71` — silence detection |
| Debounce | 400ms | `processor.py:52` — wait for STT fragments |
| **Blocking extraction** | **500ms-2s** | `processor.py:110-111` — `await extract_fields()` calls GPT-4o-mini synchronously before pushing frame to LLM |
| GPT-4o generation | 500ms-1s | Only starts after extraction completes |
| TTS synthesis | 200ms-800ms | Inworld HTTP TTS |

**Key insight:** The extraction call is the biggest fixable bottleneck. It blocks the LLM from generating, and its results (session fields like `customer_name`, `zip_code`) are only used in the *next* turn's system prompt — `get_system_prompt()` is called *before* extraction at line 107.

### B. Fragmented LLM Context

Production logs show the LLM receives:
```
{'role': 'user', 'content': 'unit.'},
{'role': 'user', 'content': 'to seventy.'},
```
Each `TranscriptionFrame` pushed downstream becomes a separate `user` message in the Pipecat context aggregator. Even with debouncing (which handles rapid fragments within one utterance), separate speaking turns create separate entries.

**Impact:** The LLM sees incomplete fragments instead of full utterances, causing confused or repetitive responses.

**Decision:** Defer pipeline restructuring. Mitigate via stronger prompt brevity constraints.

### C. Dashboard 400s

Both `/api/webhook/jobs` (400) and `/api/webhook/calls` (400) still fail. The Zod validation error details are in the response body, but `dashboard_sync.py` only logs the status code message — we're blind to what field is failing.

**Decision:** Add response body logging first, then fix specific fields in a follow-up.

### D. Agent Verbosity

The persona says "Max 2 sentences before a question" but GPT-4o generates 20-25 word sentences. No hard word limit exists for voice context.

## Design

### Fix 1: Non-Blocking Extraction (processor.py)

**Change:** `await self._run_extraction()` → `asyncio.create_task(self._safe_extraction())`

New method:
```python
async def _safe_extraction(self):
    try:
        await self._run_extraction()
    except Exception as e:
        logger.error(f"Background extraction failed: {e}")
```

**Safety argument:** Asyncio is single-threaded (cooperative multitasking). The extraction task yields at the HTTP call. Session field writes are guarded by `if not self.session.field:` checks. No data corruption from interleaving.

**Expected latency reduction:** 500ms-2s removed from the critical path.

### Fix 2: Debounce 400ms → 200ms (processor.py)

**Change:** `self._debounce_seconds = 0.4` → `self._debounce_seconds = 0.2`

Already applied locally. 200ms still catches rapid STT fragments while halving perceived delay.

### Fix 3: Webhook Response Body Logging (dashboard_sync.py)

**Change:** Before `raise_for_status()`, log the response body on 4xx/5xx:

```python
resp = await client.post(url, json=payload, headers=self._headers())
if resp.status_code >= 400:
    logger.error("%s returned %d: %s", label, resp.status_code, resp.text)
resp.raise_for_status()
```

This captures the Zod validation error details (field paths + messages) without modifying the request.

### Fix 4: Prompt Tightening (prompts.py)

Add to PERSONA:
```
RESPONSE LENGTH: 1-2 short sentences. Max 25 words total. This is a phone call — brevity is respect.
```

Trim verbose state prompts:
- Remove full example scripts from SAFETY, CONFIRM (GPT-4o knows how to ask)
- Keep essential behavioral constraints only

## Files Changed

| File | Change |
|------|--------|
| `pipecat-agent/src/calllock/processor.py` | Non-blocking extraction, debounce 200ms |
| `pipecat-agent/src/calllock/dashboard_sync.py` | Response body logging |
| `pipecat-agent/src/calllock/prompts.py` | Brevity constraints, trimmed state prompts |
| `pipecat-agent/tests/test_processor.py` | Test non-blocking extraction |
| `pipecat-agent/tests/test_post_call.py` | Test response body logging |

## Non-Goals

- Pipeline restructuring for context merging (deferred)
- Model switch from GPT-4o to GPT-4o-mini (deferred)
- Full prompt rewrite (incremental tightening only)
