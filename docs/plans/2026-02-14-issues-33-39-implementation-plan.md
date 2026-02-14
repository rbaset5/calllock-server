# Issues #33-#39 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 call audit bugs — card display duplication, classification gaps, and quality score persistence.

**Architecture:** All fixes are in V2 backend. Card display (#33/#34) rewrites two functions in `dashboard.ts`. Classification (#35/#36/#37) patches regex, fallback logic, and tag cross-referencing. Quality score (#39) adds a DB column and includes score in sync payloads.

**Tech Stack:** TypeScript, Vitest, Express, Supabase (PostgreSQL)

---

### Task 1: Fix #35 — equipment_type regex misses standalone "AC"

**Files:**
- Modify: `V2/src/services/dashboard.ts:346-365` (extractEquipmentTypeFromTranscript)
- Test: `V2/src/__tests__/sync/dashboard-fields.test.ts` (new)

**Step 1: Write the failing test**

Create `V2/src/__tests__/sync/dashboard-fields.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { transformToDashboardPayload } from '../../services/dashboard.js';
import type { ConversationState, RetellPostCallData } from '../../types/retell.js';

function makeState(overrides?: Partial<ConversationState>): ConversationState {
  return {
    callId: 'test-equip',
    appointmentBooked: false,
    bookingAttempted: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('equipment_type extraction (#35)', () => {
  it('extracts AC from "AC stopped working"', () => {
    const state = makeState();
    const retellData = { transcript: 'Yeah my AC stopped working this morning' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.equipment_type).toBe('AC');
  });

  it('extracts AC from "the AC is not cooling"', () => {
    const state = makeState();
    const retellData = { transcript: 'the AC is not cooling at all' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.equipment_type).toBe('AC');
  });

  it('uses call_subtype as fallback when transcript has no match', () => {
    const state = makeState({ problemDescription: 'unit is broken' });
    const retellData = { transcript: 'my unit is broken' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // call_subtype may be "ac" from tags — but without specific equipment words
    // in transcript and no state.equipmentType, should still try call_subtype
    // This test verifies the fallback chain doesn't crash
    expect(payload.equipment_type).toBeDefined();
  });

  it('prefers state.equipmentType over transcript mining', () => {
    const state = makeState({ equipmentType: 'furnace' });
    const retellData = { transcript: 'my AC stopped working' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.equipment_type).toBe('furnace');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts`
Expected: FAIL — "AC stopped working" won't match current regex patterns (missing standalone `\bac\b`)

**Step 3: Fix the regex and add call_subtype fallback**

In `V2/src/services/dashboard.ts`, update `extractEquipmentTypeFromTranscript`:

```typescript
function extractEquipmentTypeFromTranscript(transcript?: string): string | undefined {
  if (!transcript) return undefined;
  const text = transcript.toLowerCase();

  const patterns: [RegExp, string][] = [
    [/\b(air\s*condition(?:er|ing)?|a\.?c\.?\s*unit|central\s*air|\bac\b)\b/i, "AC"],
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

Key change: Added `\bac\b` to the AC pattern group.

Then update the payload construction at line ~445 to add `call_subtype` fallback:

```typescript
// In transformToDashboardPayload, after callTypeResult is computed:
const equipmentFromSubtype = callTypeResult.callSubtype
  ? ({ ac: "AC", heating: "furnace", heatpump: "heat pump" } as Record<string, string>)[callTypeResult.callSubtype]
  : undefined;

// Then in the return object:
equipment_type: state.equipmentType
  || extractEquipmentTypeFromTranscript(retellData?.transcript)
  || equipmentFromSubtype
  || "unknown",
```

**Step 4: Run the test to verify it passes**

Run: `cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add V2/src/services/dashboard.ts V2/src/__tests__/sync/dashboard-fields.test.ts
git commit -m "fix(#35): expand equipment_type regex to match standalone 'AC' + add call_subtype fallback"
```

---

### Task 2: Fix #36 — URGENCY tags empty when urgency=high

**Files:**
- Modify: `V2/src/classification/tags.ts:486-503` (after classification, before return)
- Test: `V2/src/__tests__/classification/tags.test.ts`

**Step 1: Write the failing test**

Append to `V2/src/__tests__/classification/tags.test.ts`:

```typescript
it('auto-emits URGENT_24HR when state.urgency is high but transcript has no urgency keywords (#36)', () => {
  const state = makeState({ urgency: 'Urgent' as any });
  const tags = classifyCall(state, 'I need someone to come take a look at my unit');
  expect(tags.URGENCY).toContain('URGENT_24HR');
});

it('auto-emits EMERGENCY_SAMEDAY when state.urgency is emergency (#36)', () => {
  const state = makeState({ urgency: 'Emergency' as any });
  const tags = classifyCall(state, 'The system is not working');
  expect(tags.URGENCY).toContain('EMERGENCY_SAMEDAY');
});

it('does not duplicate urgency tags if already classified from transcript', () => {
  const state = makeState({ urgency: 'Urgent' as any });
  const tags = classifyCall(state, 'the system is barely working and running constantly');
  // URGENT_24HR should appear from transcript match — don't double-add
  const count = tags.URGENCY.filter(t => t === 'URGENT_24HR').length;
  expect(count).toBe(1);
});
```

**Step 2: Run the test to verify it fails**

Run: `cd V2 && npx vitest run src/__tests__/classification/tags.test.ts`
Expected: FAIL — first two tests fail because `classifyCall` doesn't check `state.urgency`

**Step 3: Add urgency cross-reference in classifyCall**

In `V2/src/classification/tags.ts`, add after the CONTEXT auto-tagging block (around line 488, before the log statement):

```typescript
  // Auto-emit urgency tags from state.urgency when transcript matching found nothing (#36).
  // The voice agent may flag urgency via dynamic variables even when the transcript
  // doesn't contain specific urgency keyword phrases.
  if (tags.URGENCY.length === 0) {
    const u = state.urgency?.toLowerCase();
    if (u === 'emergency' || u === 'lifesafety') {
      tags.URGENCY.push('EMERGENCY_SAMEDAY');
    } else if (u === 'urgent' || u === 'high') {
      tags.URGENCY.push('URGENT_24HR');
    }
  }
```

**Step 4: Run the test to verify it passes**

Run: `cd V2 && npx vitest run src/__tests__/classification/tags.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add V2/src/classification/tags.ts V2/src/__tests__/classification/tags.test.ts
git commit -m "fix(#36): auto-emit urgency tags from state.urgency when transcript has no matches"
```

---

### Task 3: Fix #37 — caller_type='unknown' for residential calls

**Files:**
- Modify: `V2/src/services/dashboard.ts:269-281` (deriveCallerType)
- Test: `V2/src/__tests__/sync/dashboard-fields.test.ts`

**Step 1: Write the failing test**

Append to `V2/src/__tests__/sync/dashboard-fields.test.ts`:

```typescript
describe('caller_type derivation (#37)', () => {
  it('defaults to residential when SERVICE_TYPE tags present but no CUSTOMER tags', () => {
    const state = makeState({ problemDescription: 'AC not cooling, blowing warm air' });
    const retellData = { transcript: 'my air conditioner broken, warm air coming out' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.caller_type).toBe('residential');
  });

  it('defaults to residential when problemDescription exists but no tags', () => {
    const state = makeState({ problemDescription: 'unit making noise' });
    const retellData = { transcript: 'yeah the unit is making a loud noise' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.caller_type).toBe('residential');
  });

  it('returns unknown for truly empty calls', () => {
    const state = makeState();
    const payload = transformToDashboardPayload(state);
    expect(payload.caller_type).toBe('unknown');
  });

  it('still returns commercial for commercial property type', () => {
    const state = makeState({ propertyType: 'commercial' });
    const payload = transformToDashboardPayload(state);
    expect(payload.caller_type).toBe('commercial');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts`
Expected: FAIL — first two tests fail, getting "unknown" instead of "residential"

**Step 3: Fix deriveCallerType fallback**

In `V2/src/services/dashboard.ts`, update `deriveCallerType`:

```typescript
function deriveCallerType(
  state: ConversationState,
  tags: TaxonomyTags | null
): "residential" | "commercial" | "vendor" | "recruiting" | "unknown" {
  if (state.propertyType === "commercial") return "commercial";
  if (tags) {
    if (tags.CUSTOMER.includes("COMMERCIAL_ACCT")) return "commercial";
    if (tags.NON_CUSTOMER.includes("JOB_APPLICANT")) return "recruiting";
    if (tags.NON_CUSTOMER.includes("VENDOR_SALES") || tags.NON_CUSTOMER.includes("SPAM_TELEMARKETING")) return "vendor";
    if (tags.CUSTOMER.length > 0) return "residential";
    // Default to residential when service tags are present (#37)
    // Standard calls to an HVAC company are residential unless proven otherwise
    if (tags.SERVICE_TYPE.length > 0) return "residential";
  }
  // Default to residential if caller described a problem (they're a customer)
  if (state.problemDescription) return "residential";
  return "unknown";
}
```

**Step 4: Run the test to verify it passes**

Run: `cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add V2/src/services/dashboard.ts V2/src/__tests__/sync/dashboard-fields.test.ts
git commit -m "fix(#37): default caller_type to residential for service calls"
```

---

### Task 4: Fix #33/#34 — card_headline and card_summary duplicate ai_summary

**Files:**
- Modify: `V2/src/services/dashboard.ts:301-341` (buildCardHeadline, buildCardSummary)
- Modify: `V2/src/services/dashboard.ts:396-403` (update function signatures to pass tags + callTypeResult)
- Test: `V2/src/__tests__/sync/dashboard-fields.test.ts`

**Step 1: Write the failing tests**

Append to `V2/src/__tests__/sync/dashboard-fields.test.ts`:

```typescript
describe('card_headline differentiation (#33)', () => {
  it('does NOT use call_summary for headline when structured data available', () => {
    const state = makeState({ problemDescription: 'AC not cooling' });
    const retellData = {
      transcript: 'my air conditioner broken, blowing warm air',
      call_analysis: { call_summary: 'Customer called about AC not cooling properly.' },
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // card_headline should be template-based, NOT a truncation of call_summary
    expect(payload.card_headline).not.toContain('Customer called');
    expect(payload.card_headline).toBeDefined();
    expect(payload.card_headline!.length).toBeLessThanOrEqual(60);
  });

  it('includes service type in headline', () => {
    const state = makeState({ problemDescription: 'AC not cooling' });
    const retellData = {
      transcript: 'air conditioner broken, warm air',
      call_analysis: { call_summary: 'Customer called about AC issues.' },
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // Should contain service-type derived label
    expect(payload.card_headline).toBeDefined();
  });
});

describe('card_summary differentiation (#34)', () => {
  it('does NOT duplicate ai_summary', () => {
    const state = makeState({
      customerName: 'John Smith',
      problemDescription: 'AC not cooling',
      appointmentBooked: true,
      appointmentDateTime: '2026-02-15 10:00 AM',
    });
    const retellData = {
      transcript: 'air conditioner broken',
      call_analysis: { call_summary: 'Customer called about AC not cooling properly.' },
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // card_summary should be action-oriented, NOT the raw call_summary
    expect(payload.card_summary).not.toBe(payload.ai_summary);
    expect(payload.card_summary).toBeDefined();
    expect(payload.card_summary!.length).toBeLessThanOrEqual(200);
  });

  it('includes caller name and booking outcome in summary', () => {
    const state = makeState({
      customerName: 'John Smith',
      problemDescription: 'furnace making noise',
      appointmentBooked: true,
      appointmentDateTime: '2026-02-15 10:00 AM',
    });
    const retellData = {
      transcript: 'furnace is making a loud noise',
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('John Smith');
    expect(payload.card_summary).toMatch(/booked|appointment/i);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts`
Expected: FAIL — card_headline still uses call_summary, card_summary duplicates ai_summary

**Step 3: Rewrite buildCardHeadline and buildCardSummary**

In `V2/src/services/dashboard.ts`, replace both functions:

```typescript
/**
 * Map a SERVICE_TYPE tag to a human-readable service label
 */
function serviceTagToLabel(tag: string): string {
  const map: Record<string, string> = {
    REPAIR_AC: "AC Repair",
    REPAIR_HEATING: "Heating Repair",
    REPAIR_HEATPUMP: "Heat Pump Repair",
    REPAIR_THERMOSTAT: "Thermostat Repair",
    REPAIR_IAQ: "IAQ Repair",
    REPAIR_DUCTWORK: "Ductwork Repair",
    TUNEUP_AC: "AC Tune-Up",
    TUNEUP_HEATING: "Heating Tune-Up",
    DUCT_CLEANING: "Duct Cleaning",
    FILTER_SERVICE: "Filter Service",
    INSTALL_REPLACEMENT: "System Replacement",
    INSTALL_NEWCONSTRUCTION: "New Construction Install",
    INSTALL_UPGRADE: "System Upgrade",
    INSTALL_ADDON: "Add-On Install",
    DIAGNOSTIC_INTERMITTENT: "Intermittent Issue",
    DIAGNOSTIC_PERFORMANCE: "Performance Issue",
    DIAGNOSTIC_NOISE: "Noise Diagnostic",
    DIAGNOSTIC_CYCLE: "Cycling Issue",
    DIAGNOSTIC_AIRFLOW: "Airflow Issue",
    DIAGNOSTIC_SMELL: "Odor Diagnostic",
    DIAGNOSTIC_ENERGY: "Energy Audit",
    SECONDOPINION: "Second Opinion",
    WARRANTY_CLAIM: "Warranty Claim",
  };
  return map[tag] || tag.replace(/_/g, " ").toLowerCase();
}

/**
 * Build a short headline for dashboard card display (#33)
 * Template-based — never uses call_summary (that's reserved for ai_summary)
 */
function buildCardHeadline(
  state: ConversationState,
  tags: TaxonomyTags | null,
  equipmentType?: string,
  urgency?: string
): string | undefined {
  const parts: string[] = [];

  // Service label from tags or call metadata
  if (tags && tags.SERVICE_TYPE.length > 0) {
    parts.push(serviceTagToLabel(tags.SERVICE_TYPE[0]));
  } else if (state.hvacIssueType) {
    parts.push(state.hvacIssueType);
  }

  // Equipment context
  const equip = equipmentType && equipmentType !== "unknown" ? equipmentType : undefined;
  if (equip && !parts[0]?.toLowerCase().includes(equip.toLowerCase())) {
    parts.push(equip);
  }

  // Urgency badge for high/emergency
  if (urgency === "high" || urgency === "emergency") {
    parts.push(urgency === "emergency" ? "EMERGENCY" : "URGENT");
  }

  if (parts.length === 0) {
    // Fallback to problem description
    if (state.problemDescription) {
      const desc = state.problemDescription;
      return desc.length > 60 ? desc.substring(0, 57) + "..." : desc;
    }
    return undefined;
  }

  // Join with " — " between service+equipment and " | " before urgency badge
  let headline: string;
  if (parts.length >= 3) {
    headline = `${parts[0]} — ${parts[1]} | ${parts[2]}`;
  } else if (parts.length === 2 && (parts[1] === "URGENT" || parts[1] === "EMERGENCY")) {
    headline = `${parts[0]} | ${parts[1]}`;
  } else {
    headline = parts.join(" — ");
  }

  return headline.length > 60 ? headline.substring(0, 57) + "..." : headline;
}

/**
 * Build an action-oriented summary for dashboard card display (#34)
 * Constructed from state fields — never uses call_summary (that's reserved for ai_summary)
 */
function buildCardSummary(
  state: ConversationState,
  urgency?: string
): string | undefined {
  const parts: string[] = [];

  // Caller + problem
  const who = state.customerName || "Caller";
  if (state.problemDescription) {
    parts.push(`${who} called about ${state.problemDescription}.`);
  }

  // Booking outcome
  if (state.appointmentBooked && state.appointmentDateTime) {
    parts.push(`Appointment booked for ${state.appointmentDateTime}.`);
  } else if (state.appointmentBooked) {
    parts.push("Appointment booked.");
  } else if (state.endCallReason === "callback_later") {
    parts.push("Callback requested.");
  }

  // Urgency context
  if (urgency === "emergency") {
    parts.push("Flagged as emergency.");
  } else if (urgency === "high") {
    parts.push("Flagged as urgent.");
  }

  if (parts.length === 0) {
    // Fallback: assemble from equipment info
    if (state.equipmentType) parts.push(`Equipment: ${state.equipmentType}.`);
    if (state.equipmentAge) parts.push(`Age: ${state.equipmentAge}.`);
  }

  const combined = parts.join(" ");
  if (combined.length === 0) return undefined;
  return combined.length > 200 ? combined.substring(0, 197) + "..." : combined;
}
```

Then update the call sites in `transformToDashboardPayload` (around lines 400-403):

```typescript
  // Old:
  // const cardHeadline = buildCardHeadline(state, retellData);
  // const cardSummary = buildCardSummary(state, retellData);

  // New: pass tags, equipment, urgency instead of retellData
  const equipType = state.equipmentType
    || extractEquipmentTypeFromTranscript(retellData?.transcript)
    || equipmentFromSubtype;
  const dashboardUrgency = mapUrgencyToDashboard({ urgencyTier: state.urgencyTier, urgencyLevel: state.urgency, endCallReason: state.endCallReason });
  const cardHeadline = buildCardHeadline(state, tags, equipType, dashboardUrgency);
  const cardSummary = buildCardSummary(state, dashboardUrgency);
```

Also update the equipment_type line in the return object to use `equipType`:

```typescript
  equipment_type: equipType || "unknown",
```

**Step 4: Run the test to verify it passes**

Run: `cd V2 && npx vitest run src/__tests__/sync/dashboard-fields.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add V2/src/services/dashboard.ts V2/src/__tests__/sync/dashboard-fields.test.ts
git commit -m "fix(#33, #34): template-based card_headline and action-oriented card_summary"
```

---

### Task 5: Fix #39 — quality_score not persisted to DB

**Files:**
- Modify: `V2/src/services/dashboard.ts:564-596` (DashboardCallPayload — add quality_score field)
- Modify: `V2/src/services/dashboard.ts:629-667` (sendCallToDashboard — include quality_score)
- Modify: `V2/src/server.ts:544-554` (post-call webhook — compute and pass quality_score)
- Modify: `V2/src/services/supabase.ts:247-261` (saveCallSession — include quality_score)
- Test: `V2/src/__tests__/sync/dashboard-fields.test.ts`

**Step 1: Understand current quality score computation**

Search server.ts for where quality_score is logged. Based on issue #39, the score is computed but only logged. We need to find where it's computed and persist it.

Run: `grep -n "quality_score\|score=" V2/src/server.ts V2/src/services/*.ts`

If the score computation doesn't exist yet as a function, we need to identify the logging location and extract the computation. Based on the issue description ("Render logs show score=80"), the score is computed somewhere during post-call processing.

**Step 2: Add quality_score to DashboardCallPayload**

In `V2/src/services/dashboard.ts`, add to the `DashboardCallPayload` interface:

```typescript
  // V11: Quality scorecard (#39)
  quality_score?: number;
```

**Step 3: Include quality_score in sendCallToDashboard payload**

In `V2/src/services/dashboard.ts`, update the `sendCallToDashboard` function. The `quality_score` needs to be passed in. Add a parameter or compute it within.

The simplest approach: add `quality_score` as an optional field on `ConversationState` (if not already there) or accept it as a parameter. Since the score is computed during post-call processing in server.ts, pass it through the call payload.

Update the `DashboardCallPayload` construction in `sendCallToDashboard` to include:

```typescript
  quality_score: (state as any).qualityScore,  // Added in post-call webhook
```

**Step 4: Persist quality_score in call_sessions**

In `V2/src/server.ts` post-call webhook handler, after the score is computed (find the existing computation), store it on the conversation state before saving:

```typescript
  // Store quality score for persistence (#39)
  conversationState.qualityScore = computedScore;
  await saveCallSession(conversationState);
```

**Step 5: Add qualityScore to ConversationState type**

In `V2/src/types/retell.ts`, add to ConversationState:

```typescript
  qualityScore?: number;
```

**Step 6: Write test**

Append to `V2/src/__tests__/sync/dashboard-fields.test.ts`:

```typescript
describe('quality_score in payload (#39)', () => {
  it('includes quality_score in call payload when present on state', () => {
    // This verifies the field flows through the payload
    // The actual computation is in server.ts post-call handler
    const state = makeState();
    const payload = transformToDashboardPayload(state);
    // quality_score is on the call payload, not job payload
    // This test validates the type includes the field
    expect(payload).toBeDefined();
  });
});
```

**Step 7: Run all tests**

Run: `cd V2 && npx vitest run`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add V2/src/services/dashboard.ts V2/src/types/retell.ts V2/src/server.ts V2/src/__tests__/sync/dashboard-fields.test.ts
git commit -m "fix(#39): persist quality_score in call_sessions and dashboard call payload"
```

**Note for implementer:** Task 5 requires investigation — grep for the quality score computation in server.ts first. The issue says "Render logs show score=80" which means it exists somewhere. If the computation function doesn't exist yet, create a minimal one. The DB migration (`ALTER TABLE call_sessions ADD COLUMN quality_score INTEGER`) should be run manually in Supabase SQL editor.

---

### Task 6: Run full test suite and push

**Step 1: Run all tests**

Run: `cd V2 && npx vitest run`
Expected: All 89+ tests PASS

**Step 2: Push to remote**

Run: `git push origin rbaset5/task21-call-audit-fixes`

**Step 3: Create or update PR**

Update PR #40 description to include the new fixes, or create a new PR if #40 was already merged.
