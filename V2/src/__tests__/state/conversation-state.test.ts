import { describe, it, expect } from 'vitest';
import { incrementStateVisit, isStateLooping } from '../../state/conversation-state.js';
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

describe('bookingAttempted flag', () => {
  it('defaults to false in new state', () => {
    const state = makeState();
    expect(state.bookingAttempted).toBe(false);
  });
});

describe('incrementStateVisit', () => {
  it('initializes counter on first visit', () => {
    const state = makeState();
    incrementStateVisit(state, 'booking');
    expect(state.stateVisitCounter?.booking).toBe(1);
  });

  it('increments on repeated visits', () => {
    const state = makeState({ stateVisitCounter: { booking: 2 } });
    incrementStateVisit(state, 'booking');
    expect(state.stateVisitCounter?.booking).toBe(3);
  });

  it('tracks multiple tools independently', () => {
    const state = makeState();
    incrementStateVisit(state, 'booking');
    incrementStateVisit(state, 'lookup');
    incrementStateVisit(state, 'booking');
    expect(state.stateVisitCounter?.booking).toBe(2);
    expect(state.stateVisitCounter?.lookup).toBe(1);
  });
});

describe('isStateLooping', () => {
  it('returns true when threshold exceeded', () => {
    const state = makeState({ stateVisitCounter: { booking: 4 } });
    expect(isStateLooping(state, 'booking', 3)).toBe(true);
  });

  it('returns false when at threshold', () => {
    const state = makeState({ stateVisitCounter: { booking: 3 } });
    expect(isStateLooping(state, 'booking', 3)).toBe(false);
  });

  it('returns false when under threshold', () => {
    const state = makeState({ stateVisitCounter: { booking: 2 } });
    expect(isStateLooping(state, 'booking', 3)).toBe(false);
  });

  it('returns false when no counter exists', () => {
    const state = makeState();
    expect(isStateLooping(state, 'booking', 3)).toBe(false);
  });

  it('uses default threshold of 3', () => {
    const state = makeState({ stateVisitCounter: { booking: 4 } });
    expect(isStateLooping(state, 'booking')).toBe(true);
  });
});
