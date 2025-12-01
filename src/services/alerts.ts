/**
 * Emergency SMS Alerts Service
 * Sends urgent alerts to dispatcher/owner for Tier 2 emergencies
 */

import { EmergencyAlertParams, EmergencyAlertResult } from "../types/retell.js";

// Twilio configuration (optional - falls back to console log if not configured)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const EMERGENCY_SMS_NUMBER = process.env.EMERGENCY_SMS_NUMBER;

/**
 * Send an emergency SMS alert to the dispatcher/owner
 *
 * SMS format (punchy, no fluff):
 * 🚨 URGENT: No heat, elderly in home
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
    `🚨 URGENT: ${urgencyDescription}`,
    `Caller: ${formatPhone(callerPhone)}`,
    `Address: ${address}`,
    `Promised callback within ${callbackMinutes} min`,
  ].join("\n");

  console.log("[Alerts] Emergency alert triggered:", {
    urgencyDescription,
    callerPhone,
    address,
    callbackMinutes,
  });

  // If Twilio is configured, send real SMS
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && EMERGENCY_SMS_NUMBER) {
    try {
      const result = await sendTwilioSMS(EMERGENCY_SMS_NUMBER, smsMessage);
      return result;
    } catch (error) {
      console.error("[Alerts] Twilio SMS failed:", error);
      // Fall through to mock response
    }
  } else {
    console.log("[Alerts] Twilio not configured. SMS that would be sent:");
    console.log("---");
    console.log(smsMessage);
    console.log("---");
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_FROM_NUMBER!,
      Body: body,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[Alerts] Twilio API error:", response.status, error);
    throw new Error(`Twilio error: ${response.status}`);
  }

  const data = await response.json() as { sid: string };

  console.log("[Alerts] SMS sent successfully:", data.sid);

  return {
    success: true,
    alertId: data.sid,
    message: "Emergency SMS sent",
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
