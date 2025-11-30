/**
 * Cal.com API Service
 * Handles booking lookup, cancellation, and rescheduling
 */

const CAL_COM_API_KEY = process.env.CAL_COM_API_KEY;
const CAL_API_BASE = "https://api.cal.com/v2";

interface CalBooking {
  uid: string;
  title: string;
  start: string;
  end: string;
  status: string;
  attendees: Array<{
    name: string;
    email: string;
    phone?: string;
  }>;
}

interface LookupResult {
  found: boolean;
  booking?: {
    uid: string;
    date: string;
    time: string;
    status: string;
  };
  message: string;
}

interface CancelResult {
  success: boolean;
  message: string;
}

interface RescheduleResult {
  success: boolean;
  message: string;
  newDateTime?: string;
}

/**
 * Look up a booking by phone number
 */
export async function lookupBookingByPhone(phone: string): Promise<LookupResult> {
  if (!CAL_COM_API_KEY) {
    console.error("[CalCom] API key not configured");
    return { found: false, message: "Calendar service not configured" };
  }

  try {
    // Normalize phone number (remove spaces, dashes, etc.)
    const normalizedPhone = phone.replace(/\D/g, "");

    // Get bookings from Cal.com
    // Note: Cal.com v2 API uses different endpoints - adjust as needed
    const response = await fetch(`${CAL_API_BASE}/bookings?status=upcoming`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${CAL_COM_API_KEY}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[CalCom] API error:", response.status, error);
      return { found: false, message: "Unable to check bookings at this time" };
    }

    const data = await response.json() as { data?: CalBooking[] };
    const bookings: CalBooking[] = data.data || [];

    // Find booking matching this phone number
    const matchingBooking = bookings.find((booking) => {
      return booking.attendees?.some((attendee) => {
        const attendeePhone = attendee.phone?.replace(/\D/g, "") || "";
        return attendeePhone.includes(normalizedPhone) || normalizedPhone.includes(attendeePhone);
      });
    });

    if (matchingBooking) {
      const startDate = new Date(matchingBooking.start);
      return {
        found: true,
        booking: {
          uid: matchingBooking.uid,
          date: startDate.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          }),
          time: startDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }),
          status: matchingBooking.status,
        },
        message: `Found appointment for ${startDate.toLocaleDateString()}`,
      };
    }

    return {
      found: false,
      message: "No upcoming appointment found for this phone number",
    };
  } catch (error) {
    console.error("[CalCom] Lookup error:", error);
    return { found: false, message: "Error looking up booking" };
  }
}

/**
 * Cancel a booking by UID
 */
export async function cancelBooking(
  bookingUid: string,
  reason?: string
): Promise<CancelResult> {
  if (!CAL_COM_API_KEY) {
    console.error("[CalCom] API key not configured");
    return { success: false, message: "Calendar service not configured" };
  }

  try {
    const response = await fetch(`${CAL_API_BASE}/bookings/${bookingUid}/cancel`, {
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

    if (!response.ok) {
      const error = await response.text();
      console.error("[CalCom] Cancel error:", response.status, error);
      return { success: false, message: "Unable to cancel booking" };
    }

    return {
      success: true,
      message: "Your appointment has been cancelled successfully",
    };
  } catch (error) {
    console.error("[CalCom] Cancel error:", error);
    return { success: false, message: "Error cancelling booking" };
  }
}

/**
 * Reschedule a booking to a new time
 */
export async function rescheduleBooking(
  bookingUid: string,
  newStartTime: string
): Promise<RescheduleResult> {
  if (!CAL_COM_API_KEY) {
    console.error("[CalCom] API key not configured");
    return { success: false, message: "Calendar service not configured" };
  }

  try {
    const response = await fetch(`${CAL_API_BASE}/bookings/${bookingUid}/reschedule`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CAL_COM_API_KEY}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: newStartTime,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[CalCom] Reschedule error:", response.status, error);
      return { success: false, message: "Unable to reschedule booking" };
    }

    const newDate = new Date(newStartTime);
    const formattedDate = newDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const formattedTime = newDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    return {
      success: true,
      message: `Your appointment has been rescheduled to ${formattedDate} at ${formattedTime}`,
      newDateTime: newStartTime,
    };
  } catch (error) {
    console.error("[CalCom] Reschedule error:", error);
    return { success: false, message: "Error rescheduling booking" };
  }
}
