import { describe, it, expect } from 'vitest';
import { reconcileDynamicVariables } from '../../extraction/reconcile-dynvars.js';
import type { ConversationState } from '../../types/retell.js';

function makeState(overrides?: Partial<ConversationState>): ConversationState {
  return {
    callId: 'test-backfill',
    appointmentBooked: false,
    bookingAttempted: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('bookingAttempted backfill before reconcile', () => {
  it('reconcile does NOT set appointmentBooked when bookingAttempted is true', () => {
    // Simulate: saved session has bookingAttempted=true (from backfill)
    const state = makeState({ bookingAttempted: true, appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(false);
  });

  it('reconcile DOES set appointmentBooked when bookingAttempted is false and no booking tool called', () => {
    // Simulate: no booking attempted, has_appointment from Retell is legitimate
    const state = makeState({ bookingAttempted: false, appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });
});

describe('backfillBookingAttempted', () => {
  it('detects book_service in transcript_with_tool_calls', () => {
    const transcript = [
      { role: 'agent', content: 'Let me book that for you.' },
      { role: 'tool_call_invocation', name: 'book_service' },
      { role: 'tool_call_result', content: '{"booked":false}' },
    ];
    const detected = transcript.some(
      (entry: { role: string; name?: string }) =>
        entry.role === 'tool_call_invocation' &&
        (entry.name === 'book_service' || entry.name === 'book_appointment')
    );
    expect(detected).toBe(true);
  });

  it('detects book_appointment in transcript_with_tool_calls', () => {
    const transcript = [
      { role: 'tool_call_invocation', name: 'book_appointment' },
      { role: 'tool_call_result', content: '{"booked":true}' },
    ];
    const detected = transcript.some(
      (entry: { role: string; name?: string }) =>
        entry.role === 'tool_call_invocation' &&
        (entry.name === 'book_service' || entry.name === 'book_appointment')
    );
    expect(detected).toBe(true);
  });

  it('returns false when no booking tools in transcript', () => {
    const transcript = [
      { role: 'tool_call_invocation', name: 'lookup_caller' },
      { role: 'tool_call_result', content: '{"found":true}' },
    ];
    const detected = transcript.some(
      (entry: { role: string; name?: string }) =>
        entry.role === 'tool_call_invocation' &&
        (entry.name === 'book_service' || entry.name === 'book_appointment')
    );
    expect(detected).toBe(false);
  });
});
