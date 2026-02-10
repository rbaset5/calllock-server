import { createModuleLogger } from "./logger.js";

const log = createModuleLogger("health");

export interface HealthCheckResult {
  status: "ok" | "degraded" | "error";
  latency?: number;
  message?: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime: number;
  dependencies: {
    anthropic: HealthCheckResult;
    calcom: HealthCheckResult;
    supabase: HealthCheckResult;
    supabase_service_key: HealthCheckResult;
    twilio: HealthCheckResult;
  };
}

const startTime = Date.now();

/**
 * Check Anthropic API health
 */
export async function checkAnthropic(): Promise<HealthCheckResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: "error", message: "API key not configured" };
  }

  const start = Date.now();
  try {
    // Simple validation - the SDK will throw if the key is invalid format
    // We don't make actual API calls to avoid cost
    const keyPrefix = process.env.ANTHROPIC_API_KEY.substring(0, 7);
    if (!keyPrefix.startsWith("sk-ant-")) {
      return { status: "error", message: "Invalid API key format" };
    }
    return { status: "ok", latency: Date.now() - start };
  } catch (error) {
    log.error({ error }, "Anthropic health check failed");
    return {
      status: "error",
      latency: Date.now() - start,
      message: (error as Error).message,
    };
  }
}

/**
 * Check Cal.com API health
 */
export async function checkCalCom(): Promise<HealthCheckResult> {
  if (!process.env.CAL_COM_API_KEY) {
    return { status: "degraded", message: "API key not configured (using mock)" };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://api.cal.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.CAL_COM_API_KEY}`,
        "cal-api-version": "2024-08-13",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { status: "ok", latency: Date.now() - start };
    }

    if (response.status === 401) {
      return {
        status: "error",
        latency: Date.now() - start,
        message: "Invalid API key",
      };
    }

    return {
      status: "degraded",
      latency: Date.now() - start,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    log.error({ error }, "Cal.com health check failed");
    return {
      status: "error",
      latency: Date.now() - start,
      message: (error as Error).message,
    };
  }
}

/**
 * Check Supabase health
 */
export async function checkSupabase(): Promise<HealthCheckResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return { status: "degraded", message: "Not configured (persistence disabled)" };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Simple REST API check
    const response = await fetch(`${url}/rest/v1/`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Supabase returns 200 even for empty response
    if (response.ok || response.status === 406) {
      return { status: "ok", latency: Date.now() - start };
    }

    return {
      status: "error",
      latency: Date.now() - start,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    log.error({ error }, "Supabase health check failed");
    return {
      status: "error",
      latency: Date.now() - start,
      message: (error as Error).message,
    };
  }
}

/**
 * Check Supabase service role key (used by customer-history for RLS-protected tables)
 */
export async function checkSupabaseServiceKey(): Promise<HealthCheckResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return { status: "degraded", message: key ? "Missing SUPABASE_URL" : "Missing SUPABASE_SERVICE_ROLE_KEY (caller history disabled)" };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Query calls table with limit=1 — this table has RLS, so anon key would fail
    const response = await fetch(`${url}/rest/v1/calls?select=call_id&limit=1`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { status: "ok", latency: Date.now() - start };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "error",
        latency: Date.now() - start,
        message: `Auth failed (HTTP ${response.status}) — key may be wrong`,
      };
    }

    return {
      status: "degraded",
      latency: Date.now() - start,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    log.error({ error }, "Supabase service key health check failed");
    return {
      status: "error",
      latency: Date.now() - start,
      message: (error as Error).message,
    };
  }
}

/**
 * Check Twilio health (optional)
 */
export async function checkTwilio(): Promise<HealthCheckResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    return { status: "degraded", message: "Not configured (SMS alerts disabled)" };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      {
        method: "GET",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        },
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (response.ok) {
      return { status: "ok", latency: Date.now() - start };
    }

    if (response.status === 401) {
      return {
        status: "error",
        latency: Date.now() - start,
        message: "Invalid credentials",
      };
    }

    return {
      status: "degraded",
      latency: Date.now() - start,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    log.error({ error }, "Twilio health check failed");
    return {
      status: "error",
      latency: Date.now() - start,
      message: (error as Error).message,
    };
  }
}

/**
 * Run all health checks and return aggregated status
 */
export async function runHealthChecks(): Promise<HealthStatus> {
  const [anthropic, calcom, supabase, supabase_service_key, twilio] = await Promise.all([
    checkAnthropic(),
    checkCalCom(),
    checkSupabase(),
    checkSupabaseServiceKey(),
    checkTwilio(),
  ]);

  const dependencies = { anthropic, calcom, supabase, supabase_service_key, twilio };

  // Determine overall status
  const statuses = Object.values(dependencies).map((d) => d.status);
  let overallStatus: "healthy" | "degraded" | "unhealthy";

  if (statuses.every((s) => s === "ok")) {
    overallStatus = "healthy";
  } else if (statuses.some((s) => s === "error")) {
    // Check if critical services (anthropic) are down
    if (anthropic.status === "error") {
      overallStatus = "unhealthy";
    } else {
      overallStatus = "degraded";
    }
  } else {
    overallStatus = "degraded";
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    dependencies,
  };
}
