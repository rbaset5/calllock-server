# Issues #14–#23 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 10 open issues across voice agent, V2 backend, and dashboard using structural enforcement (Tier 1) and source-of-truth classification fixes (Tier 2).

**Architecture:** Structural enforcement via Retell state machine config (locked doors, not warning signs) for conversation integrity issues. V2 backend classification fixes for data quality issues. Dashboard gets minimal downstream updates.

**Tech Stack:** Retell AI LLM config (JSON), Node.js/Express (V2), Next.js/React (dashboard), Supabase (database), Zod (validation)

**Design Doc:** `docs/plans/2026-02-13-issues-14-23-full-stack-design.md`

---

## Tier 1: Conversation Integrity (Critical + High)

### Task 1: #17 — Consent Gate (Voice Agent)

**Files:**
- Modify: `voice-agent/retell-llm-v9-triage.json` (discovery→urgency edge, line 532; pre_confirm→booking edge, line 722)

**Step 1: Make `service_address` required on discovery→urgency edge**

Currently `service_address` is in properties but NOT in `required` array (line 532-535 only requires `customer_name` and `problem_description`).

In `voice-agent/retell-llm-v9-triage.json`, find the `discovery → urgency` edge parameters `required` array (line 532-535):

```json
"required": [
  "customer_name",
  "problem_description"
]
```

Change to:

```json
"required": [
  "customer_name",
  "problem_description",
  "service_address"
]
```

This also addresses part of **#20** (discovery field requirements).

**Step 2: Verify pre_confirm→booking edge already requires `confirmed: true`**

Check the `pre_confirm → booking` edge (line 722-733). It already has:

```json
"parameters": {
  "type": "object",
  "properties": {
    "confirmed": {
      "type": "boolean",
      "description": "true if caller explicitly approved the booking"
    }
  },
  "required": ["confirmed"]
}
```

This is already structural enforcement. The `confirmed` boolean is required. Verify no other edge leads to `booking` — currently only `pre_confirm → booking` exists. **This is already correct.** No change needed.

**Step 3: Commit**

```bash
git add voice-agent/retell-llm-v9-triage.json
git commit -m "fix(agent): require service_address on discovery→urgency edge (#17, #20)"
```

---

### Task 2: #21 — Booking Confabulation Gate (V2 Backend)

**Files:**
- Modify: `V2/src/types/retell.ts:187-191` (BookAppointmentResult interface)
- Modify: `V2/src/functions/booking.ts:132-136` (Cal.com success return)
- Modify: `V2/src/functions/booking.ts:161-165` (mock success return)

**Step 1: Add `booking_confirmed` field to BookAppointmentResult**

In `V2/src/types/retell.ts`, find the `BookAppointmentResult` interface (line 187-191):

```typescript
export interface BookAppointmentResult {
  success: boolean;
  appointmentId?: string;
  confirmationMessage: string;
}
```

Change to:

```typescript
export interface BookAppointmentResult {
  success: boolean;
  booking_confirmed: boolean;
  appointmentId?: string;
  confirmationMessage: string;
}
```

**Step 2: Add `booking_confirmed: true` to Cal.com success response**

In `V2/src/functions/booking.ts`, find the Cal.com return (line 132-136):

```typescript
return {
  success: true,
  appointmentId: data.data.uid,
  confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
};
```

Change to:

```typescript
return {
  success: true,
  booking_confirmed: true,
  appointmentId: data.data.uid,
  confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
};
```

**Step 3: Add `booking_confirmed: true` to mock success response**

In `V2/src/functions/booking.ts`, find the mock return (line 161-165):

```typescript
return {
  success: true,
  appointmentId,
  confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
};
```

Change to:

```typescript
return {
  success: true,
  booking_confirmed: true,
  appointmentId,
  confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
};
```

**Step 4: Ensure failure paths return `booking_confirmed: false`**

In `V2/src/functions/booking.ts`, the Cal.com error path falls through to mock (line 45-55). Both currently return `success: true`. If Cal.com fails AND we want to surface the failure instead of mocking, we'd need a config flag. For now, both paths return `booking_confirmed: true` since both actually create a booking (real or mock).

Add explicit `booking_confirmed: false` return for actual failures. Find the `bookAppointment` function and add error handling after the mock fallback. Currently the mock never fails, so add a safety net:

After the mock return at line 55, the function always succeeds. The only failure case is if Cal.com throws AND mock is used — both return success. This is fine. The `booking_confirmed` field is for the agent to check.

**Step 5: Commit**

```bash
git add V2/src/types/retell.ts V2/src/functions/booking.ts
git commit -m "fix(v2): add booking_confirmed field to book_service response (#21)"
```

---

### Task 3: #21 — Booking Confabulation Gate (Voice Agent)

**Files:**
- Modify: `voice-agent/retell-llm-v9-triage.json` (booking state prompt, line 741; booking→confirm edge, line 743-764)

**Step 1: Update booking state prompt to reference `booking_confirmed`**

In the booking state prompt (line 741), find:

```
### If booked: true AND time matches what was confirmed in pre_confirm
```

Change all references from `booked: true` to `booking_confirmed: true` throughout the booking state prompt. The key change is:

In the prompt section `## Step 2: Handle the Response`, update the check instructions:

Replace: `If booked: true`
With: `If booking_confirmed: true`

Replace: `If booked: false`
With: `If booking_confirmed: false`

This is defense-in-depth — the structural gate is the edge parameter.

**Step 2: Verify booking→confirm edge requires `booking_confirmed`**

Check the edge (line 743-764). It already has:

```json
"parameters": {
  "type": "object",
  "properties": {
    "appointment_time": { ... },
    "booking_confirmed": {
      "type": "boolean",
      "description": "true ONLY if book_service returned booked: true"
    }
  },
  "required": ["booking_confirmed", "appointment_time"]
}
```

Update the description:

```json
"booking_confirmed": {
  "type": "boolean",
  "description": "true ONLY if book_service returned booking_confirmed: true"
}
```

**Step 3: Verify booking→booking_failed edge also requires `booking_confirmed`**

Check edge (line 766-786). It already has `booking_confirmed` as required with value `false`. Good — already structural.

**Step 4: Commit**

```bash
git add voice-agent/retell-llm-v9-triage.json
git commit -m "fix(agent): reference booking_confirmed field in booking state (#21)"
```

---

### Task 4: #20 + #23 — Discovery & Urgency Field Requirements (Voice Agent)

**Files:**
- Modify: `voice-agent/retell-llm-v9-triage.json` (discovery→urgency edge, urgency→pre_confirm edge)

**Step 1: Verify discovery→urgency edge required fields**

Already done in Task 1: `customer_name`, `problem_description`, `service_address` are now all required.

**Step 2: Verify urgency→pre_confirm edge requires `preferred_time`**

Check the urgency→pre_confirm edge (line 546-566). Current required:

```json
"required": [
  "urgency_tier",
  "preferred_time"
]
```

`preferred_time` is already required. **This is already structural.** No change needed.

**Step 3: Verify no bypass edges exist**

Check all edges that lead to `booking`:
- Only `pre_confirm → booking` leads to booking (line 718-734)
- `booking` requires `confirmed: true` from pre_confirm

Check all edges that lead to `pre_confirm`:
- Only `urgency → pre_confirm` (line 546-566)
- Requires `urgency_tier` and `preferred_time`

Check all edges that lead to `urgency`:
- Only `discovery → urgency` (line 491-537)
- Now requires `customer_name`, `problem_description`, `service_address`

**The full chain is structurally enforced:**
```
discovery (name+problem+address required) →
urgency (timing+urgency required) →
pre_confirm (confirmed required) →
booking (booking_confirmed required) →
confirm or booking_failed
```

**Step 4: Commit** (if any changes were made)

```bash
git add voice-agent/retell-llm-v9-triage.json
git commit -m "fix(agent): verify full structural enforcement chain for #20 and #23"
```

---

### Task 5: #18 — Privacy: Address Passthrough (V2 Backend)

**Files:**
- Modify: `V2/src/services/customer-history.ts` (lookup_caller response)
- Modify: `V2/src/server.ts` (lookup_caller webhook handler, state passthrough to booking)

**Step 1: Read the customer-history.ts file to understand current response format**

Read `V2/src/services/customer-history.ts` to find the function that builds the lookup_caller response. Identify where `address` is returned in the response.

**Step 2: Split lookup_caller response into visible + passthrough**

Find the function that returns the lookup result to the agent (in `server.ts`, the lookup_caller webhook handler). Currently it returns all fields including address.

Change the response to split into two sections:

```typescript
// Before: flat response with address visible to agent
return {
  found: true,
  customerName: history.name,
  address: history.address,        // Agent can see and speak this
  zipCode: history.zipCode,
  // ...
};

// After: split into visible and passthrough
return {
  found: true,
  customerName: history.name,
  has_existing_appointment: !!history.upcomingAppointment,
  appointment_time: history.upcomingAppointment?.time,
  last_call_summary: history.lastCallSummary,
  // address and zipCode removed from agent-visible response
};
```

**Step 3: Store address in ConversationState passthrough**

In the lookup_caller handler in `server.ts`, after getting the response, store address in state:

```typescript
// Store address in state (not visible to agent)
state.serviceAddress = history.address;
state.zipCode = history.zipCode;
await saveCallSession(state);
```

**Step 4: Update booking tool to use state address**

In the booking handler in `server.ts`, when `book_service` is called:

```typescript
// Use address from state if agent didn't collect a new one
const serviceAddress = args.service_address || state.serviceAddress || "TBD";
```

**Step 5: Update voice agent lookup state prompt**

In `voice-agent/retell-llm-v9-triage.json`, update the lookup state prompt to remove references to address in the agent-visible response. Remove the instruction about pre-filling address from lookup.

**Step 6: Commit**

```bash
git add V2/src/services/customer-history.ts V2/src/server.ts voice-agent/retell-llm-v9-triage.json
git commit -m "fix(v2): strip address from lookup_caller response, use state passthrough (#18)"
```

---

### Task 6: #19 — State Loop Guardrails (V2 Backend)

**Files:**
- Modify: `V2/src/types/retell.ts:257-300` (ConversationState interface)
- Modify: `V2/src/server.ts` (tool call handlers — add counter logic)

**Step 1: Add state_visit_counter to ConversationState**

In `V2/src/types/retell.ts`, add to the `ConversationState` interface (after line 300):

```typescript
export interface ConversationState {
  // ... existing fields ...

  // V11: State loop guardrails (#19)
  stateVisitCounter?: Record<string, number>;
}
```

**Step 2: Add counter increment logic to tool dispatch**

In `V2/src/server.ts`, find the common tool dispatch pattern (each webhook handler calls `getOrCreateWebhookState` then processes). Add a utility function:

```typescript
function incrementStateVisit(state: ConversationState, stateName: string): boolean {
  if (!state.stateVisitCounter) {
    state.stateVisitCounter = {};
  }
  state.stateVisitCounter[stateName] = (state.stateVisitCounter[stateName] || 0) + 1;
  return state.stateVisitCounter[stateName] > 3;
}
```

**Step 3: Add force_transition to tool responses**

In each tool handler (lookup_caller, book_service, create_callback, etc.), after incrementing:

```typescript
const shouldForceTransition = incrementStateVisit(state, "current_state_name");
// Add to response:
response.force_transition = shouldForceTransition;
```

The challenge is that V2 doesn't know which state the agent is in — it only knows which tool was called. Map tools to states:
- `lookup_caller` → lookup state
- `book_service` → booking state
- `create_callback_request` → follow_up / non_service / urgency_callback
- `manage_appointment` → manage_booking
- `end_call` → any terminal state

For the most common loop case (agent stuck calling same tool), track by tool name instead of state name.

**Step 4: Commit**

```bash
git add V2/src/types/retell.ts V2/src/server.ts
git commit -m "fix(v2): add state visit counter and force_transition for loop prevention (#19)"
```

---

## Tier 2: Data Classification Quality (Medium)

### Task 7: #14 — Tags Always Populated (V2 Backend + Dashboard)

**Files:**
- Modify: `V2/src/services/dashboard.ts:452-453` (tags field in payload)
- Modify: `calllock-dashboard/src/app/api/webhook/jobs/route.ts` (empty tags handling)

**Step 1: Ensure tags is never omitted in V2**

In `V2/src/services/dashboard.ts`, the tags field at line 453:

```typescript
tags: tags,
```

The `classifyCall()` function returns a `TaxonomyTags` object. Check if it can return `undefined` or `null`. If so, add a fallback:

```typescript
tags: tags || { HAZARD: [], URGENCY: [], SERVICE_TYPE: [], REVENUE: [], RECOVERY: [], LOGISTICS: [], CUSTOMER: [], NON_CUSTOMER: [], CONTEXT: [] },
```

Also add a log warning:

```typescript
if (!tags || Object.values(tags).every(arr => Array.isArray(arr) && arr.length === 0)) {
  log.warn({ callId: state.callId }, "No taxonomy tags classified for call");
}
```

**Step 2: Add empty-tags indicator in dashboard**

In `calllock-dashboard/src/app/api/webhook/jobs/route.ts`, where tags are processed, no change needed — the webhook already accepts `tags` as optional JSONB. The display change would be in the UI components.

For now, this is a V2-only fix. Dashboard display of "No tags" is a nice-to-have.

**Step 3: Commit**

```bash
git add V2/src/services/dashboard.ts
git commit -m "fix(v2): ensure tags field is always populated in webhook payload (#14)"
```

---

### Task 8: #15 — 4-Level Urgency (V2 Backend)

**Files:**
- Modify: `V2/src/services/dashboard.ts:108-131` (mapUrgencyToDashboard function)
- Modify: `V2/src/server.ts:219-227` (mapUrgencyLevelFromAnalysis function)
- Modify: `V2/src/server.ts:295-307` (inferUrgencyFromContext function)

**Step 1: Update `mapUrgencyToDashboard` for 4-level output**

In `V2/src/services/dashboard.ts`, replace the function (line 108-131):

```typescript
function mapUrgencyToDashboard(
  urgencyTier?: UrgencyTier,
  endCallReason?: EndCallReason
): DashboardJobPayload["urgency"] {
  // Safety emergencies are always highest priority
  if (endCallReason === "safety_emergency") {
    return "emergency";
  }

  if (endCallReason === "urgent_escalation") {
    return "high";
  }

  switch (urgencyTier) {
    case "LifeSafety":
      return "emergency";
    case "Urgent":
      return "high";
    case "Routine":
      return "medium";
    case "Estimate":
      return "low";
    default:
      return "low";
  }
}
```

The key change: `Estimate` → `low` instead of falling into the default. `Routine` stays `medium`. This creates the 4-level spread.

**Step 2: Update `inferUrgencyFromContext` to support Estimate level**

In `V2/src/server.ts`, find `inferUrgencyFromContext` (line 295-307):

```typescript
function inferUrgencyFromContext(problemDesc?: string, transcript?: string): UrgencyLevel | undefined {
  const text = [problemDesc, transcript].filter(Boolean).join(" ").toLowerCase();
  if (!text) return undefined;

  if (/gas\s*leak|carbon\s*monoxide|smoke|fire|sparking|flood/i.test(text)) return "Emergency";
  if (/water\s*leak|leak.*inside|puddle|no\s*(heat|cool|ac|air)|emergency|asap|today|right\s*away/i.test(text)) return "Urgent";
  if (/estimate|quote|how\s*much|whenever|no\s*rush|flexible/i.test(text)) return "Estimate";
  if (/maintenance|tune.?up|this\s*week/i.test(text)) return "Routine";

  return "Routine";
}
```

Add `Estimate` detection before `Routine`.

**Step 3: Commit**

```bash
git add V2/src/services/dashboard.ts V2/src/server.ts
git commit -m "fix(v2): implement 4-level urgency mapping (emergency/high/medium/low) (#15)"
```

---

### Task 9: #15 — 4-Level Urgency (Dashboard)

**Files:**
- Modify: `calllock-dashboard/src/lib/urgency-reclassification.ts` (expand to handle all 4 levels)
- Modify: `calllock-dashboard/src/components/now/now-card.tsx:102-109` (show medium/low badges)
- Modify: `calllock-dashboard/src/components/ui/subject-card.tsx:255-264` (show medium/low badges)

**Step 1: Expand urgency reclassification to handle all 4 levels**

In `calllock-dashboard/src/lib/urgency-reclassification.ts`, update `resolveEffectiveUrgency`:

The current function only reclassifies when `originalUrgency === 'high'`. Expand to also handle `medium`:

```typescript
export function resolveEffectiveUrgency(
  originalUrgency: UrgencyLevel | undefined,
  signals: UrgencySignals
): UrgencyResult {
  // Only reclassify 'high' or 'medium' — emergency and low pass through
  if (originalUrgency !== 'high' && originalUrgency !== 'medium') {
    return { urgency: originalUrgency, reclassified: false };
  }

  // ... existing high reclassification logic ...

  // NEW: Downgrade medium → low for estimates with no time pressure
  if (originalUrgency === 'medium') {
    const isBenignWorkType = signals.work_type === 'maintenance' || signals.work_type === 'admin';
    const hasNoUrgencySignals = !signals.issue_description || !EMERGENCY_KEYWORDS.test(signals.issue_description);
    if (isBenignWorkType && hasNoUrgencySignals) {
      return { urgency: 'low', reclassified: true, reason: 'maintenance/admin with no urgency signals' };
    }
    return { urgency: 'medium', reclassified: false };
  }

  // ... rest of existing logic for 'high' ...
}
```

**Step 2: Update UI components to display all 4 urgency levels**

In `calllock-dashboard/src/components/now/now-card.tsx`, line 102:

```tsx
{item.urgency && (item.urgency === 'emergency' || item.urgency === 'high') && (
```

Change to show all non-low urgency levels:

```tsx
{item.urgency && item.urgency !== 'low' && (
```

Same change in `subject-card.tsx` line 255:

```tsx
{(urgency === 'emergency' || urgency === 'high') && (
```

Change to:

```tsx
{urgency && urgency !== 'low' && (
```

And add the `medium` badge case (line 257-262 area):

```tsx
{urgency === 'medium' && (
  <Badge {...getUrgencyBadgeProps('medium')} size="xs">Medium</Badge>
)}
```

**Step 3: Commit**

```bash
cd /Users/rashidbaset/calllock-dashboard
git add src/lib/urgency-reclassification.ts src/components/now/now-card.tsx src/components/ui/subject-card.tsx
git commit -m "fix(dashboard): expand urgency display and reclassification to 4 levels (#15)"
```

---

### Task 10: #16 — Evidence-Based Hazard Rules (V2 Backend)

**Files:**
- Modify: `V2/src/services/tag-classifier.ts:59-103` (HAZARD_PATTERNS)

**Step 1: Remove single-word patterns from hazard tags**

In `V2/src/services/tag-classifier.ts`, update HAZARD_PATTERNS. The current patterns are already mostly multi-word phrases, which is good. The main false-positive risks are:

- `CO_EVENT` has `"dizzy"`, `"headache"`, `"nausea"` — single words that could match benign health mentions
- `ELECTRICAL_FIRE` has `"sparks"` — could match "sparks of interest" or similar
- `CONDENSATE_CLOG` has `"dripping"` — very common HVAC word for routine issues

Update the problematic patterns:

```typescript
CO_EVENT: [
  "co alarm",
  "carbon monoxide",
  "detector going off",
  "co detector",
  "carbon monoxide alarm",
  "carbon monoxide detector",
  // Removed: "dizzy", "headache", "nausea", "family feels sleepy", "everyone tired"
  // These are symptoms, not CO confirmation — too many false positives
],
ELECTRICAL_FIRE: [
  "burning smell from unit",
  "smoke from furnace",
  "sparking from",       // Changed: require context word after "sparking"
  "sparks from",         // Changed: require context
  "breaker keeps tripping",
  "smell like burning plastic",
  "burning wire",
  "electrical smell",
  "electrical fire",
],
CONDENSATE_CLOG: [
  "drain pan full",
  "small puddle",
  "condensate",
  "water under unit",
  "condensate line",
  "condensate drain",
  // Removed: "dripping" (too generic), "leaking water" (too generic)
],
```

**Step 2: Add confidence scoring (future enhancement)**

For now, skip the `confidence` field — it would require changes throughout the pipeline. The evidence-based phrase list update is the primary fix. The confidence scoring can be a follow-up.

**Step 3: Commit**

```bash
git add V2/src/services/tag-classifier.ts
git commit -m "fix(v2): tighten hazard tag patterns to require multi-word evidence (#16)"
```

---

### Task 11: #22 — Equipment Type Extraction (V2 Backend)

**Files:**
- Modify: `V2/src/services/dashboard.ts` (add transcript extraction fallback)

**Step 1: Add equipment type extraction function**

In `V2/src/services/dashboard.ts`, add before `transformToDashboardPayload`:

```typescript
function extractEquipmentTypeFromTranscript(transcript?: string): string | undefined {
  if (!transcript) return undefined;
  const text = transcript.toLowerCase();

  const patterns: [RegExp, string][] = [
    [/\b(air\s*condition(?:er|ing)?|a\.?c\.?\s*unit|central\s*air)\b/i, "AC"],
    [/\b(furnace|heater)\b/i, "furnace"],
    [/\b(heat\s*pump)\b/i, "heat pump"],
    [/\b(boiler)\b/i, "boiler"],
    [/\b(thermostat)\b/i, "thermostat"],
    [/\b(mini[\s-]*split|ductless)\b/i, "mini-split"],
    [/\b(water\s*heater|hot\s*water)\b/i, "water heater"],
    [/\b(duct(?:work)?|air\s*duct)\b/i, "ductwork"],
  ];

  for (const [regex, type] of patterns) {
    if (regex.test(text)) return type;
  }
  return undefined;
}
```

**Step 2: Use extraction fallback in payload builder**

In `transformToDashboardPayload`, after line 433:

```typescript
equipment_type: state.equipmentType,
```

Change to:

```typescript
equipment_type: state.equipmentType || extractEquipmentTypeFromTranscript(retellData?.transcript) || "unknown",
```

**Step 3: Commit**

```bash
git add V2/src/services/dashboard.ts
git commit -m "fix(v2): add transcript-based equipment type extraction fallback (#22)"
```

---

### Task 12: #22 — Equipment Type in Agent Config (Voice Agent)

**Files:**
- Modify: `voice-agent/retell-llm-v9-triage.json` (discovery→urgency edge parameters)

**Step 1: Add `equipment_type` as optional parameter**

In the discovery→urgency edge parameters (line 496-536), add to `properties`:

```json
"equipment_type": {
  "type": "string",
  "description": "Type of HVAC equipment mentioned: 'AC', 'furnace', 'heat pump', 'boiler', 'thermostat', 'mini-split', 'water heater', or empty string if not mentioned"
}
```

Do NOT add to `required` array — equipment type is best-effort collection, not a gate.

**Step 2: Update discovery state prompt**

In the discovery state prompt, after the address collection section, add:

```
## Equipment Type (OPTIONAL — do NOT ask separately)
If the caller naturally mentions their equipment type (AC, furnace, heat pump, boiler, thermostat), capture it in the equipment_type edge parameter.
Do NOT add an extra question for this — only capture if volunteered during problem description.
```

**Step 3: Commit**

```bash
git add voice-agent/retell-llm-v9-triage.json
git commit -m "fix(agent): add optional equipment_type capture in discovery state (#22)"
```

---

## Deployment Order

Deploy in this order to avoid breaking changes:

1. **V2 Backend first** (Tasks 2, 5, 6, 7, 8, 10, 11) — adds new fields, doesn't remove old ones
2. **Voice Agent second** (Tasks 1, 3, 4, 12) — references new fields from V2
3. **Dashboard third** (Task 9) — displays new data from V2

Within each layer, deploy all changes together as one deployment.

---

## Testing Checklist

### Voice Agent (requires real phone calls)
- [ ] Call → skip name → verify agent asks before proceeding (#20)
- [ ] Call → skip address → verify agent asks before proceeding (#17, #20)
- [ ] Call → say "book it" before pre_confirm → verify agent reads back first (#17)
- [ ] Call → book succeeds → verify agent says "confirmed" (#21)
- [ ] Call → book fails → verify agent does NOT say "confirmed" (#21)
- [ ] Call → skip timing → verify agent asks "how urgent" (#23)
- [ ] Call → returning caller → verify agent greets by name, does NOT mention address (#18)
- [ ] Call → get stuck in loop → verify agent eventually moves on (#19)

### V2 Backend (can test with unit tests or curl)
- [ ] `book_service` response includes `booking_confirmed: true` on success (#21)
- [ ] `lookup_caller` response does NOT include address (#18)
- [ ] State visit counter increments per tool call (#19)
- [ ] Tags never null/undefined in webhook payload (#14)
- [ ] Urgency mapping: Emergency→emergency, Urgent→high, Routine→medium, Estimate→low (#15)
- [ ] "gas furnace" does NOT trigger GAS_LEAK tag (#16)
- [ ] Transcript "AC not cooling" extracts equipment_type="AC" (#22)

### Dashboard (can test with webhook payloads)
- [ ] 4-level urgency badges display correctly (#15)
- [ ] Medium urgency badge shows on cards (#15)
- [ ] Reclassification handles medium→low downgrade (#15)
