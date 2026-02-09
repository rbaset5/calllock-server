/**
 * Cal.com API Service
 * Handles booking lookup, cancellation, and rescheduling
 */

import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

const log = createModuleLogger("calcom");

const CAL_COM_API_KEY = process.env.CAL_COM_API_KEY;
const SERVICE_TIMEZONE = "America/Chicago"; // Austin, TX is Central Time
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
    attendeeName?: string;
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
    log.warn("API key not configured");
    return { found: false, message: "Calendar service not configured" };
  }

  try {
    // Normalize phone number (remove spaces, dashes, etc.)
    const normalizedPhone = phone.replace(/\D/g, "");

    log.info({ phone: maskPhone(phone) }, "Looking up booking");

    // Get bookings from Cal.com
    const response = await fetchWithRetry(
      `${CAL_API_BASE}/bookings?status=upcoming`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CAL_COM_API_KEY}`,
          "cal-api-version": "2024-08-13",
          "Content-Type": "application/json",
        },
      },
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const error = await response.text();
      log.error({ status: response.status, error }, "API error during lookup");
      return { found: false, message: "Unable to check bookings at this time" };
    }

    const data = (await response.json()) as { data?: CalBooking[] };
    const bookings: CalBooking[] = data.data || [];

    // Find booking matching this phone number
    const matchingBooking = bookings.find((booking) => {
      return booking.attendees?.some((attendee) => {
        const attendeePhone = attendee.phone?.replace(/\D/g, "") || "";
        return (
          attendeePhone.includes(normalizedPhone) ||
          normalizedPhone.includes(attendeePhone)
        );
      });
    });

    if (matchingBooking) {
      const startDate = new Date(matchingBooking.start);
      // Extract name from the matching attendee
      const matchingAttendee = matchingBooking.attendees?.find((attendee) => {
        const attendeePhone = attendee.phone?.replace(/\D/g, "") || "";
        return (
          attendeePhone.includes(normalizedPhone) ||
          normalizedPhone.includes(attendeePhone)
        );
      });
      const attendeeName = matchingAttendee?.name || undefined;
      log.info({ bookingUid: matchingBooking.uid, attendeeName }, "Booking found");
      return {
        found: true,
        booking: {
          uid: matchingBooking.uid,
          date: startDate.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            timeZone: SERVICE_TIMEZONE,
          }),
          time: startDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: SERVICE_TIMEZONE,
          }),
          status: matchingBooking.status,
          attendeeName,
        },
        message: `Found appointment for ${startDate.toLocaleDateString("en-US", { timeZone: SERVICE_TIMEZONE })}`,
      };
    }

    log.info({ phone: maskPhone(phone) }, "No booking found");
    return {
      found: false,
      message: "No upcoming appointment found for this phone number",
    };
  } catch (error) {
    if (error instanceof FetchError) {
      log.error({ error: error.message, attempts: error.attempts }, "Lookup failed after retries");
    } else {
      log.error({ error }, "Lookup error");
    }
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
    log.warn("API key not configured");
    return { success: false, message: "Calendar service not configured" };
  }

  try {
    log.info({ bookingUid }, "Cancelling booking");

    const response = await fetchWithRetry(
      `${CAL_API_BASE}/bookings/${bookingUid}/cancel`,
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
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const error = await response.text();
      log.error({ status: response.status, error, bookingUid }, "Cancel API error");
      return { success: false, message: "Unable to cancel booking" };
    }

    log.info({ bookingUid }, "Booking cancelled successfully");
    return {
      success: true,
      message: "Your appointment has been cancelled successfully",
    };
  } catch (error) {
    if (error instanceof FetchError) {
      log.error({ error: error.message, attempts: error.attempts, bookingUid }, "Cancel failed after retries");
    } else {
      log.error({ error, bookingUid }, "Cancel error");
    }
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
    log.warn("API key not configured");
    return { success: false, message: "Calendar service not configured" };
  }

  try {
    log.info({ bookingUid, newStartTime }, "Rescheduling booking");

    const response = await fetchWithRetry(
      `${CAL_API_BASE}/bookings/${bookingUid}/reschedule`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CAL_COM_API_KEY}`,
          "cal-api-version": "2024-08-13",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start: newStartTime,
        }),
      },
      { retries: 2, timeout: 10000 }
    );

    if (!response.ok) {
      const error = await response.text();
      log.error({ status: response.status, error, bookingUid }, "Reschedule API error");
      return { success: false, message: "Unable to reschedule booking" };
    }

    const newDate = new Date(newStartTime);
    const formattedDate = newDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: SERVICE_TIMEZONE,
    });
    const formattedTime = newDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: SERVICE_TIMEZONE,
    });

    log.info({ bookingUid, newStartTime }, "Booking rescheduled successfully");
    return {
      success: true,
      message: `Your appointment has been rescheduled to ${formattedDate} at ${formattedTime}`,
      newDateTime: newStartTime,
    };
  } catch (error) {
    if (error instanceof FetchError) {
      log.error({ error: error.message, attempts: error.attempts, bookingUid }, "Reschedule failed after retries");
    } else {
      log.error({ error, bookingUid }, "Reschedule error");
    }
    return { success: false, message: "Error rescheduling booking" };
  }
}
