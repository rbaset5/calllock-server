import { describe, it, expect } from 'vitest';

describe('booking_status payload logic', () => {
  function getBookingStatus(appointmentBooked: boolean, bookingAttempted: boolean): string {
    // This mirrors the logic in dashboard.ts
    return appointmentBooked
      ? 'confirmed'
      : bookingAttempted
        ? 'attempted_failed'
        : 'not_requested';
  }

  it('returns confirmed when appointment was booked', () => {
    expect(getBookingStatus(true, true)).toBe('confirmed');
  });

  it('returns attempted_failed when booking was attempted but failed', () => {
    expect(getBookingStatus(false, true)).toBe('attempted_failed');
  });

  it('returns not_requested when no booking was attempted', () => {
    expect(getBookingStatus(false, false)).toBe('not_requested');
  });
});
