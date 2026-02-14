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
