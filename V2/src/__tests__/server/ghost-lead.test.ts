import { describe, it, expect } from 'vitest';
import { isGhostLead } from '../../extraction/ghost-lead.js';
import { ConversationState } from '../../types/retell.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'test-call-1',
    appointmentBooked: false,
    bookingAttempted: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('isGhostLead', () => {
  it('returns true for user_hangup without booking or caller history', () => {
    const state = makeState();
    expect(isGhostLead('user_hangup', state, 30)).toBe(true);
  });

  it('returns false when appointmentBooked is true', () => {
    const state = makeState({ appointmentBooked: true });
    expect(isGhostLead('user_hangup', state, 30)).toBe(false);
  });

  it('returns false when callerKnown is true', () => {
    const state = makeState({ callerKnown: true });
    expect(isGhostLead('user_hangup', state, 30)).toBe(false);
  });

  it('returns false for agent_hangup', () => {
    const state = makeState();
    expect(isGhostLead('agent_hangup', state, 30)).toBe(false);
  });

  it('returns false for very short calls (<= 10s)', () => {
    const state = makeState();
    expect(isGhostLead('user_hangup', state, 5)).toBe(false);
  });
});
