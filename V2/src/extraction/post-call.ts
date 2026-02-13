/**
 * Post-call data extraction utilities.
 * Extracts customer names, addresses, safety flags from transcripts.
 */

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
