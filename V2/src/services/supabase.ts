/**
 * Supabase Persistence Layer
 * Stores call records, bookings, and emergency alerts for analytics and auditing
 */

import { ConversationState, EmergencyAlertParams } from "../types/retell.js";
import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

const log = createModuleLogger("supabase");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Check if Supabase is configured
const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

if (!isSupabaseConfigured) {
  log.info("Not configured - data persistence disabled");
}

/**
 * Database Types
 */
interface CallRecord {
  call_id: string;
  phone_number?: string;
  started_at: string;
  ended_at?: string;
  duration_seconds?: number;
  outcome?: string;
  hvac_issue_type?: string;
  urgency_tier?: string;
  [key: string]: unknown;
}

interface BookingRecord {
  call_id: string;
  customer_name?: string;
  phone: string;
  address: string;
  hvac_issue_type?: string;
  problem_description?: string;
  scheduled_time: string;
  calcom_booking_id?: string;
  status: string;
  [key: string]: unknown;
}

interface EmergencyAlertRecord {
  call_id: string;
  urgency_tier: string;
  phone_number: string;
  problem_description: string;
  sms_sent_at: string;
  callback_promised_by: string;
  [key: string]: unknown;
}

interface CallSessionRecord {
  call_id: string;
  conversation_state: ConversationState;
  retell_data?: Record<string, unknown>;
  synced_to_dashboard: boolean;
  created_at?: string;
}

/**
 * Make a Supabase API request with retry
 */
async function supabaseRequest<T>(
  table: string,
  method: "GET" | "POST" | "PATCH",
  data?: Record<string, unknown>,
  filters?: string,
  options?: { upsert?: boolean }
): Promise<T | null> {
  if (!isSupabaseConfigured) {
    return null;
  }

  const url = `${SUPABASE_URL}/rest/v1/${table}${filters ? `?${filters}` : ""}`;

  try {
    const response = await fetchWithRetry(
      url,
      {
        method,
        headers: {
          apikey: SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: method === "POST"
            ? (options?.upsert ? "return=representation,resolution=merge-duplicates" : "return=representation")
            : "return=minimal",
        },
        body: data ? JSON.stringify(data) : undefined,
      },
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const error = await response.text();
      log.error({ method, table, status: response.status, error }, "Request failed");
      return null;
    }

    if (
      method === "GET" ||
      (method === "POST" && response.headers.get("Content-Length") !== "0")
    ) {
      return (await response.json()) as T;
    }

    return null;
  } catch (error) {
    if (error instanceof FetchError) {
      log.error({ method, table, error: error.message, attempts: error.attempts }, "Request failed after retries");
    } else {
      log.error({ method, table, error }, "Request error");
    }
    return null;
  }
}

/**
 * Save a call record when call starts
 */
export async function saveCallStart(
  callId: string,
  phoneNumber?: string
): Promise<void> {
  if (!isSupabaseConfigured) return;

  const record: CallRecord = {
    call_id: callId,
    phone_number: phoneNumber,
    started_at: new Date().toISOString(),
  };

  await supabaseRequest("calls", "POST", record);
  log.info({ callId, phone: maskPhone(phoneNumber) }, "Call start saved");
}

/**
 * Update call record when call ends
 */
export async function saveCallEnd(state: ConversationState): Promise<void> {
  if (!isSupabaseConfigured) return;

  const updates = {
    ended_at: new Date().toISOString(),
    outcome: state.endCallReason || "unknown",
    hvac_issue_type: state.hvacIssueType,
    urgency_tier: state.urgencyTier,
  };

  await supabaseRequest(
    "calls",
    "PATCH",
    updates,
    `call_id=eq.${encodeURIComponent(state.callId)}`
  );
  log.info({ callId: state.callId, outcome: updates.outcome }, "Call end saved");
}

/**
 * Save a booking record
 */
export async function saveBooking(
  callId: string,
  state: ConversationState
): Promise<void> {
  if (!isSupabaseConfigured) return;

  if (!state.appointmentBooked || !state.customerPhone || !state.serviceAddress) {
    return;
  }

  const record: BookingRecord = {
    call_id: callId,
    customer_name: state.customerName,
    phone: state.customerPhone,
    address: state.serviceAddress,
    hvac_issue_type: state.hvacIssueType,
    problem_description: state.problemDescription,
    scheduled_time: state.appointmentDateTime || new Date().toISOString(),
    calcom_booking_id: state.appointmentId,
    status: "confirmed",
  };

  await supabaseRequest("bookings", "POST", record);
  log.info({ callId, phone: maskPhone(state.customerPhone) }, "Booking saved");
}

/**
 * Save an emergency alert record
 */
export async function saveEmergencyAlert(
  callId: string,
  params: EmergencyAlertParams
): Promise<void> {
  if (!isSupabaseConfigured) return;

  const now = new Date();
  const callbackTime = new Date(
    now.getTime() + params.callbackMinutes * 60 * 1000
  );

  const record: EmergencyAlertRecord = {
    call_id: callId,
    urgency_tier: "Urgent",
    phone_number: params.callerPhone,
    problem_description: params.urgencyDescription,
    sms_sent_at: now.toISOString(),
    callback_promised_by: callbackTime.toISOString(),
  };

  await supabaseRequest("emergency_alerts", "POST", record);
  log.info({ callId, phone: maskPhone(params.callerPhone) }, "Emergency alert saved");
}

/**
 * Get call history for a phone number (for future analytics)
 */
export async function getCallHistory(
  phoneNumber: string,
  limit: number = 10
): Promise<CallRecord[]> {
  if (!isSupabaseConfigured) return [];

  const result = await supabaseRequest<CallRecord[]>(
    "calls",
    "GET",
    undefined,
    `phone_number=eq.${encodeURIComponent(phoneNumber)}&order=started_at.desc&limit=${limit}`
  );

  return result || [];
}

/**
 * Save a call session for post-call webhook processing
 * This stores the full conversation state so it can be retrieved
 * when Retell's post-call webhook fires (after the WebSocket closes)
 */
export async function saveCallSession(state: ConversationState): Promise<void> {
  if (!isSupabaseConfigured) {
    log.warn({ callId: state.callId }, "Supabase not configured - session not persisted");
    return;
  }

  const record: CallSessionRecord = {
    call_id: state.callId,
    conversation_state: state,
    synced_to_dashboard: false,
  };

  await supabaseRequest("call_sessions", "POST", record as unknown as Record<string, unknown>, undefined, { upsert: true });
  log.info({ callId: state.callId }, "Call session saved for post-call processing");
}

/**
 * Retrieve a call session by call ID
 */
export async function getCallSession(callId: string): Promise<ConversationState | null> {
  if (!isSupabaseConfigured) return null;

  const result = await supabaseRequest<CallSessionRecord[]>(
    "call_sessions",
    "GET",
    undefined,
    `call_id=eq.${encodeURIComponent(callId)}&select=conversation_state,synced_to_dashboard`
  );

  if (result && result.length > 0) {
    const state = result[0].conversation_state;
    state.syncedToDashboard = result[0].synced_to_dashboard;
    log.info({ callId }, "Call session retrieved");
    return state;
  }

  log.warn({ callId }, "Call session not found");
  return null;
}

/**
 * Update call session with Retell post-call data and mark as synced
 */
export async function updateCallSessionSynced(
  callId: string,
  retellData?: Record<string, unknown>
): Promise<void> {
  if (!isSupabaseConfigured) return;

  const updates: Record<string, unknown> = {
    synced_to_dashboard: true,
  };

  if (retellData) {
    updates.retell_data = retellData;
  }

  await supabaseRequest(
    "call_sessions",
    "PATCH",
    updates,
    `call_id=eq.${encodeURIComponent(callId)}`
  );
  log.info({ callId }, "Call session marked as synced");
}

/**
 * SQL to create tables in Supabase:
 *
 * -- Call history
 * CREATE TABLE calls (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   call_id TEXT NOT NULL UNIQUE,
 *   phone_number TEXT,
 *   started_at TIMESTAMPTZ NOT NULL,
 *   ended_at TIMESTAMPTZ,
 *   duration_seconds INTEGER,
 *   outcome TEXT,
 *   hvac_issue_type TEXT,
 *   urgency_tier TEXT,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * -- Booking records
 * CREATE TABLE bookings (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   call_id TEXT NOT NULL REFERENCES calls(call_id),
 *   customer_name TEXT,
 *   phone TEXT NOT NULL,
 *   address TEXT NOT NULL,
 *   hvac_issue_type TEXT,
 *   problem_description TEXT,
 *   scheduled_time TIMESTAMPTZ NOT NULL,
 *   calcom_booking_id TEXT,
 *   status TEXT NOT NULL,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * -- Emergency alerts
 * CREATE TABLE emergency_alerts (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   call_id TEXT NOT NULL REFERENCES calls(call_id),
 *   urgency_tier TEXT NOT NULL,
 *   phone_number TEXT NOT NULL,
 *   problem_description TEXT NOT NULL,
 *   sms_sent_at TIMESTAMPTZ NOT NULL,
 *   callback_promised_by TIMESTAMPTZ NOT NULL,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * -- Call sessions (for dashboard integration)
 * CREATE TABLE call_sessions (
 *   call_id TEXT PRIMARY KEY,
 *   conversation_state JSONB NOT NULL,
 *   retell_data JSONB,
 *   synced_to_dashboard BOOLEAN DEFAULT FALSE,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * -- Enable Row Level Security
 * ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
 * ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
 * ALTER TABLE emergency_alerts ENABLE ROW LEVEL SECURITY;
 * ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
 */
