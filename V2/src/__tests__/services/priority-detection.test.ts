import { describe, it, expect } from 'vitest';
import { detectPriority } from '../../services/priority-detection.js';
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

describe('detectPriority', () => {
  describe('RED priority — customer_hangup + sentiment', () => {
    it('returns RED when customer_hangup AND sentiment is Negative', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, 'Negative');
      expect(result.color).toBe('red');
      expect(result.signals).toContain('Customer hung up (potential frustration)');
    });

    it('does NOT return RED when customer_hangup AND sentiment is Positive', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, 'Positive');
      expect(result.color).not.toBe('red');
    });

    it('does NOT return RED when customer_hangup AND sentiment is Neutral', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, 'Neutral');
      expect(result.color).not.toBe('red');
    });

    it('does NOT return RED when customer_hangup AND sentiment is undefined', () => {
      const state = makeState({ endCallReason: 'customer_hangup' });
      const result = detectPriority(state, '', undefined, undefined);
      expect(result.color).not.toBe('red');
    });

    it('still returns RED when transcript has frustrated keywords regardless of sentiment', () => {
      const state = makeState({ endCallReason: 'completed' });
      const result = detectPriority(state, 'I am very angry about this', undefined, 'Positive');
      expect(result.color).toBe('red');
    });
  });
});
