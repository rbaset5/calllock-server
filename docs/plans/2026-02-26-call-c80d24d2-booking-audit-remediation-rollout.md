# Rollout Checklist — Call `call_c80d24d2f11780aee2c1290d665` Remediation

**Date:** 2026-02-26  
**Call audited:** `call_c80d24d2f11780aee2c1290d665` (Feb 26, 2026)  
**Focus:** Booking slot substitution trust gap, urgency drift, prompt/tool schema mismatch, and post-call visibility

## Why This Exists

The audited call completed, but had a major UX trust failure:
- Caller requested `Tomorrow at 4:30 PM`
- Backend booked `Friday, February 27, 2026 at 3:45 PM`
- Agent announced success without explicit re-consent on the changed slot

It also showed:
- `urgency_tier` drift (`routine` in transition vs `urgent` in booking tool call)
- a redundant confirmation loop / dead air segment
- booking schema mismatch risk (`booked` vs `booking_confirmed`)

This checklist ties the prompt + backend + dashboard fixes together for deployment and QA.

## Implemented Changes (This Repo)

### 1) Prompt hardening (`voice-agent`)
- `voice-agent/retell-llm-v10-simplified.json`
- Accepts `booked` OR `booking_confirmed`
- Reinforces slot-change acknowledgment + caller acceptance before confirmation
- Adds anti-double-confirm guardrails
- Reinforces existing-appointment mention in lookup
- Reinforces urgency consistency from confirm -> booking

### 2) Post-call trace parsing + observability (`V2`, `V3`)
- Added booking trace analyzers:
  - `V2/src/extraction/booking-tool-result.ts`
  - `V3/src/extraction/booking-tool-result.ts`
- Detects and logs:
  - `slotChanged`
  - `urgencyMismatch`

### 3) Dashboard payload visibility (`V2`, `V3`)
- Job + call payloads now include:
  - `slot_changed`
  - `urgency_mismatch`
  - `booking_requested_time`
  - `booking_booked_slot`
  - `booking_urgency_transition`

### 4) Operator-facing summary annotations (`V2`, `V3`)
- `V2` `card_summary` and `V3` `ai_summary` now include a `Review booking:` note when slot/urgency drift occurs
- Notes include exact values when available (requested slot, booked slot, urgency transition)

### 5) Local tool schema compatibility (`V2`, `V3`)
- Local `book_appointment` success responses return both:
  - `booking_confirmed: true`
  - `booked: true`
- `V3` local booking responses also include `appointment_time`

### 6) Regression coverage / scripted QA assets
- `V2` test locks local booking response compatibility (`booking_confirmed` + `booked`)
- `voice-agent/TEST-SCENARIOS.md` adds Scenario 16 for this exact failure pattern

## Not Fixed Here (External Dependency)

The audited call used an external backend path (`book_service`) outside this repo.  
That external service still needs a contract patch to return both:
- `booked`
- `booking_confirmed`

Patch spec for that external repo:
- `docs/plans/2026-02-26-external-book-service-contract-patch.md`

Contract verifier in this repo:
- `scripts/verify_book_service_contract.sh`
- `scripts/prod_remediation_status.sh` (single-command blocker status)

## Recommended Deployment Order

1. Deploy `V2` and `V3` backend changes
2. Deploy `voice-agent/retell-llm-v10-simplified.json` prompt changes to Retell
3. Publish Retell version and confirm phone binding points to the new version
4. Run Scenario 16 (scripted regression)
5. Patch external `book_service` backend contract (if not already done)
6. Re-run Scenario 16 and compare before/after behavior

### Retell Deploy Command (this repo)

Dry-run:

```bash
./voice-agent/deploy_retell_v10.sh
```

Apply:

```bash
RETELL_API_KEY=... ./voice-agent/deploy_retell_v10.sh --apply
```

### External Contract Verification Command

Safe error-branch check (sends `{}`):

```bash
./scripts/verify_book_service_contract.sh --no-auth-infer
```

Authenticated branch check (if endpoint requires auth):

```bash
./scripts/verify_book_service_contract.sh --header "Authorization: Bearer <token>" --payload ./request.json --require-auth-pass
```

Authenticated branch check via Retell-compatible HMAC signature:

```bash
RETELL_API_KEY="<retell_key>" ./scripts/verify_book_service_contract.sh --payload ./request.json --require-auth-pass
```

### One-Command Blocker Status

```bash
./scripts/prod_remediation_status.sh
```

With auth branch verification:

```bash
BOOK_SERVICE_AUTH_HEADER="Authorization: Bearer <token>" ./scripts/prod_remediation_status.sh
```

Or with Retell signing:

```bash
RETELL_API_KEY="<retell_key>" ./scripts/prod_remediation_status.sh
```

Observed status from this workspace on 2026-02-27 (no auth):
- HTTP `401` response already includes both keys:
  - `booked: false`
  - `booking_confirmed: false`
- Success/slot-unavailable branches still require authenticated verification.

## QA Scenario (Use Scenario 16)

Source: `voice-agent/TEST-SCENARIOS.md` (Scenario 16)

### Test Setup
- Use a returning-caller phone/profile
- Ensure lookup returns an existing upcoming appointment
- Force `book_service` to return a different slot than requested (or simulate via backend/test env)

### Caller Prompt
- Example: "I need HVAC service tomorrow at 4:30 PM."

### Expected Voice UX (Pass Criteria)
- Agent mentions existing appointment (does not ignore it)
- Agent gets one clear booking approval (no duplicate "ready to proceed?" loop)
- If backend returns a different slot, agent says the exact returned slot and asks if it works
- Agent does not finalize booking verbally until caller accepts the changed slot

### Expected Engineering Signals (Pass Criteria)
- Post-call logs:
  - warning on slot mismatch if backend changed the slot
  - warning on urgency mismatch if drift occurs
- Dashboard payload (job + call, where applicable) includes:
  - `slot_changed`
  - `urgency_mismatch`
  - `booking_requested_time`
  - `booking_booked_slot`
  - `booking_urgency_transition`

### Expected Dashboard Text (Pass Criteria)
- `V2` card summary or `V3` AI summary includes:
  - `Review booking: ...`
- When values are available, note should contain the actual requested and booked slots and/or urgency transition

## Suggested Fail/Pass Examples

### Fail (old behavior)
- "You're all set for Friday at 3:45 PM" immediately after caller requested tomorrow at 4:30 PM
- No explicit question asking if the changed slot works

### Pass (new behavior)
- "I asked for tomorrow at 4:30 PM, but the soonest the system returned is Friday, February 27 at 3:45 PM. Does that work for you?"

## Rollback / Safety

If deployment regresses booking flow:
- Roll back Retell prompt to prior known-good config version
- Keep `V2`/`V3` observability changes if possible (they are non-blocking and improve auditability)

## Quick Verification Commands

```bash
cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts src/__tests__/sync/card-summary.test.ts src/__tests__/functions/booking-response.test.ts
cd V2 && npm run typecheck
cd V3 && npm run typecheck
```
