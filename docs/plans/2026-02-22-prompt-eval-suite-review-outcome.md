# Prompt Eval Suite — Design Review Outcome

**Date:** 2026-02-22
**Review mode:** SMALL CHANGE (one issue per section)

## Findings Applied

| # | Section | Issue | Decision | Impact |
|---|---------|-------|----------|--------|
| 1 | Architecture | `SNIPPETS = load_golden_transcripts()` at module level breaks test isolation — JSON parse errors crash all test collection | **Lazy-load** behind `_get_snippet_params()` with try/except fallback to `[]` | Eval tests can't break the main test suite |
| 2 | Code Quality | `judge_response()` rebuilt context from raw dict instead of reusing `_build_context()` from `prompts.py` — judge saw different context than agent | **Reuse** `_build_context` import directly | Judge and agent see identical context strings |
| 3 | Tests | No tests for JSON parsing logic (markdown fence stripping, error handling) | **Extract** `parse_judge_scores()` helper in `rubric.py` + 7 unit tests | Parsing edge cases covered, clear errors on format changes |
| 4 | Performance | Each API call created a new `httpx.AsyncClient` — 20 connections for 10 snippets | **Session-scoped** pytest fixture shares one client | ~30-40% latency reduction on eval runs |

## Changes to Plan

All four findings incorporated into `2026-02-22-prompt-eval-suite-plan.md`:
- Task 2 expanded: `parse_judge_scores()` helper + 7 additional tests (12 total in `test_rubric.py`)
- Task 4 rewritten: lazy loading, `_build_context` import, `openai_client` fixture, `parse_judge_scores` usage
