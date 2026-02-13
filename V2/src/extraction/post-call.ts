/**
 * Post-call data extraction utilities.
 * Extracts customer names, addresses, safety flags from transcripts.
 */

import type { UrgencyLevel, EndCallReason } from '../types/retell.js';

/**
 * Extract customer name from transcript.
 * IMPORTANT: Filters agent utterances first to avoid capturing agent's name.
 * Retell transcripts use "Agent:" and "User:" prefixes.
 */
export function extractCustomerName(transcript: string | undefined): string | undefined {
  if (!transcript) return undefined;

  // Extract only user utterances to avoid matching agent's greeting
  const userLines = transcript
    .split('\n')
    .filter(line => line.startsWith('User:'))
    .map(line => line.replace(/^User:\s*/, ''))
    .join(' ');

  if (!userLines) return undefined;

  const nameMatch = userLines.match(
    /(?:my name is|this is|it's|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
  );

  return nameMatch ? nameMatch[1] : undefined;
}

/**
 * Detect safety emergency from transcript keywords.
 * Returns true if the transcript mentions life-safety hazards.
 * Fixes: previously hardcoded to false in extractStateFromPostCallData.
 */
export function extractSafetyEmergency(transcript: string | undefined): boolean {
  if (!transcript) return false;
  const text = transcript.toLowerCase();
  return /gas\s*leak|smell\s*gas|carbon\s*monoxide|co\s*detector|smoke\s*from|electrical\s*fire|sparking|flooding/
    .test(text);
}

/**
 * Map urgency level string from post-call analysis to UrgencyLevel type.
 */
export function mapUrgencyLevelFromAnalysis(urgencyLevel?: string): UrgencyLevel | undefined {
  if (!urgencyLevel) return undefined;
  const normalized = urgencyLevel.toLowerCase();
  if (normalized.includes('emergency')) return 'Emergency';
  if (normalized.includes('urgent')) return 'Urgent';
  if (normalized.includes('routine')) return 'Routine';
  if (normalized.includes('estimate')) return 'Estimate';
  return undefined;
}

/**
 * Extract address from transcript using regex (fallback when custom analysis unavailable).
 */
export function extractAddressFromTranscript(transcript?: string): string | undefined {
  if (!transcript) return undefined;
  const addressMatch = transcript.match(
    /(\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Court|Ct|Lane|Ln|Way|Boulevard|Blvd)[,\s]+[\w\s]+,?\s*(?:Texas|TX)?\s*\d{5})/i
  );
  return addressMatch ? addressMatch[1].trim() : undefined;
}

/**
 * Map Retell's disconnection_reason to our EndCallReason.
 * Retell uses reasons like: "user_hangup", "agent_hangup", "call_transfer", "voicemail", "inactivity", etc.
 */
export function mapDisconnectionReason(reason?: string): EndCallReason | undefined {
  if (!reason) return undefined;

  const lowered = reason.toLowerCase();

  // Customer hung up before conversation completed
  if (lowered.includes('user_hangup') || lowered.includes('customer_hangup') || lowered === 'hangup') {
    return 'customer_hangup';
  }

  // Call went to voicemail - treat as callback_later (they need to call back)
  if (lowered.includes('voicemail')) {
    return 'callback_later';
  }

  // Other reasons don't map to our specific end call reasons
  return undefined;
}
