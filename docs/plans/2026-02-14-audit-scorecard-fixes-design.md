# Audit Scorecard Fixes — Design

**Date:** 2026-02-14
**Source:** Call audit of `call_b794875fb9c0a7e17d647f05fc4` (Jonas, Feb 14 13:08 EST)
**Branch:** `rbaset5/fix-audit-scorecard-regressions`

## Problem Statement

The call audit revealed 5 issues causing incorrect scorecard calculations, missed dead-end detection, and false booking status reporting. The Render scorecard showed 90/100 with no warnings; the correct score should be 80 with a `callback-gap` warning.

### Root Cause Chain

1. Retell agent sets `has_appointment="true"` when entering booking state, even when `book_service` returns `success: false`
2. `reconcileDynamicVariables` trusts `has_appointment` without checking `bookingAttempted`
3. `appointmentBooked` set to `true` (wrong) cascades:
   - `booking_status` sent as `"confirmed"` instead of `"attempted_failed"`
   - Dead-end detection skipped (`!appointmentBooked` guard fails)
   - Urgency not elevated to `"Urgent"`
   - `callback-gap` warning suppressed
   - Scorecard inflated by 10 points

## Fixes

### Fix 1: Guard reconcile booking with `bookingAttempted` (CRITICAL)

**File:** `V2/src/extraction/reconcile-dynvars.ts` lines 22-26

Trust `booking_confirmed` unconditionally (set by V2 booking handler on success). Only trust `has_appointment` when `bookingAttempted` is false — if the backend knows a booking was attempted and failed, the dynvar is stale.

```typescript
if (!state.appointmentBooked) {
    if (dynVars.booking_confirmed === "true") {
      state.appointmentBooked = true;
    } else if (dynVars.has_appointment === "true" && !state.bookingAttempted) {
      state.appointmentBooked = true;
    }
}
```

**Why `booking_confirmed` is trusted:** Set by V2's own `functions/booking.ts` (lines 134, 164, 182) only on successful booking. It's an authoritative signal from our own code.

**Why `has_appointment` needs the guard:** Set by the Retell agent when entering the booking state, before confirmation. It's a stale signal when booking fails.

### Fix 2: Reconcile `urgency_tier` dynvar (MODERATE)

**File:** `V2/src/extraction/reconcile-dynvars.ts`

The Retell agent collects `urgency_tier` (e.g. "routine", "same_day", "emergency") but it's never mapped to `state.urgency`. Add mapping using the same convention as `mapUrgencyLevelFromAnalysis` in `post-call.ts`:

```typescript
if (!state.urgency && dynVars.urgency_tier) {
    const tierMap: Record<string, string> = {
      emergency: "Emergency",
      urgent: "Urgent",
      same_day: "Urgent",
      routine: "Routine",
      estimate: "Estimate",
    };
    const mapped = tierMap[dynVars.urgency_tier.toLowerCase()];
    if (mapped) {
      state.urgency = mapped as ConversationState["urgency"];
    }
}
```

### Fix 3: Infer `callbackType` from agent behavior (MODERATE)

**File:** `V2/src/server.ts` (post-call handler, after dead-end detection ~line 557)

When the agent uses `end_call` (built-in) instead of `create_callback` (custom webhook), `callbackType` is never set. This makes `isCallbackCreated()` return false, breaking scorecard `hasBookingOrCallback` and triggering false `callback-gap` warnings.

```typescript
if (
    conversationState.endCallReason === "callback_later" &&
    !conversationState.callbackType &&
    !conversationState.appointmentBooked
) {
    conversationState.callbackType = "scheduling";
}
```

### Fix 4: Update `DASHBOARD_WEBHOOK_URL` on Render (MODERATE)

**Action:** `render env set` to change from `calllock-dashboard-2.vercel.app` to `app.calllock.co`.

### Fix 5: GitHub issue for agent `create_callback` (MODERATE)

Create issue: Agent booking-failure path should invoke `create_callback` before `end_call` so `callbackType` is set in the session at the source.

## Expected Outcome

After all fixes, the same call (Jonas) would produce:

| Field | Before | After |
|-------|--------|-------|
| appointmentBooked | true (wrong) | false |
| booking_status | "confirmed" | "attempted_failed" |
| urgency | undefined | "Routine" |
| Dead-end detection | skipped | fires → urgency elevated to "Urgent" |
| callbackType | undefined | "scheduling" (inferred) |
| hasBookingOrCallback | true (false positive) | true (via callback inference) |
| hasUrgency | false | true (after dead-end elevates to Urgent) |
| Score | 90 | 90 (same total, but for correct reasons) |
| Warnings | [] | [] (callback properly detected) |

Note: The score remains 90 but the underlying data is now correct. The booking credit comes from callback inference (correct) instead of false booking (wrong). Urgency gets credit from dead-end elevation (correct).

## Testing

- `reconcile-dynvars.test.ts`: 3 new cases for booking guard, 1 for urgency_tier mapping
- `server.ts` post-call handler: verify callbackType inference
- Existing scorecard tests should continue passing
