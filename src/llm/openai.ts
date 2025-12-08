import OpenAI from "openai";
import { CALLLOCK_SYSTEM_PROMPT_SHORT } from "./system-prompt-short.js";
import { LLMHandler, LLMResponse } from "./types.js";
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

// Safety limits
const MAX_TOOL_ITERATIONS = 5;
const RESPONSE_TIMEOUT_MS = 15000;

// Tool definitions for OpenAI function calling
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "checkCalendarAvailability",
      description:
        "Check available appointment time slots based on urgency level. Call this when the customer is ready to schedule.",
      parameters: {
        type: "object",
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
  },
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description:
        "Book a confirmed HVAC service appointment after the customer has selected a time slot.",
      parameters: {
        type: "object",
        properties: {
          dateTime: {
            type: "string",
            description:
              "Use the isoDateTime value from the calendar slot the customer selected",
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
        required: ["dateTime", "customerPhone", "serviceAddress", "problemDescription"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validateServiceArea",
      description:
        "Check if a ZIP code is within the service area. Always call this before checking calendar availability.",
      parameters: {
        type: "object",
        properties: {
          zipCode: {
            type: "string",
            description: "5-digit ZIP code to validate",
          },
        },
        required: ["zipCode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transferCall",
      description:
        "Transfer the call to the on-call technician for urgent situations.",
      parameters: {
        type: "object",
        properties: {
          targetNumber: {
            type: "string",
            description: "Phone number to transfer to",
          },
          ringTimeoutSeconds: {
            type: "number",
            description: "How long to ring before giving up (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sendEmergencyAlert",
      description:
        "Send an urgent SMS alert to the dispatcher/owner when a customer has an urgent issue.",
      parameters: {
        type: "object",
        properties: {
          urgencyDescription: {
            type: "string",
            description: "Brief description of the urgent situation",
          },
          callerPhone: {
            type: "string",
            description: "Customer's callback phone number",
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
        required: ["urgencyDescription", "callerPhone", "address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "endCall",
      description:
        "End the call with a specific reason. MUST be called to properly terminate every conversation.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: [
              "wrong_number",
              "callback_later",
              "safety_emergency",
              "urgent_escalation",
              "out_of_area",
              "waitlist_added",
              "completed",
            ],
            description: "Reason for ending the call",
          },
        },
        required: ["reason"],
      },
    },
  },
];

export class OpenAILLM implements LLMHandler {
  private state: ConversationState;
  private shouldEndCall: boolean = false;
  private transferNumber: string | undefined = undefined;
  private log: Logger;
  private openai: OpenAI;

  constructor(state: ConversationState) {
    this.state = state;
    this.log = createCallLogger(state.callId);
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000,
    });
  }

  getInitialGreeting(direction?: "inbound" | "outbound"): string {
    if (direction === "inbound") {
      return `Thanks for calling ${BUSINESS_NAME}! What's going on with your AC or heating?`;
    }
    return `Hi, this is ${BUSINESS_NAME} returning your call—what's going on with your AC or heating?`;
  }

  getReminder(): string {
    const reminders = [
      "Are you still there?",
      "Hello? I'm still here if you need help.",
      "Just checking - would you like to continue scheduling your service appointment?",
    ];
    return reminders[Math.floor(Math.random() * reminders.length)];
  }

  private getEndCallMessage(reason: string): string {
    const serviceArea = process.env.SERVICE_AREA || "Austin and surrounding areas";

    switch (reason) {
      case "wrong_number":
        return "I apologize for the confusion. Have a great day!";
      case "callback_later":
        return "No problem! Feel free to call us back anytime. Have a great day!";
      case "safety_emergency":
        return "Please stay safe. Emergency services have been notified.";
      case "urgent_escalation":
        return "Someone from our team will call you back shortly. Thank you for your patience.";
      case "out_of_area":
        return `I'm sorry, but we don't currently service that area. We serve ${serviceArea}. Thank you for calling!`;
      case "waitlist_added":
        return "You're on our waitlist! We'll call you as soon as a slot opens up. Have a great day!";
      case "completed":
        return "";
      default:
        return "Thank you for calling. Have a great day!";
    }
  }

  private buildSystemPrompt(): string {
    let prompt = CALLLOCK_SYSTEM_PROMPT_SHORT;

    if (this.state.phoneFromCallerId && this.state.customerPhone) {
      prompt += `\n\nIMPORTANT: Customer's phone number is already captured from caller ID. DO NOT ask for their phone number—skip directly to checking calendar availability after confirming service area.`;
    }

    if (this.state.callDirection === "inbound") {
      prompt = prompt.replace(
        "You're calling the customer BACK",
        "This is a LIVE INBOUND call"
      );
      prompt += `\n\nIMPORTANT: This is an inbound call—the owner already missed it. Do NOT use transferCall tool. For urgent situations, go straight to sendEmergencyAlert after offering the customer a choice.`;
    }

    return prompt;
  }

  async generateResponse(
    transcript: TranscriptMessage[],
    onIntermediateResponse?: (text: string) => void
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Response generation timed out after ${RESPONSE_TIMEOUT_MS}ms`));
      }, RESPONSE_TIMEOUT_MS);
    });

    const responsePromise = this.generateResponseInternal(transcript, onIntermediateResponse);

    try {
      return await Promise.race([responsePromise, timeoutPromise]);
    } catch (error) {
      this.log.error({ error, elapsedMs: Date.now() - startTime }, "Response generation failed");

      if (error instanceof Error && error.message.includes("timed out")) {
        return {
          content: "I apologize for the delay. How can I help you with your HVAC system today?",
          endCall: false,
        };
      }

      return {
        content: "I'm sorry, I'm having a bit of trouble. Could you repeat what you just said?",
        endCall: false,
      };
    }
  }

  private async generateResponseInternal(
    transcript: TranscriptMessage[],
    onIntermediateResponse?: (text: string) => void
  ): Promise<LLMResponse> {
    // Reset state for new response
    this.shouldEndCall = false;
    this.transferNumber = undefined;

    // Convert transcript to OpenAI message format
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: this.buildSystemPrompt() },
      ...transcript.map((msg) => ({
        role: (msg.role === "agent" ? "assistant" : "user") as "assistant" | "user",
        content: msg.content,
      })),
    ];

    const startTime = Date.now();

    let response = await this.openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1000,
      messages,
      tools,
      tool_choice: "auto",
    });

    this.log.debug(
      { latencyMs: Date.now() - startTime, finishReason: response.choices[0]?.finish_reason },
      "OpenAI API response received"
    );

    let toolIterations = 0;

    while (
      response.choices[0]?.finish_reason === "tool_calls" &&
      toolIterations < MAX_TOOL_ITERATIONS
    ) {
      toolIterations++;
      this.log.info({ iteration: toolIterations }, "Tool loop iteration");

      const assistantMessage = response.choices[0].message;
      const toolCalls = assistantMessage.tool_calls || [];

      // Send any content as intermediate response
      if (assistantMessage.content && onIntermediateResponse) {
        onIntermediateResponse(assistantMessage.content);
      }

      // Execute tools and collect results
      const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

      for (const toolCall of toolCalls) {
        // Type guard for function tool calls
        if (toolCall.type !== "function") continue;
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || "{}");

        this.log.info({ tool: toolName, args: toolArgs }, "Executing tool");

        let result: string;

        try {
          result = await this.executeTool(toolName, toolArgs);
        } catch (error) {
          this.log.error({ tool: toolName, error }, "Tool execution failed");
          result = JSON.stringify({ success: false, error: "Tool execution failed" });
        }

        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Add assistant message and tool results to conversation
      messages.push(assistantMessage);
      messages.push(...toolResults);

      // Get next response
      const toolLoopStart = Date.now();
      response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: "auto",
      });

      this.log.debug(
        { latencyMs: Date.now() - toolLoopStart, finishReason: response.choices[0]?.finish_reason },
        "OpenAI tool loop response"
      );
    }

    if (toolIterations >= MAX_TOOL_ITERATIONS && response.choices[0]?.finish_reason === "tool_calls") {
      this.log.warn({ iterations: toolIterations }, "Max tool iterations reached");
      return {
        content: "I apologize for the delay. Let me help you directly. What would you like to schedule?",
        endCall: false,
      };
    }

    // Extract final text response
    let content = response.choices[0]?.message?.content || "";

    // Handle end call scenario
    if (this.shouldEndCall && !content) {
      content = this.getEndCallMessage(this.state.endCallReason || "completed");
    }

    this.log.info(
      {
        responseLength: content.length,
        endCall: this.shouldEndCall,
        hasTransfer: !!this.transferNumber,
        totalLatencyMs: Date.now() - startTime,
        toolIterations,
      },
      "Response generation complete"
    );

    return {
      content,
      endCall: this.shouldEndCall,
      transferNumber: this.transferNumber,
    };
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "checkCalendarAvailability": {
        const params = args as unknown as CalendarAvailabilityParams;
        const slots = await checkCalendarAvailability(params);
        this.state.urgency = params.urgency as UrgencyLevel;
        return JSON.stringify(slots);
      }

      case "bookAppointment": {
        const params = args as unknown as BookAppointmentParams;
        const booking = await bookAppointment(params);

        if (booking.success && booking.appointmentId) {
          this.state.appointmentBooked = true;
          this.state.appointmentId = booking.appointmentId;
          this.state.appointmentDateTime = params.dateTime;
          this.state.customerPhone = params.customerPhone;
          this.state.serviceAddress = params.serviceAddress;
          this.state.problemDescription = params.problemDescription;
        }
        return JSON.stringify(booking);
      }

      case "validateServiceArea": {
        const params = args as unknown as { zipCode: string };
        const result = await validateServiceArea(params);
        return JSON.stringify(result);
      }

      case "transferCall": {
        const params = args as unknown as TransferCallParams;
        const targetNumber = params.targetNumber || ON_CALL_PHONE_NUMBER;

        if (!targetNumber) {
          this.log.warn("No on-call number configured for transfer");
          return JSON.stringify({
            success: false,
            transferred: false,
            message: "No on-call number configured. Please send an emergency alert instead.",
          });
        }

        this.transferNumber = targetNumber;
        this.log.info({ targetNumber }, "Transfer initiated");
        return JSON.stringify({
          success: true,
          transferred: true,
          message: `Attempting to transfer to ${targetNumber}.`,
        });
      }

      case "sendEmergencyAlert": {
        const params = args as unknown as EmergencyAlertParams;
        const alertResult = await sendEmergencyAlert({
          ...params,
          callbackMinutes: params.callbackMinutes || 15,
        });
        this.state.isUrgentEscalation = true;
        return JSON.stringify(alertResult);
      }

      case "endCall": {
        const params = args as unknown as EndCallParams;
        this.state.endCallReason = params.reason;
        this.shouldEndCall = true;

        if (params.reason === "safety_emergency") {
          this.state.isSafetyEmergency = true;
        }
        if (params.reason === "urgent_escalation") {
          this.state.isUrgentEscalation = true;
        }

        this.log.info({ reason: params.reason }, "End call requested");
        return JSON.stringify({ success: true, reason: params.reason });
      }

      default:
        this.log.warn({ tool: name }, "Unknown tool called");
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }
}
