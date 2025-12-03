import Anthropic from "@anthropic-ai/sdk";
import { CALLLOCK_SYSTEM_PROMPT_SHORT } from "./system-prompt-short.js";
import {
  TranscriptMessage,
  ConversationState,
  CalendarAvailabilityParams,
  BookAppointmentParams,
  EndCallParams,
  EmergencyAlertParams,
  TransferCallParams,
  UrgencyLevel,
} from "../types/retell.js";
import {
  checkCalendarAvailability,
  bookAppointment,
  validateServiceArea,
} from "../functions/index.js";
import { sendEmergencyAlert } from "../services/alerts.js";
import { createCallLogger, Logger } from "../utils/logger.js";

const BUSINESS_NAME = process.env.BUSINESS_NAME || "ACE Cooling";
const ON_CALL_PHONE_NUMBER = process.env.ON_CALL_PHONE_NUMBER;

// Safety limits to prevent blocking
const MAX_TOOL_ITERATIONS = 5; // Prevent infinite tool loops
const RESPONSE_TIMEOUT_MS = 15000; // 15 second max for entire response generation

// Initialize Anthropic client with timeout
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 30000, // 30 second timeout
});

// Tool definitions for Claude - HVAC focused
const tools: Anthropic.Tool[] = [
  {
    name: "checkCalendarAvailability",
    description:
      "Check available appointment time slots based on urgency level. Call this when the customer is ready to schedule.",
    input_schema: {
      type: "object" as const,
      properties: {
        urgency: {
          type: "string",
          enum: ["Emergency", "Urgent", "Routine", "Estimate"],
          description: "Urgency level of the service request",
        },
        preferredDate: {
          type: "string",
          description:
            "Customer's preferred date in YYYY-MM-DD format (optional)",
        },
      },
      required: ["urgency"],
    },
  },
  {
    name: "bookAppointment",
    description:
      "Book a confirmed HVAC service appointment after the customer has selected a time slot.",
    input_schema: {
      type: "object" as const,
      properties: {
        dateTime: {
          type: "string",
          description: "Appointment date and time in ISO 8601 format",
        },
        customerName: {
          type: "string",
          description: "Customer's full name (if provided)",
        },
        customerPhone: {
          type: "string",
          description: "Customer's phone number",
        },
        serviceAddress: {
          type: "string",
          description: "Full service address including street, city, state, zip",
        },
        serviceType: {
          type: "string",
          enum: ["HVAC"],
          description: "Type of service (always HVAC)",
        },
        urgency: {
          type: "string",
          enum: ["Emergency", "Urgent", "Routine", "Estimate"],
          description: "Urgency level",
        },
        problemDescription: {
          type: "string",
          description: "Brief description of the HVAC problem",
        },
      },
      required: [
        "dateTime",
        "customerPhone",
        "serviceAddress",
        "problemDescription",
      ],
    },
  },
  {
    name: "validateServiceArea",
    description:
      "Validate if a ZIP code is within the business's service area.",
    input_schema: {
      type: "object" as const,
      properties: {
        zipCode: {
          type: "string",
          description: "ZIP code to validate (5 digits)",
        },
      },
      required: ["zipCode"],
    },
  },
  {
    name: "transferCall",
    description:
      "Transfer the call to the on-call technician for urgent situations (Tier 2 emergencies like no heat in freezing weather). Ring for 15-20 seconds, then fall back to SMS alert if no answer.",
    input_schema: {
      type: "object" as const,
      properties: {
        targetNumber: {
          type: "string",
          description: "Phone number to transfer to (usually on-call technician)",
        },
        ringTimeoutSeconds: {
          type: "number",
          description: "How long to ring before giving up (default 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "sendEmergencyAlert",
    description:
      "Send an urgent SMS alert to the dispatcher/owner when transfer fails or for Tier 2 emergencies. Use this after failed transfer attempt.",
    input_schema: {
      type: "object" as const,
      properties: {
        urgencyDescription: {
          type: "string",
          description:
            "Short description of the emergency (e.g., 'No heat, elderly in home')",
        },
        callerPhone: {
          type: "string",
          description: "Caller's phone number for callback",
        },
        address: {
          type: "string",
          description: "Service address",
        },
        callbackMinutes: {
          type: "number",
          description: "Promised callback time in minutes (default 15)",
        },
      },
      required: ["urgencyDescription", "callerPhone"],
    },
  },
  {
    name: "endCall",
    description:
      "End the call. Reasons: wrong_number (customer didn't call), callback_later (customer requests callback), safety_emergency (after giving safety instructions for gas leak/fire), urgent_escalation (after sending emergency alert for Tier 2), out_of_area (customer outside service area), completed (appointment booked).",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          enum: [
            "wrong_number",
            "callback_later",
            "safety_emergency",
            "urgent_escalation",
            "out_of_area",
            "completed",
          ],
          description: "Reason for ending the call",
        },
      },
      required: ["reason"],
    },
  },
];

export class CallLockLLM {
  private state: ConversationState;
  private shouldEndCall: boolean = false;
  private transferNumber: string | undefined = undefined;
  private log: Logger;

  constructor(state: ConversationState) {
    this.state = state;
    this.log = createCallLogger(state.callId);
  }

  /**
   * Get the initial greeting for outbound calls
   */
  getInitialGreeting(): string {
    return `Hi, this is the CallLock assistant calling from ${BUSINESS_NAME}. I'm calling you back because you tried to reach us just a moment ago. Is this a good time?`;
  }

  /**
   * Get a reminder message when user is silent
   */
  getReminder(): string {
    const reminders = [
      "Are you still there?",
      "Hello? I'm still here if you need help.",
      "Just checking - would you like to continue scheduling your service appointment?",
    ];
    return reminders[Math.floor(Math.random() * reminders.length)];
  }

  /**
   * Generate a response based on the conversation transcript
   * Wrapped with timeout to prevent blocking
   */
  async generateResponse(transcript: TranscriptMessage[]): Promise<{
    content: string;
    endCall: boolean;
    transferNumber?: string;
  }> {
    const startTime = Date.now();

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Response generation timed out after ${RESPONSE_TIMEOUT_MS}ms`));
      }, RESPONSE_TIMEOUT_MS);
    });

    try {
      // Race between actual response and timeout
      const result = await Promise.race([
        this.generateResponseInternal(transcript),
        timeoutPromise,
      ]);

      this.log.info(
        { totalLatencyMs: Date.now() - startTime },
        "Response generated successfully"
      );

      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      this.log.error({ error, latencyMs: latency }, "Response generation failed");

      // Return fallback response on timeout or error
      return {
        content: "I apologize, I'm having a brief technical issue. Could you repeat that?",
        endCall: false,
        transferNumber: undefined,
      };
    }
  }

  /**
   * Internal response generation - the actual logic
   */
  private async generateResponseInternal(transcript: TranscriptMessage[]): Promise<{
    content: string;
    endCall: boolean;
    transferNumber?: string;
  }> {
    // Convert transcript to Claude message format
    const messages: Anthropic.MessageParam[] = transcript.map((msg) => ({
      role: msg.role === "agent" ? "assistant" : "user",
      content: msg.content,
    }));

    const startTime = Date.now();

    // Call Claude with tools
    let response = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1000,
      system: CALLLOCK_SYSTEM_PROMPT_SHORT,
      tools,
      messages,
    });

    this.log.debug(
      { latencyMs: Date.now() - startTime, stopReason: response.stop_reason },
      "Claude API response received"
    );

    // Handle tool use in a loop until we get a text response
    // SAFETY: Limit iterations to prevent infinite loops
    let toolIterations = 0;

    while (response.stop_reason === "tool_use" && toolIterations < MAX_TOOL_ITERATIONS) {
      toolIterations++;
      this.log.info({ iteration: toolIterations, maxIterations: MAX_TOOL_ITERATIONS }, "Tool loop iteration");

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      // Process each tool call
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        this.log.info({ tool: toolUse.name, input: toolUse.input }, "Tool call");

        let result: string;

        try {
          switch (toolUse.name) {
            case "checkCalendarAvailability": {
              const params = toolUse.input as CalendarAvailabilityParams;
              this.state.urgency = params.urgency as UrgencyLevel;
              const availability = await checkCalendarAvailability(params);
              result = JSON.stringify(availability);
              break;
            }

            case "bookAppointment": {
              const params = toolUse.input as BookAppointmentParams;
              // Update state with booking info
              this.state.customerName = params.customerName;
              this.state.customerPhone = params.customerPhone;
              this.state.serviceAddress = params.serviceAddress;
              this.state.serviceType = "HVAC"; // Always HVAC
              this.state.urgency =
                (params.urgency as UrgencyLevel) || "Routine";
              this.state.problemDescription = params.problemDescription;

              const booking = await bookAppointment({
                ...params,
                serviceType: "HVAC",
                urgency: this.state.urgency,
              });

              if (booking.success) {
                this.state.appointmentBooked = true;
                this.state.appointmentId = booking.appointmentId;
                this.state.appointmentDateTime = params.dateTime;
              }

              result = JSON.stringify(booking);
              break;
            }

            case "validateServiceArea": {
              const params = toolUse.input as { zipCode: string };
              const validation = await validateServiceArea(params);
              result = JSON.stringify(validation);
              break;
            }

            case "transferCall": {
              const params = toolUse.input as TransferCallParams;
              const targetNumber = params.targetNumber || ON_CALL_PHONE_NUMBER;

              if (!targetNumber) {
                // No on-call number configured, skip transfer
                this.log.warn("No on-call number configured for transfer");
                result = JSON.stringify({
                  success: false,
                  transferred: false,
                  message:
                    "No on-call number configured. Please send an emergency alert instead.",
                });
              } else {
                // Signal that we want to transfer (Retell will handle the actual transfer)
                this.transferNumber = targetNumber;
                this.log.info({ targetNumber }, "Transfer initiated");
                result = JSON.stringify({
                  success: true,
                  transferred: true,
                  message: `Attempting to transfer to ${targetNumber}. If no answer, fall back to emergency alert.`,
                });
              }
              break;
            }

            case "sendEmergencyAlert": {
              const params = toolUse.input as EmergencyAlertParams;
              const alertResult = await sendEmergencyAlert({
                urgencyDescription: params.urgencyDescription,
                callerPhone: params.callerPhone,
                address: params.address || "Address not provided",
                callbackMinutes: params.callbackMinutes || 15,
              });

              this.state.isUrgentEscalation = true;
              result = JSON.stringify(alertResult);
              break;
            }

            case "endCall": {
              const params = toolUse.input as EndCallParams;
              this.state.endCallReason = params.reason;
              this.shouldEndCall = true;

              if (params.reason === "safety_emergency") {
                this.state.isSafetyEmergency = true;
              }
              if (params.reason === "urgent_escalation") {
                this.state.isUrgentEscalation = true;
              }

              this.log.info({ reason: params.reason }, "End call requested");
              result = JSON.stringify({ success: true, reason: params.reason });
              break;
            }

            default:
              this.log.warn({ tool: toolUse.name }, "Unknown tool called");
              result = JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
          }
        } catch (error) {
          this.log.error({ error, tool: toolUse.name }, "Tool execution error");
          result = JSON.stringify({ error: "Tool execution failed" });
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Continue the conversation with tool results
      messages.push({
        role: "assistant",
        content: response.content,
      });
      messages.push({
        role: "user",
        content: toolResults,
      });

      // Get next response
      const toolLoopStart = Date.now();
      response = await anthropic.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1000,
        system: CALLLOCK_SYSTEM_PROMPT_SHORT,
        tools,
        messages,
      });

      this.log.debug(
        { latencyMs: Date.now() - toolLoopStart, stopReason: response.stop_reason },
        "Claude tool loop response"
      );
    }

    // SAFETY: Check if we hit the iteration limit
    if (toolIterations >= MAX_TOOL_ITERATIONS && response.stop_reason === "tool_use") {
      this.log.warn(
        { iterations: toolIterations },
        "Max tool iterations reached - forcing text response"
      );
      // Return a safe fallback response
      return {
        content: "I apologize for the delay. Let me help you directly. What would you like to schedule?",
        endCall: false,
        transferNumber: undefined,
      };
    }

    // Extract text response
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );

    const content =
      textBlock?.text || "I apologize, I didn't catch that. Could you repeat?";

    this.log.debug(
      { totalLatencyMs: Date.now() - startTime, endCall: this.shouldEndCall },
      "Response generation complete"
    );

    return {
      content,
      endCall: this.shouldEndCall,
      transferNumber: this.transferNumber,
    };
  }
}
