import { describe, it, expect } from 'vitest';
import { buildCallScorecard } from '../../extraction/call-scorecard.js';
import type { ConversationState } from '../../types/retell.js';
import type { TaxonomyTags } from '../../classification/tags.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    callId: 'test-call-123',
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    ...overrides,
  };
}

function emptyTags(): TaxonomyTags {
  return {
    HAZARD: [],
    URGENCY: [],
    SERVICE_TYPE: [],
    REVENUE: [],
    RECOVERY: [],
    LOGISTICS: [],
    CUSTOMER: [],
    NON_CUSTOMER: [],
    CONTEXT: [],
  };
}

describe('buildCallScorecard', () => {
  it('returns zero score for empty state with no tags', () => {
    const state = makeState();
    const tags = emptyTags();
    const scorecard = buildCallScorecard(state, tags);

    expect(scorecard.callId).toBe('test-call-123');
    expect(scorecard.score).toBe(0);
    expect(scorecard.fields.hasCustomerName).toBe(false);
    expect(scorecard.fields.hasCustomerPhone).toBe(false);
    expect(scorecard.fields.hasServiceAddress).toBe(false);
    expect(scorecard.fields.hasProblemDescription).toBe(false);
    expect(scorecard.fields.hasUrgency).toBe(false);
    expect(scorecard.fields.hasBookingOrCallback).toBe(false);
    expect(scorecard.fields.tagCount).toBe(0);
  });

  it('returns full score for complete state with tags', () => {
    const state = makeState({
      customerName: 'Jonas Smith',
      customerPhone: '+16155551234',
      serviceAddress: '123 Main St',
      problemDescription: 'AC not cooling',
      urgency: 'Urgent',
      appointmentBooked: true,
    });
    const tags: TaxonomyTags = {
      ...emptyTags(),
      SERVICE_TYPE: ['REPAIR_AC'],
      URGENCY: ['EMERGENCY_SAMEDAY'],
      CUSTOMER: ['NEW_CUSTOMER'],
    };
    const scorecard = buildCallScorecard(state, tags);

    expect(scorecard.score).toBe(100);
    expect(scorecard.fields.hasCustomerName).toBe(true);
    expect(scorecard.fields.hasCustomerPhone).toBe(true);
    expect(scorecard.fields.hasServiceAddress).toBe(true);
    expect(scorecard.fields.hasProblemDescription).toBe(true);
    expect(scorecard.fields.hasUrgency).toBe(true);
    expect(scorecard.fields.hasBookingOrCallback).toBe(true);
    expect(scorecard.fields.tagCount).toBe(3);
  });

  it('gives partial score for partial data', () => {
    const state = makeState({
      customerName: 'Sarah',
      customerPhone: '+16155551234',
      problemDescription: 'Heater broken',
    });
    const tags: TaxonomyTags = {
      ...emptyTags(),
      SERVICE_TYPE: ['REPAIR_HEATING'],
    };
    const scorecard = buildCallScorecard(state, tags);

    // name(15) + phone(15) + problem(15) + tags(10) = 55
    expect(scorecard.score).toBeGreaterThan(0);
    expect(scorecard.score).toBeLessThan(100);
    expect(scorecard.fields.hasCustomerName).toBe(true);
    expect(scorecard.fields.hasCustomerPhone).toBe(true);
    expect(scorecard.fields.hasServiceAddress).toBe(false);
    expect(scorecard.fields.hasProblemDescription).toBe(true);
    expect(scorecard.fields.hasUrgency).toBe(false);
    expect(scorecard.fields.hasBookingOrCallback).toBe(false);
    expect(scorecard.fields.tagCount).toBe(1);
  });

  it('counts callback as booking-or-callback', () => {
    const state = makeState({
      endCallReason: 'callback_later',
      callbackType: 'service',
    });
    const scorecard = buildCallScorecard(state, emptyTags());

    expect(scorecard.fields.hasBookingOrCallback).toBe(true);
  });

  it('includes warning for zero tags', () => {
    const state = makeState({ customerName: 'Test' });
    const scorecard = buildCallScorecard(state, emptyTags());

    expect(scorecard.warnings).toContain('zero-tags');
  });

  it('includes warning for callback gap (no booking, no callback, not wrong number)', () => {
    const state = makeState({
      customerPhone: '+16155551234',
      problemDescription: 'AC broken',
      appointmentBooked: false,
    });
    const scorecard = buildCallScorecard(state, emptyTags());

    expect(scorecard.warnings).toContain('callback-gap');
  });

  it('does NOT include callback-gap warning for wrong_number calls', () => {
    const state = makeState({
      endCallReason: 'wrong_number',
      appointmentBooked: false,
    });
    const scorecard = buildCallScorecard(state, emptyTags());

    expect(scorecard.warnings).not.toContain('callback-gap');
  });

  it('does NOT include callback-gap warning when booked', () => {
    const state = makeState({
      appointmentBooked: true,
    });
    const scorecard = buildCallScorecard(state, emptyTags());

    expect(scorecard.warnings).not.toContain('callback-gap');
  });

  it('does NOT include callback-gap warning when callback created', () => {
    const state = makeState({
      endCallReason: 'callback_later',
      callbackType: 'service',
    });
    const scorecard = buildCallScorecard(state, emptyTags());

    expect(scorecard.warnings).not.toContain('callback-gap');
  });

  it('does not include zero-tags warning when tags exist', () => {
    const tags: TaxonomyTags = {
      ...emptyTags(),
      SERVICE_TYPE: ['REPAIR_AC'],
    };
    const scorecard = buildCallScorecard(makeState(), tags);

    expect(scorecard.warnings).not.toContain('zero-tags');
  });
});
