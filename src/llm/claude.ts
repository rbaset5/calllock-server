import Anthropic from "@anthropic-ai/sdk";
import { CALLLOCK_SYSTEM_PROMPT_SHORT } from "./system-prompt-short.js";
import {
  TranscriptMessage,
  ConversationState,
  CalendarAvailabilityParams,
  BookAppointmentParams,
  EndCallParams,
  UrgencyLevel,
  ServiceType,
} from "../types/retell.js";
import {
  checkCalendarAvailability,
  bookAppointment,
  validateServiceArea,
} from "../functions/index.js";

const BUSINESS_NAME = process.env.BUSINESS_NAME || "ACE Cooling";

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Tool definitions for Claude
const tools: Anthropic.Tool[] = [
  {
    name: "checkCalendarAvailability",
    description: "Check available appointment time slots based on urgency level. Call this when the customer is ready to schedule and you need to offer available times.",
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
          description: "Customer's preferred date in YYYY-MM-DD format (optional)",
        },
      },
      required: ["urgency"],
    },
  },
  {
    name: "bookAppointment",
    description: "Book a confirmed service appointment after the customer has selected a time slot. Call this to finalize the booking.",
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
          enum: ["HVAC", "Plumbing", "Electrical", "General"],
          description: "Type of service needed",
        },
        urgency: {
          type: "string",
          enum: ["Emergency", "Urgent", "Routine", "Estimate"],
          description: "Urgency level",
        },
        problemDescription: {
          type: "string",
          description: "Description of the problem/issue",
        },
      },
      required: ["dateTime", "customerPhone", "serviceAddress", "serviceType", "problemDescription"],
    },
  },
  {
    name: "validateServiceArea",
    description: "Validate if a ZIP code is within the business's service area. Call this if the customer provides an address and you want to verify coverage.",
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
    name: "endCall",
    description: "End the call. Use this for: wrong number (customer didn't call), callback later (customer requests callback), safety emergency (after giving safety instructions), or completed (appointment booked successfully).",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          enum: ["wrong_number", "callback_later", "safety_emergency", "completed"],
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

  constructor(state: ConversationState) {
    this.state = state;
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
   */
  async generateResponse(transcript: TranscriptMessage[]): Promise<{
    content: string;
    endCall: boolean;
  }> {
    // Convert transcript to Claude message format
    const messages: Anthropic.MessageParam[] = transcript.map((msg) => ({
      role: msg.role === "agent" ? "assistant" : "user",
      content: msg.content,
    }));

    // Call Claude with tools
    let response = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1000,
      system: CALLLOCK_SYSTEM_PROMPT_SHORT,
      tools,
      messages,
    });

    // Handle tool use in a loop until we get a text response
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      // Process each tool call
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[${this.state.callId}] Tool call: ${toolUse.name}`, toolUse.input);

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
              this.state.serviceType = params.serviceType as ServiceType;
              this.state.urgency = params.urgency as UrgencyLevel;
              this.state.problemDescription = params.problemDescription;

              const booking = await bookAppointment(params);

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

            case "endCall": {
              const params = toolUse.input as EndCallParams;
              this.state.endCallReason = params.reason;
              this.shouldEndCall = true;

              if (params.reason === "safety_emergency") {
                this.state.isSafetyEmergency = true;
              }

              result = JSON.stringify({ success: true, reason: params.reason });
              break;
            }

            default:
              result = JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
          }
        } catch (error) {
          console.error(`[${this.state.callId}] Tool error:`, error);
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
      response = await anthropic.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1000,
        system: CALLLOCK_SYSTEM_PROMPT_SHORT,
        tools,
        messages,
      });
    }

    // Extract text response
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );

    const content = textBlock?.text || "I apologize, I didn't catch that. Could you repeat?";

    return {
      content,
      endCall: this.shouldEndCall,
    };
  }
}
