/**
 * Call Quality Scorecard — Level 1 Instrumentation
 *
 * Evaluates post-call data completeness to surface extraction gaps.
 * Each field contributes a weighted score (0-100 total).
 * Warnings flag actionable issues (zero tags, callback gaps).
 */

import type { ConversationState } from "../types/retell.js";
import type { TaxonomyTags } from "../classification/tags.js";

export interface CallScorecardFields {
  hasCustomerName: boolean;
  hasCustomerPhone: boolean;
  hasServiceAddress: boolean;
  hasProblemDescription: boolean;
  hasUrgency: boolean;
  hasBookingOrCallback: boolean;
  tagCount: number;
}

export type ScorecardWarning = "zero-tags" | "callback-gap";

export interface CallScorecard {
  callId: string;
  score: number;
  fields: CallScorecardFields;
  warnings: ScorecardWarning[];
}

/** Weight each field contributes to the 0-100 score */
const WEIGHTS = {
  customerName: 15,
  customerPhone: 15,
  serviceAddress: 15,
  problemDescription: 15,
  urgency: 10,
  bookingOrCallback: 20,
  tags: 10,
} as const;

/**
 * Build a quality scorecard for a completed call.
 * Scores data completeness and flags extraction/workflow gaps.
 */
export function buildCallScorecard(
  state: ConversationState,
  tags: TaxonomyTags,
): CallScorecard {
  const tagCount = Object.values(tags).flat().length;

  const fields: CallScorecardFields = {
    hasCustomerName: Boolean(state.customerName),
    hasCustomerPhone: Boolean(state.customerPhone),
    hasServiceAddress: Boolean(state.serviceAddress),
    hasProblemDescription: Boolean(state.problemDescription),
    hasUrgency: Boolean(state.urgency || state.urgencyTier),
    hasBookingOrCallback: state.appointmentBooked || isCallbackCreated(state),
    tagCount,
  };

  let score = 0;
  if (fields.hasCustomerName) score += WEIGHTS.customerName;
  if (fields.hasCustomerPhone) score += WEIGHTS.customerPhone;
  if (fields.hasServiceAddress) score += WEIGHTS.serviceAddress;
  if (fields.hasProblemDescription) score += WEIGHTS.problemDescription;
  if (fields.hasUrgency) score += WEIGHTS.urgency;
  if (fields.hasBookingOrCallback) score += WEIGHTS.bookingOrCallback;
  if (tagCount > 0) score += WEIGHTS.tags;

  const warnings: ScorecardWarning[] = [];

  if (tagCount === 0) {
    warnings.push("zero-tags");
  }

  // Callback gap: call had engagement but no booking AND no callback,
  // excluding non-customer outcomes like wrong_number.
  const nonCustomerReasons: ConversationState["endCallReason"][] = [
    "wrong_number",
    "out_of_area",
  ];
  if (
    !state.appointmentBooked &&
    !isCallbackCreated(state) &&
    !nonCustomerReasons.includes(state.endCallReason)
  ) {
    warnings.push("callback-gap");
  }

  return { callId: state.callId, score, fields, warnings };
}

function isCallbackCreated(state: ConversationState): boolean {
  return state.endCallReason === "callback_later" && Boolean(state.callbackType);
}
