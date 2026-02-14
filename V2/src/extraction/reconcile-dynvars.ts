import { ConversationState } from "../types/retell.js";

/**
 * Merge Retell's collected_dynamic_variables into conversation state.
 * Called post-call to fill gaps where the session was saved before
 * state transitions enriched it.
 */
export function reconcileDynamicVariables(
  state: ConversationState,
  dynVars: Record<string, string> | undefined
): void {
  if (!dynVars) return;

  if (!state.customerName && dynVars.customer_name) {
    state.customerName = dynVars.customer_name;
  }

  if (!state.problemDescription) {
    state.problemDescription = dynVars.problem_description || dynVars.problem_summary;
  }

  if (!state.appointmentBooked) {
    if (dynVars.has_appointment === "true" || dynVars.booking_confirmed === "true") {
      state.appointmentBooked = true;
    }
  }

  if (dynVars.caller_known === "true") {
    state.callerKnown = true;
  }

  if (!state.serviceAddress && dynVars.service_address) {
    state.serviceAddress = dynVars.service_address;
  }

  if (dynVars.zip_code && state.serviceAddress && !state.serviceAddress.includes(dynVars.zip_code)) {
    state.serviceAddress = `${state.serviceAddress}, ${dynVars.zip_code}`;
  }

  if (!state.lastAgentState && dynVars.current_agent_state) {
    state.lastAgentState = dynVars.current_agent_state;
  }
}
