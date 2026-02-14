import { ConversationState } from "../types/retell.js";

/**
 * Determine if a call is a "ghost lead" (abandoned with partial data).
 * Returns false for returning customers with existing appointments.
 */
export function isGhostLead(
  disconnectionReason: string | undefined,
  state: ConversationState,
  callDuration: number
): boolean {
  if (disconnectionReason !== "user_hangup") return false;
  if (state.appointmentBooked) return false;
  if (state.callerKnown) return false;
  if (callDuration <= 10) return false;
  return true;
}
