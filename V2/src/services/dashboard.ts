/**
 * Dashboard Integration Service
 * Sends call data to the CallLock Dashboard webhook
 */

import { ConversationState, UrgencyTier, EndCallReason, RetellPostCallData, RevenueTier } from "../types/retell.js";
import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";
import { estimateRevenue, RevenueEstimate } from "./revenue-estimation.js";
import { detectPriority, PriorityColor } from "./priority-detection.js";
import { classifyCall, TaxonomyTags } from "./tag-classifier.js";

const log = createModuleLogger("dashboard");

const DASHBOARD_WEBHOOK_URL = process.env.DASHBOARD_WEBHOOK_URL;
const DASHBOARD_WEBHOOK_SECRET = process.env.DASHBOARD_WEBHOOK_SECRET;
const DASHBOARD_USER_EMAIL = process.env.DASHBOARD_USER_EMAIL;

// Check if dashboard integration is configured
const isDashboardConfigured = Boolean(
  DASHBOARD_WEBHOOK_URL && DASHBOARD_WEBHOOK_SECRET && DASHBOARD_USER_EMAIL
);

if (!isDashboardConfigured) {
  log.info("Dashboard integration not configured - calls will not be synced to dashboard");
}

/**
 * Dashboard webhook expected payload
 */
/** Structured transcript message from Retell */
export interface TranscriptMessage {
  role: "agent" | "user";
  content: string;
}

export interface DashboardJobPayload {
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  service_type: "hvac" | "plumbing" | "electrical" | "general";
  urgency: "low" | "medium" | "high" | "emergency";
  ai_summary?: string;
  scheduled_at?: string;
  call_transcript?: string;
  transcript_object?: TranscriptMessage[];  // Structured transcript with speaker labels
  user_email: string;
  // Revenue tier classification (replaces granular dollar estimates)
  revenue_tier?: RevenueTier;
  revenue_tier_label?: string;        // "$$$$", "$$$", "$$", "$", "$$?"
  revenue_tier_description?: string;  // "Potential Replacement", "Major Repair", etc.
  revenue_tier_range?: string;        // "$5,000-$15,000+"
  revenue_tier_signals?: string[];    // ["R-22 system", "20+ years old"]
  revenue_confidence?: "low" | "medium" | "high";
  potential_replacement?: boolean;
  // Legacy field for backwards compatibility
  estimated_value?: number;
  // Call outcome for Lead creation
  end_call_reason?: EndCallReason;
  // Problem details for Lead
  issue_description?: string;
  // Sales lead specific fields
  equipment_type?: string;
  equipment_age?: string;
  sales_lead_notes?: string;
  // Diagnostic context fields (from problem clarification phase)
  problem_duration?: string;
  problem_onset?: string;
  problem_pattern?: string;
  customer_attempted_fixes?: string;
  // Call tracking
  call_id?: string;
  // V4 Priority color classification
  priority_color?: PriorityColor;
  priority_reason?: string;
  // HVAC Must-Have Fields (Owner-Operator Decision Support)
  property_type?: "house" | "condo" | "apartment" | "commercial";
  system_status?: "completely_down" | "partially_working" | "running_but_ineffective";
  equipment_age_bracket?: "under_10" | "10_to_15" | "over_15" | "unknown";
  is_decision_maker?: boolean;
  decision_maker_contact?: string;
  // V6: HVAC Smart Tag Taxonomy (117 tags across 9 categories)
  tags?: TaxonomyTags;
  // V9: Property manager / third-party caller fields
  site_contact_name?: string;
  site_contact_phone?: string;
  is_third_party?: boolean;
  third_party_type?: string;
  // V7 Call Type Classification
  call_type?: string;
  call_subtype?: string;
  call_type_confidence?: "low" | "medium" | "high";
  is_commercial?: boolean;
  // V5 Velocity Enhancements
  sentiment_score?: number;
  work_type?: "service" | "maintenance" | "install" | "admin";
  // V3 Triage Engine fields
  caller_type?: string;
  primary_intent?: string;
  // V8 LLM-Generated Display Fields
  card_headline?: string;
  card_summary?: string;
}

/**
 * Map urgency tier to dashboard urgency level
 */
function mapUrgencyToDashboard(
  urgencyTier?: UrgencyTier,
  endCallReason?: EndCallReason
): DashboardJobPayload["urgency"] {
  // Safety emergencies are always highest priority
  if (endCallReason === "safety_emergency") {
    return "emergency";
  }

  if (endCallReason === "urgent_escalation") {
    return "high";
  }

  switch (urgencyTier) {
    case "LifeSafety":
      return "emergency";
    case "Urgent":
      return "high";
    case "Routine":
      return "medium";
    default:
      return "low";
  }
}

/**
 * Build AI summary from conversation state and end reason
 */
function buildAiSummary(
  state: ConversationState,
  retellData?: RetellPostCallData
): string {
  // Prefer Retell's AI-generated call summary — it's a clean narrative.
  // Issue type, outcome, and revenue are stored in dedicated dashboard fields,
  // so don't duplicate them here.
  const callSummary = retellData?.call_analysis?.call_summary;
  if (callSummary) {
    return callSummary;
  }

  // Fallback: build summary from state when Retell analysis is unavailable
  if (state.problemDescription) {
    return state.problemDescription;
  }

  return "No summary available";
}

/**
 * Get midpoint dollar value for a tier (for backwards compatibility)
 */
function getMidpointValue(tier: RevenueTier): number {
  switch (tier) {
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

/**
 * Build a title-friendly description for sales leads
 * Format: "AC Replacement - 20 years old" or "HVAC Replacement"
 */
function buildSalesLeadTitle(equipmentType?: string, equipmentAge?: string): string {
  const equipment = equipmentType || "HVAC";
  if (equipmentAge) {
    return `${equipment} Replacement - ${equipmentAge}`;
  }
  return `${equipment} Replacement`;
}

// =============================================================================
// V10: Field Derivation Functions
// =============================================================================

/**
 * Derive call_type and call_subtype from taxonomy tags and conversation state
 */
function deriveCallType(
  tags: TaxonomyTags | null,
  state: ConversationState
): { callType: string; callSubtype?: string; confidence: "low" | "medium" | "high" } {
  if (!tags) {
    return { callType: "UNKNOWN", confidence: "low" };
  }

  // NON_CUSTOMER tags → spam/junk call types
  if (tags.NON_CUSTOMER.length > 0) {
    if (tags.NON_CUSTOMER.includes("WRONG_NUMBER")) return { callType: "WRONG_NUMBER", confidence: "high" };
    if (tags.NON_CUSTOMER.includes("JOB_APPLICANT")) return { callType: "JOB_SEEKER", confidence: "high" };
    if (tags.NON_CUSTOMER.includes("VENDOR_SALES") || tags.NON_CUSTOMER.includes("SPAM_TELEMARKETING")) {
      return { callType: "SPAM_JUNK", confidence: "high" };
    }
    return { callType: "SPAM_JUNK", callSubtype: tags.NON_CUSTOMER[0]?.toLowerCase(), confidence: "medium" };
  }

  // SERVICE_TYPE tags → derive primary call type and subtype
  const serviceTypes = tags.SERVICE_TYPE;
  if (serviceTypes.length > 0) {
    const first = serviceTypes[0];

    if (first.startsWith("REPAIR_")) {
      const subtype = first.replace("REPAIR_", "").toLowerCase();
      return { callType: "SERVICE", callSubtype: subtype, confidence: "high" };
    }
    if (first.startsWith("TUNEUP_") || first === "DUCT_CLEANING" || first === "FILTER_SERVICE") {
      const subtype = first.replace("TUNEUP_", "").toLowerCase();
      return { callType: "MAINTENANCE", callSubtype: subtype, confidence: "high" };
    }
    if (first.startsWith("INSTALL_")) {
      const subtype = first.replace("INSTALL_", "").toLowerCase();
      return { callType: "ESTIMATE", callSubtype: subtype, confidence: "high" };
    }
    if (first.startsWith("DIAGNOSTIC_")) {
      const subtype = first.replace("DIAGNOSTIC_", "").toLowerCase();
      return { callType: "SERVICE", callSubtype: subtype, confidence: "medium" };
    }
    if (first === "SECONDOPINION") return { callType: "ESTIMATE", callSubtype: "second_opinion", confidence: "high" };
    if (first === "WARRANTY_CLAIM") return { callType: "EXISTING_CUSTOMER", callSubtype: "warranty", confidence: "high" };
  }

  // RECOVERY tags → complaint-type call
  if (tags.RECOVERY.length > 0) {
    return { callType: "COMPLAINT", callSubtype: "follow_up", confidence: "medium" };
  }

  // CUSTOMER tags → returning or new
  if (tags.CUSTOMER.includes("EXISTING_CUSTOMER") || tags.CUSTOMER.includes("REPEAT_CALLER")) {
    return { callType: "RETURNING_CONTACT", confidence: "medium" };
  }
  if (tags.CUSTOMER.includes("NEW_CUSTOMER") || tags.CUSTOMER.includes("REFERRAL")) {
    return { callType: "SERVICE", callSubtype: tags.CUSTOMER.includes("REFERRAL") ? "referral" : "new_customer", confidence: "medium" };
  }

  // Fallback: use state fields
  if (state.callbackType === "estimate" || state.endCallReason === "sales_lead") {
    return { callType: "ESTIMATE", confidence: "low" };
  }
  if (state.hvacIssueType) {
    return { callType: "SERVICE", callSubtype: state.hvacIssueType.toLowerCase(), confidence: "low" };
  }

  return { callType: "UNKNOWN", confidence: "low" };
}

/**
 * Map Retell's sentiment string to 1-5 numeric score
 */
function mapSentimentToScore(sentiment?: "positive" | "neutral" | "negative"): number | undefined {
  switch (sentiment) {
    case "negative": return 2;
    case "neutral": return 3;
    case "positive": return 4;
    default: return undefined;
  }
}

/**
 * Derive work_type from state and tags
 */
function deriveWorkType(
  state: ConversationState,
  tags: TaxonomyTags | null
): "service" | "maintenance" | "install" | "admin" {
  if (tags) {
    const st = tags.SERVICE_TYPE;
    if (st.some(t => t.startsWith("INSTALL_"))) return "install";
    if (st.some(t => t.startsWith("TUNEUP_") || t === "DUCT_CLEANING" || t === "FILTER_SERVICE")) return "maintenance";
    if (tags.NON_CUSTOMER.length > 0) return "admin";
  }
  if (state.callbackType === "estimate" || state.endCallReason === "sales_lead") return "install";
  return "service";
}

/**
 * Derive caller_type from state and tags
 */
function deriveCallerType(
  state: ConversationState,
  tags: TaxonomyTags | null
): "residential" | "commercial" | "vendor" | "recruiting" | "unknown" {
  if (state.propertyType === "commercial") return "commercial";
  if (tags) {
    if (tags.CUSTOMER.includes("COMMERCIAL_ACCT")) return "commercial";
    if (tags.NON_CUSTOMER.includes("JOB_APPLICANT")) return "recruiting";
    if (tags.NON_CUSTOMER.includes("VENDOR_SALES") || tags.NON_CUSTOMER.includes("SPAM_TELEMARKETING")) return "vendor";
    if (tags.CUSTOMER.length > 0) return "residential";
  }
  return "unknown";
}

/**
 * Derive primary_intent from state and tags
 */
function derivePrimaryIntent(
  state: ConversationState,
  tags: TaxonomyTags | null
): "new_lead" | "active_job_issue" | "booking_request" | "admin_billing" | "solicitation" {
  if (state.appointmentBooked) return "booking_request";
  if (tags?.RECOVERY && tags.RECOVERY.length > 0) return "active_job_issue";
  if (tags?.NON_CUSTOMER && tags.NON_CUSTOMER.length > 0) return "solicitation";
  if (state.callbackType === "billing" || state.callbackType === "warranty") return "admin_billing";
  if (state.endCallReason === "sales_lead") return "new_lead";
  return "new_lead";
}

/**
 * Build a short headline for dashboard card display
 */
function buildCardHeadline(
  state: ConversationState,
  retellData?: RetellPostCallData
): string | undefined {
  const summary = retellData?.call_analysis?.call_summary;
  if (summary) {
    const firstSentence = summary.split(/[.!?]/)[0]?.trim();
    if (firstSentence && firstSentence.length > 0) {
      return firstSentence.length > 60 ? firstSentence.substring(0, 57) + "..." : firstSentence;
    }
  }
  if (state.problemDescription) {
    return state.problemDescription.length > 60
      ? state.problemDescription.substring(0, 57) + "..."
      : state.problemDescription;
  }
  return undefined;
}

/**
 * Build a summary paragraph for dashboard card display
 */
function buildCardSummary(
  state: ConversationState,
  retellData?: RetellPostCallData
): string | undefined {
  const summary = retellData?.call_analysis?.call_summary;
  if (summary) {
    return summary.length > 200 ? summary.substring(0, 197) + "..." : summary;
  }
  const parts: string[] = [];
  if (state.problemDescription) parts.push(state.problemDescription);
  if (state.urgencyTier === "LifeSafety") parts.push("Life safety emergency.");
  else if (state.urgencyTier === "Urgent") parts.push("Urgent service needed.");
  if (state.equipmentType) parts.push(`Equipment: ${state.equipmentType}.`);
  if (state.equipmentAge) parts.push(`Age: ${state.equipmentAge}.`);

  const combined = parts.join(" ");
  if (combined.length === 0) return undefined;
  return combined.length > 200 ? combined.substring(0, 197) + "..." : combined;
}

/**
 * Transform conversation state to dashboard payload
 */
export function transformToDashboardPayload(
  state: ConversationState,
  retellData?: RetellPostCallData
): DashboardJobPayload {
  // Calculate revenue estimate
  const estimate = estimateRevenue(state);

  // Detect priority color for V4 dashboard
  const priority = detectPriority(state, retellData?.transcript, estimate);

  // V6: Classify call with HVAC Smart Tag Taxonomy
  const tags = classifyCall(state, retellData?.transcript, retellData?.start_timestamp);

  // V10: Derive enrichment fields from tags and state
  const callTypeResult = deriveCallType(tags, state);
  const sentimentScore = mapSentimentToScore(retellData?.call_analysis?.user_sentiment);
  const workType = deriveWorkType(state, tags);
  const callerType = deriveCallerType(state, tags);
  const primaryIntent = derivePrimaryIntent(state, tags);
  const cardHeadline = buildCardHeadline(state, retellData);
  const cardSummary = buildCardSummary(state, retellData);

  // For sales leads, create a descriptive title from equipment info
  const issueDescription = state.endCallReason === "sales_lead"
    ? buildSalesLeadTitle(state.equipmentType, state.equipmentAge)
    : state.problemDescription;

  // Get midpoint value for backwards compatibility
  const estimatedValue = getMidpointValue(estimate.tier);

  // Get phone from Retell call metadata if not in conversation state
  const phoneFromRetell = retellData?.direction === "inbound"
    ? retellData?.from_number
    : retellData?.to_number;

  return {
    customer_name: state.customerName || "Unknown Caller",
    customer_phone: (state.customerPhone && state.customerPhone !== "auto" && state.customerPhone !== "TBD")
      ? state.customerPhone
      : phoneFromRetell || "Unknown",
    customer_address: state.serviceAddress || "",
    service_type: "hvac", // Always HVAC for this system
    urgency: mapUrgencyToDashboard(state.urgencyTier, state.endCallReason),
    ai_summary: buildAiSummary(state, retellData),
    scheduled_at: state.appointmentDateTime,
    call_transcript: retellData?.transcript,
    transcript_object: retellData?.transcript_object,  // Structured transcript with speaker labels
    user_email: DASHBOARD_USER_EMAIL!,
    // Revenue tier classification
    revenue_tier: estimate.tier,
    revenue_tier_label: estimate.tierLabel,
    revenue_tier_description: estimate.tierDescription,
    revenue_tier_range: estimate.estimatedRange,
    revenue_tier_signals: estimate.signals,
    revenue_confidence: estimate.confidence,
    potential_replacement: estimate.potentialReplacement,
    // Legacy field for backwards compatibility
    estimated_value: estimatedValue,
    // Call outcome for Lead creation (when no booking)
    end_call_reason: state.endCallReason,
    issue_description: issueDescription,
    // Sales lead specific fields
    equipment_type: state.equipmentType,
    equipment_age: state.equipmentAge,
    sales_lead_notes: state.salesLeadNotes,
    // Diagnostic context fields
    problem_duration: state.problemDuration,
    problem_onset: state.problemOnset,
    problem_pattern: state.problemPattern,
    customer_attempted_fixes: state.customerAttemptedFixes,
    // Call tracking - links lead/job to call record
    call_id: state.callId,
    // V4 Priority classification
    priority_color: priority.color,
    priority_reason: priority.reason,
    // HVAC Must-Have Fields (Owner-Operator Decision Support)
    property_type: state.propertyType,
    system_status: state.systemStatus,
    equipment_age_bracket: state.equipmentAgeBracket,
    is_decision_maker: state.isDecisionMaker,
    decision_maker_contact: state.decisionMakerContact,
    // V6: HVAC Smart Tag Taxonomy
    tags: tags,
    // V9: Property manager / third-party caller
    site_contact_name: state.siteContactName,
    site_contact_phone: state.siteContactPhone,
    is_third_party: state.isThirdParty,
    third_party_type: state.thirdPartyType,
    // V10: Enrichment fields
    call_type: callTypeResult.callType,
    call_subtype: callTypeResult.callSubtype,
    call_type_confidence: callTypeResult.confidence,
    is_commercial: state.propertyType === "commercial" || tags?.REVENUE?.includes("COMMERCIAL_LEAD") || false,
    sentiment_score: sentimentScore,
    work_type: workType,
    caller_type: callerType,
    primary_intent: primaryIntent,
    card_headline: cardHeadline,
    card_summary: cardSummary,
  };
}

/**
 * Send job data to the dashboard webhook
 */
export async function sendJobToDashboard(
  state: ConversationState,
  retellData?: RetellPostCallData
): Promise<{ success: boolean; jobId?: string; error?: string }> {
  if (!isDashboardConfigured) {
    log.warn({ callId: state.callId }, "Dashboard not configured - skipping sync");
    return { success: false, error: "Dashboard not configured" };
  }

  const payload = transformToDashboardPayload(state, retellData);

  log.info(
    {
      callId: state.callId,
      phone: maskPhone(payload.customer_phone),
      urgency: payload.urgency,
      hasAppointment: Boolean(payload.scheduled_at),
    },
    "Sending job to dashboard"
  );

  try {
    const response = await fetchWithRetry(
      DASHBOARD_WEBHOOK_URL!,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": DASHBOARD_WEBHOOK_SECRET!,
        },
        body: JSON.stringify(payload),
      },
      { retries: 3, timeout: 15000 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error(
        { callId: state.callId, status: response.status, error: errorText },
        "Dashboard webhook failed"
      );
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json() as { success: boolean; job_id?: string };

    log.info(
      { callId: state.callId, jobId: result.job_id },
      "Job sent to dashboard successfully"
    );

    return { success: true, jobId: result.job_id };
  } catch (error) {
    if (error instanceof FetchError) {
      log.error(
        { callId: state.callId, error: error.message, attempts: error.attempts },
        "Dashboard webhook failed after retries"
      );
      return { success: false, error: error.message };
    }

    log.error({ callId: state.callId, error }, "Dashboard webhook error");
    return { success: false, error: String(error) };
  }
}

/**
 * Check if dashboard integration is enabled
 */
export function isDashboardEnabled(): boolean {
  return isDashboardConfigured;
}

/**
 * Payload for syncing call records to dashboard
 */
export interface DashboardCallPayload {
  call_id: string;
  retell_call_id?: string;
  phone_number: string;
  customer_name?: string;
  started_at: string;
  ended_at?: string;
  duration_seconds?: number;
  direction?: "inbound" | "outbound";
  outcome?: EndCallReason;
  hvac_issue_type?: string;
  urgency_tier?: string;
  problem_description?: string;
  revenue_tier_label?: string;
  revenue_tier_signals?: string[];
  transcript_object?: TranscriptMessage[];  // Structured transcript with speaker labels
  job_id?: string;
  lead_id?: string;
  // V4 Priority color classification
  priority_color?: PriorityColor;
  priority_reason?: string;
  // V8 Booking status
  booking_status?: string;
  caller_type?: string;
  primary_intent?: string;
  // V10: Call type enrichment
  call_type?: string;
  is_commercial?: boolean;
  // Call analysis fields from Retell
  call_summary?: string;
  sentiment?: string;
  user_email: string;
}

/**
 * Send call record to dashboard for history tracking
 */
export async function sendCallToDashboard(
  state: ConversationState,
  retellData?: RetellPostCallData
): Promise<{ success: boolean; callId?: string; error?: string }> {
  if (!isDashboardConfigured) {
    log.warn({ callId: state.callId }, "Dashboard not configured - skipping call sync");
    return { success: false, error: "Dashboard not configured" };
  }

  // Calculate revenue estimate for signals
  const estimate = estimateRevenue(state);

  // Detect priority for call record
  const priority = detectPriority(state, retellData?.transcript, estimate);

  // Calculate duration if we have both start and end times
  let durationSeconds: number | undefined;
  if (retellData?.start_timestamp && retellData?.end_timestamp) {
    durationSeconds = Math.round(
      (retellData.end_timestamp - retellData.start_timestamp) / 1000
    );
  }

  // Get phone from Retell call metadata if not in conversation state
  const callPhoneFromRetell = retellData?.direction === "inbound"
    ? retellData?.from_number
    : retellData?.to_number;

  const payload: DashboardCallPayload = {
    call_id: state.callId,
    retell_call_id: retellData?.call_id,
    phone_number: (state.customerPhone && state.customerPhone !== "auto" && state.customerPhone !== "TBD")
      ? state.customerPhone
      : callPhoneFromRetell || "Unknown",
    customer_name: state.customerName,
    started_at: retellData?.start_timestamp
      ? new Date(retellData.start_timestamp).toISOString()
      : new Date().toISOString(),
    ended_at: retellData?.end_timestamp
      ? new Date(retellData.end_timestamp).toISOString()
      : undefined,
    duration_seconds: durationSeconds,
    direction: state.callDirection || "inbound",
    outcome: state.endCallReason,
    hvac_issue_type: state.hvacIssueType,
    urgency_tier: state.urgencyTier,
    problem_description: state.problemDescription,
    revenue_tier_label: estimate.tierLabel,
    revenue_tier_signals: estimate.signals,
    transcript_object: retellData?.transcript_object,  // Structured transcript with speaker labels
    // V4 Priority classification
    priority_color: priority.color,
    priority_reason: priority.reason,
    // V8 Booking status
    booking_status: state.appointmentBooked ? 'confirmed' : 'not_requested',
    // V10: Call type enrichment
    call_type: deriveCallType(classifyCall(state, retellData?.transcript, retellData?.start_timestamp), state).callType,
    is_commercial: state.propertyType === "commercial",
    // Call analysis from Retell's post-call AI
    call_summary: retellData?.call_analysis?.call_summary,
    sentiment: retellData?.call_analysis?.user_sentiment,
    user_email: DASHBOARD_USER_EMAIL!,
  };

  log.info(
    {
      callId: state.callId,
      phone: maskPhone(payload.phone_number),
      outcome: payload.outcome,
    },
    "Sending call to dashboard"
  );

  try {
    // Build calls webhook URL from jobs webhook URL
    const callsWebhookUrl = DASHBOARD_WEBHOOK_URL!.replace(
      "/api/webhook/jobs",
      "/api/webhook/calls"
    );

    const response = await fetchWithRetry(
      callsWebhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": DASHBOARD_WEBHOOK_SECRET!,
        },
        body: JSON.stringify(payload),
      },
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.warn(
        { callId: state.callId, status: response.status, error: errorText },
        "Call sync to dashboard failed (non-fatal)"
      );
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = (await response.json()) as { success: boolean; call_id?: string };

    log.info(
      { callId: state.callId, dashboardCallId: result.call_id },
      "Call synced to dashboard"
    );

    return { success: true, callId: result.call_id };
  } catch (error) {
    log.warn({ callId: state.callId, error }, "Call sync to dashboard failed (non-fatal)");
    return { success: false, error: String(error) };
  }
}

/**
 * Payload for syncing emergency alerts to dashboard
 */
export interface DashboardAlertPayload {
  alert_id?: string;
  call_id?: string;
  phone_number: string;
  customer_name?: string;
  customer_address?: string;
  urgency_tier?: string;
  problem_description: string;
  sms_sent_at: string;
  sms_message_sid?: string;
  callback_promised_minutes: number;
  user_email: string;
}

/**
 * Send emergency alert to dashboard for tracking
 */
export async function sendEmergencyAlertToDashboard(
  callId: string,
  params: {
    alertId?: string;
    callerPhone: string;
    customerName?: string;
    address?: string;
    urgencyDescription: string;
    callbackMinutes: number;
    smsMessageSid?: string;
  }
): Promise<{ success: boolean; alertId?: string; error?: string }> {
  if (!isDashboardConfigured) {
    log.warn({ callId }, "Dashboard not configured - skipping alert sync");
    return { success: false, error: "Dashboard not configured" };
  }

  const payload: DashboardAlertPayload = {
    alert_id: params.alertId,
    call_id: callId,
    phone_number: params.callerPhone,
    customer_name: params.customerName,
    customer_address: params.address,
    urgency_tier: "Urgent",
    problem_description: params.urgencyDescription,
    sms_sent_at: new Date().toISOString(),
    sms_message_sid: params.smsMessageSid,
    callback_promised_minutes: params.callbackMinutes,
    user_email: DASHBOARD_USER_EMAIL!,
  };

  log.info(
    {
      callId,
      phone: maskPhone(params.callerPhone),
      callbackMinutes: params.callbackMinutes,
    },
    "Sending emergency alert to dashboard"
  );

  try {
    // Build alerts webhook URL from jobs webhook URL
    const alertsWebhookUrl = DASHBOARD_WEBHOOK_URL!.replace(
      "/api/webhook/jobs",
      "/api/webhook/emergency-alerts"
    );

    const response = await fetchWithRetry(
      alertsWebhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": DASHBOARD_WEBHOOK_SECRET!,
        },
        body: JSON.stringify(payload),
      },
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.warn(
        { callId, status: response.status, error: errorText },
        "Alert sync to dashboard failed (non-fatal)"
      );
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = (await response.json()) as { success: boolean; alert_id?: string };

    log.info(
      { callId, dashboardAlertId: result.alert_id },
      "Emergency alert synced to dashboard"
    );

    return { success: true, alertId: result.alert_id };
  } catch (error) {
    log.warn({ callId, error }, "Alert sync to dashboard failed (non-fatal)");
    return { success: false, error: String(error) };
  }
}
