# Issue #38: problem_duration Not Captured From Transcript

**Date:** 2026-02-14
**Issue:** https://github.com/rbaset5/calllock-server/issues/38
**Status:** Approved

---

## Problem

`problem_duration` is empty when Retell's AI analysis misses temporal phrases like "this morning", "since yesterday", or "2 days". The field exists in ConversationState and DashboardPayload but has no transcript-based extraction fallback.

## Approach

**Extraction-First** with three components:

1. Backend regex extraction for temporal phrases (fallback when Retell AI misses)
2. Duration category classification into buckets (acute/recent/ongoing)
3. Voice agent prompt hint to encourage natural duration questions

## Design

### 1. Temporal Phrase Extraction

New `extractProblemDuration()` function in `V2/src/extraction/post-call.ts`.

Filters caller utterances only (same pattern as `extractCustomerName`). Returns `{ raw: string, category: 'acute' | 'recent' | 'ongoing' }` or `undefined`.

**Regex patterns:**

| Pattern Type | Examples |
|-------------|---------|
| Explicit duration | "2 days", "a few hours", "couple weeks", "about a month" |
| Relative time | "this morning", "yesterday", "last night", "last week", "since Monday" |
| Onset phrases | "started yesterday", "been going on for 3 days", "since last Tuesday" |
| Vague duration | "a while", "for some time", "recently", "just started" |

**Category classification:**

| Category | Timeframe | Example phrases |
|----------|-----------|----------------|
| acute | <24h | "this morning", "today", "just started", "a few hours", "tonight" |
| recent | 1-7d | "yesterday", "2 days", "since Monday", "a few days", "this week" |
| ongoing | >7d | "a couple weeks", "a month", "for years", "a while", "for some time" |

### 2. Tags Integration

Three new tags in the CONTEXT category of `V2/src/classification/tags.ts`:

- `DURATION_ACUTE` — problem started < 24 hours ago
- `DURATION_RECENT` — problem started 1-7 days ago
- `DURATION_ONGOING` — problem persisting > 7 days

Tags are derived from extraction results (not transcript phrase matching). `classifyCall()` calls `extractProblemDuration()` and pushes the corresponding tag.

### 3. New Fields

- `ConversationState.problemDurationCategory?: 'acute' | 'recent' | 'ongoing'`
- `DashboardPayload.problem_duration_category?: 'acute' | 'recent' | 'ongoing'`

### 4. Priority Order

1. Dynamic variables (voice agent set during call)
2. Retell AI custom analysis (`custom?.problem_duration`)
3. Transcript regex extraction (new fallback)

### 5. Voice Agent Prompt Hint

Add to discovery state prompt in `voice-agent/retell-llm-v9-triage.json`:

> "When the caller describes a problem, naturally ask how long it's been going on if they don't mention it themselves."

No state machine changes. No new states, variables, or transitions.

### 6. Data Flow

```
Customer says "this morning"
  -> Transcript captured by Retell
  -> Post-call webhook fires
  -> extractProblemDuration(transcript) -> { raw: "this morning", category: "acute" }
  -> state.problemDuration = "this morning" (if not already set)
  -> state.problemDurationCategory = "acute"
  -> classifyCall() emits DURATION_ACUTE tag
  -> Dashboard payload includes problem_duration, problem_duration_category, tags
```

## Files Modified

| File | Change |
|------|--------|
| `V2/src/extraction/post-call.ts` | Add `extractProblemDuration()` + `classifyDurationCategory()` |
| `V2/src/classification/tags.ts` | Add 3 `DURATION_*` tags, call extraction in `classifyCall()` |
| `V2/src/types/retell.ts` | Add `problemDurationCategory` to ConversationState |
| `V2/src/services/dashboard.ts` | Add `problem_duration_category` to DashboardPayload, populate in transform |
| `V2/src/server.ts` | Call extraction in post-call processing as fallback |
| `voice-agent/retell-llm-v9-triage.json` | Add prompt hint to discovery state |

## Test Plan

1. **Unit: `extractProblemDuration()`** — explicit durations, relative times, onset phrases, vague phrases, no-match, agent-utterance filtering
2. **Unit: duration tags** — DURATION_ACUTE/RECENT/ONGOING emitted correctly, no tag when no phrase
3. **Integration: dashboard payload** — `problem_duration` and `problem_duration_category` populated
