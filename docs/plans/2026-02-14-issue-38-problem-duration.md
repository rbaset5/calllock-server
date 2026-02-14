# Issue #38: problem_duration Transcript Extraction — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract temporal phrases like "this morning" from call transcripts as a fallback when Retell AI misses `problem_duration`, classify into duration buckets, and emit taxonomy tags.

**Architecture:** New `extractProblemDuration()` function in extraction module with regex patterns for temporal phrases. Results feed into `classifyCall()` as 3 new CONTEXT tags (DURATION_ACUTE/RECENT/ONGOING). New `problemDurationCategory` field added to ConversationState and DashboardPayload. Voice agent gets an optional-capture hint (no new questions).

**Tech Stack:** TypeScript, Vitest, Express, Retell voice agent JSON config

---

### Task 1: Add `extractProblemDuration()` function with tests

**Files:**
- Modify: `V2/src/extraction/post-call.ts` (append after line 89)
- Test: `V2/src/__tests__/extraction/post-call.test.ts` (append after line 138)

**Step 1: Write the failing tests**

Append to `V2/src/__tests__/extraction/post-call.test.ts`:

```typescript
import {
  extractCustomerName,
  extractSafetyEmergency,
  mapUrgencyLevelFromAnalysis,
  extractAddressFromTranscript,
  mapDisconnectionReason,
  extractProblemDuration,
} from '../../extraction/post-call.js';

// ... existing tests remain unchanged ...

describe('extractProblemDuration', () => {
  // Acute (<24h)
  it('extracts "this morning" as acute', () => {
    const transcript = 'Agent: How can I help?\nUser: Yeah my AC stopped working this morning.';
    const result = extractProblemDuration(transcript);
    expect(result).toEqual({ raw: 'this morning', category: 'acute' });
  });

  it('extracts "today" as acute', () => {
    const transcript = 'Agent: What happened?\nUser: It just stopped working today.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  it('extracts "just started" as acute', () => {
    const transcript = 'Agent: Tell me more.\nUser: The noise just started about an hour ago.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  it('extracts "a few hours" as acute', () => {
    const transcript = 'Agent: How long?\nUser: It has been making that sound for a few hours.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  it('extracts "tonight" as acute', () => {
    const transcript = 'Agent: When did it start?\nUser: The heater stopped tonight.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  // Recent (1-7d)
  it('extracts "yesterday" as recent', () => {
    const transcript = 'Agent: What is going on?\nUser: Started acting up yesterday.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "2 days" as recent', () => {
    const transcript = 'Agent: How long?\nUser: It has been about 2 days now.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "since Monday" as recent', () => {
    const transcript = 'Agent: When did this start?\nUser: Since Monday it has been leaking.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "a few days" as recent', () => {
    const transcript = 'Agent: How long?\nUser: A few days now, maybe three or four.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "this week" as recent', () => {
    const transcript = 'Agent: Tell me more.\nUser: It started doing this earlier this week.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  // Ongoing (>7d)
  it('extracts "a couple weeks" as ongoing', () => {
    const transcript = 'Agent: How long?\nUser: Been going on a couple weeks now.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "a month" as ongoing', () => {
    const transcript = 'Agent: When did you notice?\nUser: About a month ago it started.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "for years" as ongoing', () => {
    const transcript = 'Agent: Tell me more.\nUser: This has been a problem for years honestly.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "a while" as ongoing', () => {
    const transcript = 'Agent: How long has this been happening?\nUser: It has been going on for a while now.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "for some time" as ongoing', () => {
    const transcript = 'Agent: When?\nUser: This has been happening for some time.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  // Edge cases
  it('returns undefined when no temporal phrase found', () => {
    const transcript = 'Agent: How can I help?\nUser: My AC is not working.';
    expect(extractProblemDuration(transcript)).toBeUndefined();
  });

  it('returns undefined for undefined transcript', () => {
    expect(extractProblemDuration(undefined)).toBeUndefined();
  });

  it('returns undefined for empty transcript', () => {
    expect(extractProblemDuration('')).toBeUndefined();
  });

  it('ignores agent utterances — agent saying "how long" does not match', () => {
    const transcript = 'Agent: How long has this been going on since this morning?\nUser: My AC is broken.';
    expect(extractProblemDuration(transcript)).toBeUndefined();
  });

  it('extracts from user line even with agent temporal phrase', () => {
    const transcript = 'Agent: How long has this been happening?\nUser: Since yesterday the unit has been making noise.';
    const result = extractProblemDuration(transcript);
    expect(result).toEqual({ raw: 'yesterday', category: 'recent' });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/extraction/post-call.test.ts`
Expected: FAIL — `extractProblemDuration` is not exported

**Step 3: Implement `extractProblemDuration()`**

Append to `V2/src/extraction/post-call.ts` after the `mapDisconnectionReason` function (after line 89):

```typescript
/**
 * Duration category for problem onset timing.
 * - acute: <24 hours (same day)
 * - recent: 1-7 days
 * - ongoing: >7 days
 */
export type DurationCategory = 'acute' | 'recent' | 'ongoing';

export interface DurationResult {
  raw: string;
  category: DurationCategory;
}

// Patterns grouped by category, ordered most-specific first within each group.
// Each entry: [regex, matched group index for raw value, category]
const DURATION_PATTERNS: Array<[RegExp, number, DurationCategory]> = [
  // === ACUTE (<24h) ===
  [/\b(this morning|this afternoon|this evening|tonight|today)\b/i, 1, 'acute'],
  [/\b(just started|just happened|just now|just began)\b/i, 1, 'acute'],
  [/\b(an? (?:few |couple )?hours?(?: ago)?)\b/i, 1, 'acute'],
  [/\b((?:about |like )?an? hour(?: ago)?)\b/i, 1, 'acute'],

  // === RECENT (1-7d) ===
  [/\b(yesterday|last night)\b/i, 1, 'recent'],
  [/\b(since (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i, 1, 'recent'],
  [/\b((?:about |like )?(?:\d|a few|a couple|couple|several) days?(?: ago| now)?)\b/i, 1, 'recent'],
  [/\b(this week|earlier this week)\b/i, 1, 'recent'],
  [/\b((?:a |the )?(?:day|night) before yesterday)\b/i, 1, 'recent'],

  // === ONGOING (>7d) ===
  [/\b((?:about |like )?(?:\d|a few|a couple|couple|several) weeks?(?: ago| now)?)\b/i, 1, 'ongoing'],
  [/\b((?:about |like )?(?:\d|a few|a couple|couple|several) months?(?: ago| now)?)\b/i, 1, 'ongoing'],
  [/\b((?:about |like )?(?:\d|a few|a couple|couple|several) years?(?: ago| now)?)\b/i, 1, 'ongoing'],
  [/\b((?:for )?(?:a while|some time|a long time|ages))\b/i, 1, 'ongoing'],
  [/\b((?:about |like )?a (?:month|year)(?: ago)?)\b/i, 1, 'ongoing'],
  [/\b(last (?:week|month|year))\b/i, 1, 'ongoing'],
];

/**
 * Extract problem duration from transcript.
 * Filters agent utterances to avoid matching agent questions like "how long has this been going on?"
 * Returns the raw phrase and duration category, or undefined if no temporal phrase found.
 */
export function extractProblemDuration(transcript: string | undefined): DurationResult | undefined {
  if (!transcript) return undefined;

  // Extract only user utterances (same pattern as extractCustomerName)
  const userLines = transcript
    .split('\n')
    .filter(line => line.startsWith('User:'))
    .map(line => line.replace(/^User:\s*/, ''))
    .join(' ');

  if (!userLines) return undefined;

  for (const [pattern, groupIndex, category] of DURATION_PATTERNS) {
    const match = userLines.match(pattern);
    if (match && match[groupIndex]) {
      return {
        raw: match[groupIndex].trim(),
        category,
      };
    }
  }

  return undefined;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/extraction/post-call.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add V2/src/extraction/post-call.ts V2/src/__tests__/extraction/post-call.test.ts
git commit -m "feat(#38): add extractProblemDuration with temporal phrase regex"
```

---

### Task 2: Add `problemDurationCategory` to types and dashboard payload

**Files:**
- Modify: `V2/src/types/retell.ts:271` (add field after problemDuration)
- Modify: `V2/src/services/dashboard.ts:68` (add field after problem_duration)
- Modify: `V2/src/services/dashboard.ts:449` (populate in transform)

**Step 1: Add `problemDurationCategory` to ConversationState**

In `V2/src/types/retell.ts`, after line 271 (`problemDuration?: string;`), add:

```typescript
  problemDurationCategory?: 'acute' | 'recent' | 'ongoing';  // Derived from problemDuration
```

**Step 2: Add `problem_duration_category` to DashboardPayload**

In `V2/src/services/dashboard.ts`, after line 68 (`problem_duration?: string;`), add:

```typescript
  problem_duration_category?: 'acute' | 'recent' | 'ongoing';
```

**Step 3: Populate in `transformToDashboardPayload()`**

In `V2/src/services/dashboard.ts`, after line 449 (`problem_duration: state.problemDuration,`), add:

```typescript
    problem_duration_category: state.problemDurationCategory,
```

**Step 4: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: ALL PASS (type changes are backwards-compatible, all fields optional)

**Step 5: Commit**

```bash
git add V2/src/types/retell.ts V2/src/services/dashboard.ts
git commit -m "feat(#38): add problemDurationCategory to state and dashboard payload"
```

---

### Task 3: Add DURATION_* tags to taxonomy classifier

**Files:**
- Modify: `V2/src/classification/tags.ts:303-317` (add tag entries to CONTEXT_PATTERNS)
- Modify: `V2/src/classification/tags.ts:459-464` (add duration classification logic after CONTEXT loop)
- Test: `V2/src/__tests__/classification/tags.test.ts` (append duration tag tests)

**Step 1: Write failing tests**

Append to `V2/src/__tests__/classification/tags.test.ts` inside the `describe('classifyCall')` block, before the closing `});`:

```typescript
  // Duration tags (#38)
  it('emits DURATION_ACUTE for "this morning" in transcript', () => {
    const state = makeState();
    const tags = classifyCall(state, 'Agent: How can I help?\nUser: My AC stopped working this morning.');
    expect(tags.CONTEXT).toContain('DURATION_ACUTE');
  });

  it('emits DURATION_RECENT for "yesterday" in transcript', () => {
    const state = makeState();
    const tags = classifyCall(state, 'Agent: What happened?\nUser: Started acting up yesterday.');
    expect(tags.CONTEXT).toContain('DURATION_RECENT');
  });

  it('emits DURATION_ONGOING for "a couple weeks" in transcript', () => {
    const state = makeState();
    const tags = classifyCall(state, 'Agent: How long?\nUser: Been going on a couple weeks now.');
    expect(tags.CONTEXT).toContain('DURATION_ONGOING');
  });

  it('does not emit duration tag when no temporal phrase found', () => {
    const state = makeState();
    const tags = classifyCall(state, 'Agent: How can I help?\nUser: My AC is broken.');
    expect(tags.CONTEXT.filter(t => t.startsWith('DURATION_'))).toEqual([]);
  });

  it('uses state.problemDurationCategory if already set (dynamic variable priority)', () => {
    const state = makeState({ problemDurationCategory: 'ongoing' as const });
    const tags = classifyCall(state, 'Agent: Hi.\nUser: Just happened this morning.');
    // State takes priority over transcript extraction
    expect(tags.CONTEXT).toContain('DURATION_ONGOING');
    expect(tags.CONTEXT).not.toContain('DURATION_ACUTE');
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd V2 && npx vitest run src/__tests__/classification/tags.test.ts`
Expected: FAIL — no DURATION_* tags emitted

**Step 3: Add DURATION tag entries to CONTEXT_PATTERNS**

In `V2/src/classification/tags.ts`, update CONTEXT_PATTERNS (line 303) to add 3 entries with empty arrays (they're detected by extraction logic, not phrase matching — same pattern as PEAK_SUMMER, AFTER_HOURS, etc.):

```typescript
const CONTEXT_PATTERNS = {
  DURATION_ACUTE: [], // Detected by extractProblemDuration
  DURATION_RECENT: [], // Detected by extractProblemDuration
  DURATION_ONGOING: [], // Detected by extractProblemDuration
  PEAK_SUMMER: [], // Detected by date
  // ... rest unchanged
```

**Step 4: Add duration classification logic**

Add import at top of `V2/src/classification/tags.ts`:

```typescript
import { extractProblemDuration } from "../extraction/post-call.js";
```

In `classifyCall()`, after the CONTEXT pattern loop and before the seasonal auto-tags (after line 464), add:

```typescript
  // Auto-tag duration from transcript extraction or state (#38)
  const durationCategory = state.problemDurationCategory
    || extractProblemDuration(transcript)?.category;
  if (durationCategory === 'acute') {
    tags.CONTEXT.push("DURATION_ACUTE");
  } else if (durationCategory === 'recent') {
    tags.CONTEXT.push("DURATION_RECENT");
  } else if (durationCategory === 'ongoing') {
    tags.CONTEXT.push("DURATION_ONGOING");
  }
```

**Step 5: Run tests to verify they pass**

Run: `cd V2 && npx vitest run src/__tests__/classification/tags.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add V2/src/classification/tags.ts V2/src/__tests__/classification/tags.test.ts
git commit -m "feat(#38): add DURATION_ACUTE/RECENT/ONGOING taxonomy tags"
```

---

### Task 4: Wire extraction fallback into post-call processing

**Files:**
- Modify: `V2/src/server.ts:360` (add extraction fallback for problemDuration)

**Step 1: Add import**

At the top of `V2/src/server.ts`, find the import from `'./extraction/post-call.js'` and add `extractProblemDuration`:

```typescript
import {
  extractCustomerName,
  extractSafetyEmergency,
  mapUrgencyLevelFromAnalysis,
  extractAddressFromTranscript,
  mapDisconnectionReason,
  extractProblemDuration,
} from './extraction/post-call.js';
```

**Step 2: Add fallback in `extractStateFromPostCallData()`**

In `V2/src/server.ts`, find line 360 where `problemDuration` is assigned:

```typescript
    problemDuration: custom?.problem_duration,
```

Replace with extraction fallback:

```typescript
    problemDuration: custom?.problem_duration || extractProblemDuration(callData.transcript)?.raw,
    problemDurationCategory: extractProblemDuration(callData.transcript)?.category,
```

Note: To avoid calling `extractProblemDuration` twice, extract once before the return block. Find a good place before the `return {` statement (around line 352) and add:

```typescript
  // Extract problem duration from transcript as fallback (#38)
  const durationExtraction = extractProblemDuration(callData.transcript);
```

Then use in the return:

```typescript
    problemDuration: custom?.problem_duration || durationExtraction?.raw,
    problemDurationCategory: durationExtraction?.category,
```

**Step 3: Run full test suite**

Run: `cd V2 && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add V2/src/server.ts
git commit -m "feat(#38): wire extractProblemDuration fallback into post-call processing"
```

---

### Task 5: Update voice agent config with duration capture hint

**Files:**
- Modify: `voice-agent/retell-llm-v9-triage.json:490` (discovery state_prompt)
- Modify: `voice-agent/retell-llm-v9-triage.json:496-518` (discovery edge parameters)

**Step 1: Add optional duration capture to discovery state prompt**

In `voice-agent/retell-llm-v9-triage.json`, find the discovery state_prompt (line 490). After the "Equipment Type (OPTIONAL — do NOT ask separately)" paragraph, add this paragraph:

```
## Problem Duration (OPTIONAL — do NOT ask separately)\nIf the caller naturally mentions how long the problem has been going on (e.g., 'since this morning', 'a few days', 'for weeks'), capture it in the problem_duration edge parameter.\nDo NOT add an extra question for this — only capture if volunteered during problem description.\n
```

**Step 2: Add `problem_duration` edge parameter**

In the discovery state's edges[0].parameters.properties (around line 498-518), add a new property:

```json
"problem_duration": {
  "type": "string",
  "description": "If the caller naturally mentioned how long the problem has been going on, capture the phrase (e.g., 'this morning', '2 days', 'a couple weeks'). Empty string if not mentioned."
}
```

**Step 3: Verify JSON is valid**

Run: `python3 -c "import json; json.load(open('voice-agent/retell-llm-v9-triage.json'))"`
Expected: No output (valid JSON)

**Step 4: Commit**

```bash
git add voice-agent/retell-llm-v9-triage.json
git commit -m "feat(#38): add problem_duration optional capture to voice agent discovery"
```

---

### Task 6: Run full test suite and verify

**Step 1: Run all tests**

Run: `cd V2 && npx vitest run`
Expected: ALL PASS — no regressions

**Step 2: Verify no TypeScript errors**

Run: `cd V2 && npx tsc --noEmit`
Expected: No errors

**Step 3: Review diff**

Run: `git diff main --stat`
Verify only the expected files are modified.

**Step 4: Final commit if any fixups needed, then push**

```bash
git push origin HEAD
```
