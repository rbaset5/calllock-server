# CallLock MVP Stabilization Design

**Date:** 2026-02-13
**Status:** Approved
**Approach:** Stabilize-Decompose-Harden (3 phases, ~15 working days)

## Problem Statement

CallLock is stuck in a fix-break-fix cycle. The audit found 12 critical bugs, 15 high-severity issues, and 0 automated tests across the entire codebase. The 7.5:1 fix-to-feature commit ratio confirms the system spends most effort on repairs. Root causes:

1. **No safety net** — zero automated tests anywhere
2. **Monolithic architecture** — `server.ts` (1,431 lines) means any change can break anything
3. **Batch-deploy antipattern** — multiple untested fixes deployed simultaneously
4. **Branch reuse** — one branch used for 6+ PRs, no change isolation
5. **Silent data loss** — state persistence uses INSERT on PRIMARY KEY (fails silently on updates)

## Critical Bugs (Active in Production)

| # | Layer | Issue | Impact |
|---|-------|-------|--------|
| 1 | V2 Backend | Webhook auth DISABLED (`auth.ts:72` calls `next()` on failure) | Anyone can POST fake calls |
| 2 | V2 Backend | Post-call webhook registered BEFORE auth middleware (`server.ts:470` vs `659`) | Unauthenticated dashboard syncs |
| 3 | V2 Backend | `saveCallSession` uses INSERT on PRIMARY KEY (`supabase.ts:244`) | Mid-call state updates lost |
| 4 | Voice Agent | `booking_failed` state has no `create_callback_request` tool | Broken callback promises |
| 5 | Dashboard | `book-service` endpoint has zero authentication | Spam bookings possible |
| 6 | Dashboard | `customer-status` query has no `user_id` filter + substring match | Cross-tenant data leak |
| 7 | V2 Backend | `state.urgencyTier` never populated, dashboard reads it | Urgency always "low" |
| 8 | V2 Backend | `isSafetyEmergency` hardcoded `false` in post-call extraction | Emergencies classified routine |
| 9 | V2 Backend | Name regex matches agent greeting ("this is Alex from ACE") | Wrong customer names |
| 10 | Dashboard | `sales_lead` NotificationEventType doesn't exist | Commercial notifications 100% dropped |
| 11 | Voice Agent | `follow_up -> safety` edge passes no caller data | Returning callers re-asked for info |
| 12 | Voice Agent | `end_call` in `booking` state enables premature hangup | LLM prefers end_call over edges |

---

## Phase 1 — Emergency Stabilization (Days 1-3)

**Goal:** Stop active bleeding. No architecture changes, no features.

### 1.1 Re-enable Webhook Authentication
- **File:** `V2/src/middleware/auth.ts:72`
- **Change:** Replace bypass `next()` with `return res.status(401).json({ error: "Invalid signature" })`
- **File:** `V2/src/server.ts`
- **Change:** Move `app.use("/webhook/retell", retellWebhookAuth)` to BEFORE all route handlers
- **Verify:** Test with real Retell webhook call before deploying

### 1.2 Fix `saveCallSession` Upsert
- **File:** `V2/src/services/supabase.ts:244`
- **Change:** Add `Prefer: resolution=merge-duplicates` header to POST request
- **Verify:** Call session state persists across multiple tool webhook calls

### 1.3 Add Callback Tool to `booking_failed`
- **File:** `voice-agent/retell-llm-v9-triage.json` — `booking_failed` state
- **Change:** Add `create_callback_request` tool definition to tools array
- **Change:** Update prompt to require calling it before `end_call`
- **Deploy:** Push to Retell via API

### 1.4 Auth on `book-service` Endpoint
- **File:** `/calllock-dashboard/src/app/api/retell/book-service/route.ts`
- **Change:** Add Retell signature verification (blocking, not bypass)

### 1.5 Scope `customer-status` Query
- **File:** `/calllock-dashboard/src/app/api/retell/customer-status/route.ts:91`
- **Change:** Add `user_id` filter, change `ilike` substring to exact `eq` match

---

## Phase 2 — Decompose + Test (Days 4-10)

**Goal:** Break monoliths into testable modules. Fix remaining bugs during extraction.

### 2.1 `server.ts` Decomposition

| New Module | Responsibility |
|-----------|----------------|
| `V2/src/webhooks/retell-handler.ts` | Route registration, request parsing, response formatting |
| `V2/src/state/conversation-state.ts` | `getOrCreateWebhookState`, persistence, loop detection |
| `V2/src/tools/lookup-caller.ts` | lookup_caller tool logic |
| `V2/src/tools/book-appointment.ts` | book_appointment tool logic |
| `V2/src/tools/create-callback.ts` | create_callback tool logic |
| `V2/src/extraction/post-call.ts` | `extractStateFromPostCallData`, name/address/urgency extraction |
| `V2/src/extraction/urgency.ts` | Urgency inference, safety emergency detection |
| `V2/src/server.ts` (remaining) | Express app setup, middleware, health checks |

**Extraction order:** `extraction/` (pure functions) → `state/` → `classification/` → `tools/` → `sync/` → `webhooks/`

### 2.2 `dashboard.ts` Decomposition

| New Module | Responsibility |
|-----------|----------------|
| `V2/src/classification/tags.ts` | 117-tag taxonomy classification |
| `V2/src/classification/call-type.ts` | `classifyCall`, `deriveCallType` |
| `V2/src/classification/revenue.ts` | Revenue estimation tiers |
| `V2/src/sync/job-sync.ts` | `sendJobToDashboard`, retry logic |
| `V2/src/sync/call-sync.ts` | `sendCallToDashboard` |
| `V2/src/sync/alert-sync.ts` | Emergency alert sync |
| `V2/src/transformation/payload.ts` | `transformToDashboardPayload`, field mapping |

### 2.3 Test Strategy

**Framework:** Vitest

| Module | Key Test Cases |
|--------|---------------|
| `extraction/post-call.ts` | Name extraction filters agent utterances; safety detection from transcript |
| `extraction/urgency.ts` | All 4 tiers; Estimate detection; LifeSafety keywords |
| `state/conversation-state.ts` | Upsert works; loop counter persists; race condition handling |
| `classification/tags.ts` | All 117 patterns; no false positives on hazard tags |
| `classification/call-type.ts` | Urgency mapping (urgencyTier populated correctly) |
| `transformation/payload.ts` | Dashboard URL construction; field mapping |
| `sync/*.ts` | Webhook secret consistency |

### 2.4 Bugs Fixed During Decomposition

| Bug | Fixed In Module |
|-----|----------------|
| H3: Urgency always "low" | `classification/call-type.ts` — map `state.urgency` → `urgencyTier` |
| M1: Safety emergency hardcoded false | `extraction/post-call.ts` — check transcript keywords |
| M3: Agent name captured as customer | `extraction/post-call.ts` — filter agent utterances |
| H1: Race condition in state creation | `state/conversation-state.ts` — DB-level locking |
| H2: Fragile dashboard URL construction | `sync/job-sync.ts` — separate env vars per webhook |
| M5: Wrong webhook secret variable | `sync/alert-sync.ts` — unify to `DASHBOARD_WEBHOOK_SECRET` |
| H4: Double classification | `sync/call-sync.ts` — compute once, pass to both |

### 2.5 Branch Discipline

- One branch per issue
- Naming: `stabilize/phase2-extract-{module}`
- Each PR: module extraction + tests + bug fixes in that module
- CI must pass before merge

---

## Phase 3 — Harden + Voice Agent (Days 11-15)

**Goal:** Fix voice agent config, add integration tests, fix dashboard data quality, set up CI.

### 3.1 Voice Agent Config Fixes

| Fix | State | Change |
|-----|-------|--------|
| C2: Pass caller data through intent-switch edges | `follow_up → safety`, `manage_booking → safety` | Add `zip_code`, `service_address`, `customer_name` params |
| H1: Purge "transition" word from `pre_confirm` | `pre_confirm` | Replace function names with generic references |
| H3: Pass appointment data through confirm edge | `manage_booking → confirm` | Add `appointment_time`, `action_taken`; enable `speak_during_transition` |
| H4: Remove `end_call` from `booking` | `booking` | Force failures through `booking_failed` |
| H5: Correct interruption sensitivity | All states | 0.8 → 0.6 for conversation states, welcome → 0.4 |
| M3: Resolve TBD contradiction | `discovery` edge params | Remove "or TBD" from descriptions |

### 3.2 Dashboard Data Quality Fixes

| Fix | File | Change |
|-----|------|--------|
| C1: `sales_lead` notification type missing | `notification-service.ts` | Add to enum + template |
| H1: `undefined` vs `null` inconsistency | `webhook/jobs/route.ts` | Standardize to `?? undefined` |
| H4: AuthGuard renders lead UI on every page | `auth-guard.tsx` | Extract lead UI, only render on action page |
| H5: Velocity fetches all calls | `velocity/route.ts` | Replace with `GROUP BY` aggregate |
| M1: Timezone bug in `isScheduledToday` | `notification-service.ts` | Use `zonedNow` for comparison |
| M4: Job uses raw urgency not reclassified | `webhook/jobs/route.ts` | Use `effectiveUrgency` |

### 3.3 Integration Tests

| Scenario | Verifies |
|----------|----------|
| New caller → discovery → booking → success | Full happy path end-to-end |
| Return caller → follow_up → new issue → booking | Caller data preserved through intent switch |
| Failed booking → callback created | `booking_failed` creates callback |
| Safety emergency → alert sent | Safety flag + alert delivery |
| Post-call webhook with no saved session | Transcript extraction works |
| Duplicate webhook delivery | Dedup prevents doubles |

### 3.4 CI/CD

- GitHub Actions: run vitest + tsc on every PR
- Block merge on failure
- Auto-deploy to Render on merge to main

### 3.5 Documentation Sync

- Update `AGENT-STATUS.md` to 15-state flow
- Rewrite `TEST-SCENARIOS.md` for v9 architecture
- Update `V2/CLAUDE.md` with new module structure
- Fix diagnostic fee inconsistency ($89 vs $99)

---

## Success Criteria

| Metric | Before | Target |
|--------|--------|--------|
| Automated tests | 0 | >80% coverage on extracted modules |
| `server.ts` size | 1,431 lines | <200 lines (app setup only) |
| Webhook auth | Disabled | Enforced + verified |
| State persistence | Silently fails | Upsert with logging |
| Urgency accuracy | Always "low" | 4-tier correctly mapped |
| Fix-to-feature ratio | 7.5:1 | Target <2:1 after stabilization |
| Branch discipline | 6 PRs from 1 branch | 1 branch per issue |

## Non-Goals

- No new features until Phase 3 complete
- No V3 experimental work
- No multi-tenant architecture changes (hardcoded timezone stays for now)
- No Cal.com reschedule integration (the `updateAppointment` stub stays a stub)
