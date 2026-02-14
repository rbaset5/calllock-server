/**
 * HVAC Smart Tag Taxonomy Classifier
 * Classifies calls using 117-tag taxonomy across 9 categories
 */

import { ConversationState } from "../types/retell.js";
import { createModuleLogger } from "../utils/logger.js";
import { extractProblemDuration } from "../extraction/post-call.js";

const log = createModuleLogger("tag-classifier");

/** Negation words that flip the meaning of a phrase match */
const NEGATION_PATTERN = /\b(no|not|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|never|deny|denied|any)\b/;

/**
 * Check if text contains a keyword as a whole word/phrase.
 * Uses word boundaries to prevent false positives like "ice" in "service".
 * Multi-word phrases (2+ words) are naturally specific enough for substring matching.
 * Single words (<= 5 chars) require word boundary regex.
 * Negation-aware: returns false if a negation word appears in the 40 chars before the match
 * (e.g., "no gas smell" won't match "gas smell").
 */
function containsPhrase(text: string, phrase: string): boolean {
  if (phrase.includes(' ') || phrase.length > 5) {
    const idx = text.indexOf(phrase);
    if (idx === -1) return false;
    // Check for negation in the 40 chars before the match
    const prefix = text.substring(Math.max(0, idx - 40), idx);
    if (NEGATION_PATTERN.test(prefix)) return false;
    return true;
  }
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(text);
  if (!match) return false;
  // Check for negation in the 40 chars before the match
  const prefix = text.substring(Math.max(0, match.index - 40), match.index);
  if (NEGATION_PATTERN.test(prefix)) return false;
  return true;
}

/**
 * Taxonomy structure: 9 categories with 117 total tags
 */
export interface TaxonomyTags {
  HAZARD: string[];
  URGENCY: string[];
  SERVICE_TYPE: string[];
  REVENUE: string[];
  RECOVERY: string[];
  LOGISTICS: string[];
  CUSTOMER: string[];
  NON_CUSTOMER: string[];
  CONTEXT: string[];
}

// =============================================================================
// HAZARD PATTERNS (7 tags)
// =============================================================================

const HAZARD_PATTERNS = {
  GAS_LEAK: [
    "rotten egg smell",
    "hissing sound",
    "sulfur",
    "gas smell",
    "dead grass near unit",
    "smell gas",
    "smells like gas",
  ],
  CO_EVENT: [
    "co alarm",
    "carbon monoxide",
    "detector going off",
    "co detector",
    "carbon monoxide alarm",
    "carbon monoxide detector",
  ],
  ELECTRICAL_FIRE: [
    "burning smell from unit",
    "smoke from furnace",
    "sparking from",
    "sparks from",
    "breaker keeps tripping",
    "smell like burning plastic",
    "burning wire",
    "electrical smell",
    "electrical fire",
  ],
  ACTIVE_FLOODING: [
    "water pouring",
    "ceiling sagging",
    "burst pipe",
    "flooding",
    "water everywhere",
    "gallons of water",
  ],
  CONDENSATE_CLOG: [
    "drain pan full",
    "small puddle",
    "condensate",
    "water under unit",
    "condensate line",
    "condensate drain",
  ],
  HEALTH_RISK: [
    "no heat",
    "freezing",
    "no ac",
    "heat wave",
    "extreme cold",
    "extreme heat",
  ],
  REFRIGERANT_LEAK: [
    "chemical smell",
    "sweet smell",
    "hissing outdoor",
    "icing up",
    "frozen coil",
    "refrigerant",
  ],
};

// =============================================================================
// URGENCY PATTERNS (8 tags)
// =============================================================================

const URGENCY_PATTERNS = {
  CRITICAL_EVACUATE: ["evacuation", "need to leave", "call 911", "gas company"],
  CRITICAL_DISPATCH: [
    "complete failure",
    "extreme temp",
    "vulnerable",
    "infant",
    "elderly",
  ],
  EMERGENCY_SAMEDAY: [
    "not working at all",
    "completely dead",
    "no air coming out",
    "froze up",
    "completely stopped",
  ],
  URGENT_24HR: [
    "barely working",
    "running constantly",
    "won't shut off",
    "strange noise",
  ],
  PRIORITY_48HR: [
    "repeat customer",
    "concerning symptoms",
    "getting worse",
    "been a few days",
  ],
  STANDARD: ["would like to schedule", "routine", "normal maintenance"],
  FLEXIBLE: ["no rush", "planning ahead", "whenever convenient"],
  SEASONAL_RUSH: ["first hot day", "first cold day", "peak season"],
};

// =============================================================================
// SERVICE_TYPE PATTERNS (23 tags)
// =============================================================================

const SERVICE_TYPE_PATTERNS = {
  // Repair Subcategory
  REPAIR_AC: ["ac not cooling", "warm air", "air conditioner broken", "ac issue"],
  REPAIR_HEATING: ["furnace not working", "no heat", "heater broken", "heat not working"],
  REPAIR_HEATPUMP: ["heat pump", "mode switching", "reversing valve"],
  REPAIR_THERMOSTAT: ["thermostat", "blank display", "won't change temp"],
  REPAIR_IAQ: ["humidifier", "air purifier", "uv light", "air quality"],
  REPAIR_DUCTWORK: ["duct disconnected", "air not reaching room", "ductwork"],
  
  // Maintenance Subcategory
  TUNEUP_AC: ["ac tune-up", "ac tuneup", "summer maintenance", "ac checkup"],
  TUNEUP_HEATING: ["furnace tune-up", "furnace tuneup", "fall checkup", "heating maintenance"],
  DUCT_CLEANING: ["duct cleaning", "dusty vents", "clean ducts"],
  FILTER_SERVICE: ["filter replacement", "need new filter", "change filter"],
  
  // Installation Subcategory
  INSTALL_REPLACEMENT: ["need new system", "replacing unit", "new hvac", "replace furnace"],
  INSTALL_NEWCONSTRUCTION: ["new build", "building a house", "new construction"],
  INSTALL_UPGRADE: ["more efficient", "higher seer", "upgrade system"],
  INSTALL_ADDON: ["add humidifier", "add zone", "install thermostat"],
  
  // Diagnostic Subcategory
  DIAGNOSTIC_INTERMITTENT: ["works sometimes", "comes and goes", "intermittent"],
  DIAGNOSTIC_PERFORMANCE: ["not cooling well", "takes long time", "running all day"],
  DIAGNOSTIC_NOISE: ["loud noise", "grinding", "squealing", "banging"],
  DIAGNOSTIC_CYCLE: ["short cycling", "won't stay on", "keeps turning off"],
  DIAGNOSTIC_AIRFLOW: ["weak airflow", "barely any air", "not much coming out"],
  DIAGNOSTIC_SMELL: ["musty smell", "odd odor", "smells weird"],
  DIAGNOSTIC_ENERGY: ["high bill", "electric bill doubled", "using too much energy"],
  
  // Other Subcategory
  SECONDOPINION: ["second opinion", "got a quote", "someone else said"],
  WARRANTY_CLAIM: ["under warranty", "warranty claim", "covered by warranty"],
};

// =============================================================================
// REVENUE PATTERNS (9 tags)
// =============================================================================

const REVENUE_PATTERNS = {
  HOT_LEAD: ["need new system", "replace", "quote", "estimate"],
  R22_RETROFIT: ["r-22", "r22", "freon", "old refrigerant"],
  REPLACE_OPP: ["old system", "keeps breaking", "tired of repairs"],
  COMMERCIAL_LEAD: ["commercial", "office", "business", "building"],
  FINANCING_REQ: ["financing", "payment plan", "monthly payments"],
  MULTI_PROPERTY: ["multiple properties", "rental properties", "landlord"],
  SERVICE_PLAN: ["service plan", "maintenance plan", "membership"],
  IAQ_UPSELL: ["air quality", "allergies", "dust"],
  ZONING_INTEREST: ["zone control", "different temps", "upstairs hot"],
};

// =============================================================================
// RECOVERY PATTERNS (10 tags)
// =============================================================================

const RECOVERY_PATTERNS = {
  CALLBACK_RISK: ["couldn't reach me", "never called back", "waiting for call"],
  COMPLAINT_PRICE: ["too expensive", "overcharged", "price too high"],
  COMPLAINT_SERVICE: ["poor service", "rude technician", "didn't show up"],
  COMPLAINT_NOFIX: ["still broken", "didn't fix", "same problem"],
  ESCALATION_REQ: ["speak to manager", "need supervisor", "not satisfied"],
  REVIEW_THREAT: ["leave review", "tell everyone", "report you"],
  LEGAL_MENTION: ["lawyer", "sue you", "suing", "attorney", "legal action", "take legal"],
  REFUND_REQ: ["want refund", "money back", "charge back"],
  COMPETITOR_MENTION: ["other company", "someone else said", "got cheaper quote"],
  LOST_CUSTOMER: ["switching companies", "going elsewhere", "done with you"],
};

// =============================================================================
// LOGISTICS PATTERNS (20 tags)
// =============================================================================

const LOGISTICS_PATTERNS = {
  GATE_CODE: ["gate code", "gated community", "keypad"],
  ALARM_CODE: ["alarm code", "security system", "disarm"],
  PET_SECURE: ["dog", "cat", "pet", "secure the dog"],
  PARKING_ISSUE: ["no parking", "parking difficult", "street parking"],
  ACCESS_RESTRICT: ["access restricted", "need escort", "limited hours"],
  LADDER_ATTIC: ["attic access", "need ladder", "crawlspace"],
  ROOF_EQUIP: ["roof access", "equipment on roof", "rooftop"],
  LOCKBOX: ["lockbox", "key box", "combination"],
  TENANT_COORD: ["tenant occupied", "renter", "coordinate with tenant"],
  LANDLORD_AUTH: ["landlord approval", "owner permission", "not my property"],
  UTILITY_SHUTOFF: ["shut off gas", "turn off power", "utility shutoff"],
  SCOPE_LIMITED: ["only look at", "just check", "specific issue only"],
  VENDOR_ACCESS: ["vendor entrance", "loading dock", "service entrance"],
  SNOW_ICE: ["snow", "ice storm", "iced over", "ice on", "icy", "winter weather"],
  SEASONAL_PREP: ["winterize", "summer prep", "seasonal"],
  MULTIUNIT_COORD: ["multiple units", "condo", "apartment complex"],
  HOA_APPROVAL: ["hoa approval", "homeowners association", "need hoa ok"],
  PERMIT_REQ: ["permit required", "need permit", "permitting"],
  SCOPE_CREEP: ["while you're here", "also look at", "can you check"],
  PARTS_DELAY: ["parts on order", "waiting for parts", "backorder"],
};

// =============================================================================
// CUSTOMER PATTERNS (15 tags)
// =============================================================================

const CUSTOMER_PATTERNS = {
  NEW_CUSTOMER: ["first time", "never used", "heard about you"],
  EXISTING_CUSTOMER: ["used before", "customer", "been with you"],
  REFERRAL: ["friend referred", "recommended", "someone told me"],
  OWNER_OCCUPIED: ["my house", "live here", "homeowner"],
  RENTAL_PROPERTY: ["rental", "investment property", "don't live there"],
  COMMERCIAL_ACCT: ["business", "commercial", "office"],
  PROPERTY_MANAGER: ["property manager", "manage properties"],
  DECISION_MAKER: ["i'm the owner", "my decision", "i can decide"],
  NEEDS_APPROVAL: ["ask my spouse", "need to check with", "not my decision"],
  AGENT_PROXY: ["calling for", "on behalf of", "helping my"],
  VIP_ACCOUNT: ["premium", "service plan member", "maintenance contract"],
  WARRANTY_CUSTOMER: ["warranty", "under warranty"],
  REPEAT_CALLER: ["called before", "talked earlier", "follow up"],
  SEASONAL_CUSTOMER: ["every year", "annual", "seasonal service"],
  COMMERCIAL_NEW: ["new business", "first time commercial", "opening soon"],
};

// =============================================================================
// NON_CUSTOMER PATTERNS (12 tags)
// =============================================================================

const NON_CUSTOMER_PATTERNS = {
  JOB_APPLICANT: ["applying for job", "hiring", "employment"],
  VENDOR_SALES: ["selling", "offer", "products"],
  SPAM_TELEMARKETING: ["telemarketing", "spam"],
  WRONG_NUMBER: ["wrong number", "didn't mean to call"],
  PARTS_SUPPLIER: ["parts supplier", "supply house"],
  COMPETITOR_INTEL: ["competitor", "research", "market"],
  INSPECTOR_CALL: ["inspection", "inspector", "code compliance"],
  UTILITY_COMPANY: ["gas company", "electric company", "utility"],
  MANUFACTURER_REP: ["manufacturer", "warranty rep"],
  INSURANCE_CLAIM: ["insurance claim", "adjuster"],
  REALTOR_INQUIRY: ["realtor", "real estate", "home sale"],
  MEDIA_PRESS: ["media", "press", "interview", "news"],
};

// =============================================================================
// CONTEXT PATTERNS (13 tags)
// =============================================================================

const CONTEXT_PATTERNS = {
  DURATION_ACUTE: [], // Detected by extractProblemDuration
  DURATION_RECENT: [], // Detected by extractProblemDuration
  DURATION_ONGOING: [], // Detected by extractProblemDuration
  PEAK_SUMMER: [], // Detected by date
  PEAK_WINTER: [], // Detected by date
  HOLIDAY_WEEK: [], // Detected by date
  AFTER_HOURS: [], // Detected by time
  WEEKEND: [], // Detected by date
  ELDERLY_OCCUPANT: ["elderly", "senior", "old person", "grandma", "grandpa"],
  INFANT_NEWBORN: ["baby", "infant", "newborn"],
  MEDICAL_NEED: ["medical", "oxygen", "health condition"],
  VULNERABLE_POP: ["vulnerable", "disabled", "special needs"],
  EXTREME_WEATHER: ["heat wave", "cold snap", "storm", "extreme weather"],
  POST_STORM: ["after storm", "since storm", "storm damage"],
  POWER_OUTAGE: ["power outage", "electricity out", "power came back"],
  RECENT_INSTALL: ["just installed", "new system", "recently replaced"],
};

/**
 * Main classification function
 */
export function classifyCall(
  state: ConversationState,
  transcript?: string,
  callStartTimestamp?: number
): TaxonomyTags {
  const tags: TaxonomyTags = {
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

  // Combine transcript and state fields for analysis
  const textToAnalyze = [
    transcript || "",
    state.problemDescription || "",
    state.hvacIssueType || "",
    state.salesLeadNotes || "",
  ].join(" ").toLowerCase();

  // Classify HAZARD
  for (const [tag, patterns] of Object.entries(HAZARD_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.HAZARD.push(tag);
    }
  }

  // Classify URGENCY
  for (const [tag, patterns] of Object.entries(URGENCY_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.URGENCY.push(tag);
    }
  }

  // Auto-upgrade urgency for hazards
  if (tags.HAZARD.length > 0 && !tags.URGENCY.includes("CRITICAL_EVACUATE")) {
    if (
      tags.HAZARD.includes("GAS_LEAK") ||
      tags.HAZARD.includes("CO_EVENT") ||
      tags.HAZARD.includes("ELECTRICAL_FIRE")
    ) {
      tags.URGENCY.push("CRITICAL_EVACUATE");
    } else {
      tags.URGENCY.push("EMERGENCY_SAMEDAY");
    }
  }

  // Classify SERVICE_TYPE
  for (const [tag, patterns] of Object.entries(SERVICE_TYPE_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.SERVICE_TYPE.push(tag);
    }
  }

  // Classify REVENUE
  for (const [tag, patterns] of Object.entries(REVENUE_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.REVENUE.push(tag);
    }
  }

  // Auto-tag sales leads
  if (state.endCallReason === "sales_lead") {
    if (!tags.REVENUE.includes("HOT_LEAD")) {
      tags.REVENUE.push("HOT_LEAD");
    }
  }

  // Auto-tag R-22 retrofit opportunity
  if (state.equipmentAge && parseInt(state.equipmentAge) > 15) {
    if (!tags.REVENUE.includes("R22_RETROFIT")) {
      tags.REVENUE.push("R22_RETROFIT");
    }
  }

  // Classify RECOVERY
  for (const [tag, patterns] of Object.entries(RECOVERY_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.RECOVERY.push(tag);
    }
  }

  // Classify LOGISTICS
  for (const [tag, patterns] of Object.entries(LOGISTICS_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.LOGISTICS.push(tag);
    }
  }

  // Classify CUSTOMER
  for (const [tag, patterns] of Object.entries(CUSTOMER_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.CUSTOMER.push(tag);
    }
  }

  // Auto-tag based on property type
  if (state.propertyType === "commercial") {
    if (!tags.CUSTOMER.includes("COMMERCIAL_ACCT")) {
      tags.CUSTOMER.push("COMMERCIAL_ACCT");
    }
  } else if (state.propertyType === "house" || state.propertyType === "condo") {
    if (!tags.CUSTOMER.includes("OWNER_OCCUPIED")) {
      tags.CUSTOMER.push("OWNER_OCCUPIED");
    }
  }

  // Auto-tag decision maker
  if (state.isDecisionMaker === true) {
    if (!tags.CUSTOMER.includes("DECISION_MAKER")) {
      tags.CUSTOMER.push("DECISION_MAKER");
    }
  } else if (state.isDecisionMaker === false) {
    if (!tags.CUSTOMER.includes("NEEDS_APPROVAL")) {
      tags.CUSTOMER.push("NEEDS_APPROVAL");
    }
  }

  // Classify NON_CUSTOMER
  for (const [tag, patterns] of Object.entries(NON_CUSTOMER_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.NON_CUSTOMER.push(tag);
    }
  }

  // Auto-tag wrong number
  if (state.endCallReason === "wrong_number") {
    if (!tags.NON_CUSTOMER.includes("WRONG_NUMBER")) {
      tags.NON_CUSTOMER.push("WRONG_NUMBER");
    }
  }

  // Classify CONTEXT
  for (const [tag, patterns] of Object.entries(CONTEXT_PATTERNS)) {
    if (patterns.some((p) => containsPhrase(textToAnalyze, p))) {
      tags.CONTEXT.push(tag);
    }
  }

  // Auto-tag duration from transcript extraction or state (#38)
  const durationCategory = state.problemDurationCategory
    || extractProblemDuration(transcript)?.category;
  if (durationCategory === 'acute') {
    tags.CONTEXT.push("DURATION_ACUTE");
  } else if (durationCategory === 'recent') {
    tags.CONTEXT.push("DURATION_RECENT");
  } else if (durationCategory === 'ongoing') {
    tags.CONTEXT.push("DURATION_ONGOING");
  }

  // Auto-tag seasonal context using call timestamp in business timezone (Central Time)
  const callDate = callStartTimestamp ? new Date(callStartTimestamp) : new Date();
  const cstString = callDate.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const cstDate = new Date(cstString);
  const month = cstDate.getMonth(); // 0-11
  const hour = cstDate.getHours(); // 0-23
  const day = cstDate.getDay(); // 0-6

  if (month >= 5 && month <= 7) {
    // June-August
    tags.CONTEXT.push("PEAK_SUMMER");
  } else if (month >= 11 || month <= 1) {
    // Dec-Feb
    tags.CONTEXT.push("PEAK_WINTER");
  }

  if (hour < 8 || hour >= 17) {
    tags.CONTEXT.push("AFTER_HOURS");
  }

  if (day === 0 || day === 6) {
    tags.CONTEXT.push("WEEKEND");
  }

  // Log classification summary
  const totalTags = Object.values(tags).flat().length;
  log.info(
    {
      callId: state.callId,
      totalTags,
      hazard: tags.HAZARD.length,
      urgency: tags.URGENCY.length,
      revenue: tags.REVENUE.length,
    },
    "Call classified with taxonomy"
  );

  return tags;
}
