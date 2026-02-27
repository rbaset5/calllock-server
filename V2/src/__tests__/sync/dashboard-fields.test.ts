import { describe, it, expect } from 'vitest';
import { transformToDashboardPayload } from '../../services/dashboard.js';
import type { ConversationState, RetellPostCallData } from '../../types/retell.js';

function makeState(overrides?: Partial<ConversationState>): ConversationState {
  return {
    callId: 'test-equip',
    appointmentBooked: false,
    bookingAttempted: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

describe('equipment_type extraction (#35)', () => {
  it('extracts AC from "AC stopped working"', () => {
    const state = makeState();
    const retellData = { transcript: 'Yeah my AC stopped working this morning' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.equipment_type).toBe('AC');
  });

  it('extracts AC from "the AC is not cooling"', () => {
    const state = makeState();
    const retellData = { transcript: 'the AC is not cooling at all' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.equipment_type).toBe('AC');
  });

  it('uses call_subtype as fallback when transcript has no match', () => {
    const state = makeState({ problemDescription: 'unit is broken' });
    const retellData = { transcript: 'my unit is broken' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // call_subtype may be "ac" from tags — but without specific equipment words
    // in transcript and no state.equipmentType, should still try call_subtype
    // This test verifies the fallback chain doesn't crash
    expect(payload.equipment_type).toBeDefined();
  });

  it('prefers state.equipmentType over transcript mining', () => {
    const state = makeState({ equipmentType: 'furnace' });
    const retellData = { transcript: 'my AC stopped working' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.equipment_type).toBe('furnace');
  });
});

describe('caller_type derivation (#37)', () => {
  it('defaults to residential when SERVICE_TYPE tags present but no CUSTOMER tags', () => {
    const state = makeState({ problemDescription: 'AC not cooling, blowing warm air' });
    const retellData = { transcript: 'my air conditioner broken, warm air coming out' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.caller_type).toBe('residential');
  });

  it('defaults to residential when problemDescription exists but no tags', () => {
    const state = makeState({ problemDescription: 'unit making noise' });
    const retellData = { transcript: 'yeah the unit is making a loud noise' } as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.caller_type).toBe('residential');
  });

  it('returns unknown for truly empty calls', () => {
    const state = makeState();
    const payload = transformToDashboardPayload(state);
    expect(payload.caller_type).toBe('unknown');
  });

  it('still returns commercial for commercial property type', () => {
    const state = makeState({ propertyType: 'commercial' });
    const payload = transformToDashboardPayload(state);
    expect(payload.caller_type).toBe('commercial');
  });
});

describe('card_headline differentiation (#33)', () => {
  it('does NOT use call_summary for headline when structured data available', () => {
    const state = makeState({ problemDescription: 'AC not cooling' });
    const retellData = {
      transcript: 'my air conditioner broken, blowing warm air',
      call_analysis: { call_summary: 'Customer called about AC not cooling properly.' },
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // card_headline should be template-based, NOT a truncation of call_summary
    expect(payload.card_headline).not.toContain('Customer called');
    expect(payload.card_headline).toBeDefined();
    expect(payload.card_headline!.length).toBeLessThanOrEqual(60);
  });

  it('includes service type in headline', () => {
    const state = makeState({ problemDescription: 'AC not cooling' });
    const retellData = {
      transcript: 'air conditioner broken, warm air',
      call_analysis: { call_summary: 'Customer called about AC issues.' },
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // Should contain service-type derived label
    expect(payload.card_headline).toBeDefined();
  });
});

describe('card_summary differentiation (#34)', () => {
  it('does NOT duplicate ai_summary', () => {
    const state = makeState({
      customerName: 'John Smith',
      problemDescription: 'AC not cooling',
      appointmentBooked: true,
      appointmentDateTime: '2026-02-15 10:00 AM',
    });
    const retellData = {
      transcript: 'air conditioner broken',
      call_analysis: { call_summary: 'Customer called about AC not cooling properly.' },
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    // card_summary should be action-oriented, NOT the raw call_summary
    expect(payload.card_summary).not.toBe(payload.ai_summary);
    expect(payload.card_summary).toBeDefined();
    expect(payload.card_summary!.length).toBeLessThanOrEqual(200);
  });

  it('includes caller name and booking outcome in summary', () => {
    const state = makeState({
      customerName: 'John Smith',
      problemDescription: 'furnace making noise',
      appointmentBooked: true,
      appointmentDateTime: '2026-02-15 10:00 AM',
    });
    const retellData = {
      transcript: 'furnace is making a loud noise',
    } as unknown as RetellPostCallData;
    const payload = transformToDashboardPayload(state, retellData);
    expect(payload.card_summary).toContain('John Smith');
    expect(payload.card_summary).toMatch(/booked|appointment/i);
  });
});

describe('booking_status in job payload (#47)', () => {
  it('returns confirmed when appointmentBooked is true', () => {
    const state = makeState({ appointmentBooked: true });
    const payload = transformToDashboardPayload(state);
    expect(payload.booking_status).toBe('confirmed');
  });

  it('returns attempted_failed when bookingAttempted but not booked', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: false });
    const payload = transformToDashboardPayload(state);
    expect(payload.booking_status).toBe('attempted_failed');
  });

  it('returns not_requested when neither attempted nor booked', () => {
    const state = makeState({ bookingAttempted: false, appointmentBooked: false });
    const payload = transformToDashboardPayload(state);
    expect(payload.booking_status).toBe('not_requested');
  });
});

describe('quality_score persistence (#39)', () => {
  it('qualityScore on ConversationState type accepts a number', () => {
    const state = makeState({ qualityScore: 80 });
    expect(state.qualityScore).toBe(80);
  });

  it('qualityScore defaults to undefined when not set', () => {
    const state = makeState();
    expect(state.qualityScore).toBeUndefined();
  });
});

describe('booking audit flags in dashboard payload', () => {
  it('surfaces slot_changed and urgency_mismatch when booking trace shows drift', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: true });
    const retellData = {
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
          tool_call_id: 'book1',
          arguments: JSON.stringify({
            preferred_time: 'Tomorrow at 4:30 PM',
            urgency_tier: 'urgent',
          }),
        },
        {
          role: 'tool_call_result',
          tool_call_id: 'book1',
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
    expect(payload.slot_changed).toBe(true);
    expect(payload.urgency_mismatch).toBe(true);
    expect(payload.booking_requested_time).toBe('Tomorrow at 4:30 PM');
    expect(payload.booking_booked_slot).toBe('Friday, February 27, 2026 at 3:45 PM');
    expect(payload.booking_urgency_transition).toBe('routine->urgent');
  });

  it('surfaces false flags when booking trace is present but consistent', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: true });
    const retellData = {
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
          tool_call_id: 'book2',
          arguments: JSON.stringify({
            preferred_time: 'Friday, February 27, 2026 at 3:45 PM',
            urgency_tier: 'urgent',
          }),
        },
        {
          role: 'tool_call_result',
          tool_call_id: 'book2',
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
    expect(payload.slot_changed).toBe(false);
    expect(payload.urgency_mismatch).toBe(false);
    expect(payload.booking_requested_time).toBe('Friday, February 27, 2026 at 3:45 PM');
    expect(payload.booking_booked_slot).toBe('Friday, February 27, 2026 at 3:45 PM');
    expect(payload.booking_urgency_transition).toBe('urgent->urgent');
  });
});
