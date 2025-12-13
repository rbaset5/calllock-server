/**
 * Dashboard Integration Service
 * Sends call data to the CallLock Dashboard webhook
 */

import { ConversationState, UrgencyTier, EndCallReason, RetellPostCallData, RevenueTier } from "../types/retell.js";
import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";
import { estimateRevenue, RevenueEstimate } from "./revenue-estimation.js";

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
export interface DashboardJobPayload {
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  service_type: "hvac" | "plumbing" | "electrical" | "general";
  urgency: "low" | "medium" | "high" | "emergency";
  ai_summary?: string;
  scheduled_at?: string;
  call_transcript?: string;
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
  const parts: string[] = [];

  // Include Retell's AI-generated summary if available
  if (retellData?.call_analysis?.call_summary) {
    parts.push(retellData.call_analysis.call_summary);
  }

  // Include problem description
  if (state.problemDescription) {
    parts.push(`Issue: ${state.problemDescription}`);
  }

  // Include diagnostic context fields from Problem Clarification phase
  if (state.problemDuration) {
    parts.push(`Duration: ${state.problemDuration}`);
  }
  if (state.problemOnset) {
    parts.push(`Onset: ${state.problemOnset}`);
  }
  if (state.problemPattern) {
    parts.push(`Pattern: ${state.problemPattern}`);
  }
  if (state.customerAttemptedFixes) {
    parts.push(`Tried: ${state.customerAttemptedFixes}`);
  }

  // Include equipment details if captured (formatted nicely)
  const equipmentParts: string[] = [];
  if (state.equipmentBrand) equipmentParts.push(state.equipmentBrand);
  if (state.equipmentType) equipmentParts.push(state.equipmentType);
  if (state.equipmentLocation || state.equipmentAge) {
    const details: string[] = [];
    if (state.equipmentLocation) details.push(state.equipmentLocation);
    if (state.equipmentAge) details.push(state.equipmentAge);
    equipmentParts.push(`(${details.join(", ")})`);
  }
  if (equipmentParts.length > 0) {
    parts.push(`Equipment: ${equipmentParts.join(" ")}`);
  }

  // Include HVAC issue type
  if (state.hvacIssueType) {
    parts.push(`Type: ${state.hvacIssueType}`);
  }

  // Include call outcome
  if (state.endCallReason) {
    const outcomeMap: Record<EndCallReason, string> = {
      completed: "Appointment booked",
      wrong_number: "Wrong number",
      callback_later: "Customer requested callback",
      safety_emergency: "SAFETY EMERGENCY - Customer advised to call 911",
      urgent_escalation: "Urgent - Escalated to on-call technician",
      out_of_area: "Out of service area",
      waitlist_added: "Added to waitlist",
      customer_hangup: "Customer hung up",
      sales_lead: "Sales lead - Replacement inquiry",
      cancelled: "Appointment cancelled",
      rescheduled: "Appointment rescheduled",
    };
    parts.push(`Outcome: ${outcomeMap[state.endCallReason] || state.endCallReason}`);
  }

  // Include flags
  if (state.isSafetyEmergency) {
    parts.push("⚠️ SAFETY EMERGENCY");
  }
  if (state.isUrgentEscalation) {
    parts.push("🔴 URGENT ESCALATION");
  }

  return parts.join(" | ") || "No summary available";
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

/**
 * Transform conversation state to dashboard payload
 */
export function transformToDashboardPayload(
  state: ConversationState,
  retellData?: RetellPostCallData
): DashboardJobPayload {
  // Calculate revenue estimate
  const estimate = estimateRevenue(state);

  // For sales leads, create a descriptive title from equipment info
  const issueDescription = state.endCallReason === "sales_lead"
    ? buildSalesLeadTitle(state.equipmentType, state.equipmentAge)
    : state.problemDescription;

  // Get midpoint value for backwards compatibility
  const estimatedValue = getMidpointValue(estimate.tier);

  return {
    customer_name: state.customerName || state.customerPhone || "Unknown Caller",
    customer_phone: state.customerPhone || "Unknown",
    customer_address: state.serviceAddress || "Not provided",
    service_type: "hvac", // Always HVAC for this system
    urgency: mapUrgencyToDashboard(state.urgencyTier, state.endCallReason),
    ai_summary: buildAiSummary(state, retellData),
    scheduled_at: state.appointmentDateTime,
    call_transcript: retellData?.transcript,
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
  job_id?: string;
  lead_id?: string;
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

  // Calculate duration if we have both start and end times
  let durationSeconds: number | undefined;
  if (retellData?.start_timestamp && retellData?.end_timestamp) {
    durationSeconds = Math.round(
      (retellData.end_timestamp - retellData.start_timestamp) / 1000
    );
  }

  const payload: DashboardCallPayload = {
    call_id: state.callId,
    retell_call_id: retellData?.call_id,
    phone_number: state.customerPhone || "Unknown",
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
