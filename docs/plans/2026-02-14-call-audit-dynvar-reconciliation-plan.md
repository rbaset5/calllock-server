# Call Audit Dynamic Variable Reconciliation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 9 regressions found in call audit by adding a central dynamic-variable reconciliation function, fixing false-positive classification, propagating priority color to calls, and adding idempotency.

**Architecture:** One new `reconcileDynamicVariables()` function in `server.ts` merges Retell's `collected_dynamic_variables` into conversation state post-call. Targeted patches fix priority detection, ghost lead logic, dashboard calls payload, and idempotent processing.

**Tech Stack:** TypeScript, Vitest, Express (V2 backend)

**Workspace:** Implement in the nagoya workspace on branch `task21-call-audit-fixes`. The codebase layout is identical to montevideo — all paths under `V2/src/`.

---

### Task 1: Add `callerKnown` to ConversationState type

**Files:**
- Modify: `V2/src/types/retell.ts:258-304`

**Step 1: Add the field**

In `V2/src/types/retell.ts`, inside `interface ConversationState` (after `lastAgentState` at line 299), add:

```typescript
  callerKnown?: boolean;             // True if customer found in history lookup
```

**Step 2: Verify typecheck passes**

Run: `cd V2 && npx tsc --noEmit`
Expected: PASS (new optional field, no breakage)

**Step 3: Commit**

```bash
git add V2/src/types/retell.ts
git commit -m "feat: add callerKnown to ConversationState type"
```

---

### Task 2: Add `userSentiment` parameter to `detectPriority`

**Files:**
- Modify: `V2/src/services/priority-detection.ts:149-191`
- Test: `V2/src/__tests__/services/priority-detection.test.ts` (create)

**Step 1: Write failing tests**

Create `V2/src/__tests__/services/priority-detection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectPriority } from '../../services/priority-detection.js';
import { ConversationState } from '../../types/retell.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'test-call-1',
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('detectPriority', () => {
  describe('RED priority — customer_hangup + sentiment', () => {
    it('returns RED when customer_hangup AND sentiment is Negative', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, 'Negative');
      expect(result.color).toBe('red');
      expect(result.signals).toContain('Customer hung up (potential frustration)');
    });

    it('does NOT return RED when customer_hangup AND sentiment is Positive', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, 'Positive');
      expect(result.color).not.toBe('red');
    });

    it('does NOT return RED when customer_hangup AND sentiment is Neutral', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, 'Neutral');
      expect(result.color).not.toBe('red');
    });

    it('does NOT return RED when customer_hangup AND sentiment is undefined', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, undefined);
      expect(result.color).not.toBe('red');
    });

    it('still returns RED when transcript has frustrated keywords regardless of sentiment', () => {
      const state = makeState({ endCallReason: 'completed' });
      const result = detectPriority(state, 'I am very angry about this', undefined, 'Positive');
      expect(result.color).toBe('red');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/services/priority-detection.test.ts`
Expected: FAIL — `detectPriority` does not accept 4th argument yet

**Step 3: Update `detectPriority` signature and logic**

In `V2/src/services/priority-detection.ts`, change the function signature at line 149:

```typescript
export function detectPriority(
  state: ConversationState,
  transcript?: string,
  estimate?: RevenueEstimate,
  userSentiment?: string
): PriorityResult {
```

Replace lines 169-172 (the `customer_hangup` signal block):

```typescript
  // Check end call reason — only flag as frustration if sentiment is Negative
  if (state.endCallReason === "customer_hangup" && userSentiment === "Negative") {
    signals.push("Customer hung up (potential frustration)");
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/services/priority-detection.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: PASS (existing callers of `detectPriority` don't pass 4th arg — undefined is the default)

**Step 6: Commit**

```bash
git add V2/src/services/priority-detection.ts V2/src/__tests__/services/priority-detection.test.ts
git commit -m "fix: only flag RED priority on customer_hangup when sentiment is Negative"
```

---

### Task 3: Pass `userSentiment` through callers of `detectPriority`

**Files:**
- Modify: `V2/src/services/dashboard.ts:386` and `V2/src/services/dashboard.ts:614`

**Step 1: Update `transformToDashboardPayload` (line 386)**

Change:
```typescript
  const priority = detectPriority(state, retellData?.transcript, estimate);
```
To:
```typescript
  const priority = detectPriority(state, retellData?.transcript, estimate, retellData?.call_analysis?.user_sentiment);
```

**Step 2: Update `sendCallToDashboard` priority detection (line 614)**

Change:
```typescript
  const priority = detectPriority(state, retellData?.transcript, estimate);
```
To:
```typescript
  const priority = detectPriority(state, retellData?.transcript, estimate, retellData?.call_analysis?.user_sentiment);
```

**Step 3: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add V2/src/services/dashboard.ts
git commit -m "fix: pass userSentiment to detectPriority from dashboard callers"
```

---

### Task 4: Implement `reconcileDynamicVariables` and remove 30-char threshold

**Files:**
- Modify: `V2/src/server.ts:245-277` (extraction function) and `V2/src/server.ts:419-425` (call_analyzed handler)
- Test: `V2/src/__tests__/server/reconcile-dynvars.test.ts` (create)

**Step 1: Write failing tests**

Create `V2/src/__tests__/server/reconcile-dynvars.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reconcileDynamicVariables } from '../../server.js';
import { ConversationState } from '../../types/retell.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'test-call-1',
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('reconcileDynamicVariables', () => {
  it('fills customerName from dynVars when state is empty', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { customer_name: 'Jonas' });
    expect(state.customerName).toBe('Jonas');
  });

  it('does NOT overwrite existing customerName', () => {
    const state = makeState({ customerName: 'Existing' });
    reconcileDynamicVariables(state, { customer_name: 'Jonas' });
    expect(state.customerName).toBe('Existing');
  });

  it('fills problemDescription from problem_summary', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { problem_summary: 'Thermostat cover broken' });
    expect(state.problemDescription).toBe('Thermostat cover broken');
  });

  it('prefers problem_description over problem_summary', () => {
    const state = makeState();
    reconcileDynamicVariables(state, {
      problem_description: 'Detailed description here',
      problem_summary: 'Short summary',
    });
    expect(state.problemDescription).toBe('Detailed description here');
  });

  it('sets appointmentBooked from has_appointment', () => {
    const state = makeState({ appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('sets appointmentBooked from booking_confirmed', () => {
    const state = makeState({ appointmentBooked: false });
    reconcileDynamicVariables(state, { booking_confirmed: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('does NOT unset appointmentBooked if already true', () => {
    const state = makeState({ appointmentBooked: true });
    reconcileDynamicVariables(state, { has_appointment: 'false' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('sets callerKnown from caller_known', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { caller_known: 'true' });
    expect(state.callerKnown).toBe(true);
  });

  it('fills serviceAddress from dynVars', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { service_address: '123 Main St' });
    expect(state.serviceAddress).toBe('123 Main St');
  });

  it('appends zip_code to serviceAddress when not already present', () => {
    const state = makeState({ serviceAddress: '123 Main St' });
    reconcileDynamicVariables(state, { zip_code: '78701' });
    expect(state.serviceAddress).toBe('123 Main St, 78701');
  });

  it('does NOT append zip_code if already in address', () => {
    const state = makeState({ serviceAddress: '123 Main St, 78701' });
    reconcileDynamicVariables(state, { zip_code: '78701' });
    expect(state.serviceAddress).toBe('123 Main St, 78701');
  });

  it('fills lastAgentState from current_agent_state', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { current_agent_state: 'safety' });
    expect(state.lastAgentState).toBe('safety');
  });

  it('is a no-op when dynVars is undefined', () => {
    const state = makeState({ customerName: 'Keep' });
    reconcileDynamicVariables(state, undefined);
    expect(state.customerName).toBe('Keep');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: FAIL — `reconcileDynamicVariables` does not exist yet

**Step 3: Implement `reconcileDynamicVariables` in `server.ts`**

Add this exported function near the top of `server.ts`, after the imports (before `maskTestPhone`):

```typescript
/**
 * Merge Retell's collected_dynamic_variables into conversation state.
 * Called post-call to fill gaps where the session was saved before
 * state transitions enriched it.
 */
export function reconcileDynamicVariables(
  state: ConversationState,
  dynVars: Record<string, string> | undefined
): void {
  if (!dynVars) return;

  if (!state.customerName && dynVars.customer_name) {
    state.customerName = dynVars.customer_name;
  }

  if (!state.problemDescription) {
    state.problemDescription = dynVars.problem_description || dynVars.problem_summary;
  }

  if (!state.appointmentBooked) {
    if (dynVars.has_appointment === "true" || dynVars.booking_confirmed === "true") {
      state.appointmentBooked = true;
    }
  }

  if (dynVars.caller_known === "true") {
    state.callerKnown = true;
  }

  if (!state.serviceAddress && dynVars.service_address) {
    state.serviceAddress = dynVars.service_address;
  }

  if (dynVars.zip_code && state.serviceAddress && !state.serviceAddress.includes(dynVars.zip_code)) {
    state.serviceAddress = `${state.serviceAddress}, ${dynVars.zip_code}`;
  }

  if (!state.lastAgentState && dynVars.current_agent_state) {
    state.lastAgentState = dynVars.current_agent_state;
  }
}
```

**Step 4: Call it from both paths in the `call_analyzed` handler**

In the handler (~line 420-425), add the reconciliation call after BOTH paths:

After line 425 (`conversationState = extractStateFromPostCallData(payload.call);`):
```typescript
    } else {
      // No saved session - extract data from post-call webhook payload
      logger.info({ callId }, "No session found, extracting from webhook data");
      conversationState = extractStateFromPostCallData(payload.call);
    }

    // Reconcile dynamic variables into state (fills gaps from sparse sessions)
    reconcileDynamicVariables(conversationState, payload.call.collected_dynamic_variables);
```

This single line handles BOTH paths — saved session and extracted-from-webhook.

**Step 5: Remove the 30-char threshold**

In `extractStateFromPostCallData()` (~line 269-273), change:

```typescript
  const dynProblem = dynVars?.problem_description || dynVars?.problem_summary;
  const callSummary = callData.call_analysis?.call_summary;
  const problemDescription = dynProblem && dynProblem.length >= 30
    ? dynProblem
    : callSummary || dynProblem || custom?.problem_description;
```

To:

```typescript
  const dynProblem = dynVars?.problem_description || dynVars?.problem_summary;
  const callSummary = callData.call_analysis?.call_summary;
  const problemDescription = dynProblem || callSummary || custom?.problem_description;
```

**Step 6: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: PASS

Run: `cd V2 && npx vitest run`
Expected: PASS (full suite)

**Step 7: Commit**

```bash
git add V2/src/server.ts V2/src/__tests__/server/reconcile-dynvars.test.ts
git commit -m "feat: add reconcileDynamicVariables to merge Retell dynvars into state post-call

Fixes customer_name, problem_summary, has_appointment not propagating.
Removes 30-char threshold on problem descriptions."
```

---

### Task 5: Fix ghost lead + callback gap false positives

**Files:**
- Modify: `V2/src/server.ts:490-532`
- Test: Add cases to `V2/src/__tests__/server/reconcile-dynvars.test.ts` (or create a new test file for the handler — your choice; the logic is inline in the handler, so test through the reconciled state)

**Step 1: Write failing test**

Add to `V2/src/__tests__/server/reconcile-dynvars.test.ts` (or create `V2/src/__tests__/server/ghost-lead.test.ts`):

This is tricky because ghost lead logic is inline in the Express handler. Instead, extract the logic into a testable function. Add to `server.ts`:

```typescript
/**
 * Determine if a call is a "ghost lead" (abandoned with partial data).
 * Returns false for returning customers with existing appointments.
 */
export function isGhostLead(
  disconnectionReason: string | undefined,
  state: ConversationState,
  callDuration: number
): boolean {
  if (disconnectionReason !== "user_hangup") return false;
  if (state.appointmentBooked) return false;
  if (state.callerKnown) return false;
  if (callDuration <= 10) return false;
  return true;
}
```

Create `V2/src/__tests__/server/ghost-lead.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isGhostLead } from '../../server.js';
import { ConversationState } from '../../types/retell.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'test-call-1',
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('isGhostLead', () => {
  it('returns true for user_hangup without booking or caller history', () => {
    const state = makeState();
    expect(isGhostLead('user_hangup', state, 30)).toBe(true);
  });

  it('returns false when appointmentBooked is true', () => {
    const state = makeState({ appointmentBooked: true });
    expect(isGhostLead('user_hangup', state, 30)).toBe(false);
  });

  it('returns false when callerKnown is true', () => {
    const state = makeState({ callerKnown: true });
    expect(isGhostLead('user_hangup', state, 30)).toBe(false);
  });

  it('returns false for agent_hangup', () => {
    const state = makeState();
    expect(isGhostLead('agent_hangup', state, 30)).toBe(false);
  });

  it('returns false for very short calls (<= 10s)', () => {
    const state = makeState();
    expect(isGhostLead('user_hangup', state, 5)).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/server/ghost-lead.test.ts`
Expected: FAIL — `isGhostLead` not exported yet

**Step 3: Add `isGhostLead` function and refactor handler**

Add the `isGhostLead` function (from Step 1 above) to `server.ts`.

Replace the inline ghost lead block at lines 490-509:

```typescript
    // Ghost lead detection: log abandoned calls for observability
    const callDuration = payload.call.end_timestamp && payload.call.start_timestamp
      ? (payload.call.end_timestamp - payload.call.start_timestamp) / 1000
      : 0;
    if (isGhostLead(payload.call.disconnection_reason, conversationState, callDuration)) {
      logger.info(
        {
          callId,
          duration: callDuration,
          customerName: conversationState.customerName,
          customerPhone: conversationState.customerPhone,
        },
        "Ghost lead detected - abandoned call with partial data"
      );
    } else if (
      payload.call.disconnection_reason === "user_hangup" &&
      conversationState.callerKnown &&
      !conversationState.appointmentBooked
    ) {
      logger.info(
        { callId, customerName: conversationState.customerName },
        "Returning customer call ended without new booking"
      );
    }
```

**Step 4: Fix callback gap warning**

Find the callback gap warning (search for "Callback gap" in `server.ts`). If it's not in `server.ts`, it may be in the deployed-only code. In that case, skip this sub-step — the reconciliation already fixes the root data issue.

If found, gate it:

```typescript
    if (
      !conversationState.appointmentBooked &&
      !conversationState.callerKnown &&
      conversationState.endCallReason === "customer_hangup"
    ) {
      logger.warn({ callId, ... }, "Callback gap — call ended without booking or callback request");
    }
```

**Step 5: Run tests**

Run: `cd V2 && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add V2/src/server.ts V2/src/__tests__/server/ghost-lead.test.ts
git commit -m "fix: skip ghost lead and callback gap for returning customers with appointments"
```

---

### Task 6: Propagate priority_color to calls webhook

**Files:**
- Modify: `V2/src/services/dashboard.ts:601-663` (sendCallToDashboard)
- Modify: `V2/src/server.ts:534-540` (caller site)

The calls webhook payload at line 652 already has `priority_color: priority.color` — it's computed inside `sendCallToDashboard` at line 614. So the calls webhook already sends priority. The bug is that `status_color` in the calls table ends up "gray" despite RED detection.

**Step 1: Verify the calls payload already includes priority_color**

Read `V2/src/services/dashboard.ts:650-655`. Confirm `priority_color: priority.color` is in the payload.

If it IS there (which it is per the code review), then the issue is on the dashboard side — `calls` webhook handler ignoring `priority_color`. This is a dashboard fix, not a V2 fix.

**Step 2: Check if the dashboard calls webhook handler stores priority_color**

Read `calllock-dashboard/src/app/api/webhook/calls/route.ts` to see if `priority_color` is mapped to the `calls` table.

If it's NOT stored: this needs a dashboard-side fix (out of scope per design — only V2 changes). Document it.

If it IS stored but overwritten: investigate. The calls webhook schema includes `priority_color` as optional, so the field should be passed through.

**Step 3: Commit documentation if no code change needed**

If V2 already sends `priority_color` correctly, no code change here. Move on.

---

### Task 7: Add startup URL validation

**Files:**
- Modify: `V2/src/services/dashboard.ts:25-27`
- Test: `V2/src/__tests__/sync/webhook-config.test.ts`

**Step 1: Write failing test**

Add to `V2/src/__tests__/sync/webhook-config.test.ts`:

```typescript
  it('warns if DASHBOARD_WEBHOOK_URL does not point to production', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dashboardSource = fs.readFileSync(
      path.resolve(__dirname, '../../services/dashboard.ts'),
      'utf-8'
    );

    // Verify startup URL validation exists
    expect(dashboardSource).toContain('app.calllock.co');
  });
```

**Step 2: Run test to verify it fails**

Run: `cd V2 && npx vitest run src/__tests__/sync/webhook-config.test.ts`
Expected: FAIL — `app.calllock.co` not in source yet

**Step 3: Add the validation**

In `V2/src/services/dashboard.ts`, after line 27 (`}`), add:

```typescript
// Warn at startup if webhook URL doesn't point to production
if (isDashboardConfigured && DASHBOARD_WEBHOOK_URL && !DASHBOARD_WEBHOOK_URL.includes("app.calllock.co")) {
  log.warn(
    { url: DASHBOARD_WEBHOOK_URL },
    "DASHBOARD_WEBHOOK_URL does not point to app.calllock.co — verify env config"
  );
}
```

**Step 4: Run tests**

Run: `cd V2 && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add V2/src/services/dashboard.ts V2/src/__tests__/sync/webhook-config.test.ts
git commit -m "fix: add startup warning when DASHBOARD_WEBHOOK_URL is non-production"
```

---

### Task 8: Add idempotent `call_analyzed` processing

**Files:**
- Modify: `V2/src/server.ts:419-425` (call_analyzed handler, after session retrieval)

**Step 1: Add early-return guard**

In the `call_analyzed` handler, after session retrieval and BEFORE reconciliation, add:

```typescript
    // Retrieve the saved conversation state, or extract from webhook data
    let conversationState = await getCallSession(callId);

    // Idempotency: skip if already synced to dashboard
    if (conversationState?.syncedToDashboard) {
      logger.info({ callId }, "Already processed — skipping duplicate call_analyzed");
      return res.json({ success: true, message: "Already processed" });
    }
```

Note: `syncedToDashboard` is set by `updateCallSessionSynced()` at line 544 after successful sync.

**Step 2: Verify the field exists**

Check that `getCallSession` returns an object with `syncedToDashboard`. Look at `V2/src/services/supabase.ts` for the session schema. The field is `synced_to_dashboard` in the DB, mapped to `syncedToDashboard` in the JS object.

If the mapping doesn't exist, add it to the session retrieval function.

**Step 3: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add V2/src/server.ts
git commit -m "fix: skip duplicate call_analyzed processing via idempotency guard"
```

---

### Task 9: Final verification

**Step 1: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: ALL PASS

**Step 2: Run typecheck**

Run: `cd V2 && npx tsc --noEmit`
Expected: PASS

**Step 3: Review all changes**

Run: `git diff main --stat`
Verify only expected files changed.

**Step 4: Push**

```bash
git push origin task21-call-audit-fixes
```
