import "dotenv/config";
import express, { Request, Response } from "express";
import expressWs from "express-ws";
import { WebSocket } from "ws";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { createLLMHandler, validateLLMConfig, getLLMProvider } from "./llm/factory.js";
import { LLMHandler } from "./llm/types.js";
import {
  RetellRequest,
  RetellResponse,
  ConfigResponse,
  PingPongResponse,
  ResponseResponse,
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
import { sendJobToDashboard, isDashboardEnabled } from "./services/dashboard.js";
import {
  checkCalendarAvailability,
  bookAppointment,
  validateServiceArea,
} from "./functions/index.js";
import { sendEmergencyAlert } from "./services/alerts.js";

// Infrastructure imports
import { logger, createCallLogger, maskPhone } from "./utils/logger.js";
import { runHealthChecks } from "./utils/health.js";
import { apiKeyAuth } from "./middleware/auth.js";
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
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.fatal({ missing }, "Missing required environment variables");
    process.exit(1);
  }

  // Warn about optional but recommended variables
  const recommended = ["RETELL_API_KEY", "BUSINESS_NAME", "SERVICE_AREA"];
  const missingRecommended = recommended.filter((key) => !process.env[key]);
  if (missingRecommended.length > 0) {
    logger.warn({ missing: missingRecommended }, "Missing recommended environment variables");
  }

  // Warn if emergency escalation is not configured
  if (!process.env.ON_CALL_PHONE_NUMBER && !process.env.EMERGENCY_SMS_NUMBER) {
    logger.warn("No emergency escalation configured (ON_CALL_PHONE_NUMBER or EMERGENCY_SMS_NUMBER)");
  }

  // Warn if API_SECRET_KEY not set (endpoints unprotected)
  if (!process.env.API_SECRET_KEY) {
    logger.warn("API_SECRET_KEY not set - REST endpoints are unprotected");
  }

  logger.info("Environment validation passed");
}

// Run validation before starting
validateEnvironment();

const app = expressWs(express()).app;
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

// Store active conversations
const activeConversations = new Map<string, ConversationState>();

// ===========================================
// Inaudible Speech Detection
// ===========================================

/**
 * Detect if user's speech was inaudible/unclear
 * Retell sends various patterns when it can't transcribe audio
 */
function detectInaudible(text: string): boolean {
  if (!text) return true;

  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return true;

  const inaudiblePatterns = [
    /inaudible/i,
    /^\[.*\]$/,           // bracketed placeholder like [unclear]
    /^\.+$/,              // just dots/periods
    /^\s*$/,              // whitespace only
    /^(um|uh|hmm)\.?$/i,  // just filler sounds
  ];

  return inaudiblePatterns.some(p => p.test(trimmed));
}

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
 * Extract conversation state from post-call webhook data
 * Used when no saved session exists (e.g., user hung up, built-in Cal.com tools used)
 */
function extractStateFromPostCallData(callData: RetellPostCallData): ConversationState {
  // Extract phone from caller ID based on call direction
  const customerPhone = callData.direction === "inbound"
    ? callData.from_number
    : callData.to_number;

  // Try to extract address from transcript (look for address patterns)
  let serviceAddress: string | undefined;
  if (callData.transcript) {
    // Look for common address patterns in transcript
    const addressMatch = callData.transcript.match(
      /(\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Court|Ct|Lane|Ln|Way|Boulevard|Blvd)[,\s]+[\w\s]+,?\s*(?:Texas|TX)?\s*\d{5})/i
    );
    if (addressMatch) {
      serviceAddress = addressMatch[1].trim();
    }
  }

  // Determine if appointment was booked based on call analysis
  const appointmentBooked = callData.call_analysis?.call_successful === true;

  return {
    callId: callData.call_id,
    customerPhone,
    serviceAddress,
    problemDescription: callData.call_analysis?.call_summary,
    callDirection: callData.direction,
    appointmentBooked,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
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
    }

    // Send to dashboard
    const dashboardResult = await sendJobToDashboard(conversationState, payload.call);

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

// Track conversation state across webhook calls (for Retell built-in LLM)
const webhookCallStates = new Map<string, ConversationState>();

/**
 * Get or create conversation state for a call
 */
function getOrCreateWebhookState(call: RetellFunctionWebhook["call"]): ConversationState {
  const callId = call.call_id;

  if (!webhookCallStates.has(callId)) {
    // Determine call direction and customer phone from caller ID
    const direction = call.direction || (call.from_number ? "inbound" : "outbound");
    const customerPhone = direction === "inbound" ? call.from_number : call.to_number;

    webhookCallStates.set(callId, {
      callId,
      callDirection: direction,
      customerPhone: customerPhone || undefined,
      phoneFromCallerId: Boolean(customerPhone),
      appointmentBooked: false,
      isSafetyEmergency: false,
      isUrgentEscalation: false,
    });

    logger.info({ callId, direction, hasCallerIdPhone: Boolean(customerPhone) }, "Created webhook call state");
  }

  return webhookCallStates.get(callId)!;
}

/**
 * Validate service area by ZIP code
 */
app.post("/webhook/retell/validate_service_area", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = getOrCreateWebhookState(call);

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
    const state = getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "check_calendar_availability called");

    const urgency = (args.urgency as string) || "Routine";
    const preferredDate = args.preferred_date as string | undefined;
    const result = await checkCalendarAvailability({
      urgency: urgency as UrgencyLevel,
      preferredDate
    });

    // Track urgency in state
    state.urgency = urgency as UrgencyLevel;

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
    const state = getOrCreateWebhookState(call);

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
    }

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime, booked: result.success }, "book_appointment completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "book_appointment failed");
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
    const state = getOrCreateWebhookState(call);

    logger.info({ callId: state.callId, args }, "send_emergency_alert called");

    const result = await sendEmergencyAlert({
      urgencyDescription: args.urgency_description as string,
      callerPhone: args.caller_phone as string,
      address: args.address as string,
      callbackMinutes: 15,
    });

    // Track emergency escalation in state
    state.isUrgentEscalation = true;
    state.customerPhone = args.caller_phone as string;
    state.serviceAddress = args.address as string;
    state.problemDescription = args.urgency_description as string;

    logger.info({ callId: state.callId, latencyMs: Date.now() - startTime }, "send_emergency_alert completed");
    return res.json(result);
  } catch (error) {
    logger.error({ error }, "send_emergency_alert failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

/**
 * End call - save state to Supabase for dashboard integration
 */
app.post("/webhook/retell/end_call", async (req: Request, res: Response) => {
  try {
    const { call, args } = req.body as RetellFunctionWebhook;
    const state = getOrCreateWebhookState(call);
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

    logger.info({ callId: state.callId, reason, state }, "end_call called - saving state");

    // Save state to Supabase for post-call webhook to retrieve
    try {
      await saveCallSession(state);
      logger.info({ callId: state.callId }, "Call state saved to Supabase");
    } catch (saveError) {
      logger.error({ callId: state.callId, error: saveError }, "Failed to save call state to Supabase");
    }

    // Clean up in-memory state after a delay (give post-call webhook time to fire)
    setTimeout(() => {
      webhookCallStates.delete(state.callId);
      logger.debug({ callId: state.callId }, "Cleaned up webhook call state");
    }, 60000); // 60 second delay

    return res.json({ success: true, reason });
  } catch (error) {
    logger.error({ error }, "end_call failed");
    return res.status(500).json({ error: "Tool execution failed" });
  }
});

// ============================================
// WebSocket Endpoint for Retell LLM
// ============================================

const MAX_WS_MESSAGE_SIZE = 64 * 1024; // 64KB

app.ws("/llm-websocket/:callId?", (ws: WebSocket, req: Request) => {
  const callId = req.params.callId || `call_${Date.now()}`;
  const log = createCallLogger(callId);

  log.info("WebSocket connection established");

  // Initialize conversation state
  const state: ConversationState = {
    callId,
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
  };
  activeConversations.set(callId, state);

  // Initialize LLM handler (Claude or OpenAI based on LLM_PROVIDER)
  const llm: LLMHandler = createLLMHandler(state);

  // Track if we've sent the initial greeting
  let initialGreetingSent = false;

  // Message queue to prevent race conditions
  // Ensures messages are processed sequentially
  let messageQueue: Promise<void> = Promise.resolve();

  // Send configuration on connect
  const configResponse: ConfigResponse = {
    response_type: "config",
    config: {
      auto_reconnect: true,
      call_details: true,
      transcript_with_tool_calls: true,
    },
  };
  sendResponse(ws, configResponse);

  // Handle incoming messages from Retell
  ws.on("message", async (data: Buffer) => {
    // Message size limit
    if (data.length > MAX_WS_MESSAGE_SIZE) {
      log.warn({ size: data.length }, "WebSocket message too large, ignoring");
      return;
    }

    try {
      const message: RetellRequest = JSON.parse(data.toString());
      log.debug({ interactionType: message.interaction_type }, "Received message");

      switch (message.interaction_type) {
        case "ping_pong":
          // Respond to keep-alive
          const pongResponse: PingPongResponse = {
            response_type: "ping_pong",
            timestamp: message.timestamp,
          };
          sendResponse(ws, pongResponse);
          break;

        case "call_details":
          // Detect call direction (inbound vs outbound)
          const callDirection = message.call.direction || "outbound";
          state.callDirection = callDirection;

          // Capture phone number based on direction
          if (callDirection === "inbound") {
            // INBOUND: Customer's phone is from_number (they called us)
            if (message.call.from_number) {
              state.customerPhone = message.call.from_number;
              state.phoneFromCallerId = true;
              log.info({ direction: callDirection }, "Captured caller ID from inbound call");
            }
          } else {
            // OUTBOUND: Customer's phone is to_number (we called them)
            if (message.call.to_number) {
              state.customerPhone = message.call.to_number;
            }
          }

          if (message.call.metadata) {
            log.info({ metadata: message.call.metadata, direction: callDirection }, "Call metadata received");
          }

          // Send initial greeting based on call direction
          if (!initialGreetingSent) {
            initialGreetingSent = true;
            const greeting = llm.getInitialGreeting(callDirection);
            const greetingResponse: ResponseResponse = {
              response_type: "response",
              response_id: 0,
              content: greeting,
              content_complete: true,
              end_call: false,
            };
            sendResponse(ws, greetingResponse);
            log.info({ direction: callDirection }, "Sent initial greeting");
          }
          break;

        case "update_only":
          // Just a transcript update, no response needed
          log.debug("Transcript update (no response needed)");
          break;

        case "response_required":
          // User said something, we need to respond
          // Queue message processing to prevent race conditions
          const transcript = message.transcript;
          const responseId = message.response_id;

          log.info({ responseId }, "Response required, queuing for processing");

          // Check if the last user message is inaudible/unclear
          const lastUserMsg = transcript.filter((m: { role: string }) => m.role === "user").pop();
          const isInaudible = lastUserMsg && detectInaudible(lastUserMsg.content);

          if (isInaudible) {
            log.info({ responseId }, "Detected inaudible speech, sending clarification request");
            const clarifyResponse: ResponseResponse = {
              response_type: "response",
              response_id: responseId,
              content: "I'm sorry, I didn't quite catch that. Could you say that again?",
              content_complete: true,
              end_call: false,
            };
            sendResponse(ws, clarifyResponse);
            break;
          }

          // Chain onto the message queue to ensure sequential processing
          messageQueue = messageQueue.then(async () => {
            const processingStart = Date.now();
            log.info({ responseId }, "Processing queued message");

            try {
              // Callback to send intermediate responses (e.g., transition phrases) before tool execution
              const onIntermediateResponse = (text: string) => {
                log.info({ responseId, text }, "Sending intermediate response");
                const intermediateResponse: ResponseResponse = {
                  response_type: "response",
                  response_id: responseId,
                  content: text,
                  content_complete: false, // More content coming after tool execution
                  end_call: false,
                };
                sendResponse(ws, intermediateResponse);
              };

              const { content, endCall, transferNumber } = await llm.generateResponse(
                transcript,
                onIntermediateResponse
              );

              const response: ResponseResponse = {
                response_type: "response",
                response_id: responseId,
                content,
                content_complete: true,
                end_call: endCall,
                transfer_number: transferNumber,
              };
              sendResponse(ws, response);
              log.info(
                { responseId, endCall, hasTransfer: !!transferNumber, processingMs: Date.now() - processingStart },
                "Sent response"
              );
            } catch (error) {
              log.error({ error, responseId }, "Error generating response");
              // Send fallback response
              const fallbackResponse: ResponseResponse = {
                response_type: "response",
                response_id: responseId,
                content: "I'm sorry, I didn't quite catch that. Could you say that again?",
                content_complete: true,
                end_call: false,
              };
              sendResponse(ws, fallbackResponse);
            }
          }).catch((error) => {
            log.error({ error, responseId }, "Queue processing error");
            // IMPORTANT: Send error response to Retell so it doesn't hang
            const errorResponse: ResponseResponse = {
              response_type: "response",
              response_id: responseId,
              content: "I'm sorry, I didn't quite catch that. Could you say that again?",
              content_complete: true,
              end_call: false,
            };
            sendResponse(ws, errorResponse);
          });
          break;

        case "reminder_required":
          // User has been silent, send a reminder
          log.info("Reminder required");
          const reminderResponseId = message.response_id;
          const reminder = llm.getReminder();

          const reminderResponse: ResponseResponse = {
            response_type: "response",
            response_id: reminderResponseId,
            content: reminder,
            content_complete: true,
            end_call: false,
          };
          sendResponse(ws, reminderResponse);
          break;

        default:
          log.warn({ interactionType: (message as any).interaction_type }, "Unknown interaction type");
      }
    } catch (error) {
      log.error({ error }, "Error processing message");
    }
  });

  ws.on("close", async () => {
    log.info("WebSocket connection closed");

    // Log final conversation state (without PII)
    const finalState = activeConversations.get(callId);
    if (finalState) {
      log.info(
        {
          appointmentBooked: finalState.appointmentBooked,
          serviceType: finalState.serviceType,
          urgency: finalState.urgency,
          endCallReason: finalState.endCallReason,
          isSafetyEmergency: finalState.isSafetyEmergency,
          isUrgentEscalation: finalState.isUrgentEscalation,
        },
        "Final conversation state"
      );

      // Save session to Supabase for post-call webhook processing
      // This allows us to retrieve the conversation state when Retell's
      // post-call webhook fires (after audio processing completes)
      try {
        await saveCallSession(finalState);
      } catch (error) {
        log.error({ error, callId }, "Failed to save call session");
      }
    }

    activeConversations.delete(callId);
  });

  ws.on("error", (error) => {
    log.error({ error }, "WebSocket error");
  });
});

// Helper function to send responses
function sendResponse(ws: WebSocket, response: RetellResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// ===========================================
// Start Server
// ===========================================

// Validate LLM configuration before starting
validateLLMConfig();

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, llmProvider: getLLMProvider() }, "CallLock HVAC Retell Server started");
  logger.info({ wsEndpoint: `ws://localhost:${PORT}/llm-websocket` }, "WebSocket endpoint ready");
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

  // Log active conversations
  const activeCount = activeConversations.size;
  if (activeCount > 0) {
    logger.warn({ activeCount }, "Active conversations will be terminated");
  }

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
