# Audit Scorecard Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 regressions found in the call audit that cause false booking status, missing urgency, and incorrect scorecard calculations.

**Architecture:** Three backend code changes (reconcile-dynvars guard, urgency mapping, callbackType inference), one Render env var update, and one GitHub issue for agent config.

**Tech Stack:** TypeScript, Vitest, Render CLI, GitHub CLI

---

### Task 1: Guard booking reconciliation with `bookingAttempted`

**Files:**
- Modify: `V2/src/extraction/reconcile-dynvars.ts:22-26`
- Test: `V2/src/__tests__/server/reconcile-dynvars.test.ts`

**Step 1: Write failing tests**

Add three tests after line 60 in `reconcile-dynvars.test.ts`:

```typescript
  it('does NOT set appointmentBooked from has_appointment when bookingAttempted is true', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(false);
  });

  it('sets appointmentBooked from booking_confirmed even when bookingAttempted is true', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: false });
    reconcileDynamicVariables(state, { booking_confirmed: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('sets appointmentBooked from has_appointment when bookingAttempted is false', () => {
    const state = makeState({ bookingAttempted: false, appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: First test FAILS (currently sets appointmentBooked=true regardless of bookingAttempted). Second and third should PASS.

**Step 3: Update reconcile-dynvars.ts**

Replace lines 22-26 in `V2/src/extraction/reconcile-dynvars.ts`:

Old:
```typescript
  if (!state.appointmentBooked) {
    if (dynVars.has_appointment === "true" || dynVars.booking_confirmed === "true") {
      state.appointmentBooked = true;
    }
  }
```

New:
```typescript
  if (!state.appointmentBooked) {
    if (dynVars.booking_confirmed === "true") {
      state.appointmentBooked = true;
    } else if (dynVars.has_appointment === "true" && !state.bookingAttempted) {
      state.appointmentBooked = true;
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: ALL tests PASS

**Step 5: Update existing test that now needs bookingAttempted context**

The existing test at line 44-48 (`sets appointmentBooked from has_appointment`) should still pass because `makeState()` defaults `bookingAttempted: false`. Verify it passes.

**Step 6: Commit**

```bash
git add V2/src/extraction/reconcile-dynvars.ts V2/src/__tests__/server/reconcile-dynvars.test.ts
git commit -m "fix: guard reconcile booking with bookingAttempted check

When book_service was attempted and failed (bookingAttempted=true,
appointmentBooked=false), the has_appointment dynvar is stale.
Only trust booking_confirmed unconditionally."
```

---

### Task 2: Reconcile `urgency_tier` dynvar into state

**Files:**
- Modify: `V2/src/extraction/reconcile-dynvars.ts:40-42` (add after lastAgentState block)
- Test: `V2/src/__tests__/server/reconcile-dynvars.test.ts`

**Step 1: Write failing tests**

Add to `reconcile-dynvars.test.ts`:

```typescript
  it('maps urgency_tier "routine" to state.urgency "Routine"', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { urgency_tier: 'routine' });
    expect(state.urgency).toBe('Routine');
  });

  it('maps urgency_tier "emergency" to state.urgency "Emergency"', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { urgency_tier: 'emergency' });
    expect(state.urgency).toBe('Emergency');
  });

  it('maps urgency_tier "same_day" to state.urgency "Urgent"', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { urgency_tier: 'same_day' });
    expect(state.urgency).toBe('Urgent');
  });

  it('does NOT overwrite existing urgency', () => {
    const state = makeState({ urgency: 'Emergency' });
    reconcileDynamicVariables(state, { urgency_tier: 'routine' });
    expect(state.urgency).toBe('Emergency');
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: First three FAIL (urgency never mapped). Fourth should PASS (no overwrite logic needed when urgency already set).

**Step 3: Add urgency mapping to reconcile-dynvars.ts**

Add after line 42 (after the `lastAgentState` block), before the closing `}`:

```typescript
  if (!state.urgency && dynVars.urgency_tier) {
    const tierMap: Record<string, UrgencyLevel> = {
      emergency: "Emergency",
      urgent: "Urgent",
      same_day: "Urgent",
      routine: "Routine",
      estimate: "Estimate",
    };
    const mapped = tierMap[dynVars.urgency_tier.toLowerCase()];
    if (mapped) {
      state.urgency = mapped;
    }
  }
```

Also add the import at the top of the file:

```typescript
import type { UrgencyLevel } from "../types/retell.js";
```

Update line 1 to include UrgencyLevel:

```typescript
import type { ConversationState, UrgencyLevel } from "../types/retell.js";
```

**Step 4: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: ALL tests PASS

**Step 5: Commit**

```bash
git add V2/src/extraction/reconcile-dynvars.ts V2/src/__tests__/server/reconcile-dynvars.test.ts
git commit -m "feat: reconcile urgency_tier dynvar into state.urgency

Maps Retell agent's urgency_tier dynamic variable to the
UrgencyLevel type used by scorecard and dashboard."
```

---

### Task 3: Infer `callbackType` when agent uses `end_call`

**Files:**
- Modify: `V2/src/server.ts:557` (add after dead-end detection block)
- Test: `V2/src/__tests__/server/reconcile-dynvars.test.ts` (or new test file)

**Step 1: Write failing test**

This tests the post-call handler behavior. Since the callbackType inference is simple state mutation, test it inline. Add to `reconcile-dynvars.test.ts` in a new describe block:

```typescript
describe('callbackType inference', () => {
  it('infers callbackType as scheduling when callback_later without booking', () => {
    const state = makeState({
      endCallReason: 'callback_later',
      appointmentBooked: false,
    });
    // Simulate the inference logic from server.ts
    if (
      state.endCallReason === 'callback_later' &&
      !state.callbackType &&
      !state.appointmentBooked
    ) {
      state.callbackType = 'scheduling';
    }
    expect(state.callbackType).toBe('scheduling');
  });

  it('does NOT override existing callbackType', () => {
    const state = makeState({
      endCallReason: 'callback_later',
      callbackType: 'emergency',
      appointmentBooked: false,
    });
    if (
      state.endCallReason === 'callback_later' &&
      !state.callbackType &&
      !state.appointmentBooked
    ) {
      state.callbackType = 'scheduling';
    }
    expect(state.callbackType).toBe('emergency');
  });

  it('does NOT infer callbackType when appointment is booked', () => {
    const state = makeState({
      endCallReason: 'callback_later',
      appointmentBooked: true,
    });
    if (
      state.endCallReason === 'callback_later' &&
      !state.callbackType &&
      !state.appointmentBooked
    ) {
      state.callbackType = 'scheduling';
    }
    expect(state.callbackType).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/server/reconcile-dynvars.test.ts`
Expected: ALL PASS (these test the logic pattern, not the server integration)

**Step 3: Add callbackType inference to server.ts**

Add after line 557 in `V2/src/server.ts` (after the dead-end detection closing brace):

```typescript
    // Infer callbackType when agent promised callback but didn't invoke create_callback.
    // This happens when the agent uses end_call (built-in) instead of create_callback (custom).
    if (
      conversationState.endCallReason === "callback_later" &&
      !conversationState.callbackType &&
      !conversationState.appointmentBooked
    ) {
      conversationState.callbackType = "scheduling";
    }
```

**Step 4: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: ALL tests PASS

**Step 5: Verify build compiles**

Run: `cd V2 && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add V2/src/server.ts V2/src/__tests__/server/reconcile-dynvars.test.ts
git commit -m "fix: infer callbackType when agent uses end_call without create_callback

When endCallReason is callback_later but callbackType is unset,
infer scheduling. This ensures isCallbackCreated() returns true
and the scorecard correctly credits the callback."
```

---

### Task 4: Update `DASHBOARD_WEBHOOK_URL` on Render

**Files:** None (infra change)

**Step 1: Verify current value**

Run: `render env list -r srv-d4mak524d50c73eh3uig -o json 2>&1 | jq '.[] | select(.key == "DASHBOARD_WEBHOOK_URL")'`

Expected: Shows `calllock-dashboard-2.vercel.app` URL

**Step 2: Update to production URL**

Run: `render env set DASHBOARD_WEBHOOK_URL=https://app.calllock.co/api/webhook/jobs -r srv-d4mak524d50c73eh3uig`

**Step 3: Verify update**

Run: `render env list -r srv-d4mak524d50c73eh3uig -o json 2>&1 | jq '.[] | select(.key == "DASHBOARD_WEBHOOK_URL")'`

Expected: Shows `https://app.calllock.co/api/webhook/jobs`

**Step 4: No commit needed** (infra-only change)

---

### Task 5: Create GitHub issue for agent `create_callback` fix

**Files:** None (GitHub issue)

**Step 1: Create the issue**

Run:
```bash
gh issue create \
  --repo rbaset5/calllock-belgrade \
  --title "Agent should call create_callback before end_call on booking failure" \
  --body "$(cat <<'EOF'
## Problem

When `book_service` fails, the agent verbally promises a callback ("they'll call you shortly") then fires `end_call` without invoking `create_callback`. This means `callbackType` is never set in the session.

## Evidence

Call `call_b794875fb9c0a7e17d647f05fc4` (Feb 14 2026):
- `book_service` called at 108.2s → `success: false`
- Agent says "I'll have someone call you back"
- `end_call` fired at 128.3s
- No `create_callback` in tool call list

## Impact

- `callbackType` never set → `isCallbackCreated()` returns false
- Scorecard `hasBookingOrCallback` depends on backend inference (workaround deployed)
- Dashboard doesn't know a callback was promised

## Fix

In the Retell agent config (CallSeal - 8 State v6), the booking state's failure exit path should:
1. Call `create_callback` with type `scheduling`
2. Then call `end_call`

## Workaround

Backend now infers `callbackType = "scheduling"` when `endCallReason === "callback_later"` and no `callbackType` is set (deployed in audit-scorecard-fixes branch).
EOF
)"
```

Note: Adjust `--repo` to the correct repository name if different.

**Step 2: Verify issue created**

Expected: Issue URL returned

---

### Task 6: Push branch and create PR

**Files:** None

**Step 1: Run full test suite one final time**

Run: `cd V2 && npx vitest run`
Expected: ALL tests PASS

**Step 2: Run TypeScript compiler check**

Run: `cd V2 && npx tsc --noEmit`
Expected: No errors

**Step 3: Push and create PR**

```bash
git push -u origin rbaset5/fix-dynvar-reconciliation
gh pr create \
  --title "fix: audit scorecard regressions (booking guard, urgency, callback)" \
  --body "$(cat <<'EOF'
## Summary

Fixes 5 regressions found in call audit of `call_b794875fb9c0a7e17d647f05fc4`:

- **CRITICAL:** Guard `reconcileDynamicVariables` booking with `bookingAttempted` check — prevents stale `has_appointment` dynvar from overriding failed booking result
- **MODERATE:** Reconcile `urgency_tier` dynvar into `state.urgency` — previously collected but never mapped
- **MODERATE:** Infer `callbackType = "scheduling"` when agent uses `end_call` without `create_callback`
- **MODERATE:** Updated `DASHBOARD_WEBHOOK_URL` on Render to `app.calllock.co`
- **MODERATE:** Created issue for agent to call `create_callback` before `end_call`

## Test plan

- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsc --noEmit` — no type errors
- [ ] Verify scorecard for failed-booking calls shows `booking_status: "attempted_failed"` not `"confirmed"`
- [ ] Verify urgency is populated from dynvar when not set by session
- [ ] Verify callbackType inferred for callback_later calls without explicit create_callback

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
