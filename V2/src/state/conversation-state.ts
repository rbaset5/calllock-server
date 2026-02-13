import type { ConversationState } from '../types/retell.js';

/**
 * Increment the visit counter for a given state/tool.
 * Used to detect infinite loops in the voice agent state machine.
 */
export function incrementStateVisit(state: ConversationState, stateName: string): void {
  if (!state.stateVisitCounter) {
    state.stateVisitCounter = {};
  }
  state.stateVisitCounter[stateName] = (state.stateVisitCounter[stateName] || 0) + 1;
}

/**
 * Check if a state has been visited more times than the threshold.
 * Returns true if the agent appears to be stuck in a loop.
 */
export function isStateLooping(
  state: ConversationState,
  stateName: string,
  threshold: number = 3
): boolean {
  return (state.stateVisitCounter?.[stateName] || 0) > threshold;
}
