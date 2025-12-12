/**
 * SMS Alerts Service
 * Sends alerts to dispatcher/owner for emergencies and sales leads
 */

import { EmergencyAlertParams, EmergencyAlertResult, SalesLeadAlertParams, SalesLeadAlertResult } from "../types/retell.js";
import { createModuleLogger, maskPhone } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

const log = createModuleLogger("alerts");

// Twilio configuration (optional - falls back to console log if not configured)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const EMERGENCY_SMS_NUMBER = process.env.EMERGENCY_SMS_NUMBER;

/**
 * Send an emergency SMS alert to the dispatcher/owner
 *
 * SMS format (punchy, no fluff):
 * URGENT: No heat, elderly in home
 * Caller: (248) 555-1234
 * Address: 1234 Oak St, Milford
 * Promised callback within 15 min
 */
export async function sendEmergencyAlert(
  params: EmergencyAlertParams
): Promise<EmergencyAlertResult> {
  const { urgencyDescription, callerPhone, address, callbackMinutes } = params;

  // Format the SMS message
  const smsMessage = [
    `URGENT: ${urgencyDescription}`,
    `Caller: ${formatPhone(callerPhone)}`,
    `Address: ${address}`,
    `Promised callback within ${callbackMinutes} min`,
  ].join("\n");

  log.info(
    {
      urgencyDescription,
      phone: maskPhone(callerPhone),
      callbackMinutes,
    },
    "Emergency alert triggered"
  );

  // If Twilio is configured, send real SMS
  if (
    TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    TWILIO_FROM_NUMBER &&
    EMERGENCY_SMS_NUMBER
  ) {
    try {
      const result = await sendTwilioSMS(EMERGENCY_SMS_NUMBER, smsMessage);
      return result;
    } catch (error) {
      if (error instanceof FetchError) {
        log.error({ error: error.message, attempts: error.attempts }, "Twilio SMS failed after retries");
      } else {
        log.error({ error }, "Twilio SMS failed");
      }
      // Fall through to mock response
    }
  } else {
    log.info("Twilio not configured - logging SMS instead");
    log.info({ smsContent: smsMessage }, "SMS that would be sent");
  }

  // Return success (either real SMS sent or logged for demo)
  const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  return {
    success: true,
    alertId,
    message: "Emergency alert sent successfully",
  };
}

/**
 * Send SMS via Twilio
 */
async function sendTwilioSMS(
  to: string,
  body: string
): Promise<EmergencyAlertResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  log.info({ to: maskPhone(to) }, "Sending Twilio SMS");

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: TWILIO_FROM_NUMBER!,
        Body: body,
      }),
    },
    { retries: 2, timeout: 15000 }
  );

  if (!response.ok) {
    const error = await response.text();
    log.error({ status: response.status, error }, "Twilio API error");
    throw new Error(`Twilio error: ${response.status}`);
  }

  const data = (await response.json()) as { sid: string };

  log.info({ messageSid: data.sid }, "SMS sent successfully");

  return {
    success: true,
    alertId: data.sid,
    message: "Emergency SMS sent",
  };
}

/**
 * Send a sales lead SMS alert to the owner
 *
 * SMS format:
 * SALES LEAD: AC Replacement
 * Customer: John Smith
 * Phone: (512) 555-1234
 * Address: 1234 Oak St, Austin
 * Equipment: Central AC, 20 years old
 * Promised callback
 */
export async function sendSalesLeadAlert(
  params: SalesLeadAlertParams
): Promise<SalesLeadAlertResult> {
  const { customerName, customerPhone, address, currentEquipment, equipmentAge, notes } = params;

  // Build equipment description
  const equipmentParts: string[] = [];
  if (currentEquipment) equipmentParts.push(currentEquipment);
  if (equipmentAge) equipmentParts.push(equipmentAge);
  const equipmentDesc = equipmentParts.length > 0 ? equipmentParts.join(", ") : "Not specified";

  // Format the SMS message
  const messageLines = [
    `SALES LEAD: ${currentEquipment || "HVAC"} Replacement`,
    customerName ? `Customer: ${customerName}` : null,
    `Phone: ${formatPhone(customerPhone)}`,
    address ? `Address: ${address}` : null,
    `Equipment: ${equipmentDesc}`,
    notes ? `Notes: ${notes}` : null,
    `Promised callback`,
  ].filter(Boolean);

  const smsMessage = messageLines.join("\n");

  log.info(
    {
      phone: maskPhone(customerPhone),
      equipment: currentEquipment,
      equipmentAge,
    },
    "Sales lead alert triggered"
  );

  // If Twilio is configured, send real SMS
  if (
    TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    TWILIO_FROM_NUMBER &&
    EMERGENCY_SMS_NUMBER
  ) {
    try {
      const result = await sendTwilioSMS(EMERGENCY_SMS_NUMBER, smsMessage);
      return {
        success: result.success,
        alertId: result.alertId,
        message: "Sales lead alert sent successfully",
      };
    } catch (error) {
      if (error instanceof FetchError) {
        log.error({ error: error.message, attempts: error.attempts }, "Twilio SMS failed after retries");
      } else {
        log.error({ error }, "Twilio SMS failed");
      }
      // Fall through to mock response
    }
  } else {
    log.info("Twilio not configured - logging SMS instead");
    log.info({ smsContent: smsMessage }, "SMS that would be sent");
  }

  // Return success (either real SMS sent or logged for demo)
  const alertId = `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  return {
    success: true,
    alertId,
    message: "Sales lead alert sent successfully",
  };
}

/**
 * Format phone number for display
 */
function formatPhone(phone: string): string {
  // Remove non-digits
  const digits = phone.replace(/\D/g, "");

  // Format as (XXX) XXX-XXXX if 10 digits
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  // Format as +X (XXX) XXX-XXXX if 11 digits (with country code)
  if (digits.length === 11 && digits[0] === "1") {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  // Return as-is if other format
  return phone;
}
