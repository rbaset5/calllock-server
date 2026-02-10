/**
 * Customer History Service
 * Retrieves customer's account history for status inquiries
 */

import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";
import { lookupBookingByPhone } from "./calcom.js";

const log = createModuleLogger("customer-history");

const SUPABASE_URL = process.env.SUPABASE_URL;
// Use service role key to bypass RLS (anon key blocked by row-level security on jobs/calls/customer_notes)
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

/**
 * Call record from Supabase
 */
interface CallRecord {
  call_id: string;
  phone_number?: string;
  started_at: string;
  ended_at?: string;
  outcome?: string;
  hvac_issue_type?: string;
  problem_description?: string;
  urgency_tier?: string;
}

/**
 * Job record from Supabase (used for booking history)
 */
interface JobRecord {
  original_call_id?: string;
  customer_name?: string;
  customer_phone: string;
  customer_address: string;
  service_type?: string;
  scheduled_at?: string;
  status: string;
}

/**
 * Emergency alert record from Supabase
 */
interface EmergencyAlertRecord {
  call_id: string;
  phone_number: string;
  problem_description: string;
  sms_sent_at: string;
  callback_promised_by: string;
}

/**
 * Customer note record from Supabase (operator updates)
 */
interface CustomerNoteRecord {
  id: string;
  phone_number: string;
  note: string;
  created_by?: string;
  created_at: string;
  expires_at?: string;
  is_active: boolean;
}

/**
 * Customer history result returned to the AI
 */
export interface CustomerHistoryResult {
  found: boolean;
  customerName?: string;
  address?: string; // Most recent service address from booking history
  zipCode?: string; // ZIP code extracted from address or booking history
  operatorNotes: string[]; // Active notes from operator to read to customer
  upcomingAppointment?: {
    date: string;
    time: string;
    issue?: string;
    jobId?: string; // For manage_appointment actions
  };
  recentCalls: {
    date: string;
    issue?: string;
    outcome?: string;
  }[];
  pastAppointments: {
    date: string;
    issue?: string;
    status: string;
  }[];
  callbackPromise?: {
    date: string;
    issue?: string;
    promisedBy?: string;
  };
  urgentAlert?: {
    date: string;
    description: string;
    callbackBy: string;
  };
  message: string; // Human-readable summary for AI to speak
}

/**
 * Query Supabase REST API
 */
async function supabaseQuery<T>(
  table: string,
  filters: string
): Promise<T[] | null> {
  if (!isSupabaseConfigured) {
    return null;
  }

  const url = `${SUPABASE_URL}/rest/v1/${table}?${filters}`;

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_KEY!,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
      },
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const error = await response.text();
      log.error({ table, status: response.status, error }, "Supabase query failed");
      return null;
    }

    return (await response.json()) as T[];
  } catch (error) {
    if (error instanceof FetchError) {
      log.error({ table, error: error.message }, "Supabase query failed after retries");
    } else {
      log.error({ table, error }, "Supabase query error");
    }
    return null;
  }
}

const SERVICE_TIMEZONE = "America/Chicago"; // Austin, TX is Central Time

/**
 * Format a date for human reading
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: SERVICE_TIMEZONE,
  });
}

/**
 * Format a time for human reading
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: SERVICE_TIMEZONE,
  });
}

/**
 * Format relative time (e.g., "2 days ago", "last week")
 */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "last week";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return formatDate(isoString);
}

/**
 * Map outcome to human-readable text
 */
function formatOutcome(outcome?: string): string {
  if (!outcome) return "";

  const outcomeMap: Record<string, string> = {
    completed: "booked an appointment",
    wrong_number: "wrong number",
    callback_later: "requested a callback",
    safety_emergency: "reported an emergency",
    urgent_escalation: "urgent issue escalated",
    out_of_area: "out of service area",
    waitlist_added: "added to waitlist",
    customer_hangup: "call ended",
    sales_lead: "discussed replacement options",
    cancelled: "cancelled appointment",
    rescheduled: "rescheduled appointment",
  };

  return outcomeMap[outcome] || outcome;
}

/**
 * Build a human-readable summary message
 */
function buildSummaryMessage(result: CustomerHistoryResult): string {
  const parts: string[] = [];

  // Operator notes first (most important updates)
  if (result.operatorNotes.length > 0) {
    parts.push(`Quick update: ${result.operatorNotes.join(" Also, ")}`);
  }

  // Greeting with name if available
  if (result.customerName) {
    parts.push(`I found your account, ${result.customerName}.`);
  } else {
    parts.push("I found your account.");
  }

  // Upcoming appointment (most important)
  if (result.upcomingAppointment) {
    const { date, time, issue } = result.upcomingAppointment;
    if (issue) {
      parts.push(`You have an appointment scheduled for ${date} at ${time} for ${issue}.`);
    } else {
      parts.push(`You have an appointment scheduled for ${date} at ${time}.`);
    }
  }

  // Recent call history
  if (result.recentCalls.length > 0) {
    const lastCall = result.recentCalls[0];
    const issuePart = lastCall.issue ? ` about ${lastCall.issue}` : "";
    const outcomePart = lastCall.outcome ? ` and ${formatOutcome(lastCall.outcome)}` : "";
    parts.push(`Your last call was ${lastCall.date}${issuePart}${outcomePart}.`);

    if (result.recentCalls.length > 1) {
      parts.push(`You've called us ${result.recentCalls.length} times recently.`);
    }
  }

  // Callback promise (if any)
  if (result.callbackPromise) {
    const issuePart = result.callbackPromise.issue ? ` about ${result.callbackPromise.issue}` : "";
    parts.push(`You called ${result.callbackPromise.date}${issuePart} and were told someone would call back.`);
  }

  // Urgent alert (if any)
  if (result.urgentAlert) {
    parts.push(
      `We had you marked as urgent on ${result.urgentAlert.date} for ${result.urgentAlert.description}. ` +
      `A callback was promised by ${result.urgentAlert.callbackBy}.`
    );
  }

  // If nothing significant found
  if (!result.upcomingAppointment && result.recentCalls.length === 0) {
    return "I don't see any recent calls or upcoming appointments under this number. Would you like to schedule a service visit?";
  }

  return parts.join(" ");
}

/**
 * Get customer history by phone number
 */
export async function getCustomerHistory(phone: string): Promise<CustomerHistoryResult> {
  const normalizedPhone = phone.replace(/[^\d+]/g, "");
  log.info({ phone: maskPhone(phone) }, "Looking up customer history");

  // Start with empty result
  const result: CustomerHistoryResult = {
    found: false,
    operatorNotes: [],
    recentCalls: [],
    pastAppointments: [],
    message: "",
    // address, zipCode, callbackPromise populated below if found
  };

  // 1. Check for active operator notes (highest priority)
  const notes = await supabaseQuery<CustomerNoteRecord>(
    "customer_notes",
    `phone_number=eq.${encodeURIComponent(normalizedPhone)}&is_active=eq.true&order=created_at.desc`
  );

  if (notes && notes.length > 0) {
    result.found = true;
    // Filter out expired notes and extract note text
    const now = new Date();
    result.operatorNotes = notes
      .filter((n) => !n.expires_at || new Date(n.expires_at) > now)
      .map((n) => n.note);
  }

  // 2. Check Cal.com for upcoming appointment (parallel with notes)
  const calResult = await lookupBookingByPhone(phone);
  if (calResult.found && calResult.booking) {
    result.found = true;
    result.upcomingAppointment = {
      date: calResult.booking.date,
      time: calResult.booking.time,
    };
    // Use attendee name from Cal.com as early fallback
    // Will be overridden by Supabase booking name if available (section 3 below)
    if (calResult.booking.attendeeName && !result.customerName) {
      result.customerName = calResult.booking.attendeeName;
    }
  }

  // 2. Get recent calls from Supabase
  const calls = await supabaseQuery<CallRecord>(
    "calls",
    `phone_number=eq.${encodeURIComponent(normalizedPhone)}&select=call_id,phone_number,started_at,ended_at,outcome,hvac_issue_type,problem_description,urgency_tier&order=started_at.desc&limit=5`
  );

  if (calls && calls.length > 0) {
    result.found = true;
    result.recentCalls = calls.map((call) => ({
      date: formatRelativeTime(call.started_at),
      issue: call.hvac_issue_type || call.problem_description || undefined,
      outcome: call.outcome,
    }));

    // Detect unfulfilled callback promises (callback_later outcome within last 3 days)
    const recentCallback = calls.find((call) => {
      if (call.outcome !== "callback_later") return false;
      const callDate = new Date(call.started_at);
      const daysSince = (Date.now() - callDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysSince < 3;
    });

    if (recentCallback) {
      result.callbackPromise = {
        date: formatRelativeTime(recentCallback.started_at),
        issue: recentCallback.hvac_issue_type || recentCallback.problem_description || undefined,
      };
    }
  }

  // 3. Get jobs from Supabase (past and upcoming bookings)
  const jobs = await supabaseQuery<JobRecord>(
    "jobs",
    `customer_phone=eq.${encodeURIComponent(normalizedPhone)}&order=scheduled_at.desc.nulls.last&limit=5`
  );

  if (jobs && jobs.length > 0) {
    result.found = true;

    // Extract customer name from most recent job
    if (jobs[0].customer_name) {
      result.customerName = jobs[0].customer_name;
    }

    // Extract address from most recent job with an address
    const jobWithAddress = jobs.find((j) => j.customer_address && j.customer_address !== "TBD");
    if (jobWithAddress) {
      result.address = jobWithAddress.customer_address;
      // Extract ZIP code from address (5-digit pattern at end)
      const zipMatch = jobWithAddress.customer_address.match(/\b(\d{5})(?:-\d{4})?\b/);
      if (zipMatch) {
        result.zipCode = zipMatch[1];
      }
    }

    // If we have an upcoming appointment from Cal.com, add the issue from job
    if (result.upcomingAppointment && jobs[0].service_type) {
      const upcomingJob = jobs.find(
        (j) => j.scheduled_at && new Date(j.scheduled_at) > new Date()
      );
      if (upcomingJob) {
        result.upcomingAppointment.issue = upcomingJob.service_type;
      }
    }

    // Check for upcoming appointments in Supabase jobs (supplement Cal.com)
    if (!result.upcomingAppointment) {
      const upcomingJob = jobs.find(
        (j) => j.scheduled_at && new Date(j.scheduled_at) > new Date()
      );
      if (upcomingJob && upcomingJob.scheduled_at) {
        result.upcomingAppointment = {
          date: formatDate(upcomingJob.scheduled_at),
          time: formatTime(upcomingJob.scheduled_at),
          issue: upcomingJob.service_type,
          jobId: upcomingJob.original_call_id,
        };
      }
    }

    // Add past appointments
    result.pastAppointments = jobs
      .filter((j) => j.scheduled_at && new Date(j.scheduled_at) < new Date())
      .slice(0, 3)
      .map((j) => ({
        date: formatDate(j.scheduled_at!),
        issue: j.service_type,
        status: j.status,
      }));
  }

  // 4. Check for urgent alerts
  const alerts = await supabaseQuery<EmergencyAlertRecord>(
    "emergency_alerts",
    `phone_number=eq.${encodeURIComponent(normalizedPhone)}&order=sms_sent_at.desc&limit=1`
  );

  if (alerts && alerts.length > 0) {
    const alert = alerts[0];
    // Only show alerts from the last 7 days
    const alertDate = new Date(alert.sms_sent_at);
    const daysSinceAlert = (Date.now() - alertDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceAlert < 7) {
      result.urgentAlert = {
        date: formatRelativeTime(alert.sms_sent_at),
        description: alert.problem_description,
        callbackBy: formatTime(alert.callback_promised_by),
      };
    }
  }

  // Build the summary message
  result.message = buildSummaryMessage(result);

  log.info(
    {
      phone: maskPhone(phone),
      found: result.found,
      hasAppointment: Boolean(result.upcomingAppointment),
      hasAddress: Boolean(result.address),
      hasCallbackPromise: Boolean(result.callbackPromise),
      callCount: result.recentCalls.length,
      notesCount: result.operatorNotes.length,
    },
    "Customer history lookup complete"
  );

  return result;
}
