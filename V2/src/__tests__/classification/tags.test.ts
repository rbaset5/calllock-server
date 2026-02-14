import { describe, it, expect } from 'vitest';
import { classifyCall } from '../../classification/tags.js';
import type { ConversationState } from '../../types/retell.js';

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

describe('classifyCall', () => {
  it('detects HAZARD:GAS_LEAK from transcript', () => {
    const state = makeState();
    const tags = classifyCall(state, 'I smell gas in my kitchen, rotten egg smell');
    expect(tags.HAZARD).toContain('GAS_LEAK');
  });

  it('detects HAZARD:CO_EVENT from transcript', () => {
    const state = makeState();
    const tags = classifyCall(state, 'carbon monoxide detector is going off');
    expect(tags.HAZARD).toContain('CO_EVENT');
  });

  it('auto-upgrades urgency for hazards', () => {
    const state = makeState();
    const tags = classifyCall(state, 'there is a gas smell, rotten egg smell');
    expect(tags.URGENCY).toContain('CRITICAL_EVACUATE');
  });

  it('detects SERVICE_TYPE tags', () => {
    const state = makeState();
    const tags = classifyCall(state, 'my air conditioner broken, blowing warm air');
    expect(tags.SERVICE_TYPE.some(t => t.startsWith('REPAIR_'))).toBe(true);
  });

  it('returns empty arrays for empty transcript', () => {
    const state = makeState();
    const tags = classifyCall(state);
    // Context tags may still appear based on date/time, but HAZARD/SERVICE_TYPE should be empty
    expect(tags.HAZARD).toEqual([]);
    expect(tags.SERVICE_TYPE).toEqual([]);
  });

  it('does not return HAZARD tags for routine maintenance', () => {
    const state = makeState();
    const tags = classifyCall(state, 'I need a seasonal tune-up for my AC');
    expect(tags.HAZARD).toEqual([]);
  });

  it('detects REVENUE:HOT_LEAD for sales leads', () => {
    const state = makeState({ endCallReason: 'sales_lead' });
    const tags = classifyCall(state, 'I want a quote on a new system');
    expect(tags.REVENUE).toContain('HOT_LEAD');
  });

  it('detects NON_CUSTOMER:WRONG_NUMBER from endCallReason', () => {
    const state = makeState({ endCallReason: 'wrong_number' });
    const tags = classifyCall(state);
    expect(tags.NON_CUSTOMER).toContain('WRONG_NUMBER');
  });

  it('detects CUSTOMER tags from state properties', () => {
    const state = makeState({ propertyType: 'commercial' });
    const tags = classifyCall(state);
    expect(tags.CUSTOMER).toContain('COMMERCIAL_ACCT');
  });

  it('is negation-aware — "no gas smell" does not match GAS_LEAK', () => {
    const state = makeState();
    const tags = classifyCall(state, 'any gas smell? no gas smell reported');
    // "no" negates "gas smell" within 40 chars
    expect(tags.HAZARD).not.toContain('GAS_LEAK');
  });

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
});
