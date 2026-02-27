import { describe, it, expect } from 'vitest';
import { reconcileDynamicVariables } from '../../extraction/reconcile-dynvars.js';
import { analyzeBookingToolTrace, parseBookingToolResultContent } from '../../extraction/booking-tool-result.js';
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

describe('parseBookingToolResultContent', () => {
  it('parses legacy booked=true shape', () => {
    const parsed = parseBookingToolResultContent(
      JSON.stringify({
        booked: true,
        appointment_date: 'Friday, February 27',
        appointment_time: '3:45 PM',
      })
    );

    expect(parsed).toEqual({
      booked: true,
      appointmentDateTime: 'Friday, February 27 at 3:45 PM',
    });
  });

  it('parses booking_confirmed=true alias shape', () => {
    const parsed = parseBookingToolResultContent(
      JSON.stringify({
        success: true,
        booking_confirmed: true,
        appointment_time: 'Friday, February 27 at 3:45 PM',
      })
    );

    expect(parsed).toEqual({
      booked: true,
      appointmentDateTime: 'Friday, February 27 at 3:45 PM',
    });
  });

  it('returns null for failed booking result', () => {
    const parsed = parseBookingToolResultContent(
      JSON.stringify({ success: true, booked: false })
    );

    expect(parsed).toBeNull();
  });
});

describe('analyzeBookingToolTrace', () => {
  it('detects urgency mismatch and slot change from transcript tool calls', () => {
    const entries = [
      {
        role: 'tool_call_invocation',
        tool_call_id: 't1',
        name: 'transition_to_booking',
        arguments: JSON.stringify({
          preferred_time: 'Tomorrow at 4:30 PM',
          urgency_tier: 'routine',
        }),
      },
      {
        role: 'tool_call_invocation',
        tool_call_id: 't2',
        name: 'book_service',
        arguments: JSON.stringify({
          preferred_time: 'Tomorrow at 4:30 PM',
          urgency_tier: 'urgent',
        }),
      },
      {
        role: 'tool_call_result',
        tool_call_id: 't2',
        successful: true,
        content: JSON.stringify({
          booked: true,
          appointment_date: 'Friday, February 27',
          appointment_time: '3:45 PM',
        }),
      },
    ];

    const audit = analyzeBookingToolTrace(entries);
    expect(audit.urgencyMismatch).toBe(true);
    expect(audit.slotChanged).toBe(true);
    expect(audit.requestedTime).toBe('Tomorrow at 4:30 PM');
    expect(audit.bookedSlot).toBe('Friday, February 27 at 3:45 PM');
  });

  it('does not flag mismatch when urgencies match and no booking result exists', () => {
    const entries = [
      {
        role: 'tool_call_invocation',
        name: 'transition_to_booking',
        arguments: JSON.stringify({ preferred_time: 'Soonest available', urgency_tier: 'urgent' }),
      },
      {
        role: 'tool_call_invocation',
        name: 'book_service',
        arguments: JSON.stringify({ preferred_time: 'Soonest available', urgency_tier: 'urgent' }),
      },
    ];

    const audit = analyzeBookingToolTrace(entries);
    expect(audit.urgencyMismatch).toBe(false);
    expect(audit.slotChanged).toBe(false);
    expect(audit.requestedTime).toBe('Soonest available');
    expect(audit.bookedSlot).toBeUndefined();
  });

  it('supports booking_confirmed alias result shape', () => {
    const entries = [
      {
        role: 'tool_call_invocation',
        tool_call_id: 'b1',
        name: 'book_service',
        arguments: JSON.stringify({ preferred_time: 'Tomorrow', urgency_tier: 'routine' }),
      },
      {
        role: 'tool_call_result',
        tool_call_id: 'b1',
        successful: true,
        content: JSON.stringify({ booking_confirmed: true, appointment_time: 'Friday at 3:45 PM' }),
      },
    ];

    const audit = analyzeBookingToolTrace(entries);
    expect(audit.bookedSlot).toBe('Friday at 3:45 PM');
    expect(audit.slotChanged).toBe(true);
  });
});
