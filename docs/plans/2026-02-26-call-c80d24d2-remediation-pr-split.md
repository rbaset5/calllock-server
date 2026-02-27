# Commit / PR Split Recommendation — `call_c80d24d2f11780aee2c1290d665` Remediation

**Date:** 2026-02-26  
**Scope source:** Current workspace changes for prompt + `V2` + `V3` + QA/docs remediation tied to `call_c80d24d2f11780aee2c1290d665`

## Goal

Package the remediation work into reviewable units with clear dependency order and low rollback risk.

## Recommended Split (4 PRs)

### PR 1 — Voice Agent Prompt Hardening (behavioral fix)

**Why first**
- Directly addresses the caller-facing trust issue (slot substitution without re-consent)
- Smallest blast radius for fastest validation in Retell test calls

**Files**
- `voice-agent/retell-llm-v10-simplified.json`

**What it contains**
- `booked`/`booking_confirmed` tolerance
- slot-change acknowledgment + required caller acceptance
- existing appointment mention guidance
- anti-double-confirm loop guidance
- urgency consistency guidance

**Suggested commit message**
- `fix: harden v10 booking flow for slot changes and booking schema drift`

**Validation**
- JSON parse check for prompt file
- 1 scripted Retell test call (forced slot substitution if possible)

---

### PR 2 — `V2` Booking Trace Auditing + Dashboard Visibility + Local Tool Compatibility

**Why second**
- Adds observability and operator-facing visibility for the exact failure mode
- Includes `V2` tests, giving the strongest regression coverage in this repo

**Files**
- `V2/src/extraction/booking-tool-result.ts`
- `V2/src/server.ts`
- `V2/src/services/dashboard.ts`
- `V2/src/functions/booking.ts`
- `V2/src/types/retell.ts`
- `V2/src/__tests__/server/booking-backfill.test.ts`
- `V2/src/__tests__/sync/dashboard-fields.test.ts`
- `V2/src/__tests__/sync/card-summary.test.ts`
- `V2/src/__tests__/functions/booking-response.test.ts`

**What it contains**
- booking trace parser + schema compatibility (`booked` OR `booking_confirmed`)
- post-call warnings for slot/urgency mismatch
- dashboard payload audit flags + structured details
- operator-visible card summary review notes with exact values
- local `book_appointment` tool response compatibility alias (`booked`)
- tests for all of the above

**Suggested commit message**
- `feat: add V2 booking drift audit signals and compatibility hardening`

**Validation**
- `cd V2 && npx vitest run src/__tests__/server/booking-backfill.test.ts src/__tests__/sync/dashboard-fields.test.ts src/__tests__/sync/card-summary.test.ts src/__tests__/functions/booking-response.test.ts`
- `cd V2 && npm run typecheck`

---

### PR 3 — `V3` Parity for Booking Audit Signals + Summary Visibility + Local Tool Compatibility

**Why third**
- Brings `V3` operational parity after `V2` is established
- Typecheck-only validation in this repo (no `V3` test harness), so better to merge after the `V2` version of the pattern is reviewed

**Files**
- `V3/src/extraction/booking-tool-result.ts`
- `V3/src/server.ts`
- `V3/src/services/dashboard.ts`
- `V3/src/functions/booking.ts`
- `V3/src/types/retell.ts`

**What it contains**
- booking trace parser + audit signals
- post-call warnings for slot/urgency mismatch
- dashboard payload audit flags + structured booking details
- operator-visible `ai_summary` review notes with exact values
- local `book_appointment` compatibility response shape (`booking_confirmed`, `booked`, `appointment_time`)
- post-call typing for `transcript_with_tool_calls`

**Suggested commit message**
- `feat: add V3 booking drift audit visibility and tool response compatibility`

**Validation**
- `cd V3 && npm ci` (if deps not present)
- `cd V3 && npm run typecheck`

---

### PR 4 — QA / Rollout / Audit Clarity Docs

**Why separate**
- Reviewers can merge docs independently of backend deploy timing
- Keeps code review focused in PRs 1–3

**Files**
- `voice-agent/TEST-SCENARIOS.md`
- `voice-agent/AGENT-STATUS.md`
- `voice-agent/deploy_retell_v10.sh`
- `scripts/verify_book_service_contract.sh`
- `scripts/prod_remediation_status.sh`
- `docs/plans/2026-02-26-call-c80d24d2-booking-audit-remediation-rollout.md`
- `docs/plans/2026-02-26-external-book-service-contract-patch.md`
- `docs/plans/2026-02-26-call-c80d24d2-remediation-pr-summary.md`
- `docs/plans/2026-02-26-call-c80d24d2-remediation-pr-split.md` (this file)

**What it contains**
- Scenario 16 scripted regression for this exact failure pattern
- rollout checklist with expected dashboard fields/summaries
- dry-run-safe Retell deploy script for publish + phone binding
- external contract verification script for `book_service`
- single-command blocker status script for production readiness
- external `book_service` contract patch spec for dashboard repo
- PR summary / reviewer context
- stale Retell display-label warning to avoid audit misreads

**Suggested commit message**
- `docs: add call_c80 remediation rollout, QA scenario, and PR packaging notes`

**Validation**
- Docs-only (no tests required)

## Alternative Split (Single PR, 4 Commits)

If you want one PR instead of four, keep the same commit boundaries:

1. Prompt hardening (`voice-agent/retell-llm-v10-simplified.json`)
2. `V2` backend + dashboard + tests
3. `V3` parity changes
4. QA/rollout/docs

This keeps review diff manageable while avoiding cross-PR dependency management.

## Dependency / Merge Order

**Preferred merge order**
1. PR 2 (`V2`) and PR 1 (`voice-agent`) can be reviewed in parallel, but deploy prompt only after `V2` observability is ready if you want audit visibility on first verification call.
2. PR 3 (`V3`) next (parity)
3. PR 4 (docs) anytime

**External dependency (still required)**
- Patch external `book_service` backend (`app.calllock.co/api/retell/book-service`) to return both:
  - `booked`
  - `booking_confirmed`

## Staging / Commiting Tips From Current Workspace

- `voice-agent/scripts/` is untracked in this workspace and was **not** part of this remediation. Do not include it.
- Use path-based `git add` per PR group to avoid accidental cross-contamination.

Quick pre-check:

```bash
git status --short --untracked-files=all
```

PR 1 staging (prompt only):

```bash
git add \
  voice-agent/retell-llm-v10-simplified.json
```

PR 2 staging (`V2` only):

```bash
git add \
  V2/src/extraction/booking-tool-result.ts \
  V2/src/server.ts \
  V2/src/services/dashboard.ts \
  V2/src/functions/booking.ts \
  V2/src/types/retell.ts \
  V2/src/__tests__/server/booking-backfill.test.ts \
  V2/src/__tests__/sync/dashboard-fields.test.ts \
  V2/src/__tests__/sync/card-summary.test.ts \
  V2/src/__tests__/functions/booking-response.test.ts
```

PR 3 staging (`V3` only):

```bash
git add \
  V3/src/extraction/booking-tool-result.ts \
  V3/src/server.ts \
  V3/src/services/dashboard.ts \
  V3/src/functions/booking.ts \
  V3/src/types/retell.ts
```

PR 4 staging (docs / QA / audit clarity):

```bash
git add \
  voice-agent/TEST-SCENARIOS.md \
  voice-agent/AGENT-STATUS.md \
  voice-agent/deploy_retell_v10.sh \
  scripts/verify_book_service_contract.sh \
  scripts/prod_remediation_status.sh \
  docs/plans/2026-02-26-call-c80d24d2-booking-audit-remediation-rollout.md \
  docs/plans/2026-02-26-external-book-service-contract-patch.md \
  docs/plans/2026-02-26-call-c80d24d2-remediation-pr-summary.md \
  docs/plans/2026-02-26-call-c80d24d2-remediation-pr-split.md
```

Optional sanity check before each commit:

```bash
git diff --cached --stat
```

## Reviewer Focus Areas (By PR)

### PR 1 (Prompt)
- Does booking state explicitly ask for acceptance on slot substitutions?
- Are `booked` and `booking_confirmed` both handled consistently?
- Any new prompt instructions likely to cause regressions or loops?

### PR 2 (V2)
- Audit parser correctness (`requested vs booked`, `urgency transition`)
- Dashboard payload field naming and optionality
- Card summary wording length / clarity
- Backward compatibility of booking result parsing

### PR 3 (V3)
- `RetellPostCallData` typing changes (`transcript_with_tool_calls`)
- Summary annotation wording in `ai_summary`
- Local booking response shape consistency

### PR 4 (Docs)
- Scenario 16 accurately matches the audited failure pattern
- Rollout doc reflects deployed/undeployed boundaries (especially external `book_service`)
