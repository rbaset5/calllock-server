/**
 * Revenue Tier Classification Service
 *
 * Classifies jobs into revenue tiers based on high-signal keywords rather than
 * trying to calculate exact dollar amounts. This approach is more reliable because:
 * 1. Dispatchers care about Repair vs Replacement, not $450 vs $475
 * 2. "$$$$ - Replacement" manages expectations better than "$12,400"
 * 3. Signal priority ensures "20 years old" overrides "weird noise"
 */

import { ConversationState, RevenueTier } from "../types/retell.js";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("revenue-estimation");

// ============================================
// Types
// ============================================

export interface RevenueEstimate {
  tier: RevenueTier;
  tierLabel: string;        // "$$$$", "$$$", "$$", "$", "$$?"
  tierDescription: string;  // "Potential Replacement", "Major Repair", etc.
  estimatedRange: string;   // "$5,000-$15,000+"
  confidence: "low" | "medium" | "high";
  signals: string[];        // What triggered this tier
  potentialReplacement: boolean;
}

interface TierConfig {
  tier: RevenueTier;
  label: string;
  description: string;
  range: string;
}

// ============================================
// Tier Configuration
// ============================================

const TIER_CONFIG: Record<RevenueTier, TierConfig> = {
  replacement: {
    tier: "replacement",
    label: "$$$$",
    description: "Potential Replacement",
    range: "$5,000-$15,000+",
  },
  major_repair: {
    tier: "major_repair",
    label: "$$$",
    description: "Major Repair",
    range: "$800-$3,000",
  },
  standard_repair: {
    tier: "standard_repair",
    label: "$$",
    description: "Standard Repair",
    range: "$200-$800",
  },
  minor: {
    tier: "minor",
    label: "$",
    description: "Maintenance/Minor",
    range: "$75-$250",
  },
  diagnostic: {
    tier: "diagnostic",
    label: "$$?",
    description: "Diagnostic Needed",
    range: "$99 Diagnostic",
  },
};

// ============================================
// Signal Keywords (ordered by priority)
// ============================================

// Replacement signals - CHECK FIRST (highest value)
const REPLACEMENT_REFRIGERANT = ["r-22", "r22", "freon", "old refrigerant"];
const REPLACEMENT_INTENT = [
  "new unit", "new system", "replace", "replacement", "upgrade",
  "quote for new", "time to replace", "need a new", "want a new",
];

// Major repair signals
const MAJOR_REPAIR_COMPONENTS = [
  "compressor", "heat exchanger", "coil", "evaporator coil",
  "condenser coil", "evaporator", "condenser",
];
const MAJOR_REPAIR_SEVERITY = [
  "completely dead", "won't turn on at all", "totally dead",
  "smoke", "burning smell", "burning",
];

// Standard repair signals
const STANDARD_REPAIR_COMPONENTS = [
  "motor", "fan", "blower", "capacitor", "leak", "leaking",
  "recharge", "refrigerant", // Note: recharge without R-22 is standard
];
const STANDARD_REPAIR_SCOPE = [
  "ductwork", "duct", "ducts", "adding zone", "zone", "vent",
];

// Maintenance signals
const MAINTENANCE_SERVICE = [
  "tune-up", "tune up", "tuneup", "maintenance", "cleaning",
  "filter", "check-up", "checkup", "inspection", "annual",
];
const MAINTENANCE_SIMPLE = [
  "thermostat", "weird noise", "running loud", "making noise",
  "strange sound",
];

// ============================================
// Helper Functions
// ============================================

/**
 * Parse equipment age from string like "10 years old" or "about 12 years"
 * Returns null if age is invalid (negative, > 50, or unparseable)
 */
function parseEquipmentAge(ageStr?: string): number | null {
  if (!ageStr) return null;

  // Try to match "X years" pattern
  const match = ageStr.match(/(\d+)\s*(?:year|yr|years|yrs)/i);
  if (match) {
    const age = parseInt(match[1], 10);
    // Validate: age should be 0-50 years (reasonable range)
    if (age >= 0 && age <= 50) {
      return age;
    }
  }

  // Try to extract just a number if it's standalone
  const numMatch = ageStr.match(/^(\d{1,2})$/);
  if (numMatch) {
    const age = parseInt(numMatch[1], 10);
    if (age >= 0 && age <= 50) {
      return age;
    }
  }

  return null;
}

/**
 * Check if text contains any of the keywords (case-insensitive)
 */
function containsAny(text: string, keywords: string[]): string | null {
  const lowerText = text.toLowerCase();
  for (const keyword of keywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }
  return null;
}

/**
 * Calculate confidence based on available data
 */
function calculateConfidence(state: ConversationState, signalCount: number): "low" | "medium" | "high" {
  // High confidence: multiple signals or very clear indicators
  if (signalCount >= 2) return "high";

  // Medium confidence: at least one signal plus some context
  if (signalCount >= 1) {
    if (state.problemDescription || state.equipmentAge || state.equipmentType) {
      return "medium";
    }
  }

  return "low";
}

/**
 * Build the result object
 */
function buildResult(
  tier: RevenueTier,
  signals: string[],
  confidence: "low" | "medium" | "high"
): RevenueEstimate {
  const config = TIER_CONFIG[tier];
  return {
    tier: config.tier,
    tierLabel: config.label,
    tierDescription: config.description,
    estimatedRange: config.range,
    confidence,
    signals,
    potentialReplacement: tier === "replacement",
  };
}

// ============================================
// Main Classification Function
// ============================================

/**
 * Classify job into revenue tier based on conversation signals
 *
 * Priority cascade:
 * 1. Replacement signals (R-22, age 15+, replacement intent)
 * 2. Special case: recharge + R-22 → replacement
 * 3. Major repair signals (compressor, heat exchanger)
 * 4. Standard repair signals (motor, capacitor, ductwork)
 * 5. Maintenance signals (tune-up, filter)
 * 6. Fallback to diagnostic if unclear
 */
export function estimateRevenue(state: ConversationState, transcript?: string): RevenueEstimate {
  const signals: string[] = [];

  // Combine all text sources for keyword matching
  const allText = [
    state.problemDescription || "",
    state.equipmentType || "",
    state.salesLeadNotes || "",
    transcript || "",  // User-only transcript speech for replacement keyword detection
  ].join(" ").toLowerCase();

  // Parse equipment age
  const equipmentAge = parseEquipmentAge(state.equipmentAge);

  // ==========================================
  // TIER 1: REPLACEMENT ($$$$) - Check first
  // ==========================================

  // Check for R-22/Freon (obsolete refrigerant = replacement)
  const refrigerantSignal = containsAny(allText, REPLACEMENT_REFRIGERANT);
  if (refrigerantSignal) {
    signals.push(`R-22/Freon system`);
  }

  // Check for old system (15+ years)
  if (equipmentAge !== null && equipmentAge >= 15) {
    signals.push(`${equipmentAge}+ years old`);
  }

  // Check for replacement intent keywords
  const intentSignal = containsAny(allText, REPLACEMENT_INTENT);
  if (intentSignal) {
    signals.push(`Replacement inquiry`);
  }

  // CRITICAL: If "recharge" mentioned WITH R-22, it's replacement
  const hasRecharge = containsAny(allText, ["recharge", "freon fill", "refrigerant"]);
  if (hasRecharge && refrigerantSignal) {
    signals.push(`R-22 recharge (obsolete)`);
  }

  // If we have ANY replacement signal, classify as replacement
  if (refrigerantSignal || (equipmentAge !== null && equipmentAge >= 15) || intentSignal) {
    const confidence = calculateConfidence(state, signals.length);
    log.debug({ callId: state.callId, tier: "replacement", signals }, "Classified as replacement");
    return buildResult("replacement", signals, confidence);
  }

  // ==========================================
  // TIER 2: MAJOR REPAIR ($$$)
  // ==========================================

  const majorComponent = containsAny(allText, MAJOR_REPAIR_COMPONENTS);
  if (majorComponent) {
    signals.push(`Major component: ${majorComponent}`);
  }

  const severitySignal = containsAny(allText, MAJOR_REPAIR_SEVERITY);
  if (severitySignal) {
    signals.push(`Severity: ${severitySignal}`);
  }

  if (majorComponent || severitySignal) {
    const confidence = calculateConfidence(state, signals.length);
    log.debug({ callId: state.callId, tier: "major_repair", signals }, "Classified as major repair");
    return buildResult("major_repair", signals, confidence);
  }

  // ==========================================
  // TIER 3: STANDARD REPAIR ($$)
  // ==========================================

  const standardComponent = containsAny(allText, STANDARD_REPAIR_COMPONENTS);
  if (standardComponent) {
    signals.push(`Component: ${standardComponent}`);
  }

  const scopeSignal = containsAny(allText, STANDARD_REPAIR_SCOPE);
  if (scopeSignal) {
    signals.push(`Scope: ${scopeSignal}`);
  }

  if (standardComponent || scopeSignal) {
    const confidence = calculateConfidence(state, signals.length);
    log.debug({ callId: state.callId, tier: "standard_repair", signals }, "Classified as standard repair");
    return buildResult("standard_repair", signals, confidence);
  }

  // ==========================================
  // TIER 4: MAINTENANCE ($)
  // ==========================================

  const maintenanceSignal = containsAny(allText, MAINTENANCE_SERVICE);
  if (maintenanceSignal) {
    signals.push(`Service: ${maintenanceSignal}`);
  }

  const simpleSignal = containsAny(allText, MAINTENANCE_SIMPLE);
  if (simpleSignal) {
    signals.push(`Issue: ${simpleSignal}`);
  }

  if (maintenanceSignal || simpleSignal) {
    const confidence = calculateConfidence(state, signals.length);
    log.debug({ callId: state.callId, tier: "minor", signals }, "Classified as maintenance");
    return buildResult("minor", signals, confidence);
  }

  // ==========================================
  // FALLBACK: DIAGNOSTIC ($$?)
  // ==========================================

  // If no signals detected, classify as diagnostic
  // Don't default to minor ($) - could deprioritize a major job
  signals.push("Unclear scope");
  log.debug({ callId: state.callId, tier: "diagnostic", signals }, "Classified as diagnostic (no signals)");
  return buildResult("diagnostic", signals, "low");
}

/**
 * Get a simple estimate value for backwards compatibility
 * Returns midpoint of the tier's range
 */
export function getEstimatedValue(state: ConversationState): number {
  const estimate = estimateRevenue(state);

  // Return midpoint values for each tier
  switch (estimate.tier) {
    case "replacement":
      return 10000;
    case "major_repair":
      return 1900;
    case "standard_repair":
      return 500;
    case "minor":
      return 150;
    case "diagnostic":
      return 99;
    default:
      return 300;
  }
}
