# Level 1 Instrumentation Design

**Date:** 2026-02-13
**Status:** Approved
**Depends on:** MVP Stabilization (complete)

## Problem

The system has no way to know when calls are misclassified, names are missed, or urgency is wrong. Improvements are reactive (someone notices a problem) instead of systematic (data shows where to invest).

## Solution

Emit one structured Pino log line per completed call — a **call quality scorecard** — from the post-call webhook. No new infrastructure. Consumed via Render log search.

## The Call Scorecard

New file: `V2/src/instrumentation/call-scorecard.ts`

Called from the post-call webhook handler after dashboard sync completes. Reads the final `ConversationState` + Retell post-call data and emits:

```json
{
  "level": "info",
  "module": "quality",
  "event": "call_scorecard",
  "callId": "call_abc123",
  "metrics": {
    "tags_count": 3,
    "tags_empty": false,
    "name_captured": true,
    "name_source": "dynamic_vars",
    "urgency_agent": "Urgent",
    "urgency_inferred": "Urgent",
    "urgency_match": true,
    "safety_detected": false,
    "equipment_type_captured": true,
    "address_captured": true,
    "address_is_tbd": false,
    "booking_attempted": true,
    "booking_succeeded": true,
    "callback_promised": false,
    "callback_created": false,
    "call_duration_seconds": 142,
    "end_reason": "appointment_booked",
    "states_visited": ["welcome","lookup","safety","service_area","discovery","urgency","booking","confirm"]
  }
}
```

## Metric Definitions

| Metric | Source | What It Measures |
|--------|--------|-----------------|
| `tags_count` / `tags_empty` | Tag classifier output | Whether classification found any tags |
| `name_captured` / `name_source` | ConversationState.customerName | Whether a customer name was extracted, and from where (dynamic_vars, custom_analysis, transcript_mining) |
| `urgency_agent` | Retell dynamic variables | What the voice agent assigned |
| `urgency_inferred` | `inferUrgencyFromContext()` on transcript | What post-call analysis thinks |
| `urgency_match` | Compare the two above | Agreement between agent and post-call |
| `safety_detected` | `extractSafetyEmergency()` | Whether transcript contains safety keywords |
| `equipment_type_captured` | ConversationState.hvacIssueType or equipmentType | Whether we know what equipment is involved |
| `address_captured` / `address_is_tbd` | ConversationState.serviceAddress | Whether a real address was collected |
| `booking_attempted` | ConversationState reaching booking state | Whether the agent tried to book |
| `booking_succeeded` | ConversationState.appointmentBooked | Whether booking completed |
| `callback_promised` / `callback_created` | ConversationState.callbackRequested / callbackCreated | Whether callback was promised and actually created |
| `call_duration_seconds` | Retell post-call data | Call length |
| `end_reason` | ConversationState.endCallReason | How the call ended |
| `states_visited` | Retell dynamic variables (current_agent_state history) or ConversationState | State machine path taken |

## How To Query

On Render logs, search `"event":"call_scorecard"`:

- **Tag miss rate:** Count `tags_empty: true` per day
- **Name capture rate:** Count `name_captured: false` per day
- **Urgency accuracy:** Filter `urgency_match: false`, review those transcripts
- **Booking success rate:** Filter `booking_attempted: true, booking_succeeded: false`
- **Broken callbacks:** Filter `callback_promised: true, callback_created: false` (should be 0)
- **State loops:** Look for repeated states in `states_visited`

## Integration Point

In `V2/src/server.ts`, post-call webhook handler, after `sendJobToDashboard` and `sendCallToDashboard` complete:

```typescript
import { emitCallScorecard } from './instrumentation/call-scorecard.js';
// ... after dashboard sync ...
emitCallScorecard(conversationState, retellData, classificationResult);
```

## Non-Goals

- No new database tables
- No dashboard UI for metrics (future Level 2)
- No alerting on thresholds (future)
- No historical aggregation (just per-call logs)
