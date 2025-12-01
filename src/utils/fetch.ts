import { createModuleLogger } from "./logger.js";

const log = createModuleLogger("fetch");

interface FetchWithRetryOptions {
  /** Number of retry attempts (default: 3) */
  retries?: number;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Backoff strategy (default: exponential) */
  backoff?: "exponential" | "linear";
  /** Base delay for backoff in ms (default: 1000) */
  baseDelay?: number;
  /** HTTP status codes that should trigger a retry (default: [408, 429, 500, 502, 503, 504]) */
  retryableStatusCodes?: number[];
}

const DEFAULT_OPTIONS: Required<FetchWithRetryOptions> = {
  retries: 3,
  timeout: 10000,
  backoff: "exponential",
  baseDelay: 1000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly isRetryable: boolean = false,
    public readonly attempts: number = 1
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * Fetch with automatic retry, timeout, and exponential backoff
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: FetchWithRetryOptions = {}
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...config };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Check if we should retry based on status code
      if (!response.ok && opts.retryableStatusCodes.includes(response.status)) {
        if (attempt <= opts.retries) {
          const delay = calculateDelay(attempt, opts.backoff, opts.baseDelay);
          log.warn(
            { url: sanitizeUrl(url), status: response.status, attempt, delay },
            "Retryable error, backing off"
          );
          await sleep(delay);
          continue;
        }
      }

      // Return response (even if not ok - let caller handle business logic errors)
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error as Error;

      const isTimeout = (error as Error).name === "AbortError";
      const isRetryable = isTimeout || isNetworkError(error);

      if (isRetryable && attempt <= opts.retries) {
        const delay = calculateDelay(attempt, opts.backoff, opts.baseDelay);
        log.warn(
          {
            url: sanitizeUrl(url),
            error: (error as Error).message,
            attempt,
            delay,
            isTimeout,
          },
          "Fetch failed, retrying"
        );
        await sleep(delay);
        continue;
      }

      // Final attempt failed
      throw new FetchError(
        `Fetch failed after ${attempt} attempts: ${(error as Error).message}`,
        undefined,
        isRetryable,
        attempt
      );
    }
  }

  // Should not reach here, but TypeScript needs it
  throw new FetchError(
    `Fetch failed after all retries: ${lastError?.message}`,
    undefined,
    false,
    opts.retries + 1
  );
}

function calculateDelay(
  attempt: number,
  backoff: "exponential" | "linear",
  baseDelay: number
): number {
  // Add jitter to prevent thundering herd
  const jitter = Math.random() * 0.3 + 0.85; // 0.85-1.15

  if (backoff === "exponential") {
    return Math.min(baseDelay * Math.pow(2, attempt - 1) * jitter, 30000);
  }
  return Math.min(baseDelay * attempt * jitter, 30000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // Network errors in fetch throw TypeError
    return true;
  }
  const message = (error as Error).message?.toLowerCase() || "";
  return (
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout")
  );
}

// Remove sensitive parts from URL for logging
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove query params that might contain sensitive data
    u.search = u.search ? "[params]" : "";
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}
