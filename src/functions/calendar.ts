import {
  CalendarAvailabilityParams,
  CalendarAvailabilityResult,
  CalendarSlot,
  UrgencyLevel,
} from "../types/retell.js";

const FETCH_TIMEOUT_MS = 10000; // 10 second timeout

/**
 * Check calendar availability based on urgency level
 *
 * Currently uses mock data. To integrate Cal.com availability:
 * - Use Cal.com Availability API: GET /v2/slots/available
 * - See: https://cal.com/docs/api-reference/v2/slots
 */
export async function checkCalendarAvailability(
  params: CalendarAvailabilityParams
): Promise<CalendarAvailabilityResult> {
  console.log("[Calendar] Checking availability:", params);

  // TODO: Integrate Cal.com availability API
  // For now, return mock availability based on urgency
  return generateMockAvailability(params.urgency);
}

/**
 * Generate mock availability slots based on urgency
 */
function generateMockAvailability(urgency: UrgencyLevel): CalendarAvailabilityResult {
  const now = new Date();
  const slots: CalendarSlot[] = [];

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  switch (urgency) {
    case "Emergency":
      // Emergency: Offer slots within 1-4 hours
      const emergencyTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours from now
      slots.push({
        date: emergencyTime.toISOString().split("T")[0],
        dayOfWeek: "Today",
        timeWindow: `${formatTime(emergencyTime)} - ${formatTime(
          new Date(emergencyTime.getTime() + 2 * 60 * 60 * 1000)
        )}`,
      });
      break;

    case "Urgent":
      // Urgent: Same day or next day
      const urgentTime1 = new Date(now.getTime() + 4 * 60 * 60 * 1000);
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);

      slots.push({
        date: now.toISOString().split("T")[0],
        dayOfWeek: "Today",
        timeWindow: `${formatTime(urgentTime1)} - ${formatTime(
          new Date(urgentTime1.getTime() + 2 * 60 * 60 * 1000)
        )}`,
      });
      slots.push({
        date: tomorrow.toISOString().split("T")[0],
        dayOfWeek: dayNames[tomorrow.getDay()],
        timeWindow: "9:00 AM - 11:00 AM",
      });
      break;

    case "Routine":
    case "Estimate":
    default:
      // Routine: 2-7 days out, offer multiple slots
      for (let i = 2; i <= 5; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() + i);

        // Skip weekends for routine
        if (date.getDay() === 0 || date.getDay() === 6) continue;

        slots.push({
          date: date.toISOString().split("T")[0],
          dayOfWeek: dayNames[date.getDay()],
          timeWindow: i % 2 === 0 ? "9:00 AM - 11:00 AM" : "2:00 PM - 4:00 PM",
        });

        if (slots.length >= 3) break;
      }
      break;
  }

  return { availableSlots: slots };
}

/**
 * Format time to human readable string
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
