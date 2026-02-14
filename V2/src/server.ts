import "dotenv/config";
import express, { Request, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import {
  ConversationState,
  RetellPostCallWebhook,
  RetellPostCallData,
  UrgencyLevel,
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
import { inferUrgencyFromContext } from "./extraction/urgency.js";
import {
  extractCustomerName,
  extractSafetyEmergency,
  mapUrgencyLevelFromAnalysis,
  extractAddressFromTranscript,
  mapDisconnectionReason,
  extractProblemDuration,
} from "./extraction/post-call.js";
import { incrementStateVisit, isStateLooping } from "./state/conversation-state.js";
import { inferHvacIssueType } from "./extraction/hvac-issue.js";
import { buildCallScorecard } from "./extraction/call-scorecard.js";
import { classifyCall } from "./classification/tags.js";
import { reconcileDynamicVariables } from "./extraction/reconcile-dynvars.js";

// ===========================================
// Test Phone Masking (toggle via MASK_TEST_PHONES env var)
// ===========================================

const MASK_TEST_PHONES = process.env.MASK_TEST_PHONES === "true";
const TEST_PHONE_NUMBERS = new Set(["+12488841980", "+12487391087"]);

/** Replace test phone numbers with a random +1555XXXXXXX number (when enabled) */
function maskTestPhone(phone: string | undefined): string | undefined {
  if (!phone || !MASK_TEST_PHONES) return phone;
  if (TEST_PHONE_NUMBERS.has(phone)) {
    const rand = Math.floor(1_000_000 + Math.random() * 9_000_000);
    return `+1555${rand}`;
  }
  return phone;
}

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
app.use(express.json({
  limit: "1mb",
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));

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

// incrementStateVisit and isStateLooping moved to state/conversation-state.ts

// ============================================
// Retell Webhook Auth (must be before all /webhook/retell routes)
// ============================================

// ALL Retell webhooks must be authenticated
app.use("/webhook/retell", retellWebhookAuth);

// ============================================
// Retell Post-Call Webhook (Dashboard Integration)
// ============================================

// mapUrgencyLevelFromAnalysis, extractAddressFromTranscript, mapDisconnectionReason
// moved to extraction/post-call.ts
// inferHvacIssueType moved to extraction/hvac-issue.ts

// inferUrgencyFromContext moved to extraction/urgency.ts

/**
 * Extract conversation state from post-call webhook data
 * Uses Retell's custom_analysis_data when available (AI-extracted fields)
 * Falls back to basic extraction for older calls or when analysis unavailable
 */
function extractStateFromPostCallData(callData: RetellPostCallData): ConversationState {
  const custom = callData.call_analysis?.custom_analysis_data;
  const dynVars = callData.collected_dynamic_variables;

  // Extract phone from caller ID based on call direction
  const rawPhone = callData.direction === "inbound"
    ? callData.from_number
    : callData.to_number;
  const customerPhone = maskTestPhone(rawPhone);

  // Prefer dynamic variables (LLM state during call) > custom analysis > regex fallback
  let customerName = dynVars?.customer_name || custom?.customer_name;

  // Ghost lead recovery: mine transcript for caller name when dynamic vars are empty
  // Uses extractCustomerName which filters agent utterances to avoid capturing agent's name
  if (!customerName && callData.transcript) {
    customerName = extractCustomerName(callData.transcript);
    if (customerName) {
      logger.info({ callId: callData.call_id, minedName: customerName }, "Mined caller name from transcript");
    }
  }

  let serviceAddress = dynVars?.service_address || custom?.service_address
    || extractAddressFromTranscript(callData.transcript);
  // Prefer dynamic variable descriptions; fall back to call_summary
  const dynProblem = dynVars?.problem_description || dynVars?.problem_summary;
  const callSummary = callData.call_analysis?.call_summary;
  const problemDescription = dynProblem || callSummary || custom?.problem_description;

  // Check if booking was confirmed via dynamic variables
  // book_service sets booking_confirmed=true in the LLM's dynamic variables
  let appointmentBooked = dynVars?.booking_confirmed === "true";
  let appointmentDateTime = dynVars?.appointment_time;

  // Fallback: detect booking from tool call results when dynamic variables are empty.
  // Retell's collected_dynamic_variables is often empty, but transcript_with_tool_calls
  // always contains the book_service result with "booked":true and appointment details.
  if (!appointmentBooked && callData.transcript_with_tool_calls) {
    for (const entry of callData.transcript_with_tool_calls) {
      if (entry.role === "tool_call_result" && entry.successful && entry.content) {
        try {
          const result = JSON.parse(entry.content);
          if (result.booked === true) {
            appointmentBooked = true;
            if (result.appointment_date && result.appointment_time) {
              appointmentDateTime = `${result.appointment_date} at ${result.appointment_time}`;
            }
            logger.info(
              { callId: callData.call_id, appointmentDateTime },
              "Booking detected from tool call result (dynamic variables were empty)"
            );
            break;
          }
        } catch {
          // Not JSON or not a booking result - skip
        }
      }
    }
  }

  // Detect booking ATTEMPTS (even failed ones) from tool invocations
  const bookingAttempted = appointmentBooked || (callData.transcript_with_tool_calls?.some(
    entry => entry.role === "tool_call_invocation" &&
      (entry.name === "book_service" || entry.name === "book_appointment")
  ) || false);
  if (bookingAttempted && !appointmentBooked) {
    logger.info({ callId: callData.call_id }, "Booking attempt detected from tool invocations (may have failed)");
  }

  // Also extract customer name, address, and ZIP from book_service invocation if not already set
  if (!customerName || !serviceAddress) {
    for (const entry of callData.transcript_with_tool_calls || []) {
      if (entry.role === "tool_call_invocation" && entry.name === "book_service" && entry.arguments) {
        try {
          const args = JSON.parse(entry.arguments);
          if (!customerName && args.customer_name) customerName = args.customer_name;
          if (!serviceAddress && args.service_address) serviceAddress = args.service_address;
          // Append ZIP to address so future lookups can extract it
          if (args.zip_code && serviceAddress && !serviceAddress.includes(args.zip_code)) {
            serviceAddress = `${serviceAddress}, ${args.zip_code}`;
          }
        } catch {
          // Not JSON - skip
        }
      }
    }
  }

  // Determine end call reason from Retell's disconnection_reason
  let endCallReason = mapDisconnectionReason(callData.disconnection_reason);

  // If agent hung up, check if booking was made to determine outcome
  if (!endCallReason && callData.disconnection_reason === "agent_hangup") {
    endCallReason = appointmentBooked ? "completed" : "callback_later";
  }

  // Infer HVAC issue type from problem description only (not transcript).
  // The transcript contains safety check "any gas smell?" which falsely matches Odor.
  const hvacIssueType = inferHvacIssueType(problemDescription);

  // Urgency: prefer dynamic variables > custom analysis > inferred from context
  let urgency = mapUrgencyLevelFromAnalysis(dynVars?.urgency_tier || custom?.urgency_level);
  if (!urgency) {
    urgency = inferUrgencyFromContext(problemDescription, callData.transcript);
  }

  // Extract problem duration from transcript as fallback (#38)
  const durationExtraction = extractProblemDuration(callData.transcript);

  return {
    callId: callData.call_id,
    // Customer info - prefer dynamic variables > custom analysis
    customerName,
    customerPhone,
    serviceAddress,
    // Problem details
    problemDescription,
    problemDuration: custom?.problem_duration || durationExtraction?.raw,
    problemDurationCategory: durationExtraction?.category,
    problemPattern: dynVars?.problem_pattern || custom?.problem_pattern,
    // Equipment details from custom analysis
    equipmentType: custom?.equipment_type,
    equipmentBrand: custom?.equipment_brand,
    equipmentAge: custom?.equipment_age,
    // HVAC classification
    hvacIssueType,
    // Urgency - dynamic vars > custom analysis > inferred
    urgency,
    // Call metadata
    callDirection: callData.direction,
    appointmentBooked,
    bookingAttempted,
    appointmentDateTime,
    isSafetyEmergency: extractSafetyEmergency(callData.transcript),
    isUrgentEscalation: false,
    // End call reason from disconnection
    endCallReason,
    // V9: Detect property manager / third-party caller from transcript
    isThirdParty: /property manag|landlord|on behalf of|calling for my tenant/i.test(callData.transcript || ""),
    // Last agent state for dead-end call detection
    lastAgentState: dynVars?.current_agent_state,
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
    const event = payload.event;

    logger.info(
      {
        callId,
        event,
        callStatus: payload.call.call_status,
        hasSummary: Boolean(payload.call.call_analysis?.call_summary),
        hasTranscript: Boolean(payload.call.transcript),
      },
      "Retell webhook received"
    );

    // Only process call_analyzed — it fires after Retell's AI analysis completes
    // and includes call_summary, sentiment, and custom_analysis_data.
    // Skipping call_ended prevents duplicate leads (race condition) and null summaries.
    if (event !== "call_analyzed") {
      logger.info({ callId, event }, "Skipping non-analyzed event");
      return res.json({ success: true, message: `Skipped event: ${event}` });
    }

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
      // This means the AI didn't call endCall webhook (end_call is a built-in Retell tool)
      const mappedReason = mapDisconnectionReason(payload.call.disconnection_reason);
      if (mappedReason) {
        logger.info(
          { callId, disconnectionReason: payload.call.disconnection_reason, mappedReason },
          "Setting end call reason from disconnection_reason"
        );
        conversationState.endCallReason = mappedReason;
      } else if (payload.call.disconnection_reason === "agent_hangup") {
        // Agent hung up without setting explicit reason via webhook
        // (end_call is a built-in Retell tool that doesn't fire webhooks)
        // Match the fallback logic from extractStateFromPostCallData()
        conversationState.endCallReason = conversationState.appointmentBooked ? "completed" : "callback_later";
        logger.info(
          { callId, endCallReason: conversationState.endCallReason, appointmentBooked: conversationState.appointmentBooked },
          "Setting end call reason from agent_hangup fallback"
        );
      }
    }

    // Reconcile dynamic variables into state (fills gaps from sparse sessions)
    reconcileDynamicVariables(conversationState, payload.call.collected_dynamic_variables);

    // Detect bookings made via Retell's built-in Cal.com tool (book_appointment_cal).
    // The built-in tool doesn't fire a webhook to V2, so saved sessions have
    // appointmentBooked=false. Check post-call data for booking evidence.
    if (!conversationState.appointmentBooked) {
      // Check 1: Dynamic variables (Retell may set booking_confirmed)
      const postCallDynVars = payload.call.collected_dynamic_variables;
      if (postCallDynVars?.booking_confirmed === "true") {
        conversationState.appointmentBooked = true;
        conversationState.appointmentDateTime = postCallDynVars.appointment_time;
        conversationState.endCallReason = "completed";
        logger.info({ callId }, "Booking detected from dynamic variables (saved session)");
      }

      // Check 2: Tool call results (scan for booked:true in any tool response)
      if (!conversationState.appointmentBooked && payload.call.transcript_with_tool_calls) {
        for (const entry of payload.call.transcript_with_tool_calls) {
          if (entry.role === "tool_call_result" && entry.successful && entry.content) {
            try {
              const result = JSON.parse(entry.content);
              if (result.booked === true) {
                conversationState.appointmentBooked = true;
                if (result.appointment_date && result.appointment_time) {
                  conversationState.appointmentDateTime =
                    `${result.appointment_date} at ${result.appointment_time}`;
                }
                conversationState.endCallReason = "completed";
                logger.info({ callId }, "Booking detected from tool call results (saved session)");
                break;
              }
            } catch {
              // Not JSON or not a booking result — skip
            }
          }
        }
      }
    }

    // Ghost lead detection: log abandoned calls for observability
    const callDuration = payload.call.end_timestamp && payload.call.start_timestamp
      ? (payload.call.end_timestamp - payload.call.start_timestamp) / 1000
      : 0;
    if (
      payload.call.disconnection_reason === "user_hangup" &&
      !conversationState.appointmentBooked &&
      callDuration > 10
    ) {
      logger.info(
        {
          callId,
          duration: callDuration,
          customerName: conversationState.customerName,
          customerPhone: conversationState.customerPhone,
          problemDescription: conversationState.problemDescription,
        },
        "Ghost lead detected - abandoned call with partial data"
      );
    }

    // Dead-end call detection: agent hung up at a scheduling state without booking or callback
    const lastState = conversationState.lastAgentState
      || payload.call.collected_dynamic_variables?.current_agent_state;
    const deadEndStates = ["urgency", "pre_confirm", "booking"];
    if (
      payload.call.disconnection_reason === "agent_hangup" &&
      !conversationState.appointmentBooked &&
      lastState && deadEndStates.includes(lastState)
    ) {
      logger.warn(
        { callId, lastState, customerName: conversationState.customerName },
        "Dead-end call detected — reached scheduling without booking"
      );
      // Ensure end call reason reflects the dead-end (not generic callback_later)
      if (!conversationState.endCallReason || conversationState.endCallReason === "callback_later") {
        conversationState.endCallReason = "callback_later";
      }
      // Flag urgency so dashboard gives RED priority to dead-end calls
      if (!conversationState.urgency || conversationState.urgency === "Routine") {
        conversationState.urgency = "Urgent";
      }
    }

    // Level 1 instrumentation: call quality scorecard
    const tags = classifyCall(conversationState, payload.call.transcript, payload.call.start_timestamp);
    const scorecard = buildCallScorecard(conversationState, tags);
    conversationState.qualityScore = scorecard.score;
    logger.info(
      { callId, score: scorecard.score, fields: scorecard.fields, warnings: scorecard.warnings },
      "Call quality scorecard"
    );

    if (scorecard.warnings.includes("zero-tags")) {
      logger.warn(
        { callId, transcript: Boolean(payload.call.transcript), problemDescription: conversationState.problemDescription },
        "Zero taxonomy tags classified — check transcript quality or tag patterns"
      );
    }

    if (scorecard.warnings.includes("callback-gap")) {
      logger.warn(
        { callId, endCallReason: conversationState.endCallReason, lastAgentState: conversationState.lastAgentState },
        "Callback gap — call ended without booking or callback request"
      );
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
  const rawPhone = direction === "inbound" ? call.from_number : call.to_number;
  const customerPhone = maskTestPhone(rawPhone);
  if (customerPhone !== rawPhone) {
    logger.info({ callId, originalMasked: true }, "Test phone masked for QA — treating as new caller");
  }

  const newState: ConversationState = {
    callId,
    callDirection: direction,
    customerPhone: customerPhone || undefined,
    phoneFromCallerId: Boolean(customerPhone),
    appointmentBooked: false,
    bookingAttempted: false,
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

    // Loop guard (#19)
    incrementStateVisit(state, "book_appointment");
    const shouldForceTransition = isStateLooping(state, "book_appointment");

    const bookingUrgency = (args.urgency as string) || "Routine";

    // Mark that booking was attempted — even if the API call fails,
    // this flag ensures booking_status becomes "attempted_failed" instead of "not_requested"
    state.bookingAttempted = true;
    await saveCallSession(state);

    // Use agent-collected address, fall back to state passthrough from lookup (#18)
    const serviceAddress = (args.service_address as string) || state.serviceAddress || "TBD";
    const result = await bookAppointment({
      dateTime: args.date_time as string,
      customerName: args.customer_name as string | undefined,
      customerPhone: args.customer_phone as string,
      serviceAddress,
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
    return res.json({ ...result, force_transition: shouldForceTransition });
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
    state.endCallReason = "sales_lead";
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
 * Lookup caller - automatic caller recognition at call start
 * Uses caller ID from Retell call metadata to look up history
 * Returns enriched data including address, ZIP, and callback promises
 */
app.post("/webhook/retell/lookup_caller", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    // Use caller ID directly — no args needed
    const phone = state.customerPhone;

    if (!phone) {
      return res.json({
        found: false,
        message: "No caller ID available. Let me get your information.",
      });
    }

    logger.info({ callId: state.callId, phone: maskPhone(phone) }, "lookup_caller called");

    // Loop guard (#19)
    incrementStateVisit(state, "lookup_caller");
    const shouldForceTransition = isStateLooping(state, "lookup_caller");

    const result = await getCustomerHistory(phone);

    // Don't carry forward prior caller data into session state.
    // Each call should extract fresh customer data from its own conversation.
    // The lookup result is returned to the AI agent for conversational context
    // only — it must NOT contaminate the webhook payload with stale data
    // (e.g. Person A's name when Person B calls from the same phone).
    //
    // Exception: store address in state for booking passthrough (#18 privacy).
    // The address is stripped from the agent-visible response below, but the
    // booking handler needs it as a fallback when the agent doesn't collect one.
    if (result.address) {
      state.serviceAddress = result.address;
    }
    if (result.found) {
      await saveCallSession(state);
    }

    logger.info(
      {
        callId: state.callId,
        found: result.found,
        hasAppointment: Boolean(result.upcomingAppointment),
        hasAddress: Boolean(result.address),
        hasCallbackPromise: Boolean(result.callbackPromise),
        latencyMs: Date.now() - startTime,
      },
      "lookup_caller completed"
    );

    // Strip street address from agent-visible response (#18 privacy)
    // Keep zipCode — needed for service area validation, not a privacy concern
    const { address, ...agentVisibleResult } = result;
    return res.json({ ...agentVisibleResult, force_transition: shouldForceTransition });
  } catch (error) {
    logger.error({ error }, "lookup_caller failed");
    // Graceful fallback — don't block the call if lookup fails
    return res.json({
      found: false,
      message: "I wasn't able to pull up the account — no problem, I can help you from scratch.",
    });
  }
});

/**
 * Manage appointment - reschedule, cancel, or check status of existing booking
 * Used by the manage_booking state for returning callers
 */
app.post("/webhook/retell/manage_appointment", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    const action = args.action as string;
    // Use booking_uid from args, or from state (set by lookup_booking/lookup_caller)
    const bookingUid = (args.booking_uid as string) || state.appointmentId;

    logger.info({ callId: state.callId, action, bookingUid }, "manage_appointment called");

    if (!action) {
      return res.json({
        success: false,
        message: "I need to know what you'd like to do — reschedule, cancel, or check on the appointment.",
      });
    }

    if (action === "status") {
      // Status check — look up the appointment details
      if (!bookingUid) {
        return res.json({
          success: true,
          action_taken: "status",
          message: "I don't have a booking on file to check. Would you like to schedule a new appointment?",
        });
      }
      const lookup = await lookupBookingByPhone(state.customerPhone || "");
      if (lookup.found && lookup.booking) {
        return res.json({
          success: true,
          action_taken: "status",
          message: `Your appointment is still on for ${lookup.booking.date} at ${lookup.booking.time}. The tech will call about 30 minutes before heading over.`,
        });
      }
      return res.json({
        success: true,
        action_taken: "status",
        message: "I'm not finding an active appointment on file. Would you like to set one up?",
      });
    }

    if (action === "cancel") {
      if (!bookingUid) {
        return res.json({
          success: false,
          message: "I don't have a booking on file to cancel.",
        });
      }
      const reason = (args.reason as string) || "Cancelled via phone";
      const result = await cancelBooking(bookingUid, reason);

      if (result.success) {
        state.appointmentBooked = false;
        state.appointmentId = undefined;
        await saveCallSession(state);
      }

      logger.info({ callId: state.callId, success: result.success, latencyMs: Date.now() - startTime }, "manage_appointment cancel completed");
      return res.json({
        success: result.success,
        action_taken: "cancel",
        message: result.success
          ? "Done — your appointment's been cancelled. Call us back anytime if you need to reschedule."
          : "I wasn't able to cancel that on my end. Let me have someone call you back to take care of it.",
      });
    }

    if (action === "reschedule") {
      if (!bookingUid) {
        return res.json({
          success: false,
          message: "I don't have a booking on file to reschedule.",
        });
      }
      const newTime = args.new_time as string;
      if (!newTime) {
        return res.json({
          success: false,
          message: "When would you like to reschedule to?",
        });
      }

      const result = await rescheduleBooking(bookingUid, newTime);

      if (result.success) {
        state.appointmentDateTime = newTime;
        await saveCallSession(state);
      }

      logger.info({ callId: state.callId, success: result.success, latencyMs: Date.now() - startTime }, "manage_appointment reschedule completed");
      return res.json({
        success: result.success,
        action_taken: "reschedule",
        message: result.success
          ? result.message || "Your appointment's been moved. Tech will call 30 minutes before heading over."
          : result.message || "That time didn't work out. Want to try another time?",
      });
    }

    return res.json({
      success: false,
      message: "I can reschedule, cancel, or check on an appointment. Which would you like?",
    });
  } catch (error) {
    logger.error({ error }, "manage_appointment failed");
    return res.json({
      success: false,
      message: "I'm having trouble updating that right now. Want me to have someone call you back?",
    });
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
 * Create callback request - used by follow_up and urgency states
 * Records a callback request and sends immediate SMS notification
 */
app.post("/webhook/retell/create_callback", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = await getOrCreateWebhookState(call);

    const reason = (args.reason as string) || "Customer requested callback";
    const urgency = (args.urgency as string) || "normal";
    const callbackType = (args.callback_type as string) || "service";

    logger.info({ callId: state.callId, reason, urgency, callbackType }, "create_callback called");

    // Loop guard (#19)
    incrementStateVisit(state, "create_callback");
    const shouldForceTransition = isStateLooping(state, "create_callback");

    // Update state with callback request
    state.endCallReason = "callback_later";
    state.callbackType = callbackType as ConversationState["callbackType"];
    if (args.customer_name) state.customerName = args.customer_name as string;
    if (args.issue_description) state.problemDescription = args.issue_description as string;

    await saveCallSession(state);

    // Send immediate SMS notification to business owner
    try {
      const typeLabel = callbackType !== "service" ? `${callbackType.toUpperCase()} callback` : "Callback requested";
      await sendEmergencyAlert({
        urgencyDescription: `${typeLabel}: ${reason}`,
        callerPhone: state.customerPhone || "Unknown",
        address: state.serviceAddress || "Not provided",
        callbackMinutes: urgency === "urgent" ? 30 : 60,
      });
      logger.info({ callId: state.callId }, "Callback SMS notification sent");
    } catch (smsError) {
      logger.warn({ callId: state.callId, error: smsError }, "Callback SMS failed (non-fatal)");
    }

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime }, "create_callback completed");
    return res.json({
      success: true,
      force_transition: shouldForceTransition,
      message: urgency === "urgent"
        ? "Done — I've flagged this as urgent. Someone from the team will reach out as soon as possible."
        : "Done — I've passed this along to the team. They'll reach out as soon as possible.",
    });
  } catch (error) {
    logger.error({ error }, "create_callback failed");
    return res.json({
      success: false,
      message: "I'll make sure someone calls you back today.",
    });
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
