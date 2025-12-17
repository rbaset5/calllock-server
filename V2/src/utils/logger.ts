import pino from "pino";

// Create base logger with PII redaction
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Redact sensitive fields (PII)
  redact: {
    paths: [
      "phone",
      "customerPhone",
      "from_number",
      "to_number",
      "*.phone",
      "*.customerPhone",
      "*.from_number",
      "*.to_number",
      "apiKey",
      "password",
      "token",
      "*.apiKey",
      "*.password",
      "*.token",
    ],
    censor: "[REDACTED]",
  },
  // Base context
  base: {
    service: "calllock-retell",
    version: process.env.npm_package_version || "1.0.0",
  },
});

// Create child logger for a specific call
export function createCallLogger(callId: string) {
  return logger.child({ callId });
}

// Create child logger for a specific module/service
export function createModuleLogger(module: string) {
  return logger.child({ module });
}

// Mask phone number for safe display (last 4 digits only)
export function maskPhone(phone: string | undefined): string {
  if (!phone) return "unknown";
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length < 4) return "****";
  return `***-***-${cleaned.slice(-4)}`;
}

// Export types
export type Logger = pino.Logger;
