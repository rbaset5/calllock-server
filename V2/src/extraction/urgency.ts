import type { UrgencyLevel } from '../types/retell.js';

/**
 * Infer urgency from problem description and/or transcript text.
 * Used as fallback when the voice agent doesn't set urgency_tier.
 */
export function inferUrgencyFromContext(
  problemDesc?: string,
  transcript?: string
): UrgencyLevel | undefined {
  const text = [problemDesc, transcript].filter(Boolean).join(' ').toLowerCase();
  if (!text) return undefined;

  // Emergency — life safety
  if (/gas\s*leak|carbon\s*monoxide|smoke|fire|sparking|flood/i.test(text)) return 'Emergency';
  // Urgent — needs same-day attention
  if (/water\s*leak|leak.*inside|puddle|no\s*(heat|cool|ac|air)|emergency|asap|today|right\s*away/i.test(text)) return 'Urgent';
  // Estimate — lowest urgency, just wants pricing (check before Routine)
  if (/estimate|quote|how\s*much|whenever|no\s*rush|flexible/i.test(text)) return 'Estimate';
  // Routine — standard service request
  if (/maintenance|tune.?up|this\s*week/i.test(text)) return 'Routine';

  return 'Routine';
}
