export interface ParsedBookingToolResult {
  booked: boolean;
  appointmentDateTime?: string;
}

export interface BookingToolTraceAudit {
  requestedTime?: string;
  transitionUrgencyTier?: string;
  bookingToolUrgencyTier?: string;
  bookedSlot?: string;
  slotChanged: boolean;
  urgencyMismatch: boolean;
}

function isTrueFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Parse a Retell transcript tool_call_result payload for booking success.
 * Supports both legacy {"booked": true} and newer {"booking_confirmed": true}
 * response shapes.
 */
export function parseBookingToolResultContent(content: string): ParsedBookingToolResult | null {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!isTrueFlag(result.booked) && !isTrueFlag(result.booking_confirmed)) {
    return null;
  }

  let appointmentDateTime: string | undefined;
  const appointmentDate = result.appointment_date;
  const appointmentTime = result.appointment_time;
  const bookingTime = result.booking_time;

  if (typeof appointmentDate === "string" && typeof appointmentTime === "string") {
    appointmentDateTime = `${appointmentDate} at ${appointmentTime}`;
  } else if (typeof appointmentTime === "string" && appointmentTime.trim()) {
    appointmentDateTime = appointmentTime;
  } else if (typeof bookingTime === "string" && bookingTime.trim()) {
    appointmentDateTime = bookingTime;
  }

  return {
    booked: true,
    appointmentDateTime,
  };
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeText(value: string | undefined): string | undefined {
  return value?.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Extract observability signals from transcript_with_tool_calls for booking flow audits.
 * Used only for logging/triage and dashboard flags; does not affect booking behavior.
 */
export function analyzeBookingToolTrace(entries: Array<{
  role: string;
  name?: string;
  arguments?: string;
  content?: string;
  tool_call_id?: string;
  successful?: boolean;
}> | undefined): BookingToolTraceAudit {
  const byToolCallId = new Map<string, string>();

  let requestedTime: string | undefined;
  let transitionUrgencyTier: string | undefined;
  let bookingToolUrgencyTier: string | undefined;
  let bookedSlot: string | undefined;

  for (const entry of entries || []) {
    if (entry.role === "tool_call_invocation") {
      if (entry.tool_call_id && entry.name) {
        byToolCallId.set(entry.tool_call_id, entry.name);
      }

      const args = parseJsonObject(entry.arguments);
      if (!args) continue;

      if (entry.name === "transition_to_booking") {
        if (typeof args.preferred_time === "string" && !requestedTime) {
          requestedTime = args.preferred_time;
        }
        if (typeof args.urgency_tier === "string") {
          transitionUrgencyTier = args.urgency_tier;
        }
      }

      if (entry.name === "book_service") {
        if (typeof args.preferred_time === "string") {
          requestedTime = args.preferred_time;
        }
        if (typeof args.urgency_tier === "string") {
          bookingToolUrgencyTier = args.urgency_tier;
        }
      }
    }

    if (entry.role === "tool_call_result" && entry.successful && entry.content) {
      const toolName = entry.tool_call_id ? byToolCallId.get(entry.tool_call_id) : undefined;
      if (toolName && toolName !== "book_service" && toolName !== "book_appointment") {
        continue;
      }
      const parsed = parseBookingToolResultContent(entry.content);
      if (parsed?.booked && parsed.appointmentDateTime) {
        bookedSlot = parsed.appointmentDateTime;
      }
    }
  }

  const requestedNorm = normalizeText(requestedTime);
  const bookedNorm = normalizeText(bookedSlot);
  const slotChanged = Boolean(requestedNorm && bookedNorm && requestedNorm !== bookedNorm);
  const urgencyMismatch = Boolean(
    transitionUrgencyTier &&
    bookingToolUrgencyTier &&
    transitionUrgencyTier !== bookingToolUrgencyTier
  );

  return {
    requestedTime,
    transitionUrgencyTier,
    bookingToolUrgencyTier,
    bookedSlot,
    slotChanged,
    urgencyMismatch,
  };
}
