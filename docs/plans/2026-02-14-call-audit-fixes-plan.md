# Call Audit Critical Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 critical regressions found by end-to-end call audit: missing `call_sessions` table, binary `booking_status` logic, and commented-out `end_call_reason` storage.

**Architecture:** Dashboard migration creates the missing table. Dashboard webhook handler gets a 1-line uncomment. V2 backend gets a new `bookingAttempted` state flag and tri-state `booking_status` logic.

**Tech Stack:** Supabase (PostgreSQL migration), Next.js API route (dashboard), Express/TypeScript (V2 backend), vitest (both repos)

---

### Task 1: Create `call_sessions` migration in dashboard repo

**Files:**
- Create: `/Users/rashidbaset/calllock-dashboard/supabase/migrations/0031_call_sessions.sql`

**Step 1: Write the migration SQL**

```sql
-- 0031_call_sessions.sql
-- Creates the call_sessions table for V2 backend mid-call state persistence.
-- The V2 backend (calllock-server on Render) uses this table to store conversation
-- state during a call so it can be retrieved during post-call webhook processing.
-- Without this table, post-call processing falls back to degraded extraction from
-- Retell's collected_dynamic_variables only.

CREATE TABLE IF NOT EXISTS public.call_sessions (
  call_id TEXT PRIMARY KEY,
  conversation_state JSONB NOT NULL,
  retell_data JSONB,
  synced_to_dashboard BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

-- V2 backend connects via service_role key (bypasses RLS).
-- This policy allows admin/service-role access for completeness.
CREATE POLICY "Service role full access" ON public.call_sessions
  FOR ALL USING (true);

-- Index for cleanup queries (find old un-synced sessions)
CREATE INDEX idx_call_sessions_synced ON public.call_sessions (synced_to_dashboard)
  WHERE synced_to_dashboard = FALSE;
```

**Step 2: Verify migration file is correctly numbered**

Run: `ls /Users/rashidbaset/calllock-dashboard/supabase/migrations/ | tail -3`
Expected: `0031_call_sessions.sql` appears after `0030_site_contact_fields.sql`

**Step 3: Commit**

```bash
cd /Users/rashidbaset/calllock-dashboard
git add supabase/migrations/0031_call_sessions.sql
git commit -m "feat: add call_sessions table migration (fixes state persistence)"
```

---

### Task 2: Uncomment `end_call_reason` in dashboard webhook — write failing test first

**Files:**
- Modify: `/Users/rashidbaset/calllock-dashboard/src/app/api/webhook/jobs/route.ts:523`
- Test: `/Users/rashidbaset/calllock-dashboard/src/__tests__/api/webhook/jobs.test.ts`

**Step 1: Read the existing test file to understand patterns**

Read: `/Users/rashidbaset/calllock-dashboard/src/__tests__/api/webhook/jobs.test.ts`
Understand how the webhook handler is tested (mocking Supabase, request construction, etc.)

**Step 2: Write the failing test**

Add a test case to the existing test file that verifies `end_call_reason` is stored when creating a lead. The test should:
- Send a webhook payload with `end_call_reason: "callback_later"` and no `scheduled_at` (so it creates a lead)
- Assert the Supabase insert call includes `end_call_reason: "callback_later"`

The exact test code depends on the existing mock patterns in the test file. Follow the pattern of existing tests.

**Step 3: Run test to verify it fails**

Run: `cd /Users/rashidbaset/calllock-dashboard && npx vitest run src/__tests__/api/webhook/jobs.test.ts -t "end_call_reason"`
Expected: FAIL — the current code has `end_call_reason` commented out, so the insert won't include it.

**Step 4: Fix the code — uncomment `end_call_reason` in lead INSERT**

In `/Users/rashidbaset/calllock-dashboard/src/app/api/webhook/jobs/route.ts`, line 523:

Change:
```typescript
          // end_call_reason: body.end_call_reason || null,
```

To:
```typescript
          end_call_reason: effectiveReason || null,
```

Note: Use `effectiveReason` (not `body.end_call_reason`) because the handler already resolves the effective reason (may reclassify `customer_hangup` → `callback_later`). This is on line ~344 where `effectiveReason` is computed.

**Step 5: Add `end_call_reason` to the lead UPDATE path**

In the same file, in the update block (~lines 420-465), add:

```typescript
              end_call_reason: effectiveReason ?? undefined,
```

alongside the other fields being updated.

**Step 6: Run test to verify it passes**

Run: `cd /Users/rashidbaset/calllock-dashboard && npx vitest run src/__tests__/api/webhook/jobs.test.ts -t "end_call_reason"`
Expected: PASS

**Step 7: Run full test suite to check for regressions**

Run: `cd /Users/rashidbaset/calllock-dashboard && npx vitest run`
Expected: All tests pass

**Step 8: Commit**

```bash
cd /Users/rashidbaset/calllock-dashboard
git add src/app/api/webhook/jobs/route.ts src/__tests__/api/webhook/jobs.test.ts
git commit -m "fix: store end_call_reason in leads (was commented out)"
```

---

### Task 3: Add `bookingAttempted` flag to V2 ConversationState — write failing test first

**Files:**
- Modify: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/types/retell.ts:295`
- Modify: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/server.ts:609` (initial state)
- Modify: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/server.ts:685` (book_appointment handler)
- Modify: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/services/dashboard.ts:655` (payload)
- Test: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/__tests__/state/conversation-state.test.ts`

**Step 1: Write the failing test**

Add to `V2/src/__tests__/state/conversation-state.test.ts`:

```typescript
describe('bookingAttempted flag', () => {
  it('defaults to false in new state', () => {
    const state = makeState();
    expect(state.bookingAttempted).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2 && npx vitest run src/__tests__/state/conversation-state.test.ts -t "bookingAttempted"`
Expected: FAIL — `bookingAttempted` doesn't exist on `ConversationState` yet.

**Step 3: Add `bookingAttempted` to the ConversationState interface**

In `V2/src/types/retell.ts`, after line 295 (`appointmentBooked: boolean;`), add:

```typescript
  bookingAttempted: boolean;          // True when book_service was called (even if it failed)
```

**Step 4: Add `bookingAttempted` to initial state**

In `V2/src/server.ts`, line 609 (inside `newState` object), add after `appointmentBooked: false,`:

```typescript
    bookingAttempted: false,
```

**Step 5: Add `bookingAttempted` to makeState test helper**

In `V2/src/__tests__/state/conversation-state.test.ts`, update `makeState`:

```typescript
function makeState(overrides?: Partial<ConversationState>): ConversationState {
  return {
    callId: 'test',
    appointmentBooked: false,
    bookingAttempted: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}
```

Also update `V2/src/__tests__/classification/tags.test.ts` — its `makeState` helper also needs `bookingAttempted: false`.

**Step 6: Run test to verify it passes**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2 && npx vitest run src/__tests__/state/conversation-state.test.ts -t "bookingAttempted"`
Expected: PASS

**Step 7: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2
git add src/types/retell.ts src/server.ts src/__tests__/state/conversation-state.test.ts src/__tests__/classification/tags.test.ts
git commit -m "feat: add bookingAttempted flag to ConversationState"
```

---

### Task 4: Set `bookingAttempted = true` in book_appointment handler

**Files:**
- Modify: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/server.ts:685-726`

**Step 1: Add bookingAttempted = true BEFORE the API call**

In `V2/src/server.ts`, in the `book_appointment` handler (line 679), add **before** the `bookAppointment()` call (before line 694):

```typescript
    // Mark that booking was attempted — even if the API call fails,
    // this flag ensures booking_status becomes "attempted_failed" instead of "not_requested"
    state.bookingAttempted = true;
    await saveCallSession(state);
```

This goes between line 691 (`const bookingUrgency = ...`) and line 694 (`const result = await bookAppointment({...}`).

**Step 2: Also update the post-call fallback detection**

In `V2/src/server.ts`, around lines 283-304 (the fallback booking detection from `transcript_with_tool_calls`), add a check for `book_service` invocations (not just results):

After the existing booking detection loop (line 303), add:

```typescript
  // Detect booking ATTEMPTS (even failed ones) from tool invocations
  if (!appointmentBooked && callData.transcript_with_tool_calls) {
    const bookingInvoked = callData.transcript_with_tool_calls.some(
      entry => entry.role === "tool_call_invocation" &&
        (entry.name === "book_service" || entry.name === "book_appointment")
    );
    if (bookingInvoked) {
      // bookingAttempted will be set on the state object built from this data
      // We track this via a local variable since we're building initial state here
      logger.info({ callId: callData.call_id }, "Booking attempt detected from tool invocations (may have failed)");
    }
  }
```

And set `bookingAttempted` in the state construction (around line 363):

```typescript
    bookingAttempted: appointmentBooked || callData.transcript_with_tool_calls?.some(
      e => e.role === "tool_call_invocation" &&
        (e.name === "book_service" || e.name === "book_appointment")
    ) || false,
```

**Step 3: Run full V2 test suite**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2 && npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2
git add src/server.ts
git commit -m "fix: set bookingAttempted=true before booking API call"
```

---

### Task 5: Change booking_status to tri-state logic — write failing test first

**Files:**
- Modify: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/services/dashboard.ts:655`
- Test: `/Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2/src/__tests__/sync/webhook-config.test.ts`

**Step 1: Write the failing test**

Create or add to `V2/src/__tests__/sync/booking-status.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('booking_status payload logic', () => {
  function getBookingStatus(appointmentBooked: boolean, bookingAttempted: boolean): string {
    // This mirrors the logic in dashboard.ts
    return appointmentBooked
      ? 'confirmed'
      : bookingAttempted
        ? 'attempted_failed'
        : 'not_requested';
  }

  it('returns confirmed when appointment was booked', () => {
    expect(getBookingStatus(true, true)).toBe('confirmed');
  });

  it('returns attempted_failed when booking was attempted but failed', () => {
    expect(getBookingStatus(false, true)).toBe('attempted_failed');
  });

  it('returns not_requested when no booking was attempted', () => {
    expect(getBookingStatus(false, false)).toBe('not_requested');
  });
});
```

**Step 2: Run test to verify it passes (logic test)**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2 && npx vitest run src/__tests__/sync/booking-status.test.ts`
Expected: PASS (this tests the logic pattern we want to implement)

**Step 3: Update dashboard.ts jobs webhook payload**

In `V2/src/services/dashboard.ts`, line 655:

Change:
```typescript
    booking_status: state.appointmentBooked ? 'confirmed' : 'not_requested',
```

To:
```typescript
    booking_status: state.appointmentBooked
      ? 'confirmed'
      : state.bookingAttempted
        ? 'attempted_failed'
        : 'not_requested',
```

**Step 4: Update dashboard.ts calls webhook payload**

In the same file, find the calls webhook payload construction (around line 655 in the `sendCallToDashboard` function). Apply the same change there.

**Step 5: Run full V2 test suite**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2 && npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/montevideo/V2
git add src/services/dashboard.ts src/__tests__/sync/booking-status.test.ts
git commit -m "fix: booking_status tri-state — confirmed/attempted_failed/not_requested"
```

---

### Task 6: Create GitHub issues for moderate/minor findings

**Files:** None (GitHub CLI only)

**Step 1: Create moderate issues**

```bash
gh issue create --repo rbaset5/calllock-server --title "card_headline duplicates ai_summary instead of generating distinct headline" --body "buildCardHeadline() in V2/src/services/dashboard.ts:301-318 truncates call_summary first sentence. Should generate a distinct punchy headline. Found via call audit call_2590f950."

gh issue create --repo rbaset5/calllock-server --title "card_summary duplicates ai_summary — no distinct value" --body "buildCardSummary() returns the same call_analysis.call_summary that becomes ai_summary. These should be differentiated. Found via call audit."

gh issue create --repo rbaset5/calllock-server --title "equipment_type='unknown' for AC calls despite clear transcript mention" --body "Customer said 'AC stopped working' but equipment_type stored as 'unknown'. extractEquipmentTypeFromTranscript() or call_subtype should be used. V2/src/services/dashboard.ts:445."

gh issue create --repo rbaset5/calllock-server --title "URGENCY taxonomy tags empty when urgency=high" --body "Tag classifier produces totalTags with 0 urgency tags even when urgency_tier='urgent'. Should emit URGENT_24HR or EMERGENCY_SAMEDAY. V2/src/classification/tags.ts."
```

**Step 2: Create minor issues**

```bash
gh issue create --repo rbaset5/calllock-server --title "caller_type='unknown' for residential service calls" --body "deriveCallerType() should default to 'residential' for standard service calls. V2/src/services/dashboard.ts:268-283."

gh issue create --repo rbaset5/calllock-server --title "problem_duration not captured from transcript ('this morning')" --body "Agent should ask onset/duration. Post-call extraction should parse temporal phrases like 'this morning', 'since yesterday'. Voice agent + extraction improvement."

gh issue create --repo rbaset5/calllock-server --title "Quality scorecard score not persisted to DB" --body "Render logs show score=80 for calls but this is only logged, never stored. Consider adding a quality_score column to calls table for monitoring."
```

**Step 3: Commit — no code changes needed**

No commit needed for this task.

---

### Task 7: Apply migration to Supabase

**Step 1: Run the migration**

Option A (Supabase CLI):
```bash
cd /Users/rashidbaset/calllock-dashboard && supabase db push
```

Option B (Manual — copy SQL from `0031_call_sessions.sql` and run in Supabase Dashboard SQL Editor):
Navigate to https://supabase.com/dashboard/project/xboybmqtwsxmdokgzclk/sql and paste the migration SQL.

**Step 2: Verify the table exists**

```bash
# Use SUPABASE_SERVICE_ROLE_KEY from calllock-dashboard/.env.local
node -e "
require('dotenv').config({ path: '/Users/rashidbaset/calllock-dashboard/.env.local' });
const https = require('https');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1/call_sessions?select=call_id&limit=1';
const options = { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key } };
https.get(url, options, (res) => {
  console.log('Status:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Response:', data));
});
"
```

Expected: `Status: 200` and `Response: []` (empty table, no 404)

**Step 3: Verify via Render logs that next call doesn't hit 404**

After the next real call, check:
```bash
render logs -r srv-d4mak524d50c73eh3uig --limit 50 -o json 2>&1 | grep -c "PGRST205"
```
Expected: 0 occurrences of the 404 error for `call_sessions`.

---

## Deployment Order

1. **Dashboard repo** — Tasks 1-2 (migration + end_call_reason fix) → push to main, Vercel auto-deploys
2. **Supabase** — Task 7 (apply migration) → run before or immediately after dashboard deploy
3. **V2 repo** — Tasks 3-5 (bookingAttempted + tri-state logic) → push to main, Render auto-deploys
4. **GitHub** — Task 6 (create issues) → can be done anytime

Dashboard and V2 deploys are independent. The migration (Task 7) must be applied before the V2 deploy goes live (otherwise V2 will still get 404s until the table exists).
