import {
  CalendarAvailabilityParams,
  CalendarAvailabilityResult,
  CalendarSlot,
  UrgencyLevel,
} from "../types/retell.js";
import { createModuleLogger } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

const log = createModuleLogger("calendar");

const CAL_COM_API_KEY = process.env.CAL_COM_API_KEY;
const CAL_COM_EVENT_TYPE_ID = process.env.CAL_COM_EVENT_TYPE_ID || "3877847";
const CAL_API_BASE = "https://api.cal.com/v2";

interface CalComSlot {
  time: string;
}

interface CalComSlotsResponse {
  status: string;
  data: {
    slots: Record<string, CalComSlot[]>;
  };
}

/**
 * Check calendar availability based on urgency level
 * Uses Cal.com API for real availability, falls back to mock if not configured
 */
export async function checkCalendarAvailability(
  params: CalendarAvailabilityParams
): Promise<CalendarAvailabilityResult> {
  log.info({ urgency: params.urgency }, "Checking availability");

  // Try Cal.com API if configured (production mode)
  if (CAL_COM_API_KEY) {
    try {
      const calComSlots = await fetchCalComAvailability(params.urgency);
      // Return Cal.com result even if empty - don't fake availability
      if (calComSlots.availableSlots.length === 0) {
        log.info("No Cal.com slots available");
      }
      return calComSlots;
    } catch (error) {
      if (error instanceof FetchError) {
        log.error({ error: error.message, attempts: error.attempts }, "Cal.com API failed after retries");
      } else {
        log.error({ error }, "Cal.com API error");
      }
      // Return empty slots on API failure - don't fake availability
      return { availableSlots: [] };
    }
  }

  // Only use mock data when Cal.com is NOT configured (dev/testing mode)
  log.info("Cal.com not configured, using mock data");
  return generateMockAvailability(params.urgency);
}

/**
 * Fetch real availability from Cal.com API
 */
async function fetchCalComAvailability(
  urgency: UrgencyLevel
): Promise<CalendarAvailabilityResult> {
  const now = new Date();
  let startDate: Date;
  let endDate: Date;

  // Set date range based on urgency
  switch (urgency) {
    case "Emergency":
      startDate = now;
      endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Next 24 hours
      break;
    case "Urgent":
      startDate = now;
      endDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // Next 2 days
      break;
    case "Routine":
    case "Estimate":
    default:
      startDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // Start 2 days out
      endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Up to 7 days
      break;
  }

  const startTime = startDate.toISOString();
  const endTime = endDate.toISOString();

  const url = `${CAL_API_BASE}/slots/available?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&eventTypeId=${CAL_COM_EVENT_TYPE_ID}`;

  log.info(
    { startTime, endTime, eventTypeId: CAL_COM_EVENT_TYPE_ID },
    "Fetching Cal.com slots"
  );

  const response = await fetchWithRetry(
    url,
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
    log.error({ status: response.status, error }, "Cal.com API error");
    throw new Error(`Cal.com API error: ${response.status}`);
  }

  const data = (await response.json()) as CalComSlotsResponse;

  // Convert Cal.com slots to our format
  const slots: CalendarSlot[] = [];
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  if (data.data?.slots) {
    // Cal.com returns slots grouped by date
    for (const [dateStr, daySlots] of Object.entries(data.data.slots)) {
      if (daySlots.length === 0) continue;

      // Take first available slot for each day
      const firstSlot = daySlots[0];
      const slotDate = new Date(firstSlot.time);

      const isToday = slotDate.toDateString() === now.toDateString();
      const isTomorrow =
        slotDate.toDateString() ===
        new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString();

      slots.push({
        date: dateStr,
        dayOfWeek: isToday
          ? "Today"
          : isTomorrow
            ? "Tomorrow"
            : dayNames[slotDate.getDay()],
        timeWindow: formatTime(slotDate),
      });

      // Limit to 3 options
      if (slots.length >= 3) break;
    }
  }

  log.info({ slotCount: slots.length }, "Parsed Cal.com slots");
  return { availableSlots: slots };
}

/**
 * Generate mock availability slots based on urgency (fallback)
 */
function generateMockAvailability(
  urgency: UrgencyLevel
): CalendarAvailabilityResult {
  const now = new Date();
  const slots: CalendarSlot[] = [];
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  switch (urgency) {
    case "Emergency":
      const emergencyTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      slots.push({
        date: emergencyTime.toISOString().split("T")[0],
        dayOfWeek: "Today",
        timeWindow: `${formatTime(emergencyTime)} - ${formatTime(new Date(emergencyTime.getTime() + 2 * 60 * 60 * 1000))}`,
      });
      break;

    case "Urgent":
      const urgentTime1 = new Date(now.getTime() + 4 * 60 * 60 * 1000);
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);

      slots.push({
        date: now.toISOString().split("T")[0],
        dayOfWeek: "Today",
        timeWindow: `${formatTime(urgentTime1)} - ${formatTime(new Date(urgentTime1.getTime() + 2 * 60 * 60 * 1000))}`,
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
      for (let i = 2; i <= 5; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() + i);
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

  log.info({ urgency, slotCount: slots.length }, "Generated mock availability");
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
