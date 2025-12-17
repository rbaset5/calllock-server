import { z } from "zod";

/**
 * Phone number validation (E.164 format)
 * Accepts: +1234567890 or 1234567890
 */
export const phoneSchema = z
  .string()
  .min(1, "Phone number is required")
  .regex(
    /^\+?[1-9]\d{1,14}$/,
    "Invalid phone number format. Use E.164 format (e.g., +15125551234)"
  );

/**
 * Booking UID validation (Cal.com format)
 */
export const bookingUidSchema = z
  .string()
  .min(1, "Booking UID is required")
  .max(100, "Booking UID too long")
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid booking UID format");

/**
 * ISO 8601 datetime validation
 */
export const datetimeSchema = z
  .string()
  .min(1, "Datetime is required")
  .refine(
    (val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: "Invalid datetime format. Use ISO 8601 (e.g., 2024-01-15T10:00:00Z)" }
  );

/**
 * ZIP code validation (US format)
 */
export const zipCodeSchema = z
  .string()
  .regex(/^\d{5}(-\d{4})?$/, "Invalid ZIP code format");

/**
 * Cancellation reason validation
 */
export const cancellationReasonSchema = z
  .string()
  .max(500, "Reason too long")
  .optional();

// ============================================
// Request Body Schemas
// ============================================

/**
 * Booking lookup request
 */
export const lookupRequestSchema = z.object({
  phone: phoneSchema,
});

/**
 * Cancel booking request
 */
export const cancelRequestSchema = z.object({
  booking_uid: bookingUidSchema,
  reason: cancellationReasonSchema,
});

/**
 * Reschedule booking request
 */
export const rescheduleRequestSchema = z.object({
  booking_uid: bookingUidSchema,
  new_start_time: datetimeSchema,
});

// ============================================
// Type Exports (inferred from schemas)
// ============================================

export type LookupRequest = z.infer<typeof lookupRequestSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type RescheduleRequest = z.infer<typeof rescheduleRequestSchema>;

// ============================================
// V3 Triage Classification Enums
// ============================================

/**
 * Caller Type enum - validated at API gateway
 */
export const CallerTypeEnum = z.enum([
  "residential",
  "commercial",
  "vendor",
  "recruiting",
  "unknown"
]);

/**
 * Primary Intent enum
 */
export const PrimaryIntentEnum = z.enum([
  "new_lead",
  "active_job_issue",
  "booking_request",
  "admin_billing",
  "solicitation"
]);

/**
 * Booking Status enum
 */
export const BookingStatusEnum = z.enum([
  "confirmed",
  "attempted_failed",
  "not_requested"
]);

// ============================================
// EndCall Args Schema (V3 Triage)
// ============================================

/**
 * Schema for end_call function arguments
 * Validates triage fields with defaults for invalid LLM values
 */
export const EndCallArgsSchema = z.object({
  // Required
  reason: z.string(),

  // Customer data (optional)
  customer_name: z.string().optional(),
  customer_phone: z.string().optional(),
  customer_address: z.string().optional(),
  problem_description: z.string().optional(),
  urgency: z.string().optional(),

  // Diagnostic context (optional)
  problem_duration: z.string().optional(),
  problem_onset: z.string().optional(),
  problem_pattern: z.string().optional(),
  customer_attempted_fixes: z.string().optional(),

  // Equipment details (optional)
  equipment_type: z.string().optional(),
  equipment_brand: z.string().optional(),
  equipment_location: z.string().optional(),
  equipment_age: z.string().optional(),

  // V3 Triage fields with defaults
  caller_type: CallerTypeEnum.optional().default("unknown"),
  primary_intent: PrimaryIntentEnum.optional(),
  booking_status: BookingStatusEnum.optional(),
  is_callback_complaint: z.boolean().optional().default(false),
});

export type EndCallArgs = z.infer<typeof EndCallArgsSchema>;

// ============================================
// Validation Helper
// ============================================

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: Array<{ field: string; message: string }>;
}

/**
 * Validate data against a schema and return formatted errors
 */
export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "body",
    message: issue.message,
  }));

  return { success: false, errors };
}
