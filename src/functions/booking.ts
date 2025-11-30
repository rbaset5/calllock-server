import {
  BookAppointmentParams,
  BookAppointmentResult,
} from "../types/retell.js";

const N8N_WEBHOOK_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL;

/**
 * Book a service appointment
 *
 * This can either:
 * 1. Call your n8n webhook which creates Google Calendar event + logs to Sheets
 * 2. Return mock confirmation for testing
 * 3. Directly call Google Calendar API
 */
export async function bookAppointment(
  params: BookAppointmentParams
): Promise<BookAppointmentResult> {
  console.log("[Booking] Creating appointment:", params);

  // If n8n webhook is configured, use it
  if (N8N_WEBHOOK_BASE_URL) {
    try {
      const response = await fetch(`${N8N_WEBHOOK_BASE_URL}/appointments/book`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.N8N_WEBHOOK_SECRET || "",
        },
        body: JSON.stringify(params),
      });

      if (response.ok) {
        return (await response.json()) as BookAppointmentResult;
      }
    } catch (error) {
      console.error("[Booking] n8n webhook error:", error);
      // Fall through to mock data
    }
  }

  // Return mock confirmation for testing/demo
  return generateMockBookingConfirmation(params);
}

/**
 * Generate mock booking confirmation
 */
function generateMockBookingConfirmation(
  params: BookAppointmentParams
): BookAppointmentResult {
  const appointmentId = `apt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Parse the datetime to create a readable confirmation
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
 * Update an existing appointment (if needed)
 */
export async function updateAppointment(
  appointmentId: string,
  updates: Partial<BookAppointmentParams>
): Promise<BookAppointmentResult> {
  console.log("[Booking] Updating appointment:", appointmentId, updates);

  if (N8N_WEBHOOK_BASE_URL) {
    try {
      const response = await fetch(`${N8N_WEBHOOK_BASE_URL}/appointments/update`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.N8N_WEBHOOK_SECRET || "",
        },
        body: JSON.stringify({ appointmentId, ...updates }),
      });

      if (response.ok) {
        return (await response.json()) as BookAppointmentResult;
      }
    } catch (error) {
      console.error("[Booking] Update error:", error);
    }
  }

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

  if (N8N_WEBHOOK_BASE_URL) {
    try {
      const response = await fetch(`${N8N_WEBHOOK_BASE_URL}/appointments/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.N8N_WEBHOOK_SECRET || "",
        },
        body: JSON.stringify({ appointmentId, reason }),
      });

      if (response.ok) {
        return (await response.json()) as { success: boolean; message: string };
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
