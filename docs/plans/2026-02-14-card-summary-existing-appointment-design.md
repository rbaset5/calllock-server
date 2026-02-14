# Card Summary: Distinguish New vs Existing Appointments

**Date:** 2026-02-14
**Issue:** Call audit of `call_7414ebcc9420110834f30170cc7` revealed that card_summary says "Appointment booked." for callers who already had a pre-existing appointment, not a new booking.

## Problem

When a returning caller (e.g., Jonas) has an existing appointment found via `lookup_caller`, the agent sets `has_appointment=true` in dynvars. Reconcile trusts this and sets `appointmentBooked=true`. The card_summary then says "Appointment booked." — implying the AI booked a NEW appointment, when it didn't.

This misleads the business owner into thinking the new issue is handled. In Jonas's case, he called about a dead rat in his air vent, but his existing appointment (Thu Feb 19) was for a different issue.

## Root Cause

`buildCardSummary()` doesn't distinguish between:
- `appointmentBooked=true` from a new booking (`bookingAttempted=true`)
- `appointmentBooked=true` from a pre-existing appointment (`bookingAttempted=false`)

## Fix

In `buildCardSummary()`, split the `appointmentBooked` branch:

```typescript
if (state.appointmentBooked && state.appointmentDateTime && state.bookingAttempted) {
  parts.push(`Appointment booked for ${state.appointmentDateTime}.`);
} else if (state.appointmentBooked && state.bookingAttempted) {
  parts.push("Appointment booked.");
} else if (state.appointmentBooked) {
  parts.push("Has existing appointment.");
} else if (state.bookingAttempted) {
  parts.push("Booking failed, callback requested.");
} else if (state.endCallReason === "callback_later") {
  parts.push("Callback requested.");
}
```

## UX Rationale

For the HVAC business owner:
- **"Appointment booked."** → AI handled it, no action needed
- **"Has existing appointment."** → Caller has one on file, review if it covers the new issue
- **"Booking failed, callback requested."** → AI tried but failed, call them back
