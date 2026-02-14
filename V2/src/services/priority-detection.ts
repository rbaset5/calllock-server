/**
 * Priority Detection Service
 *
 * Analyzes call data to determine lead priority color for V4 dashboard.
 * Priority colors help contractors quickly triage their action queue.
 *
 * Priority Colors:
 * - RED: Callback risk - frustrated customer, previous issues, demanded manager
 * - GREEN: Commercial - property management, business, multi-unit, high value
 * - BLUE: Standard residential lead (default)
 * - GRAY: Spam/vendor - sales calls, solicitations, non-customers
 */

import { ConversationState, EndCallReason, RevenueTier } from "../types/retell.js";
import { RevenueEstimate } from "./revenue-estimation.js";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("priority-detection");

export type PriorityColor = "red" | "green" | "blue" | "gray";

export interface PriorityResult {
  color: PriorityColor;
  reason: string;
  signals: string[];
}

// Keywords that indicate callback risk (frustrated/unhappy customer)
const RED_KEYWORDS = [
  "angry",
  "frustrated",
  "furious",
  "upset",
  "manager",
  "supervisor",
  "refund",
  "complaint",
  "complain",
  "terrible",
  "awful",
  "horrible",
  "lawsuit",
  "lawyer",
  "attorney",
  "bbb",
  "better business bureau",
  "review",
  "yelp",
  "google review",
  "again",
  "third time",
  "second time",
  "still broken",
  "still not working",
  "still waiting",
  "you people",
  "your company",
  "unacceptable",
  "ridiculous",
  "never coming back",
  "worst service",
  "been waiting",
  "no one showed",
  "missed appointment",
  "stood up",
  "lied to",
];

// Keywords that indicate commercial/high-value opportunity
const GREEN_KEYWORDS = [
  "property management",
  "property manager",
  "commercial",
  "business",
  "office",
  "retail",
  "warehouse",
  "restaurant",
  "hotel",
  "motel",
  "apartment complex",
  "apartments",
  "multiple units",
  "multi-unit",
  "building",
  "tenant",
  "tenants",
  "rental",
  "rentals",
  "landlord",
  "hoa",
  "homeowner association",
  "facility",
  "facilities",
  "corporate",
  "company",
  "fleet",
  "contract",
  "ongoing service",
  "maintenance contract",
  "service agreement",
];

// Keywords that indicate spam/vendor/solicitation
const GRAY_KEYWORDS = [
  "selling",
  "sell you",
  "sales",
  "marketing",
  "offer",
  "promotion",
  "special deal",
  "insurance",
  "warranty",
  "extended warranty",
  "duct cleaning",
  "air duct",
  "chimney sweep",
  "solar",
  "siding",
  "windows",
  "roofing",
  "gutters",
  "pest control",
  "lawn care",
  "security system",
  "free estimate",
  "free inspection",
  "vendor",
  "supplier",
  "partnership",
  "advertise",
  "advertising",
  "google listing",
  "business listing",
];

/**
 * Check if any keywords from a list are present in the text
 */
function containsKeywords(text: string, keywords: string[]): string[] {
  const normalizedText = text.toLowerCase();
  return keywords.filter((keyword) => normalizedText.includes(keyword));
}

/**
 * Detect priority color from conversation state and analysis
 */
export function detectPriority(
  state: ConversationState,
  transcript?: string,
  estimate?: RevenueEstimate,
  userSentiment?: string
): PriorityResult {
  const signals: string[] = [];

  // Combine all available text for keyword analysis
  const analysisText = [
    transcript || "",
    state.problemDescription || "",
    state.salesLeadNotes || "",
  ]
    .join(" ")
    .toLowerCase();

  // ============================================
  // RED: Callback Risk Detection
  // ============================================

  // Check end call reason — only flag as frustration if sentiment is Negative
  if (state.endCallReason === "customer_hangup" && userSentiment === "Negative") {
    signals.push("Customer hung up (potential frustration)");
  }

  // Check for frustrated keywords in transcript
  const redMatches = containsKeywords(analysisText, RED_KEYWORDS);
  if (redMatches.length > 0) {
    signals.push(`Mentioned: ${redMatches.slice(0, 3).join(", ")}`);
  }

  // If we have enough red signals, mark as callback risk
  if (signals.length >= 1 && (redMatches.length > 0 || state.endCallReason === "customer_hangup")) {
    log.info(
      { callId: state.callId, signals },
      "Detected RED priority - callback risk"
    );
    return {
      color: "red",
      reason: signals[0],
      signals,
    };
  }

  // ============================================
  // GRAY: Spam/Vendor Detection
  // ============================================

  const grayMatches = containsKeywords(analysisText, GRAY_KEYWORDS);
  if (grayMatches.length >= 2) {
    const reason = `Likely vendor/spam: ${grayMatches.slice(0, 2).join(", ")}`;
    log.info({ callId: state.callId, matches: grayMatches }, "Detected GRAY priority - spam/vendor");
    return {
      color: "gray",
      reason,
      signals: grayMatches,
    };
  }

  // Check if problem description indicates non-service call
  if (
    state.problemDescription &&
    (state.problemDescription.toLowerCase().includes("selling") ||
      state.problemDescription.toLowerCase().includes("offer"))
  ) {
    return {
      color: "gray",
      reason: "Appears to be sales/solicitation call",
      signals: ["selling/offer in description"],
    };
  }

  // ============================================
  // GREEN: Commercial/High-Value Detection
  // ============================================

  const greenMatches = containsKeywords(analysisText, GREEN_KEYWORDS);
  const commercialSignals: string[] = [];

  if (greenMatches.length > 0) {
    commercialSignals.push(`Commercial keywords: ${greenMatches.slice(0, 2).join(", ")}`);
  }

  // Check revenue tier for high-value indicator
  if (estimate) {
    if (estimate.tier === "replacement" || estimate.potentialReplacement) {
      commercialSignals.push("Potential replacement ($5,000+)");
    } else if (estimate.tier === "major_repair") {
      commercialSignals.push("Major repair opportunity");
    }
  }

  // Check if revenue estimate is high
  if (estimate?.tier === "replacement" || estimate?.tier === "major_repair") {
    commercialSignals.push(`Revenue tier: ${estimate.tierLabel}`);
  }

  // Check for sales lead (replacement inquiry)
  if (state.endCallReason === "sales_lead") {
    commercialSignals.push("Sales lead - replacement inquiry");
  }

  // If we have commercial indicators, mark as green
  if (commercialSignals.length > 0 || greenMatches.length > 0) {
    const reason = commercialSignals[0] || `Commercial: ${greenMatches[0]}`;
    log.info(
      { callId: state.callId, signals: commercialSignals },
      "Detected GREEN priority - commercial/high-value"
    );
    return {
      color: "green",
      reason,
      signals: [...commercialSignals, ...greenMatches],
    };
  }

  // ============================================
  // BLUE: Standard Residential (Default)
  // ============================================

  log.debug({ callId: state.callId }, "Default BLUE priority - standard residential");
  return {
    color: "blue",
    reason: "Standard residential service request",
    signals: [],
  };
}

/**
 * Get notification tier based on priority color
 * Used to determine SMS delivery urgency
 */
export function getPriorityNotificationTier(
  color: PriorityColor
): "urgent" | "standard" {
  switch (color) {
    case "red":
    case "green":
      return "urgent";
    case "blue":
    case "gray":
    default:
      return "standard";
  }
}

/**
 * Get human-readable priority label
 */
export function getPriorityLabel(color: PriorityColor): string {
  switch (color) {
    case "red":
      return "CALLBACK RISK";
    case "green":
      return "COMMERCIAL $$$";
    case "blue":
      return "NEW LEAD";
    case "gray":
      return "SPAM/VENDOR";
    default:
      return "UNKNOWN";
  }
}
