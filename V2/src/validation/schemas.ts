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
