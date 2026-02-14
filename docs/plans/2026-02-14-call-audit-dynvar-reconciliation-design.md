# Call Audit Fixes — Dynamic Variable Reconciliation Design

**Date:** 2026-02-14
**Audit Call:** call_a5edfbbe2781828aee133335831 (Jonas, 02/14 10:21 EST)
**Verdict:** 3 CRITICAL + 4 MODERATE + 2 MINOR regressions
**Approach:** Central reconciliation function + targeted patches

## Problem

An end-to-end audit of Jonas's call revealed that `collected_dynamic_variables` from Retell
(customer_name, problem_summary, has_appointment, caller_known) are available post-call but
NOT merged into the conversation state used for classification and dashboard sync.

This causes cascading failures:
- Quality score 40/100 instead of ~80 (4 false negatives)
- Ghost lead false positive on returning customer (5 prior calls)
- RED priority false positive despite Positive sentiment
- Callback gap warning despite existing appointment
- Dashboard jobs webhook HTTP 500 (wrong URL — env config, not code)

## Scope

9 fixes across 6 sections. Scorecard logic excluded (lives in deployed code not in this workspace).
Dashboard webhook URL is an env var fix on Render (documented, not coded).

## Design

### Section 1: Post-Call Dynamic Variable Reconciliation

**Location:** `V2/src/server.ts`, inside `call_analyzed` handler after session retrieval (~line 420-425)

New function `reconcileDynamicVariables(state, dynVars)` merges `collected_dynamic_variables`
into conversation state, filling gaps:

```typescript
function reconcileDynamicVariables(
  state: ConversationState,
  dynVars: Record<string, string> | undefined
): void {
  if (!dynVars) return;

  // Customer name: prefer existing state, fall back to dynamic vars
  if (!state.customerName && dynVars.customer_name) {
    state.customerName = dynVars.customer_name;
  }

  // Problem description: prefer existing, fall back to problem_summary
  if (!state.problemDescription) {
    state.problemDescription = dynVars.problem_description || dynVars.problem_summary;
  }

  // Appointment: check has_appointment OR booking_confirmed
  if (!state.appointmentBooked) {
    if (dynVars.has_appointment === "true" || dynVars.booking_confirmed === "true") {
      state.appointmentBooked = true;
    }
  }

  // Caller known flag
  if (dynVars.caller_known === "true") {
    state.callerKnown = true;
  }

  // Service address
  if (!state.serviceAddress && dynVars.service_address) {
    state.serviceAddress = dynVars.service_address;
  }

  // ZIP code (append to address if not present)
  if (dynVars.zip_code && state.serviceAddress && !state.serviceAddress.includes(dynVars.zip_code)) {
    state.serviceAddress = `${state.serviceAddress}, ${dynVars.zip_code}`;
  }

  // Last agent state
  if (!state.lastAgentState && dynVars.current_agent_state) {
    state.lastAgentState = dynVars.current_agent_state;
  }
}
```

Called from BOTH paths in the `call_analyzed` handler:
1. After `extractStateFromPostCallData()` (no saved session path)
2. After `getCallSession()` returns a saved session

Also: Remove the 30-char threshold at line 271. Change to:
```typescript
const problemDescription = dynProblem || callSummary || custom?.problem_description;
```

Also: Add `callerKnown?: boolean` to the ConversationState type.

### Section 2: Ghost Lead + Callback Gap False Positive Fixes

**Location:** `V2/src/server.ts:494-509`

**Ghost lead:** Add `callerKnown` and `appointmentBooked` gates:

```typescript
if (
  payload.call.disconnection_reason === "user_hangup" &&
  !conversationState.appointmentBooked &&
  !conversationState.callerKnown &&
  callDuration > 10
) {
  logger.info({ ... }, "Ghost lead detected - abandoned call with partial data");
}
```

When `callerKnown` is true but no new booking, log:
```typescript
logger.info({ ... }, "Returning customer call ended without new booking");
```

**Callback gap:** Same gates. A returning customer with an existing appointment
does not have a "callback gap".

### Section 3: RED Priority False Positive Fix

**Location:** `V2/src/services/priority-detection.ts:170-191`

Pass `userSentiment` from Retell's `call_analysis.user_sentiment` into `detectPriority()`.

Only flag `customer_hangup` as frustration when sentiment is explicitly Negative:

```typescript
if (state.endCallReason === "customer_hangup") {
  if (userSentiment === "Negative") {
    signals.push("Customer hung up (potential frustration)");
  }
}
```

Positive, Neutral, and unknown/null sentiment skip the signal. Other RED paths
(frustrated keywords in transcript) still work independently.

### Section 4: Calls Webhook Priority Color Propagation

**Location:** `V2/src/services/dashboard.ts:676` area + `V2/src/server.ts:534-540`

After `sendJobToDashboard()` returns the detected priority, pass `priorityColor` to
`sendCallToDashboard()`:

```typescript
const dashboardResult = await sendJobToDashboard(conversationState, payload.call);
sendCallToDashboard(conversationState, payload.call, dashboardResult.priorityColor).catch(...)
```

Update `sendCallToDashboard` signature and payload to include `priority_color`.

### Section 5: Startup URL Validation

**Location:** `V2/src/services/dashboard.ts:16-22`

Add a startup warning log:

```typescript
if (DASHBOARD_WEBHOOK_URL && !DASHBOARD_WEBHOOK_URL.includes("app.calllock.co")) {
  console.warn(
    `[dashboard] WARNING: DASHBOARD_WEBHOOK_URL points to ${DASHBOARD_WEBHOOK_URL} — expected app.calllock.co`
  );
}
```

Informational only, no blocking. The actual URL fix is an env var change on Render.

### Section 6: Idempotent call_analyzed Processing

**Location:** `V2/src/server.ts:405-411`

Add early-return guard after session retrieval:

```typescript
const conversationState = await getCallSession(callId);

if (conversationState?.syncedToDashboard) {
  logger.info({ callId }, "Already processed — skipping duplicate call_analyzed");
  return res.json({ success: true, message: "Already processed" });
}
```

If first `call_analyzed` succeeds and marks session as synced, retries short-circuit.
If first attempt fails (dashboard 500), session stays unsynced and retries proceed.

No saved session (fallback extraction path) processes normally — no idempotency check possible.

## Fix Summary

| # | Fix | Section | Severity | File |
|---|-----|---------|----------|------|
| 1 | Customer name from dynamic vars | S1 | CRITICAL | server.ts |
| 2 | Problem description threshold | S1 | CRITICAL | server.ts |
| 3 | has_appointment detection | S1 | MODERATE | server.ts |
| 4 | Ghost lead false positive | S2 | MODERATE | server.ts |
| 5 | Callback gap false positive | S2 | MODERATE | server.ts |
| 6 | RED priority false positive | S3 | MODERATE | priority-detection.ts |
| 7 | status_color propagation | S4 | MODERATE | dashboard.ts, server.ts |
| 8 | Startup URL validation | S5 | MINOR | dashboard.ts |
| 9 | Idempotent call_analyzed | S6 | MINOR | server.ts |

## Deployment

All fixes are in V2 backend (Render). No dashboard code changes.

1. Implement fixes in `task21-call-audit-fixes` branch (nagoya workspace)
2. Run existing V2 tests
3. Deploy to Render
4. Fix `DASHBOARD_WEBHOOK_URL` env var on Render to `https://app.calllock.co/api/webhook/jobs`
5. Verify with a test call

## Verification

After deployment + env var fix, make a test call and verify:
- Quality scorecard shows customer_name and problem_description populated
- Returning customer calls are NOT flagged as ghost leads
- Positive-sentiment hangups do NOT get RED priority
- Calls table has correct `priority_color` (not always gray)
- Duplicate `call_analyzed` events are short-circuited
- Render startup logs warn if webhook URL is non-production
