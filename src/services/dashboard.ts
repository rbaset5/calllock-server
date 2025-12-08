/**
 * Dashboard Integration Service
 * Sends call data to the CallLock Dashboard webhook
 */

import { ConversationState, UrgencyTier, EndCallReason, RetellPostCallData } from "../types/retell.js";
import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

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
      human_callback_requested: "Customer requested human callback",
      complaint_escalation: "Complaint - Escalated to management",
      maintenance_booked: "Maintenance appointment booked",
      second_opinion_booked: "Second opinion appointment booked",
      new_install_lead: "New install lead - Sales follow-up",
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
 * Transform conversation state to dashboard payload
 */
export function transformToDashboardPayload(
  state: ConversationState,
  retellData?: RetellPostCallData
): DashboardJobPayload {
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
