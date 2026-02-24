import { describe, it, expect } from "vitest";
import { formatBookingTime } from "../booking.js";

describe("formatBookingTime", () => {
  it("formats UTC time as America/Chicago timezone", () => {
    // 2026-02-25T15:00:00Z (3 PM UTC) = 9:00 AM CST
    const result = formatBookingTime("2026-02-25T15:00:00.000Z");
    expect(result.timeStr).toBe("9:00 AM");
    expect(result.dateStr).toContain("Wednesday");
    expect(result.dateStr).toContain("February");
    expect(result.dateStr).toContain("25");
  });

  it("formats CST offset time correctly", () => {
    // 2026-02-25T09:00:00-06:00 = 9:00 AM CST
    const result = formatBookingTime("2026-02-25T09:00:00-06:00");
    expect(result.timeStr).toBe("9:00 AM");
  });

  it("handles afternoon times", () => {
    // 2026-02-25T20:00:00Z (8 PM UTC) = 2:00 PM CST
    const result = formatBookingTime("2026-02-25T20:00:00.000Z");
    expect(result.timeStr).toBe("2:00 PM");
  });
});
