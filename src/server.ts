import "dotenv/config";
import express, { Request, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import {
  ConversationState,
  RetellPostCallWebhook,
  RetellPostCallData,
  UrgencyLevel,
  EndCallReason,
} from "./types/retell.js";
import {
  lookupBookingByPhone,
  cancelBooking,
  rescheduleBooking,
} from "./services/calcom.js";
import { saveCallSession, getCallSession, updateCallSessionSynced } from "./services/supabase.js";
import { sendJobToDashboard, isDashboardEnabled, sendCallToDashboard, sendEmergencyAlertToDashboard } from "./services/dashboard.js";
import {
  checkCalendarAvailability,
  bookAppointment,
  validateServiceArea,
} from "./functions/index.js";
import { sendEmergencyAlert, sendSalesLeadAlert } from "./services/alerts.js";
import { getCustomerHistory } from "./services/customer-history.js";

// Infrastructure imports
import { logger, maskPhone } from "./utils/logger.js";
import { runHealthChecks } from "./utils/health.js";
import { apiKeyAuth, retellWebhookAuth } from "./middleware/auth.js";
import {
  validate,
  lookupRequestSchema,
  cancelRequestSchema,
  rescheduleRequestSchema,
  phoneSchema,
} from "./validation/schemas.js";

// ===========================================
// Startup Validation
// ===========================================

function validateEnvironment(): void {
  // Enforce required security variables
  const required = ["API_SECRET_KEY", "RETELL_API_KEY"];
  const missingRequired = required.filter((key) => !process.env[key]);
  if (missingRequired.length > 0) {
    logger.fatal({ missing: missingRequired }, "Missing required security environment variables. Shutting down.");
    process.exit(1);
  }

  // Warn about optional but recommended variables
  const recommended = ["BUSINESS_NAME", "SERVICE_AREA"];
  const missingRecommended = recommended.filter((key) => !process.env[key]);
  if (missingRecommended.length > 0) {
    logger.warn({ missing: missingRecommended }, "Missing recommended environment variables");
  }

  // Warn if emergency escalation is not configured
  if (!process.env.ON_CALL_PHONE_NUMBER && !process.env.EMERGENCY_SMS_NUMBER) {
    logger.warn("No emergency escalation configured (ON_CALL_PHONE_NUMBER or EMERGENCY_SMS_NUMBER)");
  }

  logger.info("Environment validation passed");
}

// Run validation before starting
validateEnvironment();

const app = express();
const PORT = process.env.PORT || 8080;

// ===========================================
// Security Middleware
// ===========================================

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // API only - no HTML
    crossOriginEmbedderPolicy: false,
  })
);

// Request size limits (increased for Retell post-call webhooks with transcripts)
app.use(express.json({ limit: "1mb" }));

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window per IP
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===========================================
// Health Check Endpoints
// ===========================================

// Simple health check (for load balancer)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Detailed health check with dependency status
app.get("/health/detailed", async (_req: Request, res: Response) => {
  const health = await runHealthChecks();
  const statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503;
  res.status(statusCode).json(health);
});

// ============================================
// Cal.com Booking Management REST Endpoints
// ============================================

// Apply rate limiting and auth to all /api routes
app.use("/api", apiLimiter, apiKeyAuth);

/**
 * Look up a booking by phone number (GET)
 */
app.get("/api/bookings/lookup", async (req: Request, res: Response) => {
  const phone = req.query.phone as string;

  // Validate phone number
  const phoneResult = phoneSchema.safeParse(phone);
  if (!phoneResult.success) {
    return res.status(400).json({
      error: "Invalid phone number",
      details: phoneResult.error.issues.map((issue) => issue.message),
    });
  }

  logger.info({ phone: maskPhone(phone) }, "Booking lookup requested");
  const result = await lookupBookingByPhone(phone);
  res.json(result);
});

/**
 * Look up a booking by phone number (POST - for Retell webhook)
 */
app.post("/api/bookings/lookup", async (req: Request, res: Response) => {
  const validation = validate(lookupRequestSchema, req.body);

  if (!validation.success) {
    return res.status(400).json({ error: "Validation failed", details: validation.errors });
  }

  const { phone } = validation.data!;
  logger.info({ phone: maskPhone(phone) }, "Booking lookup requested");
  const result = await lookupBookingByPhone(phone);
  res.json(result);
});

/**
 * Cancel a booking
 */
app.post("/api/bookings/cancel", async (req: Request, res: Response) => {
  const validation = validate(cancelRequestSchema, req.body);

  if (!validation.success) {
    return res.status(400).json({ error: "Validation failed", details: validation.errors });
  }

  const { booking_uid, reason } = validation.data!;
  logger.info({ bookingUid: booking_uid }, "Booking cancellation requested");
  const result = await cancelBooking(booking_uid, reason);
  res.json(result);
});

/**
 * Reschedule a booking
 */
app.post("/api/bookings/reschedule", async (req: Request, res: Response) => {
  const validation = validate(rescheduleRequestSchema, req.body);

  if (!validation.success) {
    return res.status(400).json({ error: "Validation failed", details: validation.errors });
  }

  const { booking_uid, new_start_time } = validation.data!;
  logger.info({ bookingUid: booking_uid }, "Booking reschedule requested");
  const result = await rescheduleBooking(booking_uid, new_start_time);
  res.json(result);
});

// ============================================
// Retell Post-Call Webhook (Dashboard Integration)
// ============================================

/**
 * Map urgency level string from post-call analysis to UrgencyLevel type
 */
function mapUrgencyLevelFromAnalysis(urgencyLevel?: string): UrgencyLevel | undefined {
  if (!urgencyLevel) return undefined;
  const normalized = urgencyLevel.toLowerCase();
  if (normalized.includes("emergency")) return "Emergency";
  if (normalized.includes("urgent")) return "Urgent";
  if (normalized.includes("routine")) return "Routine";
  if (normalized.includes("estimate")) return "Estimate";
  return undefined;
}

/**
 * Extract address from transcript using regex (fallback when custom analysis unavailable)
 */
function extractAddressFromTranscript(transcript?: string): string | undefined {
  if (!transcript) return undefined;
  const addressMatch = transcript.match(
    /(\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Court|Ct|Lane|Ln|Way|Boulevard|Blvd)[,\s]+[\w\s]+,?\s*(?:Texas|TX)?\s*\d{5})/i
  );
  return addressMatch ? addressMatch[1].trim() : undefined;
}

/**
 * Map Retell's disconnection_reason to our EndCallReason
 * Retell uses reasons like: "user_hangup", "agent_hangup", "call_transfer", "voicemail", "inactivity", etc.
 */
function mapDisconnectionReason(reason?: string): EndCallReason | undefined {
  if (!reason) return undefined;

  const lowered = reason.toLowerCase();

  // Customer hung up before conversation completed
  if (lowered.includes("user_hangup") || lowered.includes("customer_hangup") || lowered === "hangup") {
    return "customer_hangup";
  }

  // Call went to voicemail - treat as callback_later (they need to call back)
  if (lowered.includes("voicemail")) {
    return "callback_later";
  }

  // Other reasons don't map to our specific end call reasons
  return undefined;
}

/**
 * Extract conversation state from post-call webhook data
 * Uses Retell's custom_analysis_data when available (AI-extracted fields)
 * Falls back to basic extraction for older calls or when analysis unavailable
 */
function extractStateFromPostCallData(callData: RetellPostCallData): ConversationState {
  const custom = callData.call_analysis?.custom_analysis_data;

  // Extract phone from caller ID based on call direction
  const customerPhone = callData.direction === "inbound"
    ? callData.from_number
    : callData.to_number;

  // Prefer custom analysis data, fall back to regex for address
  const serviceAddress = custom?.service_address || extractAddressFromTranscript(callData.transcript);

  // Determine if appointment was booked based on call analysis
  const appointmentBooked = callData.call_analysis?.call_successful === true;

  // Determine end call reason from Retell's disconnection_reason
  const endCallReason = mapDisconnectionReason(callData.disconnection_reason);

  return {
    callId: callData.call_id,
    // Customer info - prefer custom analysis
    customerName: custom?.customer_name,
    customerPhone,
    serviceAddress,
    // Problem details - prefer custom analysis, fall back to summary
    problemDescription: custom?.problem_description || callData.call_analysis?.call_summary,
    problemDuration: custom?.problem_duration,
    problemPattern: custom?.problem_pattern,
    // Equipment details from custom analysis
    equipmentType: custom?.equipment_type,
    equipmentBrand: custom?.equipment_brand,
    equipmentAge: custom?.equipment_age,
    // Urgency from custom analysis
    urgency: mapUrgencyLevelFromAnalysis(custom?.urgency_level),
    // Call metadata
    callDirection: callData.direction,
    appointmentBooked,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
    // End call reason from disconnection
    endCallReason,
  };
}

/**
 * Handle Retell's post-call webhook
 * This fires after the call ends AND audio processing is complete
 * We use this to send call data to the CallLock Dashboard
 */
app.post("/webhook/retell/call-ended", async (req: Request, res: Response) => {
  try {
    const payload = req.body as RetellPostCallWebhook;

    // Validate we have the expected structure
    if (!payload.call?.call_id) {
      logger.warn("Post-call webhook received without call_id");
      return res.status(400).json({ error: "Missing call_id" });
    }

    const callId = payload.call.call_id;
    logger.info(
      {
        callId,
        event: payload.event,
        callStatus: payload.call.call_status,
        hasSummary: Boolean(payload.call.call_analysis?.call_summary),
        hasTranscript: Boolean(payload.call.transcript),
      },
      "Retell post-call webhook received"
    );

    // Check if dashboard integration is enabled
    if (!isDashboardEnabled()) {
      logger.info({ callId }, "Dashboard not configured - skipping sync");
      return res.json({ success: true, message: "Dashboard not configured" });
    }

    // Retrieve the saved conversation state, or extract from webhook data
    let conversationState = await getCallSession(callId);

    if (!conversationState) {
      // No saved session - extract data from post-call webhook payload
      logger.info({ callId }, "No session found, extracting from webhook data");
      conversationState = extractStateFromPostCallData(payload.call);
    } else if (!conversationState.endCallReason && payload.call.disconnection_reason) {
      // We have a saved session but no explicit end call reason was set
      // This means the AI didn't call endCall - customer likely hung up
      const mappedReason = mapDisconnectionReason(payload.call.disconnection_reason);
      if (mappedReason) {
        logger.info(
          { callId, disconnectionReason: payload.call.disconnection_reason, mappedReason },
          "Setting end call reason from disconnection_reason"
        );
        conversationState.endCallReason = mappedReason;
      }
    }

    // Send to dashboard (job/lead)
    const dashboardResult = await sendJobToDashboard(conversationState, payload.call);

    // Also sync call record to dashboard for history tracking (non-blocking)
    sendCallToDashboard(conversationState, payload.call).catch((err) => {
      logger.warn({ callId, error: err }, "Call history sync failed (non-fatal)");
    });

    if (dashboardResult.success) {
      // Mark session as synced
      await updateCallSessionSynced(callId, payload.call as unknown as Record<string, unknown>);

      logger.info({ callId, jobId: dashboardResult.jobId }, "Call synced to dashboard");
      return res.json({
        success: true,
        job_id: dashboardResult.jobId,
      });
    } else {
      logger.error({ callId, error: dashboardResult.error }, "Failed to sync call to dashboard");
      return res.status(500).json({
        success: false,
        error: dashboardResult.error,
      });
    }
  } catch (error) {
    logger.error({ error }, "Error processing post-call webhook");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// Webhooks for Retell Built-in LLM Tool Calls
// Each function has its own endpoint
// ============================================

// ALL Retell webhooks must be authenticated
app.use("/webhook/retell", retellWebhookAuth);

interface RetellFunctionWebhook {
  call: {
    call_id: string;
    from_number?: string;
    to_number?: string;
    direction?: "inbound" | "outbound";
    [key: string]: unknown;
  };
  args: Record<string, unknown>;
}

// In-memory state is not used for scalability. State is persisted in Supabase.
// const webhookCallStates = new Map<string, ConversationState>();

/**
 * Get or create conversation state for a call from Supabase
 */
async function getOrCreateWebhookState(call: RetellFunctionWebhook["call"]): Promise<ConversationState> {
  const callId = call.call_id;

  const state = await getCallSession(callId);

  if (state) {
    logger.info({ callId }, "Found existing call session in Supabase");
    return state;
  }

  // Determine call direction and customer phone from caller ID
  const direction = call.direction || (call.from_number ? "inbound" : "outbound");
  const customerPhone = direction === "inbound" ? call.from_number : call.to_number;

  const newState: ConversationState = {
    callId,
    callDirection: direction,
    customerPhone: customerPhone || undefined,
    phoneFromCallerId: Boolean(customerPhone),
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
  };

  // Save the new state to the database
  await saveCallSession(newState);

  logger.info({ callId, direction, hasCallerIdPhone: Boolean(customerPhone) }, "Created new call session in Supabase");

  return newState;
}

/**
 * Validate service area by ZIP code
 */
app.post("/webhook/retell/validate_service_area", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "validate_service_area called");

    const zipCode = args.zip_code as string;
    const result = await validateServiceArea({ zipCode });

    // Track validated ZIP in state (extract from service address later if needed)

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime }, "validate_service_area completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "validate_service_area failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Check calendar availability
 */
app.post("/webhook/retell/check_calendar_availability", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "check_calendar_availability called");

    const urgency = (args.urgency as string) || "Routine";
    const preferredDate = args.preferred_date as string | undefined;
    const result = await checkCalendarAvailability({
      urgency: urgency as UrgencyLevel,
      preferredDate
    });

    // Track urgency in state
    state.urgency = urgency as UrgencyLevel;
    await saveCallSession(state); // Persist state change

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime }, "check_calendar_availability completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "check_calendar_availability failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Book an appointment
 */
app.post("/webhook/retell/book_appointment", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "book_appointment called");

    const bookingUrgency = (args.urgency as string) || "Routine";
    const result = await bookAppointment({
      dateTime: args.date_time as string,
      customerName: args.customer_name as string | undefined,
      customerPhone: args.customer_phone as string,
      serviceAddress: args.service_address as string,
      serviceType: "HVAC",
      urgency: bookingUrgency as UrgencyLevel,
      problemDescription: args.problem_description as string,
    });

    // Track booking details in state
    if (result.success && result.appointmentId) {
      state.appointmentBooked = true;
      state.appointmentId = result.appointmentId;
      state.appointmentDateTime = args.date_time as string;
      state.customerPhone = args.customer_phone as string;
      state.customerName = args.customer_name as string | undefined;
      state.serviceAddress = args.service_address as string;
      state.problemDescription = args.problem_description as string;
      state.urgency = bookingUrgency as UrgencyLevel;
      // Diagnostic context fields from Problem Clarification phase
      state.problemDuration = args.problem_duration as string | undefined;
      state.problemOnset = args.problem_onset as string | undefined;
      state.problemPattern = args.problem_pattern as string | undefined;
      state.customerAttemptedFixes = args.customer_attempted_fixes as string | undefined;
      // Equipment details (captured when customer volunteers)
      state.equipmentType = args.equipment_type as string | undefined;
      state.equipmentBrand = args.equipment_brand as string | undefined;
      state.equipmentLocation = args.equipment_location as string | undefined;
      state.equipmentAge = args.equipment_age as string | undefined;

      await saveCallSession(state); // Persist state change
    }

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime, booked: result.success }, "book_appointment completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "book_appointment failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Lookup existing booking by phone number
 */
app.post("/webhook/retell/lookup_booking", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    // Use phone from args, or fall back to caller ID
    const phone = (args.phone as string) || state.customerPhone;

    if (!phone) {
      return res.json({
        found: false,
        message: "No phone number provided. Please ask the customer for their phone number.",
      });
    }

    logger.info({ callId: state.callId, phone: phone.slice(-4) }, "lookup_booking called");

    const result = await lookupBookingByPhone(phone);

    // Store booking UID in state if found (for subsequent cancel/reschedule)
    if (result.found && result.booking) {
      state.appointmentId = result.booking.uid;
      await saveCallSession(state); // Persist state change
    }

    logger.info({ callId: state.callId, found: result.found, latencyMs: Date.now() - startTime }, "lookup_booking completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "lookup_booking failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Cancel an existing booking
 */
app.post("/webhook/retell/cancel_booking", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    // Use booking_uid from args, or from state (set by lookup_booking)
    const bookingUid = (args.booking_uid as string) || state.appointmentId;

    if (!bookingUid) {
      return res.json({
        success: false,
        message: "No booking found. Please look up the booking first.",
      });
    }

    const reason = (args.reason as string) || "Cancelled via phone";

    logger.info({ callId: state.callId, bookingUid }, "cancel_booking called");

    const result = await cancelBooking(bookingUid, reason);

    // Update state
    if (result.success) {
      state.appointmentBooked = false;
      state.appointmentId = undefined;
      await saveCallSession(state); // Persist state change
    }

    logger.info({ callId: state.callId, success: result.success, latencyMs: Date.now() - startTime }, "cancel_booking completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "cancel_booking failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Reschedule an existing booking to a new time
 */
app.post("/webhook/retell/reschedule_booking", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    // Use booking_uid from args, or from state (set by lookup_booking)
    const bookingUid = (args.booking_uid as string) || state.appointmentId;

    if (!bookingUid) {
      return res.json({
        success: false,
        message: "No booking found. Please look up the booking first.",
      });
    }

    const newDateTime = args.new_date_time as string;
    if (!newDateTime) {
      return res.json({
        success: false,
        message: "No new date/time provided.",
      });
    }

    logger.info({ callId: state.callId, bookingUid, newDateTime }, "reschedule_booking called");

    const result = await rescheduleBooking(bookingUid, newDateTime);

    // Update state
    if (result.success) {
      state.appointmentDateTime = newDateTime;
      await saveCallSession(state); // Persist state change
    }

    logger.info({ callId: state.callId, success: result.success, latencyMs: Date.now() - startTime }, "reschedule_booking completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "reschedule_booking failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Send emergency alert
 */
app.post("/webhook/retell/send_emergency_alert", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "send_emergency_alert called");

    const result = await sendEmergencyAlert({
      urgencyDescription: args.urgency_description as string,
      callerPhone: args.caller_phone as string,
      address: args.address as string,
      callbackMinutes: 15,
    });

    // Sync emergency alert to dashboard for tracking (non-blocking)
    sendEmergencyAlertToDashboard(state.callId, {
      alertId: result.alertId,
      callerPhone: args.caller_phone as string,
      customerName: state.customerName,
      address: args.address as string,
      urgencyDescription: args.urgency_description as string,
      callbackMinutes: 15,
      smsMessageSid: result.alertId,
    }).catch((err) => {
      logger.warn({ callId: state.callId, error: err }, "Emergency alert dashboard sync failed (non-fatal)");
    });

    // Track emergency escalation in state
    state.isUrgentEscalation = true;
    state.customerPhone = args.caller_phone as string;
    state.serviceAddress = args.address as string;
    state.problemDescription = args.urgency_description as string;
    // Diagnostic context fields from Problem Clarification phase
    state.problemDuration = args.problem_duration as string | undefined;
    state.problemOnset = args.problem_onset as string | undefined;
    // Equipment details (captured when customer volunteers)
    state.equipmentType = args.equipment_type as string | undefined;
    state.equipmentLocation = args.equipment_location as string | undefined;

    await saveCallSession(state); // Persist state change

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime }, "send_emergency_alert completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "send_emergency_alert failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * Send sales lead alert - for replacement/new equipment inquiries
 */
app.post("/webhook/retell/send_sales_lead_alert", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "send_sales_lead_alert called");

    const result = await sendSalesLeadAlert({
      customerName: args.customer_name as string | undefined,
      customerPhone: args.customer_phone as string,
      address: args.address as string | undefined,
      currentEquipment: args.current_equipment as string | undefined,
      equipmentAge: args.equipment_age as string | undefined,
      notes: args.notes as string | undefined,
    });

    // Track sales lead in state
    state.customerName = args.customer_name as string | undefined;
    state.customerPhone = args.customer_phone as string;
    state.serviceAddress = args.address as string | undefined;
    state.equipmentType = args.current_equipment as string | undefined;
    state.equipmentAge = args.equipment_age as string | undefined;
    state.salesLeadNotes = args.notes as string | undefined;

    await saveCallSession(state); // Persist state change

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime }, "send_sales_lead_alert completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "send_sales_lead_alert failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});
/**
 * Get customer status/history - allows customers to ask "what's my status?"
 */
app.post("/webhook/retell/get_customer_status", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    // Use phone from args, or fall back to caller ID
    const phone = (args.phone as string) || state.customerPhone;

    if (!phone) {
      return res.json({
        found: false,
        message: "I don't have a phone number to look up. Can you give me the phone number on your account?",
      });
    }

    logger.info({ callId: state.callId, phone: maskPhone(phone) }, "get_customer_status called");

    const result = await getCustomerHistory(phone);

    // Update state with customer name if found
    if (result.customerName && !state.customerName) {
      state.customerName = result.customerName;
      await saveCallSession(state); // Persist state change
    }

    logger.info(
      {
        callId: state.callId,
        found: result.found,
        hasAppointment: Boolean(result.upcomingAppointment),
        latencyMs: Date.now() - startTime,
      },
      "get_customer_status completed"
    );

    return res.json(result);
  } catch (error) {
    logger.error({ error }, "get_customer_status failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * End call - save state to Supabase for dashboard integration
 */
app.post("/webhook/retell/end_call", async (req: Request, res: Response) => {
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);
    const reason = args.reason as string;

    // Update state with end call reason (cast to EndCallReason type)
    state.endCallReason = reason as ConversationState["endCallReason"];
    if (reason === "safety_emergency") {
      state.isSafetyEmergency = true;
    }
    if (reason === "urgent_escalation") {
      state.isUrgentEscalation = true;
    }

    // Capture any customer data collected during the call
    if (args.customer_name) state.customerName = args.customer_name as string;
    if (args.customer_phone) state.customerPhone = args.customer_phone as string;
    if (args.customer_address) state.serviceAddress = args.customer_address as string;
    if (args.problem_description) state.problemDescription = args.problem_description as string;
    if (args.urgency) state.urgency = args.urgency as UrgencyLevel;

    // Capture diagnostic context fields
    if (args.problem_duration) state.problemDuration = args.problem_duration as string;
    if (args.problem_onset) state.problemOnset = args.problem_onset as string;
    if (args.problem_pattern) state.problemPattern = args.problem_pattern as string;
    if (args.customer_attempted_fixes) state.customerAttemptedFixes = args.customer_attempted_fixes as string;

    // Capture equipment details
    if (args.equipment_type) state.equipmentType = args.equipment_type as string;
    if (args.equipment_brand) state.equipmentBrand = args.equipment_brand as string;
    if (args.equipment_location) state.equipmentLocation = args.equipment_location as string;
    if (args.equipment_age) state.equipmentAge = args.equipment_age as string;

    logger.info({ callId: state.callId, reason, state }, "end_call called - saving state");

    // Save state to Supabase for post-call webhook to retrieve
    try {
      await saveCallSession(state);
      logger.info({ callId: state.callId }, "Call state saved to Supabase");
    } catch (saveError) {
      logger.error({ callId: state.callId, error: saveError }, "Failed to save call state to Supabase");
    }

    return res.json({ success: true, reason });
  } catch (error) {
    logger.error({ error }, "end_call failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

// ===========================================
// Start Server
// ===========================================

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "CallLock HVAC Retell Server started");
  logger.info({ healthCheck: `http://localhost:${PORT}/health` }, "Health check ready");

  // Keep-alive ping for Render free tier (prevents spin-down)
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
  if (RENDER_URL) {
    logger.info({ url: RENDER_URL }, "Keep-alive enabled");
    setInterval(async () => {
      try {
        await fetch(`${RENDER_URL}/health`);
        // Quiet success - only log failures
      } catch (error) {
        logger.warn({ error }, "Keep-alive ping failed");
      }
    }, 14 * 60 * 1000); // Every 14 minutes
  }
});

// ===========================================
// Graceful Shutdown
// ===========================================

function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Graceful shutdown initiated");

  // Close HTTP server (stop accepting new connections)
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10000);
}

// Listen for termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
