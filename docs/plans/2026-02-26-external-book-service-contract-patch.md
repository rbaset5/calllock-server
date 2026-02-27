# External Patch Spec — `book_service` Response Contract

**Date:** 2026-02-26  
**Target system:** External dashboard backend endpoint `POST /api/retell/book-service`  
**Current blocker:** End-to-end production is not fully fixed until this endpoint returns both compatibility keys:
- `booked`
- `booking_confirmed`

## Scope

This patch is for the external repo that owns:
- `calllock-dashboard/src/app/api/retell/book-service/route.ts` (as documented)

That code is **not** in this workspace, so this document is the implementation contract.

## Required Contract Change

### Success response (must include both keys)

```json
{
  "booked": true,
  "booking_confirmed": true,
  "appointment_date": "Friday, February 27, 2026",
  "appointment_time": "3:45 PM",
  "message": "You're all set for Friday, February 27, 2026 at 3:45 PM."
}
```

### Not-booked response (must include both keys)

```json
{
  "booked": false,
  "booking_confirmed": false,
  "available_slots": ["Friday 3:45 PM", "Friday 5:15 PM"],
  "message": "Requested slot unavailable."
}
```

### Error response (must include both keys)

```json
{
  "booked": false,
  "booking_confirmed": false,
  "error": "Unable to complete booking at this time."
}
```

## Minimal Implementation Pattern (TypeScript)

In `route.ts`, normalize all return paths through a helper:

```ts
type BookServiceResult = {
  booked: boolean;
  booking_confirmed: boolean;
  appointment_date?: string;
  appointment_time?: string;
  message?: string;
  available_slots?: string[];
  error?: string;
  [key: string]: unknown;
};

function withCompatibility(result: Omit<BookServiceResult, "booking_confirmed"> & { booked: boolean }): BookServiceResult {
  return {
    ...result,
    booking_confirmed: result.booked,
  };
}
```

Then return:

```ts
return NextResponse.json(
  withCompatibility({
    booked: true,
    appointment_date,
    appointment_time,
    message,
    // ...other existing fields
  })
);
```

And similarly for all failure/error branches with `booked: false`.

### Safer Option: Enforce in `jsonResponse`

To avoid missing a branch, apply compatibility in the route response helper so every JSON response includes both keys when `booked` is present:

```ts
function jsonResponse(data: unknown, status = 200): NextResponse {
  const normalized = normalizeResponseShape(data);
  if (typeof normalized.booked === 'boolean' && typeof normalized.booking_confirmed !== 'boolean') {
    normalized.booking_confirmed = normalized.booked;
  }
  const body = JSON.stringify(normalized);
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
```

## Guardrails

- Do not remove existing fields currently consumed by the agent (backward compatibility).
- Keep `booked` as the canonical boolean in this endpoint; `booking_confirmed` is an alias for compatibility.
- Ensure every branch (success, no slot, validation fail, exception) includes both booleans.

## Validation Checklist (External Repo)

1. Unit tests or route tests assert:
   - success includes `booked: true` and `booking_confirmed: true`
   - failure includes `booked: false` and `booking_confirmed: false`
   - error includes both booleans
2. Run one real Retell test call where slot is available:
   - call logs show `book_service` result with both keys
3. Run one test where preferred time is unavailable:
   - result includes both keys and alternatives list
4. Confirm `V2`/`V3` post-call logs and dashboard fields still parse correctly.

## Why This Is Required

Prompt/backend behavior now tolerates both keys, but leaving external `book_service` on a single-key contract keeps production brittle and can regress branching/edge behavior across prompts, parsers, and dashboards.

## Current Status (Local Patch Applied, Deploy Pending)

As of **2026-02-27**, local checkout `/Users/rashidbaset/calllock-dashboard` has been patched to enforce compatibility at response normalization:

- `/Users/rashidbaset/calllock-dashboard/src/app/api/retell/book-service/response-shape.ts`
  - Adds `withBookingCompatibility()` so any response containing either `booked` or `booking_confirmed` is normalized to include both keys.
- `/Users/rashidbaset/calllock-dashboard/src/__tests__/api/retell/book-service-route.test.ts`
  - Updated to assert `booking_confirmed` presence on success/failure normalized payloads.

Validation executed locally:

```bash
npm run test:run -- src/__tests__/api/retell/book-service-route.test.ts
```

Result: **12 tests passed**.

Production remains blocked until these external dashboard changes are deployed.
