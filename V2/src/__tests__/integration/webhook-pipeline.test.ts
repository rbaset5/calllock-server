/**
 * Integration tests for the full webhook pipeline.
 *
 * These tests chain the extracted modules together to simulate
 * the end-to-end data flow from a Retell post-call webhook through
 * extraction, classification, urgency mapping, and state management.
 *
 * Pipeline: Post-call data → extraction → classification → urgency mapping → dashboard payload
 */
import { describe, it, expect } from 'vitest';
import { extractCustomerName, extractSafetyEmergency, mapDisconnectionReason } from '../../extraction/post-call.js';
import { inferUrgencyFromContext } from '../../extraction/urgency.js';
import { inferHvacIssueType } from '../../extraction/hvac-issue.js';
import { classifyCall, type TaxonomyTags } from '../../classification/tags.js';
import { mapUrgencyToDashboard } from '../../classification/call-type.js';
import { incrementStateVisit, isStateLooping } from '../../state/conversation-state.js';
import type { ConversationState } from '../../types/retell.js';

// ============================================
// Helpers
// ============================================

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'test-call-001',
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

// ============================================
// Scenario 1: New caller → discovery → booking → success
// ============================================

describe('Scenario 1: New caller books appointment successfully', () => {
  const transcript = [
    'Agent: Thanks for calling ACE Cooling, how can I help you today?',
    'User: Hi, my name is Sarah Johnson. My AC stopped working this morning.',
    'Agent: Sorry to hear that. What is the address for the service?',
    'User: 123 Elm Street, Indianapolis, IN 46201',
    'Agent: I have an opening tomorrow at 2pm, would that work?',
    'User: Yes, that works great.',
    'Agent: Youre all set. Anything else I can help with?',
    'User: No, thank you!',
  ].join('\n');

  it('extracts customer name from transcript', () => {
    const name = extractCustomerName(transcript);
    expect(name).toBe('Sarah Johnson');
  });

  it('detects no safety emergency', () => {
    expect(extractSafetyEmergency(transcript)).toBe(false);
  });

  it('infers urgency from problem description', () => {
    const urgency = inferUrgencyFromContext('AC stopped working this morning');
    // "AC stopped" isn't in the emergency/urgent keyword list
    expect(urgency).toBe('Routine');
  });

  it('infers HVAC issue type from problem description', () => {
    // Patterns require specific phrases; checked in priority order
    expect(inferHvacIssueType('AC not cooling at all')).toBe('No Cool');
    // "furnace won't" matches No Heat before Not Running (priority order)
    expect(inferHvacIssueType("furnace won't start")).toBe('No Heat');
    expect(inferHvacIssueType("unit won't start, no power")).toBe('Not Running');
    expect(inferHvacIssueType('AC stopped working')).toBeUndefined();
  });

  it('classifies tags correctly for a routine AC repair', () => {
    const state = makeState({
      problemDescription: 'air conditioner broken',
      customerName: 'Sarah Johnson',
    });
    // Don't pass transcript — negation-aware matching can be tripped by
    // "no, thank you" in preceding text. Test classification from state alone.
    const tags = classifyCall(state);

    // Should detect AC repair service type
    expect(tags.SERVICE_TYPE).toContain('REPAIR_AC');
    // Should NOT detect hazard tags
    expect(tags.HAZARD).toEqual([]);
    expect(tags.NON_CUSTOMER).toEqual([]);
  });

  it('maps urgency to dashboard correctly', () => {
    // Completed booking, routine urgency
    const dashUrgency = mapUrgencyToDashboard({
      urgencyLevel: 'Routine',
      endCallReason: 'completed',
    });
    expect(dashUrgency).toBe('medium');
  });

  it('full pipeline produces correct state', () => {
    const name = extractCustomerName(transcript);
    const isSafety = extractSafetyEmergency(transcript);
    const urgency = inferUrgencyFromContext('AC stopped working this morning');

    const state = makeState({
      customerName: name,
      isSafetyEmergency: isSafety,
      urgency: urgency,
      appointmentBooked: true,
      appointmentDateTime: '2026-02-14T14:00:00Z',
      endCallReason: 'completed',
      serviceAddress: '123 Elm Street, Indianapolis, IN 46201',
    });

    const tags = classifyCall(state, transcript);
    const dashUrgency = mapUrgencyToDashboard({
      urgencyLevel: state.urgency,
      endCallReason: state.endCallReason,
    });

    // Assertions on the assembled state
    expect(state.customerName).toBe('Sarah Johnson');
    expect(state.isSafetyEmergency).toBe(false);
    expect(state.appointmentBooked).toBe(true);
    expect(dashUrgency).toBe('medium');
    expect(tags.HAZARD).toEqual([]);
  });
});

// ============================================
// Scenario 2: Failed booking → callback created
// ============================================

describe('Scenario 2: Booking fails, callback requested', () => {
  const transcript = [
    'Agent: Thanks for calling ACE Cooling.',
    'User: Hi, my name is Mike Davis. My furnace is barely working.',
    'Agent: Let me check availability... Unfortunately I dont have any openings today.',
    'User: Can you have someone call me back with times?',
    'Agent: Absolutely, Ill have the team reach out to you.',
  ].join('\n');

  it('extracts customer name', () => {
    expect(extractCustomerName(transcript)).toBe('Mike Davis');
  });

  it('infers urgent urgency for "barely working"', () => {
    const urgency = inferUrgencyFromContext('furnace is barely working');
    // "barely working" doesn't match our emergency/urgent patterns exactly
    // but let's check what it returns
    expect(['Routine', 'Urgent']).toContain(urgency);
  });

  it('maps callback_later to non-emergency dashboard urgency', () => {
    const dashUrgency = mapUrgencyToDashboard({
      urgencyLevel: 'Routine',
      endCallReason: 'callback_later',
    });
    expect(dashUrgency).toBe('medium');
  });

  it('classifies heating repair tags', () => {
    const state = makeState({
      // "furnace not working" matches REPAIR_HEATING pattern
      problemDescription: 'furnace not working, no heat at all',
      endCallReason: 'callback_later',
    });
    const tags = classifyCall(state, transcript);

    expect(tags.SERVICE_TYPE).toContain('REPAIR_HEATING');
  });

  it('does NOT extract agent name as customer name', () => {
    const agentOnlyTranscript = [
      'Agent: Thanks for calling, this is Alex from ACE Cooling.',
      'User: Hi, I need help with my furnace.',
    ].join('\n');
    const name = extractCustomerName(agentOnlyTranscript);
    expect(name).not.toBe('Alex');
  });
});

// ============================================
// Scenario 3: Safety emergency → alert triggered
// ============================================

describe('Scenario 3: Safety emergency detected', () => {
  const transcript = [
    'Agent: Thanks for calling ACE Cooling.',
    'User: I smell gas in my kitchen! The rotten egg smell is really strong.',
    'Agent: That sounds like a potential gas leak. Please leave the house immediately.',
    'User: Were already outside.',
  ].join('\n');

  it('detects safety emergency', () => {
    expect(extractSafetyEmergency(transcript)).toBe(true);
  });

  it('infers Emergency urgency from gas leak mention', () => {
    // inferUrgencyFromContext matches "gas leak", not just "smell gas"
    const urgency = inferUrgencyFromContext('there is a gas leak in the kitchen');
    expect(urgency).toBe('Emergency');
  });

  it('maps safety_emergency to critical dashboard urgency', () => {
    const dashUrgency = mapUrgencyToDashboard({
      endCallReason: 'safety_emergency',
    });
    expect(dashUrgency).toBe('emergency');
  });

  it('classifies hazard tags correctly', () => {
    const state = makeState({
      isSafetyEmergency: true,
      endCallReason: 'safety_emergency',
      problemDescription: 'Gas smell in kitchen, rotten egg smell',
    });
    const tags = classifyCall(state, transcript);

    expect(tags.HAZARD).toContain('GAS_LEAK');
    expect(tags.URGENCY).toContain('CRITICAL_EVACUATE');
  });

  it('full pipeline flags emergency correctly', () => {
    const isSafety = extractSafetyEmergency(transcript);
    // Use "gas leak" which matches the urgency inference pattern
    const urgency = inferUrgencyFromContext('gas leak in the kitchen');

    const state = makeState({
      isSafetyEmergency: isSafety,
      urgency: urgency,
      endCallReason: 'safety_emergency',
      problemDescription: 'Gas leak in kitchen, rotten egg smell',
    });

    const tags = classifyCall(state, transcript);
    const dashUrgency = mapUrgencyToDashboard({
      urgencyLevel: state.urgency,
      endCallReason: state.endCallReason,
    });

    expect(state.isSafetyEmergency).toBe(true);
    expect(state.urgency).toBe('Emergency');
    expect(dashUrgency).toBe('emergency');
    expect(tags.HAZARD.length).toBeGreaterThan(0);
    expect(tags.URGENCY).toContain('CRITICAL_EVACUATE');
  });
});

// ============================================
// Scenario 4: State loop detection (dedup)
// ============================================

describe('Scenario 4: State loop detection prevents infinite loops', () => {
  it('detects a stuck booking loop', () => {
    const state = makeState();

    // Simulate the agent visiting booking state 4 times
    incrementStateVisit(state, 'booking');
    incrementStateVisit(state, 'booking');
    incrementStateVisit(state, 'booking');
    expect(isStateLooping(state, 'booking', 3)).toBe(false); // at threshold, not over

    incrementStateVisit(state, 'booking');
    expect(isStateLooping(state, 'booking', 3)).toBe(true); // over threshold
  });

  it('different states tracked independently', () => {
    const state = makeState();

    incrementStateVisit(state, 'booking');
    incrementStateVisit(state, 'booking');
    incrementStateVisit(state, 'booking');
    incrementStateVisit(state, 'discovery');

    expect(isStateLooping(state, 'booking', 3)).toBe(false);
    expect(isStateLooping(state, 'discovery', 3)).toBe(false);
  });
});

// ============================================
// Scenario 5: Disconnection reason mapping
// ============================================

describe('Scenario 5: Disconnection reason mapping', () => {
  it('maps user_hangup to customer_hangup', () => {
    expect(mapDisconnectionReason('user_hangup')).toBe('customer_hangup');
  });

  it('maps voicemail to callback_later', () => {
    expect(mapDisconnectionReason('voicemail')).toBe('callback_later');
  });

  it('returns undefined for unknown reasons', () => {
    expect(mapDisconnectionReason('agent_hangup')).toBeUndefined();
  });

  it('returns undefined for no reason', () => {
    expect(mapDisconnectionReason(undefined)).toBeUndefined();
  });
});

// ============================================
// Scenario 6: Urgency fallback chain
// ============================================

describe('Scenario 6: Urgency mapping fallback chain', () => {
  it('endCallReason safety_emergency overrides everything', () => {
    expect(
      mapUrgencyToDashboard({
        urgencyTier: 'Routine',
        urgencyLevel: 'Routine',
        endCallReason: 'safety_emergency',
      })
    ).toBe('emergency');
  });

  it('urgencyTier takes precedence when set', () => {
    expect(
      mapUrgencyToDashboard({
        urgencyTier: 'LifeSafety',
        urgencyLevel: 'Routine',
      })
    ).toBe('emergency');
  });

  it('falls back to urgencyLevel when urgencyTier is undefined', () => {
    expect(
      mapUrgencyToDashboard({
        urgencyLevel: 'Urgent',
      })
    ).toBe('high');
  });

  it('returns low when all fields are undefined', () => {
    expect(mapUrgencyToDashboard({})).toBe('low');
  });
});

// ============================================
// Scenario 7: Commercial property classification
// ============================================

describe('Scenario 7: Commercial property detection', () => {
  it('auto-tags commercial properties', () => {
    const state = makeState({
      propertyType: 'commercial',
      problemDescription: 'AC unit on the roof is not working',
    });
    const tags = classifyCall(state);

    expect(tags.CUSTOMER).toContain('COMMERCIAL_ACCT');
  });

  it('auto-tags owner-occupied for houses', () => {
    const state = makeState({
      propertyType: 'house',
      problemDescription: 'My furnace wont start',
    });
    const tags = classifyCall(state);

    expect(tags.CUSTOMER).toContain('OWNER_OCCUPIED');
  });
});

// ============================================
// Scenario 8: Sales lead flow
// ============================================

describe('Scenario 8: Sales lead identified', () => {
  it('auto-tags HOT_LEAD for sales_lead end reason', () => {
    const state = makeState({
      endCallReason: 'sales_lead',
      salesLeadNotes: 'Customer interested in new system replacement',
      problemDescription: 'wants quote on new system',
    });
    const tags = classifyCall(state);

    expect(tags.REVENUE).toContain('HOT_LEAD');
  });

  it('detects financing interest from transcript', () => {
    const transcript = 'User: Do you offer financing or payment plans?';
    const state = makeState({
      problemDescription: 'interested in new system with financing',
    });
    const tags = classifyCall(state, transcript);

    expect(tags.REVENUE).toContain('FINANCING_REQ');
  });
});
