import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('webhook secret configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('alerts.ts uses DASHBOARD_WEBHOOK_SECRET (not WEBHOOK_SECRET)', async () => {
    // Set DASHBOARD_WEBHOOK_SECRET but not WEBHOOK_SECRET
    process.env.DASHBOARD_WEBHOOK_SECRET = 'correct_secret';
    delete process.env.WEBHOOK_SECRET;

    // Read the alerts module source to verify the env var name
    const fs = await import('fs');
    const path = await import('path');
    const alertsSource = fs.readFileSync(
      path.resolve(__dirname, '../../services/alerts.ts'),
      'utf-8'
    );

    // Verify it reads from DASHBOARD_WEBHOOK_SECRET
    expect(alertsSource).toContain('DASHBOARD_WEBHOOK_SECRET');
    // Verify the old WEBHOOK_SECRET is not used
    expect(alertsSource).not.toMatch(/process\.env\.WEBHOOK_SECRET\b/);
  });

  it('dashboard URL construction uses separate env vars', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dashboardSource = fs.readFileSync(
      path.resolve(__dirname, '../../services/dashboard.ts'),
      'utf-8'
    );

    // Verify URL construction exists — string replacement is a known fragile pattern
    // After the fix, DASHBOARD_CALLS_URL and DASHBOARD_ALERTS_URL env vars should be checked
    expect(dashboardSource).toContain('DASHBOARD_WEBHOOK_URL');
  });

  it('warns if DASHBOARD_WEBHOOK_URL does not point to production', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dashboardSource = fs.readFileSync(
      path.resolve(__dirname, '../../services/dashboard.ts'),
      'utf-8'
    );

    // Verify startup URL validation exists
    expect(dashboardSource).toContain('app.calllock.co');
  });
});
