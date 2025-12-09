/**
 * Revenue Estimation Service
 * Estimates job revenue based on call data to motivate operators to act on leads
 */

import { ConversationState, UrgencyTier, HVACIssueType } from "../types/retell.js";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("revenue-estimation");

// ============================================
// Types
// ============================================

export interface RevenueEstimate {
  lowEstimate: number;
  highEstimate: number;
  midpoint: number;
  displayRange: string;
  confidence: "low" | "medium" | "high";
  factors: string[];
  potentialReplacement: boolean;
  serviceCategory: string;
}

interface PriceRange {
  low: number;
  high: number;
}

interface ServiceCategory {
  name: string;
  keywords: string[];
  priceRange: PriceRange;
}

// ============================================
// HVAC Service Pricing Matrix (2025 Industry Data)
// Sources: Angi, HomeGuide, Fixr
// ============================================

const SERVICE_CATEGORIES: ServiceCategory[] = [
  // Specific component repairs (check first - more specific)
  {
    name: "Compressor Repair",
    keywords: ["compressor", "compressor not working", "compressor failed"],
    priceRange: { low: 600, high: 2500 },
  },
  {
    name: "Refrigerant Service",
    keywords: ["refrigerant", "freon", "recharge", "leak", "low refrigerant", "needs freon"],
    priceRange: { low: 100, high: 1500 },
  },
  {
    name: "Motor/Fan Repair",
    keywords: ["motor", "fan", "blower", "blower motor", "fan motor", "fan not working"],
    priceRange: { low: 200, high: 700 },
  },
  {
    name: "Coil Repair",
    keywords: ["coil", "evaporator", "condenser coil", "frozen coil", "dirty coil"],
    priceRange: { low: 200, high: 1500 },
  },
  {
    name: "Capacitor Repair",
    keywords: ["capacitor", "run capacitor", "start capacitor"],
    priceRange: { low: 150, high: 400 },
  },
  {
    name: "Ignitor Repair",
    keywords: ["ignitor", "igniter", "pilot", "won't ignite", "no ignition"],
    priceRange: { low: 150, high: 400 },
  },
  {
    name: "Circuit Board Repair",
    keywords: ["circuit board", "control board", "motherboard", "board"],
    priceRange: { low: 100, high: 600 },
  },
  {
    name: "Ductwork Repair",
    keywords: ["duct", "ductwork", "ducts", "air duct", "vent"],
    priceRange: { low: 450, high: 2000 },
  },
  {
    name: "Thermostat Service",
    keywords: ["thermostat", "temperature control", "programmable"],
    priceRange: { low: 150, high: 350 },
  },
  // General issue categories (check after specific components)
  {
    name: "AC Repair",
    keywords: [
      "not cooling", "won't cool", "warm air", "hot air", "ac not working",
      "air conditioner", "a/c", "cooling issue", "no cold air", "ac broken",
      "ac won't turn on", "ac running but not cooling",
    ],
    priceRange: { low: 250, high: 700 },
  },
  {
    name: "Furnace Repair",
    keywords: [
      "not heating", "no heat", "cold air", "furnace", "heater",
      "won't heat", "heating issue", "furnace not working", "no warm air",
      "furnace won't turn on", "furnace broken",
    ],
    priceRange: { low: 125, high: 500 },
  },
  {
    name: "Heat Pump Repair",
    keywords: ["heat pump", "heatpump", "reversing valve"],
    priceRange: { low: 200, high: 2000 },
  },
  {
    name: "Maintenance",
    keywords: [
      "maintenance", "tune-up", "tune up", "check", "inspection",
      "cleaning", "service", "annual", "preventive", "filter",
    ],
    priceRange: { low: 75, high: 200 },
  },
];

// Default when no category matches
const DEFAULT_SERVICE: ServiceCategory = {
  name: "General Service",
  keywords: [],
  priceRange: { low: 200, high: 500 },
};

// Issue type to service category mapping (fallback when no keywords match)
const ISSUE_TYPE_DEFAULTS: Record<HVACIssueType, PriceRange> = {
  Cooling: { low: 250, high: 700 },
  Heating: { low: 125, high: 500 },
  Maintenance: { low: 75, high: 200 },
};

// Urgency multipliers
const URGENCY_MULTIPLIERS: Record<UrgencyTier, number> = {
  LifeSafety: 1.5, // Emergency/after-hours premium
  Urgent: 1.25,    // Same-day premium
  Routine: 1.0,    // Standard pricing
};

// Equipment age thresholds and multipliers
const AGE_THRESHOLDS = {
  NEW: 5,           // 0-5 years: no adjustment
  AGING: 10,        // 6-10 years: slight increase
  OLD: 15,          // 10-15 years: significant increase, replacement flag
  VERY_OLD: 20,     // 15+ years: major increase, strong replacement signal
};

const AGE_MULTIPLIERS = {
  NEW: 1.0,
  AGING: 1.25,
  OLD: 2.5,
  VERY_OLD: 3.0,
};

// ============================================
// Helper Functions
// ============================================

/**
 * Parse equipment age from string like "10 years old" or "about 12 years"
 */
function parseEquipmentAge(ageStr?: string): number | null {
  if (!ageStr) return null;

  const match = ageStr.match(/(\d+)\s*(?:year|yr|years|yrs)/i);
  if (match) {
    return parseInt(match[1], 10);
  }

  // Try to extract just a number if it's just "10" or similar
  const numMatch = ageStr.match(/(\d+)/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }

  return null;
}

/**
 * Determine service category from problem description keywords
 */
function categorizeFromDescription(description?: string): ServiceCategory | null {
  if (!description) return null;

  const lowerDesc = description.toLowerCase();

  // Check each category's keywords
  for (const category of SERVICE_CATEGORIES) {
    for (const keyword of category.keywords) {
      if (lowerDesc.includes(keyword.toLowerCase())) {
        return category;
      }
    }
  }

  return null;
}

/**
 * Get base price range from issue type (fallback)
 */
function getPriceRangeFromIssueType(issueType?: HVACIssueType): PriceRange {
  if (issueType && ISSUE_TYPE_DEFAULTS[issueType]) {
    return ISSUE_TYPE_DEFAULTS[issueType];
  }
  return DEFAULT_SERVICE.priceRange;
}

/**
 * Calculate confidence level based on available data
 */
function calculateConfidence(state: ConversationState): "low" | "medium" | "high" {
  let score = 0;

  if (state.problemDescription) score++;
  if (state.hvacIssueType) score++;
  if (state.equipmentType) score++;
  if (state.urgencyTier) score++;
  if (state.equipmentAge) score++;

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/**
 * Format price range as display string
 */
function formatPriceRange(low: number, high: number): string {
  return `$${low.toLocaleString()}-$${high.toLocaleString()}`;
}

// ============================================
// Main Estimation Function
// ============================================

/**
 * Estimate revenue for a job based on conversation state
 */
export function estimateRevenue(state: ConversationState): RevenueEstimate {
  const factors: string[] = [];

  // Step 1: Determine service category from problem description
  let category = categorizeFromDescription(state.problemDescription);
  let baseRange: PriceRange;

  if (category) {
    baseRange = { ...category.priceRange };
    factors.push(category.name);
  } else {
    // Fallback to issue type
    baseRange = getPriceRangeFromIssueType(state.hvacIssueType);
    category = {
      name: state.hvacIssueType
        ? `${state.hvacIssueType} Service`
        : DEFAULT_SERVICE.name,
      keywords: [],
      priceRange: baseRange,
    };
    factors.push(category.name);
  }

  // Step 2: Apply urgency multiplier
  const urgencyTier = state.urgencyTier || "Routine";
  const urgencyMult = URGENCY_MULTIPLIERS[urgencyTier];

  if (urgencyMult > 1) {
    factors.push(`${urgencyTier} priority (+${Math.round((urgencyMult - 1) * 100)}%)`);
  }

  // Step 3: Check equipment age
  const equipmentAge = parseEquipmentAge(state.equipmentAge);
  let ageMult = 1.0;
  let potentialReplacement = false;

  if (equipmentAge !== null) {
    if (equipmentAge >= AGE_THRESHOLDS.VERY_OLD) {
      ageMult = AGE_MULTIPLIERS.VERY_OLD;
      potentialReplacement = true;
      factors.push(`Equipment ${equipmentAge}+ years (potential replacement)`);
    } else if (equipmentAge >= AGE_THRESHOLDS.OLD) {
      ageMult = AGE_MULTIPLIERS.OLD;
      potentialReplacement = true;
      factors.push(`Equipment ${equipmentAge} years (aging system)`);
    } else if (equipmentAge >= AGE_THRESHOLDS.AGING) {
      ageMult = AGE_MULTIPLIERS.AGING;
      factors.push(`Equipment ${equipmentAge} years`);
    }
  }

  // Step 4: Add equipment type context if available
  if (state.equipmentType) {
    factors.push(state.equipmentType);
  }

  // Step 5: Calculate final price range
  // Urgency affects both low and high
  // Age only affects the upper bound (potential for bigger job)
  const lowEstimate = Math.round(baseRange.low * urgencyMult);
  const highEstimate = Math.round(baseRange.high * urgencyMult * ageMult);

  // Midpoint for dashboard display (weighted slightly toward lower end for conservatism)
  const midpoint = Math.round((lowEstimate + highEstimate) / 2);

  // Step 6: Calculate confidence
  const confidence = calculateConfidence(state);

  const estimate: RevenueEstimate = {
    lowEstimate,
    highEstimate,
    midpoint,
    displayRange: formatPriceRange(lowEstimate, highEstimate),
    confidence,
    factors,
    potentialReplacement,
    serviceCategory: category.name,
  };

  log.debug(
    {
      callId: state.callId,
      problemDescription: state.problemDescription?.substring(0, 50),
      issueType: state.hvacIssueType,
      equipmentAge: state.equipmentAge,
      urgencyTier: state.urgencyTier,
      estimate: {
        range: estimate.displayRange,
        midpoint: estimate.midpoint,
        confidence: estimate.confidence,
        category: estimate.serviceCategory,
      },
    },
    "Revenue estimate calculated"
  );

  return estimate;
}

/**
 * Get a simple estimate value (midpoint) for cases where full estimate isn't needed
 */
export function getEstimatedValue(state: ConversationState): number {
  return estimateRevenue(state).midpoint;
}
