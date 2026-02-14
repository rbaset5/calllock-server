import { describe, it, expect } from 'vitest';
import { reconcileDynamicVariables } from '../../extraction/reconcile-dynvars.js';
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

describe('reconcileDynamicVariables', () => {
  it('fills customerName from dynVars when state is empty', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { customer_name: 'Jonas' });
    expect(state.customerName).toBe('Jonas');
  });

  it('does NOT overwrite existing customerName', () => {
    const state = makeState({ customerName: 'Existing' });
    reconcileDynamicVariables(state, { customer_name: 'Jonas' });
    expect(state.customerName).toBe('Existing');
  });

  it('fills problemDescription from problem_summary', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { problem_summary: 'Thermostat cover broken' });
    expect(state.problemDescription).toBe('Thermostat cover broken');
  });

  it('prefers problem_description over problem_summary', () => {
    const state = makeState();
    reconcileDynamicVariables(state, {
      problem_description: 'Detailed description here',
      problem_summary: 'Short summary',
    });
    expect(state.problemDescription).toBe('Detailed description here');
  });

  it('sets appointmentBooked from has_appointment', () => {
    const state = makeState({ appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('sets appointmentBooked from booking_confirmed', () => {
    const state = makeState({ appointmentBooked: false });
    reconcileDynamicVariables(state, { booking_confirmed: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('does NOT unset appointmentBooked if already true', () => {
    const state = makeState({ appointmentBooked: true });
    reconcileDynamicVariables(state, { has_appointment: 'false' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('does NOT set appointmentBooked from has_appointment when bookingAttempted is true', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(false);
  });

  it('sets appointmentBooked from booking_confirmed even when bookingAttempted is true', () => {
    const state = makeState({ bookingAttempted: true, appointmentBooked: false });
    reconcileDynamicVariables(state, { booking_confirmed: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('sets appointmentBooked from has_appointment when bookingAttempted is false', () => {
    const state = makeState({ bookingAttempted: false, appointmentBooked: false });
    reconcileDynamicVariables(state, { has_appointment: 'true' });
    expect(state.appointmentBooked).toBe(true);
  });

  it('sets callerKnown from caller_known', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { caller_known: 'true' });
    expect(state.callerKnown).toBe(true);
  });

  it('fills serviceAddress from dynVars', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { service_address: '123 Main St' });
    expect(state.serviceAddress).toBe('123 Main St');
  });

  it('appends zip_code to serviceAddress when not already present', () => {
    const state = makeState({ serviceAddress: '123 Main St' });
    reconcileDynamicVariables(state, { zip_code: '78701' });
    expect(state.serviceAddress).toBe('123 Main St, 78701');
  });

  it('does NOT append zip_code if already in address', () => {
    const state = makeState({ serviceAddress: '123 Main St, 78701' });
    reconcileDynamicVariables(state, { zip_code: '78701' });
    expect(state.serviceAddress).toBe('123 Main St, 78701');
  });

  it('fills lastAgentState from current_agent_state', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { current_agent_state: 'safety' });
    expect(state.lastAgentState).toBe('safety');
  });

  it('is a no-op when dynVars is undefined', () => {
    const state = makeState({ customerName: 'Keep' });
    reconcileDynamicVariables(state, undefined);
    expect(state.customerName).toBe('Keep');
  });

  it('maps urgency_tier "routine" to state.urgency "Routine"', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { urgency_tier: 'routine' });
    expect(state.urgency).toBe('Routine');
  });

  it('maps urgency_tier "emergency" to state.urgency "Emergency"', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { urgency_tier: 'emergency' });
    expect(state.urgency).toBe('Emergency');
  });

  it('maps urgency_tier "same_day" to state.urgency "Urgent"', () => {
    const state = makeState();
    reconcileDynamicVariables(state, { urgency_tier: 'same_day' });
    expect(state.urgency).toBe('Urgent');
  });

  it('does NOT overwrite existing urgency', () => {
    const state = makeState({ urgency: 'Emergency' });
    reconcileDynamicVariables(state, { urgency_tier: 'routine' });
    expect(state.urgency).toBe('Emergency');
  });
});
