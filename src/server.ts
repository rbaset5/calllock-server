import "dotenv/config";
import express, { Request, Response } from "express";
import expressWs from "express-ws";
import { WebSocket } from "ws";
import { CallLockLLM } from "./llm/claude.js";
import {
  RetellRequest,
  RetellResponse,
  ConfigResponse,
  PingPongResponse,
  ResponseResponse,
  ConversationState,
  TranscriptMessage,
} from "./types/retell.js";
import {
  lookupBookingByPhone,
  cancelBooking,
  rescheduleBooking,
} from "./services/calcom.js";

// ===========================================
// Startup Validation
// ===========================================

function validateEnvironment(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:", missing.join(", "));
    process.exit(1);
  }

  // Warn about optional but recommended variables
  const recommended = ["RETELL_API_KEY", "BUSINESS_NAME", "SERVICE_AREA"];
  const missingRecommended = recommended.filter((key) => !process.env[key]);
  if (missingRecommended.length > 0) {
    console.warn("⚠️  Missing recommended environment variables:", missingRecommended.join(", "));
  }

  // Warn if emergency escalation is not configured
  if (!process.env.ON_CALL_PHONE_NUMBER && !process.env.EMERGENCY_SMS_NUMBER) {
    console.warn("⚠️  No emergency escalation configured (ON_CALL_PHONE_NUMBER or EMERGENCY_SMS_NUMBER)");
  }

  console.log("✅ Environment validation passed");
}

// Run validation before starting
validateEnvironment();

const app = expressWs(express()).app;
const PORT = process.env.PORT || 8080;

// Store active conversations
const activeConversations = new Map<string, ConversationState>();

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Parse JSON body for REST endpoints
app.use(express.json());

// ============================================
// Cal.com Booking Management REST Endpoints
// ============================================

/**
 * Look up a booking by phone number
 * Used by Retell custom function to find existing appointments
 */
app.get("/api/bookings/lookup", async (req: Request, res: Response) => {
  const phone = req.query.phone as string;

  if (!phone) {
    return res.status(400).json({ error: "Phone number required" });
  }

  console.log("[API] Looking up booking for phone:", phone);
  const result = await lookupBookingByPhone(phone);
  res.json(result);
});

/**
 * POST endpoint for Retell webhook (lookup)
 */
app.post("/api/bookings/lookup", async (req: Request, res: Response) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone number required" });
  }

  console.log("[API] Looking up booking for phone:", phone);
  const result = await lookupBookingByPhone(phone);
  res.json(result);
});

/**
 * Cancel a booking
 * Used by Retell custom function to cancel appointments
 */
app.post("/api/bookings/cancel", async (req: Request, res: Response) => {
  const { booking_uid, reason } = req.body;

  if (!booking_uid) {
    return res.status(400).json({ error: "Booking UID required" });
  }

  console.log("[API] Cancelling booking:", booking_uid);
  const result = await cancelBooking(booking_uid, reason);
  res.json(result);
});

/**
 * Reschedule a booking
 * Used by Retell custom function to reschedule appointments
 */
app.post("/api/bookings/reschedule", async (req: Request, res: Response) => {
  const { booking_uid, new_start_time } = req.body;

  if (!booking_uid || !new_start_time) {
    return res.status(400).json({ error: "Booking UID and new start time required" });
  }

  console.log("[API] Rescheduling booking:", booking_uid, "to", new_start_time);
  const result = await rescheduleBooking(booking_uid, new_start_time);
  res.json(result);
});

// Main WebSocket endpoint for Retell LLM
app.ws("/llm-websocket/:callId?", (ws: WebSocket, req: Request) => {
  const callId = req.params.callId || `call_${Date.now()}`;
  console.log(`[${callId}] WebSocket connection established`);

  // Initialize conversation state
  const state: ConversationState = {
    callId,
    appointmentBooked: false,
    isSafetyEmergency: false,
    isUrgentEscalation: false,
  };
  activeConversations.set(callId, state);

  // Initialize Claude LLM handler
  const llm = new CallLockLLM(state);

  // Track if we've sent the initial greeting
  let initialGreetingSent = false;

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
    try {
      const message: RetellRequest = JSON.parse(data.toString());
      console.log(`[${callId}] Received:`, message.interaction_type);

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
          // Store call metadata
          if (message.call.to_number) {
            state.customerPhone = message.call.to_number;
          }
          if (message.call.metadata) {
            console.log(`[${callId}] Call metadata:`, message.call.metadata);
          }

          // Send initial greeting for outbound call
          if (!initialGreetingSent) {
            initialGreetingSent = true;
            const greeting = llm.getInitialGreeting();
            const greetingResponse: ResponseResponse = {
              response_type: "response",
              response_id: 0,
              content: greeting,
              content_complete: true,
              end_call: false,
            };
            sendResponse(ws, greetingResponse);
            console.log(`[${callId}] Sent initial greeting`);
          }
          break;

        case "update_only":
          // Just a transcript update, no response needed
          console.log(`[${callId}] Transcript update (no response needed)`);
          break;

        case "response_required":
          // User said something, we need to respond
          console.log(`[${callId}] Response required, processing...`);
          const transcript = message.transcript;
          const responseId = message.response_id;

          try {
            const { content, endCall, transferNumber } = await llm.generateResponse(transcript);

            const response: ResponseResponse = {
              response_type: "response",
              response_id: responseId,
              content,
              content_complete: true,
              end_call: endCall,
              transfer_number: transferNumber, // For Tier 2 urgent transfers
            };
            sendResponse(ws, response);
            console.log(`[${callId}] Sent response (end_call: ${endCall}, transfer: ${transferNumber || "none"})`);
          } catch (error) {
            console.error(`[${callId}] Error generating response:`, error);
            // Send fallback response
            const fallbackResponse: ResponseResponse = {
              response_type: "response",
              response_id: responseId,
              content: "I apologize, I'm having a technical issue. Please call us back or hold for a moment.",
              content_complete: true,
              end_call: false,
            };
            sendResponse(ws, fallbackResponse);
          }
          break;

        case "reminder_required":
          // User has been silent, send a reminder
          console.log(`[${callId}] Reminder required`);
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
          console.log(`[${callId}] Unknown interaction type:`, (message as any).interaction_type);
      }
    } catch (error) {
      console.error(`[${callId}] Error processing message:`, error);
    }
  });

  ws.on("close", () => {
    console.log(`[${callId}] WebSocket connection closed`);

    // Log final conversation state
    const finalState = activeConversations.get(callId);
    if (finalState) {
      console.log(`[${callId}] Final state:`, {
        appointmentBooked: finalState.appointmentBooked,
        serviceType: finalState.serviceType,
        urgency: finalState.urgency,
        endCallReason: finalState.endCallReason,
        isSafetyEmergency: finalState.isSafetyEmergency,
        isUrgentEscalation: finalState.isUrgentEscalation,
      });
    }

    activeConversations.delete(callId);
  });

  ws.on("error", (error) => {
    console.error(`[${callId}] WebSocket error:`, error);
  });
});

// Helper function to send responses
function sendResponse(ws: WebSocket, response: RetellResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// Start server
const server = app.listen(PORT, () => {
  console.log(`CallLock HVAC Retell Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/llm-websocket`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  // Keep-alive ping for Render free tier (prevents spin-down)
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
  if (RENDER_URL) {
    console.log(`[Keep-alive] Enabled for ${RENDER_URL}`);
    setInterval(async () => {
      try {
        await fetch(`${RENDER_URL}/health`);
        // Quiet success - only log failures
      } catch (e) {
        console.log("[Keep-alive] Ping failed");
      }
    }, 14 * 60 * 1000); // Every 14 minutes
  }
});

// ===========================================
// Graceful Shutdown
// ===========================================

function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Log active conversations
  const activeCount = activeConversations.size;
  if (activeCount > 0) {
    console.log(`⚠️  ${activeCount} active conversation(s) will be terminated`);
  }

  // Close HTTP server (stop accepting new connections)
  server.close(() => {
    console.log("✅ HTTP server closed");
    process.exit(0);
  });

  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error("❌ Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10000);
}

// Listen for termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
