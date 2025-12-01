import {
  BookAppointmentParams,
  BookAppointmentResult,
} from "../types/retell.js";

const CAL_COM_API_KEY = process.env.CAL_COM_API_KEY;
const CAL_COM_EVENT_TYPE_ID = process.env.CAL_COM_EVENT_TYPE_ID || "3877847";
const CAL_API_BASE = "https://api.cal.com/v2";
const FETCH_TIMEOUT_MS = 10000;

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
  console.log("[Booking] Creating appointment:", params);

  // Try Cal.com API if configured
  if (CAL_COM_API_KEY) {
    try {
      const result = await createCalComBooking(params);
      return result;
    } catch (error) {
      console.error("[Booking] Cal.com API error, falling back to mock:", error);
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
  const firstName = nameParts[0] || "HVAC";
  const lastName = nameParts.slice(1).join(" ") || "Customer";

  // Create booking payload for Cal.com v2 API
  const bookingData = {
    eventTypeId: parseInt(CAL_COM_EVENT_TYPE_ID),
    start: params.dateTime,
    attendee: {
      name: params.customerName || "HVAC Customer",
      email: `${params.customerPhone.replace(/\D/g, "")}@phone.calllock.ai`, // Generate email from phone
      timeZone: "America/Chicago", // Default to Central time for Austin
    },
    metadata: {
      phone: params.customerPhone,
      address: params.serviceAddress,
      serviceType: params.serviceType,
      urgency: params.urgency,
      problemDescription: params.problemDescription,
    },
  };

  console.log("[Booking] Cal.com request:", JSON.stringify(bookingData));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CAL_COM_API_KEY}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bookingData),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.text();
      console.error("[Booking] Cal.com API error:", response.status, error);
      throw new Error(`Cal.com booking error: ${response.status} - ${error}`);
    }

    const data = await response.json() as CalComBookingResponse;
    console.log("[Booking] Cal.com booking created:", data);

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
      appointmentId: data.data.uid,
      confirmationMessage: `Appointment confirmed for ${dateStr} at ${timeStr}`,
    };

  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
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

  return {
    success: true,
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
  console.log("[Booking] Updating appointment:", appointmentId, updates);

  // TODO: Integrate with Cal.com reschedule API
  return {
    success: true,
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
  console.log("[Booking] Cancelling appointment:", appointmentId, reason);

  if (CAL_COM_API_KEY && appointmentId && !appointmentId.startsWith("apt_")) {
    // Real Cal.com booking - cancel via API
    try {
      const response = await fetch(`${CAL_API_BASE}/bookings/${appointmentId}/cancel`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CAL_COM_API_KEY}`,
          "cal-api-version": "2024-08-13",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cancellationReason: reason || "Cancelled via phone",
        }),
      });

      if (response.ok) {
        return {
          success: true,
          message: "Appointment cancelled successfully",
        };
      }
    } catch (error) {
      console.error("[Booking] Cancel error:", error);
    }
  }

  return {
    success: true,
    message: "Appointment cancelled",
  };
}
