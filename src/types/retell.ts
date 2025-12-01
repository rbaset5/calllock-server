// Retell AI WebSocket Event Types

// ============================================
// Events FROM Retell (Your Server Receives)
// ============================================

export type RetellRequest =
  | PingPongRequest
  | CallDetailsRequest
  | UpdateOnlyRequest
  | ResponseRequiredRequest
  | ReminderRequiredRequest;

export interface PingPongRequest {
  interaction_type: "ping_pong";
  timestamp: number;
}

export interface CallDetailsRequest {
  interaction_type: "call_details";
  call: RetellCallObject;
}

export interface UpdateOnlyRequest {
  interaction_type: "update_only";
  transcript: TranscriptMessage[];
  turntaking?: "agent_turn" | "user_turn";
}

export interface ResponseRequiredRequest {
  interaction_type: "response_required";
  response_id: number;
  transcript: TranscriptMessage[];
}

export interface ReminderRequiredRequest {
  interaction_type: "reminder_required";
  response_id: number;
}

// ============================================
// Events TO Retell (Your Server Sends)
// ============================================

export type RetellResponse =
  | ConfigResponse
  | PingPongResponse
  | ResponseResponse
  | AgentInterruptResponse
  | ToolCallInvocationResponse
  | ToolCallResultResponse
  | UpdateAgentResponse;

export interface ConfigResponse {
  response_type: "config";
  config: {
    auto_reconnect: boolean;
    call_details: boolean;
    transcript_with_tool_calls?: boolean;
  };
}

export interface PingPongResponse {
  response_type: "ping_pong";
  timestamp: number;
}

export interface ResponseResponse {
  response_type: "response";
  response_id: number;
  content: string;
  content_complete: boolean;
  end_call?: boolean;
  transfer_number?: string;
  no_interruption_allowed?: boolean;
}

export interface AgentInterruptResponse {
  response_type: "agent_interrupt";
  interrupt_id: number;
  content: string;
  content_complete: boolean;
  end_call?: boolean;
  no_interruption_allowed?: boolean;
}

export interface ToolCallInvocationResponse {
  response_type: "tool_call_invocation";
  tool_call_id: string;
  name: string;
  arguments: string;
}

export interface ToolCallResultResponse {
  response_type: "tool_call_result";
  tool_call_id: string;
  content: string;
}

export interface UpdateAgentResponse {
  response_type: "update_agent";
  agent_config: {
    responsiveness?: number;
    interruption_sensitivity?: number;
    reminder_trigger_ms?: number;
    reminder_max_count?: number;
  };
}

// ============================================
// Supporting Types
// ============================================

export interface TranscriptMessage {
  role: "agent" | "user";
  content: string;
}

export interface RetellCallObject {
  call_id: string;
  agent_id: string;
  call_type: "web_call" | "phone_call";
  call_status: "registered" | "ongoing" | "ended" | "error";
  from_number?: string;
  to_number?: string;
  direction?: "inbound" | "outbound";
  metadata?: Record<string, unknown>;
  retell_llm_dynamic_variables?: Record<string, string>;
  start_timestamp?: number;
  end_timestamp?: number;
  transcript?: string;
  recording_url?: string;
  public_log_url?: string;
}

// ============================================
// CallLock HVAC Types
// ============================================

// Simplified to HVAC only
export type ServiceType = "HVAC";

// HVAC-specific issue classification
export type HVACIssueType = "Cooling" | "Heating" | "Maintenance";

// Two-tier emergency system + routine
export type UrgencyTier = "LifeSafety" | "Urgent" | "Routine";

// Legacy urgency level for calendar availability
export type UrgencyLevel = "Emergency" | "Urgent" | "Routine" | "Estimate";

// Extended end call reasons to include urgent escalation
export type EndCallReason = "wrong_number" | "callback_later" | "safety_emergency" | "urgent_escalation" | "completed";

export interface CalendarSlot {
  date: string;
  dayOfWeek: string;
  timeWindow: string;
}

export interface CalendarAvailabilityParams {
  urgency: UrgencyLevel;
  preferredDate?: string;
}

export interface CalendarAvailabilityResult {
  availableSlots: CalendarSlot[];
}

export interface BookAppointmentParams {
  dateTime: string;
  customerName?: string;
  customerPhone: string;
  serviceAddress: string;
  serviceType: ServiceType;
  urgency: UrgencyLevel;
  problemDescription: string;
}

export interface BookAppointmentResult {
  success: boolean;
  appointmentId?: string;
  confirmationMessage: string;
}

export interface ValidateServiceAreaParams {
  zipCode: string;
}

export interface ValidateServiceAreaResult {
  inServiceArea: boolean;
  message: string;
}

export interface EndCallParams {
  reason: EndCallReason;
}

// ============================================
// Emergency Alert Types
// ============================================

export interface EmergencyAlertParams {
  urgencyDescription: string; // e.g., "No heat, elderly in home"
  callerPhone: string;
  address: string;
  callbackMinutes: number;
}

export interface EmergencyAlertResult {
  success: boolean;
  alertId?: string;
  message: string;
}

export interface TransferCallParams {
  targetNumber: string;
  ringTimeoutSeconds?: number; // Default 20 seconds
}

export interface TransferCallResult {
  success: boolean;
  transferred: boolean;
  message: string;
}

// ============================================
// Conversation State
// ============================================

export interface ConversationState {
  callId: string;
  customerPhone?: string;
  customerName?: string;
  serviceAddress?: string;
  serviceType?: ServiceType;
  hvacIssueType?: HVACIssueType;
  urgencyTier?: UrgencyTier;
  urgency?: UrgencyLevel; // Legacy for calendar
  problemDescription?: string;
  appointmentBooked: boolean;
  appointmentId?: string;
  appointmentDateTime?: string;
  endCallReason?: EndCallReason;
  isSafetyEmergency: boolean;
  isUrgentEscalation: boolean;
}
