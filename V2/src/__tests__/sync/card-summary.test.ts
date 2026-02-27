import { describe, it, expect } from 'vitest';
import { transformToDashboardPayload } from '../../services/dashboard.js';
import type { ConversationState, RetellPostCallData } from '../../types/retell.js';

function makeState(overrides?: Partial<ConversationState>): ConversationState {
  return {
    callId: 'test-card',
    appointmentBooked: false,
    bookingAttempted: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('card_summary booking wording', () => {
  it('says "Booking failed" when bookingAttempted but not booked', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC unit issue',
      bookingAttempted: true,
      appointmentBooked: false,
      endCallReason: 'callback_later',
    });
    const retellData = { transcript: 'AC unit issue' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('Booking failed');
    expect(payload.card_summary).not.toContain('Appointment booked');
  });

  it('says "Appointment booked" when actually booked', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC unit issue',
      bookingAttempted: true,
      appointmentBooked: true,
    });
    const retellData = { transcript: 'AC unit issue' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toMatch(/[Aa]ppointment booked/);
  });

  it('says "Has existing appointment" when appointmentBooked but no booking attempted', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC issue, dead rat in vent',
      appointmentBooked: true,
      bookingAttempted: false,
      endCallReason: 'callback_later',
    });
    const retellData = { transcript: 'dead rat in air vent' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('Has existing appointment');
    expect(payload.card_summary).not.toContain('Appointment booked');
  });

  it('says "Appointment booked for {dateTime}" only when bookingAttempted', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC repair',
      appointmentBooked: true,
      bookingAttempted: true,
      appointmentDateTime: '2026-02-19 3:45 PM',
    });
    const retellData = { transcript: 'AC repair' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('Appointment booked for 2026-02-19 3:45 PM');
  });

  it('says "Callback requested" for callback_later without booking attempt', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'question about billing',
      endCallReason: 'callback_later',
    });
    const retellData = { transcript: 'billing question' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('Callback requested');
    expect(payload.card_summary).not.toContain('Booking failed');
  });
});

describe('card_summary booking audit annotations', () => {
  it('adds alternate-slot review note when booked slot differs from requested slot', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC repair',
      bookingAttempted: true,
      appointmentBooked: true,
      appointmentDateTime: 'Friday, February 27, 2026 at 3:45 PM',
    });
    const retellData = {
      transcript: 'AC repair',
      transcript_with_tool_calls: [
        {
          role: 'tool_call_invocation',
          name: 'transition_to_booking',
          arguments: JSON.stringify({
            preferred_time: 'Tomorrow at 4:30 PM',
            urgency_tier: 'routine',
          }),
        },
        {
          role: 'tool_call_invocation',
          name: 'book_service',
          tool_call_id: 'book3',
          arguments: JSON.stringify({
            preferred_time: 'Tomorrow at 4:30 PM',
            urgency_tier: 'routine',
          }),
        },
        {
          role: 'tool_call_result',
          tool_call_id: 'book3',
          successful: true,
          content: JSON.stringify({
            booked: true,
            appointment_date: 'Friday, February 27, 2026',
            appointment_time: '3:45 PM',
          }),
        },
      ],
    } as unknown as RetellPostCallData;

    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('Review booking: requested Tomorrow at 4:30 PM; booked Friday, February 27, 2026 at 3:45 PM.');
  });

  it('adds urgency-drift review note when booking urgency changes', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC repair',
      bookingAttempted: true,
      appointmentBooked: true,
    });
    const retellData = {
      transcript: 'AC repair',
      transcript_with_tool_calls: [
        {
          role: 'tool_call_invocation',
          name: 'transition_to_booking',
          arguments: JSON.stringify({
            preferred_time: 'Friday, February 27, 2026 at 3:45 PM',
            urgency_tier: 'routine',
          }),
        },
        {
          role: 'tool_call_invocation',
          name: 'book_service',
          tool_call_id: 'book4',
          arguments: JSON.stringify({
            preferred_time: 'Friday, February 27, 2026 at 3:45 PM',
            urgency_tier: 'urgent',
          }),
        },
        {
          role: 'tool_call_result',
          tool_call_id: 'book4',
          successful: true,
          content: JSON.stringify({
            booking_confirmed: true,
            appointment_date: 'Friday, February 27, 2026',
            appointment_time: '3:45 PM',
          }),
        },
      ],
    } as unknown as RetellPostCallData;

    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('Review booking: urgency routine->urgent.');
  });

  it('does not add review note when booking trace is present and consistent', () => {
    const state = makeState({
      customerName: 'Jonas',
      problemDescription: 'AC repair',
      bookingAttempted: true,
      appointmentBooked: true,
    });
    const retellData = {
      transcript: 'AC repair',
      transcript_with_tool_calls: [
        {
          role: 'tool_call_invocation',
          name: 'transition_to_booking',
          arguments: JSON.stringify({
            preferred_time: 'Friday, February 27, 2026 at 3:45 PM',
            urgency_tier: 'urgent',
          }),
        },
        {
          role: 'tool_call_invocation',
          name: 'book_service',
          tool_call_id: 'book5',
          arguments: JSON.stringify({
            preferred_time: 'Friday, February 27, 2026 at 3:45 PM',
            urgency_tier: 'urgent',
          }),
        },
        {
          role: 'tool_call_result',
          tool_call_id: 'book5',
          successful: true,
          content: JSON.stringify({
            booked: true,
            appointment_date: 'Friday, February 27, 2026',
            appointment_time: '3:45 PM',
          }),
        },
      ],
    } as unknown as RetellPostCallData;

    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).not.toContain('Review booking:');
  });
});
