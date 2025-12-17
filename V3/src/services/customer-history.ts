/**
 * Customer History Service
 * Retrieves customer's account history for status inquiries
 */

import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";
import { lookupBookingByPhone } from "./calcom.js";

const log = createModuleLogger("customer-history");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

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
  urgency_tier?: string;
}

/**
 * Booking record from Supabase
 */
interface BookingRecord {
  call_id: string;
  customer_name?: string;
  phone: string;
  address: string;
  hvac_issue_type?: string;
  problem_description?: string;
  scheduled_time: string;
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
  operatorNotes: string[]; // Active notes from operator to read to customer
  upcomingAppointment?: {
    date: string;
    time: string;
    issue?: string;
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
          apikey: SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
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

/**
 * Format a date for human reading
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
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
  const normalizedPhone = phone.replace(/\D/g, "");
  log.info({ phone: maskPhone(phone) }, "Looking up customer history");

  // Start with empty result
  const result: CustomerHistoryResult = {
    found: false,
    operatorNotes: [],
    recentCalls: [],
    pastAppointments: [],
    message: "",
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
  }

  // 2. Get recent calls from Supabase
  const calls = await supabaseQuery<CallRecord>(
    "calls",
    `phone_number=eq.${encodeURIComponent(normalizedPhone)}&order=started_at.desc&limit=5`
  );

  if (calls && calls.length > 0) {
    result.found = true;
    result.recentCalls = calls.map((call) => ({
      date: formatRelativeTime(call.started_at),
      issue: call.hvac_issue_type,
      outcome: call.outcome,
    }));
  }

  // 3. Get bookings from Supabase (past and upcoming)
  const bookings = await supabaseQuery<BookingRecord>(
    "bookings",
    `phone=eq.${encodeURIComponent(normalizedPhone)}&order=scheduled_time.desc&limit=5`
  );

  if (bookings && bookings.length > 0) {
    result.found = true;

    // Extract customer name from most recent booking
    if (bookings[0].customer_name) {
      result.customerName = bookings[0].customer_name;
    }

    // If we have an upcoming appointment from Cal.com, add the issue from booking
    if (result.upcomingAppointment && bookings[0].problem_description) {
      const upcomingBooking = bookings.find(
        (b) => new Date(b.scheduled_time) > new Date()
      );
      if (upcomingBooking) {
        result.upcomingAppointment.issue = upcomingBooking.problem_description;
      }
    }

    // Add past appointments
    result.pastAppointments = bookings
      .filter((b) => new Date(b.scheduled_time) < new Date())
      .slice(0, 3)
      .map((b) => ({
        date: formatDate(b.scheduled_time),
        issue: b.problem_description,
        status: b.status,
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
      callCount: result.recentCalls.length,
      notesCount: result.operatorNotes.length,
    },
    "Customer history lookup complete"
  );

  return result;
}
