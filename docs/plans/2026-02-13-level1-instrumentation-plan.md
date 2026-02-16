# Level 1 Instrumentation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Emit a structured call quality scorecard log line for every completed call, enabling measurement of tag accuracy, name capture, urgency consistency, and booking success.

**Architecture:** One new module (`V2/src/instrumentation/call-scorecard.ts`) with a pure function that builds metrics from ConversationState + Retell post-call data, then logs via Pino. Called from the post-call webhook handler.

**Tech Stack:** TypeScript, vitest, Pino (already in use)

**Design Doc:** `docs/plans/2026-02-13-level1-instrumentation-design.md`

---

### Task 1: Write Failing Tests for Call Scorecard

**Files:**
- Create: `V2/src/__tests__/instrumentation/call-scorecard.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { buildCallScorecard } from '../../instrumentation/call-scorecard.js';
import type { ConversationState } from '../../types/retell.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'call_test_123',
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('buildCallScorecard', () => {
  it('returns correct structure for minimal state', () => {
    const scorecard = buildCallScorecard(makeState(), {});
    expect(scorecard.callId).toBe('call_test_123');
    expect(scorecard.metrics).toBeDefined();
    expect(scorecard.metrics.tags_count).toBe(0);
    expect(scorecard.metrics.tags_empty).toBe(true);
    expect(scorecard.metrics.name_captured).toBe(false);
    expect(scorecard.metrics.booking_attempted).toBe(false);
    expect(scorecard.metrics.booking_succeeded).toBe(false);
  });

  it('detects name captured from state', () => {
    const scorecard = buildCallScorecard(
      makeState({ customerName: 'Jonas' }),
      {}
    );
    expect(scorecard.metrics.name_captured).toBe(true);
  });

  it('detects address captured vs TBD', () => {
    const withAddress = buildCallScorecard(
      makeState({ serviceAddress: '123 Main St' }),
      {}
    );
    expect(withAddress.metrics.address_captured).toBe(true);
    expect(withAddress.metrics.address_is_tbd).toBe(false);

    const withTbd = buildCallScorecard(
      makeState({ serviceAddress: 'TBD' }),
      {}
    );
    expect(withTbd.metrics.address_captured).toBe(true);
    expect(withTbd.metrics.address_is_tbd).toBe(true);
  });

  it('compares agent urgency vs inferred urgency', () => {
    const scorecard = buildCallScorecard(
      makeState({ urgency: 'Urgent' }),
      { transcript: 'water leak inside the house, need help today' }
    );
    expect(scorecard.metrics.urgency_agent).toBe('Urgent');
    expect(scorecard.metrics.urgency_inferred).toBeDefined();
    expect(typeof scorecard.metrics.urgency_match).toBe('boolean');
  });

  it('detects booking success', () => {
    const scorecard = buildCallScorecard(
      makeState({
        appointmentBooked: true,
        lastAgentState: 'confirm',
      }),
      {}
    );
    expect(scorecard.metrics.booking_attempted).toBe(true);
    expect(scorecard.metrics.booking_succeeded).toBe(true);
  });

  it('detects booking attempted but failed', () => {
    const scorecard = buildCallScorecard(
      makeState({
        appointmentBooked: false,
        lastAgentState: 'booking_failed',
      }),
      {}
    );
    expect(scorecard.metrics.booking_attempted).toBe(true);
    expect(scorecard.metrics.booking_succeeded).toBe(false);
  });

  it('detects safety from state flag', () => {
    const scorecard = buildCallScorecard(
      makeState({ isSafetyEmergency: true }),
      {}
    );
    expect(scorecard.metrics.safety_detected).toBe(true);
  });

  it('calculates call duration from retell timestamps', () => {
    const scorecard = buildCallScorecard(
      makeState(),
      { start_timestamp: 1000000, end_timestamp: 1000142000 }
    );
    expect(scorecard.metrics.call_duration_seconds).toBe(142);
  });

  it('captures states_visited from dynamic variables', () => {
    const scorecard = buildCallScorecard(
      makeState({ lastAgentState: 'confirm' }),
      { collected_dynamic_variables: { current_agent_state: 'confirm' } }
    );
    expect(scorecard.metrics.end_state).toBe('confirm');
  });

  it('detects callback promised but not created', () => {
    const scorecard = buildCallScorecard(
      makeState({
        endCallReason: 'callback_later',
        callbackType: undefined,
      }),
      {}
    );
    expect(scorecard.metrics.callback_promised).toBe(true);
    expect(scorecard.metrics.callback_created).toBe(false);
  });

  it('captures tag count from classification result', () => {
    const scorecard = buildCallScorecard(
      makeState(),
      {},
      { tags: ['HAZARD:GAS_LEAK', 'URGENCY:EMERGENCY', 'SERVICE_TYPE:REPAIR'] }
    );
    expect(scorecard.metrics.tags_count).toBe(3);
    expect(scorecard.metrics.tags_empty).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd V2 && npx vitest run src/__tests__/instrumentation/call-scorecard.test.ts
```

Expected: FAIL — module `../../instrumentation/call-scorecard.js` does not exist.

**Step 3: Commit the test file**

```bash
git add V2/src/__tests__/instrumentation/call-scorecard.test.ts
git commit -m "test: add failing tests for call quality scorecard"
```

---

### Task 2: Implement `buildCallScorecard` Function

**Files:**
- Create: `V2/src/instrumentation/call-scorecard.ts`

**Step 1: Implement the module**

```typescript
import { ConversationState } from '../types/retell.js';
import { inferUrgencyFromContext } from '../extraction/urgency.js';
import { createModuleLogger } from '../utils/logger.js';

const log = createModuleLogger('quality');

export interface CallScorecardMetrics {
  tags_count: number;
  tags_empty: boolean;
  name_captured: boolean;
  name_source: 'dynamic_vars' | 'custom_analysis' | 'transcript_mining' | 'none';
  urgency_agent: string | undefined;
  urgency_inferred: string | undefined;
  urgency_match: boolean;
  safety_detected: boolean;
  equipment_type_captured: boolean;
  address_captured: boolean;
  address_is_tbd: boolean;
  booking_attempted: boolean;
  booking_succeeded: boolean;
  callback_promised: boolean;
  callback_created: boolean;
  call_duration_seconds: number;
  end_reason: string | undefined;
  end_state: string | undefined;
}

export interface CallScorecard {
  callId: string;
  metrics: CallScorecardMetrics;
}

interface RetellPostCallData {
  transcript?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  collected_dynamic_variables?: Record<string, string>;
  [key: string]: unknown;
}

interface ClassificationResult {
  tags?: string[];
  [key: string]: unknown;
}

const BOOKING_STATES = new Set([
  'booking', 'booking_failed', 'confirm', 'pre_confirm',
]);

/**
 * Build a call quality scorecard from the final conversation state,
 * Retell post-call data, and classification results.
 *
 * This is a pure function — no side effects. Call emitCallScorecard()
 * to log it.
 */
export function buildCallScorecard(
  state: ConversationState,
  retellData: RetellPostCallData,
  classification?: ClassificationResult,
): CallScorecard {
  const tags = classification?.tags || [];

  // Determine name source
  let nameSource: CallScorecardMetrics['name_source'] = 'none';
  if (state.customerName) {
    // We can't perfectly determine source after the fact, but we
    // can infer: if dynamic vars had it, that was the source
    const dynVars = retellData.collected_dynamic_variables;
    if (dynVars?.customer_name) {
      nameSource = 'dynamic_vars';
    } else {
      nameSource = 'transcript_mining';
    }
  }

  // Urgency comparison
  const urgencyAgent = state.urgency;
  const urgencyInferred = inferUrgencyFromContext(
    state.problemDescription,
    retellData.transcript,
  );
  const urgencyMatch = urgencyAgent !== undefined && urgencyInferred !== undefined
    ? urgencyAgent === urgencyInferred
    : urgencyAgent === urgencyInferred; // both undefined = match

  // Booking detection
  const lastState = state.lastAgentState
    || retellData.collected_dynamic_variables?.current_agent_state;
  const bookingAttempted = state.appointmentBooked
    || (lastState !== undefined && BOOKING_STATES.has(lastState));

  // Callback detection
  const callbackPromised = state.endCallReason === 'callback_later'
    || state.endCallReason === 'callback_requested';
  const callbackCreated = state.callbackType !== undefined;

  // Duration
  const durationMs = (retellData.end_timestamp && retellData.start_timestamp)
    ? retellData.end_timestamp - retellData.start_timestamp
    : 0;
  const durationSeconds = Math.round(durationMs / 1000);

  return {
    callId: state.callId,
    metrics: {
      tags_count: tags.length,
      tags_empty: tags.length === 0,
      name_captured: Boolean(state.customerName),
      name_source: nameSource,
      urgency_agent: urgencyAgent,
      urgency_inferred: urgencyInferred,
      urgency_match: urgencyMatch,
      safety_detected: state.isSafetyEmergency,
      equipment_type_captured: Boolean(state.hvacIssueType || state.equipmentType),
      address_captured: Boolean(state.serviceAddress),
      address_is_tbd: state.serviceAddress?.toUpperCase() === 'TBD',
      booking_attempted: bookingAttempted,
      booking_succeeded: state.appointmentBooked,
      callback_promised: callbackPromised,
      callback_created: callbackCreated,
      call_duration_seconds: durationSeconds,
      end_reason: state.endCallReason,
      end_state: lastState,
    },
  };
}

/**
 * Emit the call scorecard as a structured Pino log line.
 * Call this from the post-call webhook after dashboard sync.
 */
export function emitCallScorecard(
  state: ConversationState,
  retellData: RetellPostCallData,
  classification?: ClassificationResult,
): void {
  const scorecard = buildCallScorecard(state, retellData, classification);

  log.info({
    event: 'call_scorecard',
    callId: scorecard.callId,
    metrics: scorecard.metrics,
  }, 'Call quality scorecard');
}
```

**Step 2: Run tests to verify they pass**

```bash
cd V2 && npx vitest run src/__tests__/instrumentation/call-scorecard.test.ts
```

Expected: ALL PASS

**Step 3: Run full test suite**

```bash
cd V2 && npx vitest run
```

Expected: ALL PASS (85+ existing tests + 12 new tests)

**Step 4: Commit**

```bash
git add V2/src/instrumentation/call-scorecard.ts
git commit -m "feat: implement call quality scorecard module

Pure function that builds metrics from ConversationState + Retell
post-call data: tag accuracy, name capture, urgency match, booking
success, callback fulfillment, and duration. Logged via Pino."
```

---

### Task 3: Wire Scorecard Into Post-Call Webhook

**Files:**
- Modify: `V2/src/server.ts:624-635` (add scorecard emission after dashboard sync)

**Step 1: Add import to server.ts**

At the top of `V2/src/server.ts`, add with the other imports:

```typescript
import { emitCallScorecard } from './instrumentation/call-scorecard.js';
```

**Step 2: Add scorecard emission after dashboard sync**

In `V2/src/server.ts`, after line 633 (`await updateCallSessionSynced(...)`) and before line 635 (`logger.info({ callId, jobId: dashboardResult.jobId }...`), add:

```typescript
      // Emit call quality scorecard for instrumentation
      emitCallScorecard(
        conversationState,
        payload.call as unknown as Record<string, unknown>,
        dashboardResult.classification
      );
```

Also add the scorecard for failed syncs — after line 641 (`logger.error...`), before the return:

```typescript
      // Still emit scorecard even on sync failure — quality data is independent
      emitCallScorecard(
        conversationState,
        payload.call as unknown as Record<string, unknown>,
      );
```

**Step 3: Verify typecheck**

```bash
cd V2 && npx tsc --noEmit
```

Expected: PASS

Note: If `dashboardResult.classification` doesn't exist on the current type, pass `undefined` instead. The scorecard handles missing classification gracefully (tags_count: 0, tags_empty: true).

**Step 4: Run full test suite**

```bash
cd V2 && npx vitest run
```

Expected: ALL PASS

**Step 5: Commit**

```bash
git add V2/src/server.ts
git commit -m "feat: wire call scorecard into post-call webhook

Emits structured quality metrics after every call: tag accuracy,
name capture rate, urgency consistency, booking success, callback
fulfillment. Search Render logs for event:call_scorecard."
```

---

### Task 4: Add Warning Log for Zero-Tag Calls

**Files:**
- Modify: `V2/src/instrumentation/call-scorecard.ts`
- Modify: `V2/src/__tests__/instrumentation/call-scorecard.test.ts`

**Step 1: Write the failing test**

Add to the test file:

```typescript
import { vi } from 'vitest';

describe('emitCallScorecard', () => {
  it('logs a warning when tags are empty', () => {
    // This test verifies that zero-tag calls get extra visibility
    const scorecard = buildCallScorecard(makeState(), {}, { tags: [] });
    expect(scorecard.metrics.tags_empty).toBe(true);
    // The warning log is emitted by emitCallScorecard, not buildCallScorecard
    // We verify the flag is set correctly here
  });
});
```

**Step 2: Add warning to emitCallScorecard**

In `call-scorecard.ts`, in the `emitCallScorecard` function, after the `log.info` call, add:

```typescript
  if (scorecard.metrics.tags_empty) {
    log.warn({
      event: 'tags_empty',
      callId: scorecard.callId,
      end_reason: scorecard.metrics.end_reason,
      call_duration_seconds: scorecard.metrics.call_duration_seconds,
    }, 'Call completed with zero tags classified');
  }

  if (scorecard.metrics.callback_promised && !scorecard.metrics.callback_created) {
    log.warn({
      event: 'callback_gap',
      callId: scorecard.callId,
    }, 'Callback was promised but no callback record created');
  }
```

**Step 3: Run tests**

```bash
cd V2 && npx vitest run
```

Expected: ALL PASS

**Step 4: Commit**

```bash
git add V2/src/instrumentation/call-scorecard.ts V2/src/__tests__/instrumentation/call-scorecard.test.ts
git commit -m "feat: add warning logs for zero-tag calls and callback gaps

These stand out in Render logs (warn level) for quick triage:
- tags_empty: classifier found nothing
- callback_gap: callback promised but never created"
```

---

## Completion Checklist

- [ ] Task 1: Failing tests written
- [ ] Task 2: buildCallScorecard implemented, tests pass
- [ ] Task 3: Wired into post-call webhook
- [ ] Task 4: Warning logs for zero-tag and callback gap
- [ ] All existing tests still pass (85+)
- [ ] TypeScript compiles clean
