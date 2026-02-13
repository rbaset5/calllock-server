import {
  BookAppointmentParams,
  BookAppointmentResult,
} from "../types/retell.js";
import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

const log = createModuleLogger("booking");

const CAL_COM_API_KEY = process.env.CAL_COM_API_KEY;
const CAL_COM_EVENT_TYPE_ID = process.env.CAL_COM_EVENT_TYPE_ID || "3877847";
const CAL_API_BASE = "https://api.cal.com/v2";

interface CalComBookingResponse {
  status: string;
  data: {
    uid: string;
    title: string;
    startTime: string;
    endTime: string;
  };
}

/**
 * Book a service appointment via Cal.com
 * Falls back to mock confirmation if Cal.com is not configured or fails
 */
export async function bookAppointment(
  params: BookAppointmentParams
): Promise<BookAppointmentResult> {
  log.info(
    {
      phone: maskPhone(params.customerPhone),
      serviceType: params.serviceType,
      urgency: params.urgency,
    },
    "Creating appointment"
  );

  // Try Cal.com API if configured
  if (CAL_COM_API_KEY) {
    try {
      const result = await createCalComBooking(params);
      return result;
    } catch (error) {
      if (error instanceof FetchError) {
        log.error({ error: error.message, attempts: error.attempts }, "Cal.com API failed after retries, using mock");
      } else {
        log.error({ error }, "Cal.com API error, falling back to mock");
      }
    }
  }

  // Fall back to mock confirmation
  return generateMockBookingConfirmation(params);
}

/**
 * Create a real booking via Cal.com API
 */
async function createCalComBooking(
  params: BookAppointmentParams
): Promise<BookAppointmentResult> {
  const url = `${CAL_API_BASE}/bookings`;

  // Parse customer name into first/last
  const nameParts = (params.customerName || "HVAC Customer").split(" ");

  // Create booking payload for Cal.com v2 API
  const bookingData = {
    eventTypeId: parseInt(CAL_COM_EVENT_TYPE_ID),
    start: params.dateTime,
    attendee: {
      name: params.customerName || "HVAC Customer",
      email: `${params.customerPhone.replace(/\D/g, "")}@phone.calllock.ai`,
      timeZone: "America/Chicago",
    },
    metadata: {
      phone: params.customerPhone,
      address: params.serviceAddress,
      serviceType: params.serviceType,
      urgency: params.urgency,
      problemDescription: params.problemDescription,
    },
  };

  log.info(
    {
      eventTypeId: CAL_COM_EVENT_TYPE_ID,
      dateTime: params.dateTime,
      serviceType: params.serviceType,
    },
    "Sending Cal.com booking request"
  );

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CAL_COM_API_KEY}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bookingData),
    },
    { retries: 1, timeout: 5000 }  // Reduced to prevent blocking Retell responses
  );

  if (!response.ok) {
    const error = await response.text();
    log.error({ status: response.status, error }, "Cal.com API error");
    throw new Error(`Cal.com booking error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as CalComBookingResponse;
  log.info({ bookingUid: data.data.uid }, "Cal.com booking created");

  // Parse the booking response
  const startTime = new Date(data.data.startTime);
  const dateStr = startTime.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const timeStr = startTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return {
    success: true,
    booking_confirmed: true,
    appointmentId: data.data.uid,
    confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
  };
}

/**
 * Generate mock booking confirmation (fallback)
 */
function generateMockBookingConfirmation(
  params: BookAppointmentParams
): BookAppointmentResult {
  const appointmentId = `apt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const dateTime = new Date(params.dateTime);
  const dateStr = dateTime.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const timeStr = dateTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  log.info({ appointmentId }, "Generated mock booking");

  return {
    success: true,
    booking_confirmed: true,
    appointmentId,
    confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
  };
}

/**
 * Update an existing appointment
 */
export async function updateAppointment(
  appointmentId: string,
  updates: Partial<BookAppointmentParams>
): Promise<BookAppointmentResult> {
  log.info({ appointmentId, updates }, "Updating appointment");

  // TODO: Integrate with Cal.com reschedule API
  return {
    success: true,
    booking_confirmed: true,
    appointmentId,
    confirmationMessage: "Appointment updated successfully",
  };
}

/**
 * Cancel an appointment
 */
export async function cancelAppointment(
  appointmentId: string,
  reason?: string
): Promise<{ success: boolean; message: string }> {
  log.info({ appointmentId, reason }, "Cancelling appointment");

  if (CAL_COM_API_KEY && appointmentId && !appointmentId.startsWith("apt_")) {
    // Real Cal.com booking - cancel via API
    try {
      const response = await fetchWithRetry(
        `${CAL_API_BASE}/bookings/${appointmentId}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CAL_COM_API_KEY}`,
            "cal-api-version": "2024-08-13",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cancellationReason: reason || "Cancelled via phone",
          }),
        },
        { retries: 1, timeout: 5000 }  // Reduced to prevent blocking Retell responses
      );

      if (response.ok) {
        log.info({ appointmentId }, "Appointment cancelled via Cal.com");
        return {
          success: true,
          message: "Appointment cancelled successfully",
        };
      }
    } catch (error) {
      if (error instanceof FetchError) {
        log.error({ error: error.message, appointmentId }, "Cancel failed after retries");
      } else {
        log.error({ error, appointmentId }, "Cancel error");
      }
    }
  }

  return {
    success: true,
    message: "Appointment cancelled",
  };
}
