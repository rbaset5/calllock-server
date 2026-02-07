# AGENT STATUS

- Version: v8-returning-callers (11-state)
- Previous: v7-ux-refined (8-state)
- Agent ID: agent_4fb753a447e714064e71fadc6d
- LLM ID: llm_4621893c9db9478b431a418dc2b6
- Retell Phone Number Version: 23 (bound to +13126463816)
- Retell Published Version: 22
- Agent Name: CallSeal - 8 State v6
- Deployment status: DRAFT — not yet deployed
- Backchannel: Enabled (platform-level active listening sounds)
- LESSON: Phone number was pinned to version 15. Publishing new versions does NOT update the phone binding. Must update via PATCH /update-phone-number.
- Config file: retell-llm-v8-returning-callers.json

## What's New in v8

- **Automatic caller recognition** via `lookup_caller` tool at call start
- **Returning caller fast-track**: skip ZIP, name, address for known callers (~45s saved)
- **Follow-up handling**: acknowledge callback promises and past call history
- **Booking management**: reschedule, cancel, or status check via `manage_appointment` tool
- **Intent switching**: any branch can exit into new-issue flow with pre-filled data

## State Flow

### New caller / new issue:
```
welcome → lookup → safety → service_area → discovery → urgency → pre_confirm → booking → confirm
```

### Known caller with new issue (fast-track):
```
welcome → lookup → safety → service_area* → discovery* → urgency → pre_confirm → booking → confirm
```
*service_area skipped if ZIP known; discovery skips name/address if pre-filled

### Follow-up / callback promise:
```
welcome → lookup → follow_up → (resolve or → safety flow)
```

### Manage existing booking:
```
welcome → lookup → manage_booking → confirm (or → safety flow for new issue)
```

## Testing Status

| # | State | Type | Status |
|---|---|---|---|
| 1 | welcome | Core | Untested |
| 2 | lookup | NEW | Untested |
| 3 | follow_up | NEW | Untested |
| 4 | manage_booking | NEW | Untested |
| 5 | safety | Core | Untested |
| 6 | service_area | Modified | Untested |
| 7 | discovery | Modified | Untested |
| 8 | urgency | Core | Untested |
| 9 | pre_confirm | Core | Untested |
| 10 | booking | Core | Untested |
| 11 | confirm | Modified | Untested |

## New Tools

| Tool | Endpoint | Purpose |
|------|----------|---------|
| lookup_caller | V2: /webhook/retell/lookup_caller | Auto-lookup caller by phone at call start |
| manage_appointment | V2: /webhook/retell/manage_appointment | Reschedule, cancel, or status check |

## Test Scenarios (v8)

### Returning Caller Scenarios
1. Known caller + new issue → name confirmed, ZIP/address skipped
2. Known caller + follow-up → history acknowledged, callback offered
3. Known caller + booking management → appointment found, reschedule/cancel works
4. Known caller + intent switch → start booking mgmt, add new issue mid-call

### Existing Scenarios (must still pass)
5. New caller: full flow works unchanged
6. Safety emergency: 911 flow
7. Out of area: ZIP rejection
8. Booking: full booking + pre_confirm flow

### Edge Cases
9. Lookup times out → graceful fallback to normal flow
10. Caller says "my appointment" but has none → offer to schedule
11. Caller has callback promise but wants to book instead → transition to safety

## Golden Rules (Calm HVAC Dispatcher — v8 Returning Callers)

- Calm, capable dispatcher voice (friendly, brisk, confident).
- ONE question at a time; max 2 sentences before a question.
- Tone matching: mirror caller's energy (never more cheerful than the caller).
- Semantic paraphrasing: rephrase caller's words, don't parrot them verbatim.
- Acknowledgment rotation: vary phrases, often skip acknowledgment entirely.
- Bridge phrases for dead air: "Let me see..." / "One second..." (sparingly).
- Backchannel enabled at platform level for active listening sounds.
- Safety first: gas/burning/smoke/CO/sparks -> safety-critical flow.
- NEVER book without caller's explicit approval (pre_confirm state).
- Never claim booking confirmed unless booking tool returns SUCCESS.
- Known caller recognition: confirm name only, silently pre-fill address/ZIP.
- Callback promise acknowledgment: "I see we owe you a callback" (empathetic, no excuses).
- Service area testing: ZIP prefix 787 only.
- Pricing: $89 diagnostic, credited if repair proceeds.
