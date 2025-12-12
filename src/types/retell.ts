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

// Revenue tier classification (replaces granular dollar estimates)
export type RevenueTier = "replacement" | "major_repair" | "standard_repair" | "minor" | "diagnostic";

// Extended end call reasons
export type EndCallReason = "wrong_number" | "callback_later" | "safety_emergency" | "urgent_escalation" | "out_of_area" | "waitlist_added" | "completed" | "customer_hangup" | "sales_lead" | "cancelled" | "rescheduled";

export interface CalendarSlot {
  date: string;
  dayOfWeek: string;
  timeWindow: string;
  isoDateTime: string; // ISO 8601 format for booking API (e.g., "2024-12-05T14:00:00")
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

// ============================================
// Sales Lead Alert Types
// ============================================

export interface SalesLeadAlertParams {
  customerName?: string;
  customerPhone: string;
  address?: string;
  currentEquipment?: string;  // "AC", "furnace", "heat pump", etc.
  equipmentAge?: string;      // "20 years", "unknown"
  notes?: string;             // Any additional context from the call
}

export interface SalesLeadAlertResult {
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
  callDirection?: "inbound" | "outbound";
  customerPhone?: string;
  phoneFromCallerId?: boolean;
  customerName?: string;
  serviceAddress?: string;
  serviceType?: ServiceType;
  hvacIssueType?: HVACIssueType;
  urgencyTier?: UrgencyTier;
  urgency?: UrgencyLevel; // Legacy for calendar
  problemDescription?: string;
  // Diagnostic context fields (captured during Problem Clarification phase)
  problemDuration?: string;          // "2 days", "since yesterday", "few hours"
  problemOnset?: string;             // "after power outage", "after storm", "gradual"
  problemPattern?: string;           // "constant", "intermittent", "only at night"
  customerAttemptedFixes?: string;   // "checked filter", "reset thermostat"
  // Equipment details (captured when customer volunteers, not asked)
  equipmentType?: string;            // "AC unit", "furnace", "heat pump", "mini-split"
  equipmentBrand?: string;           // "Carrier", "Trane", "Lennox"
  equipmentLocation?: string;        // "attic", "backyard", "basement", "garage"
  equipmentAge?: string;             // "10 years old", "new last year"
  // Sales lead specific
  salesLeadNotes?: string;           // Additional context from sales inquiry
  appointmentBooked: boolean;
  appointmentId?: string;
  appointmentDateTime?: string;
  endCallReason?: EndCallReason;
  isSafetyEmergency: boolean;
  isUrgentEscalation: boolean;
}

// ============================================
// Retell Post-Call Webhook Types
// ============================================

/**
 * Payload sent by Retell AI's post-call webhook
 * This fires after the call ends AND audio processing is complete
 */
export interface RetellPostCallWebhook {
  event: "call_ended" | "call_analyzed";
  call: RetellPostCallData;
}

export interface RetellPostCallData {
  call_id: string;
  agent_id: string;
  call_type: "web_call" | "phone_call";
  call_status: "ended" | "error";
  from_number?: string;
  to_number?: string;
  direction?: "inbound" | "outbound";
  start_timestamp: number;
  end_timestamp: number;
  duration_ms?: number;
  transcript?: string;
  transcript_object?: TranscriptMessage[];
  recording_url?: string;
  public_log_url?: string;
  call_analysis?: RetellCallAnalysis;
  metadata?: Record<string, unknown>;
  disconnection_reason?: string;
}

/**
 * Custom analysis data extracted by Retell's post-call AI analysis
 * These fields are configured in the Retell agent's post_call_analysis_data
 */
export interface CustomAnalysisData {
  customer_name?: string;
  service_address?: string;
  problem_description?: string;
  problem_duration?: string;
  problem_pattern?: string;
  equipment_type?: string;
  equipment_brand?: string;
  equipment_age?: string;
  urgency_level?: string;
}

export interface RetellCallAnalysis {
  call_summary?: string;
  user_sentiment?: "positive" | "neutral" | "negative";
  call_successful?: boolean;
  custom_analysis_data?: CustomAnalysisData;
}
