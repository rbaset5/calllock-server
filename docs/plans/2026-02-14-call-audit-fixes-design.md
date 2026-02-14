# Call Audit Fixes — Design Document

**Date:** 2026-02-14
**Audit Call:** call_2590f950022ab09881fee0d0abb (Jonas, 02/13 20:00 EST)
**Verdict:** 3 CRITICAL + 4 MODERATE + 3 MINOR regressions

## Problem

An end-to-end call audit revealed systemic issues affecting all calls:

1. The `call_sessions` table (used by V2 backend for mid-call state persistence) does not exist in Supabase. Every save/load attempt returns 404, but errors are silently masked. Post-call processing falls back to degraded webhook-only extraction.

2. `booking_status` uses binary logic (`confirmed` / `not_requested`) with no `attempted_failed` state. When `book_service` is called but returns a 500 error, the status shows `not_requested` — making it appear the agent never tried to book.

3. `end_call_reason` is sent by V2 backend but never stored in leads. The dashboard webhook handler has the field commented out (line 523 of `jobs/route.ts`).

## Approach: Fix All 3 Critical Issues

### Fix 1: Create `call_sessions` table

**Where:** `calllock-dashboard/supabase/migrations/0031_call_sessions.sql`

```sql
CREATE TABLE IF NOT EXISTS public.call_sessions (
  call_id TEXT PRIMARY KEY,
  conversation_state JSONB NOT NULL,
  retell_data JSONB,
  synced_to_dashboard BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON public.call_sessions
  FOR ALL USING (true);
```

V2 backend already has full upsert logic for this table (`supabase.ts`). Creating the table unblocks state persistence for all calls.

### Fix 2: Uncomment `end_call_reason` in dashboard webhook

**Where:** `calllock-dashboard/src/app/api/webhook/jobs/route.ts`

- Line 523: Uncomment `end_call_reason: body.end_call_reason || null,` in lead INSERT
- Lead UPDATE path (~line 420-465): Add `end_call_reason: body.end_call_reason ?? undefined,`

### Fix 3: Add `attempted_failed` booking status

**Where:** `V2/src/services/dashboard.ts`

1. Add `bookingAttempted: boolean` to ConversationState
2. Set `bookingAttempted = true` in book-service webhook handler (before the API call)
3. Change dashboard payload (line 655 and calls payload):
   ```typescript
   booking_status: state.appointmentBooked
     ? 'confirmed'
     : state.bookingAttempted
       ? 'attempted_failed'
       : 'not_requested',
   ```

## GitHub Issues for Moderate/Minor

Filed separately:

1. **MODERATE:** card_headline duplicates ai_summary — buildCardHeadline() should generate distinct headline
2. **MODERATE:** card_summary duplicates ai_summary — buildCardSummary() needs differentiation
3. **MODERATE:** equipment_type="unknown" for AC calls — extraction should use call_subtype
4. **MODERATE:** URGENCY taxonomy tags empty when urgency=high — tag classifier gap
5. **MINOR:** caller_type="unknown" for residential — deriveCallerType() default
6. **MINOR:** problem_duration not captured — agent/extraction gap
7. **MINOR:** Quality scorecard score not persisted to DB

## Deployment Order

1. Deploy dashboard migration (creates table)
2. Run `supabase db push` or execute SQL in Supabase Dashboard
3. Deploy dashboard webhook fix (end_call_reason)
4. Deploy V2 backend fix (booking_status tri-state)

Steps 1-3 can deploy together (dashboard). Step 4 deploys independently (V2/Render).

## Verification

After deployment, make a test call and verify:
- `call_sessions` table has a row with conversation_state JSONB
- Lead record has `end_call_reason` populated
- If booking fails, lead shows `booking_status: "attempted_failed"`
- Render logs show no more `PGRST205` errors for `call_sessions`
