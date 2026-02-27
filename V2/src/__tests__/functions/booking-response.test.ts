import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const originalCalApiKey = process.env.CAL_COM_API_KEY;

describe('bookAppointment response compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CAL_COM_API_KEY;
  });

  afterAll(() => {
    if (originalCalApiKey === undefined) {
      delete process.env.CAL_COM_API_KEY;
    } else {
      process.env.CAL_COM_API_KEY = originalCalApiKey;
    }
  });

  it('returns both booking_confirmed and booked aliases in mock fallback', async () => {
    const { bookAppointment } = await import('../../functions/booking.js');

    const result = await bookAppointment({
      dateTime: '2026-02-27T15:45:00.000Z',
      customerName: 'Jonas',
      customerPhone: '+15125551212',
      serviceAddress: '123 Main St, Austin, TX 78745',
      serviceType: 'HVAC',
      urgency: 'Urgent',
      problemDescription: 'AC not cooling',
    });

    expect(result.success).toBe(true);
    expect(result.booking_confirmed).toBe(true);
    expect(result.booked).toBe(true);
    expect(result.appointmentId).toMatch(/^apt_/);
    expect(result.appointment_time).toBe('2026-02-27T15:45:00.000Z');
    expect(result.confirmationMessage).toMatch(/Appointment confirmed/i);
  });
});
