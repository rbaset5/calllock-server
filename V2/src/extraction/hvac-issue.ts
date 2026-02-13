import type { HVACIssueType } from '../types/retell.js';

/**
 * Infer HVAC issue type from problem description and transcript.
 * Used as a fallback when the voice agent doesn't set hvacIssueType.
 */
export function inferHvacIssueType(problemDesc?: string, transcript?: string): HVACIssueType | undefined {
  const text = [problemDesc, transcript].filter(Boolean).join(' ').toLowerCase();
  if (!text) return undefined;

  // Water/leak patterns
  if (/water\s*(leak|puddle|drip|pool)|leak.*unit|puddle.*inside|dripping/i.test(text)) return 'Leaking';
  // Cooling patterns
  if (/not?\s*cool|ac\s*(not|isn|won)|no\s*(cold|cool)|warm\s*air|won.t\s*cool/i.test(text)) return 'No Cool';
  // Heating patterns
  if (/not?\s*heat|no\s*heat|furnace\s*(not|won|isn)|cold\s*air.*heat|won.t\s*heat/i.test(text)) return 'No Heat';
  // Noise patterns
  if (/noise|loud|bang|rattle|squeal|grind|vibrat/i.test(text)) return 'Noisy System';
  // Smell patterns
  if (/smell|odor|musty|mold/i.test(text)) return 'Odor';
  // Not running
  if (/won.t\s*(start|turn|run)|not\s*(start|turn|run)|dead|no\s*power/i.test(text)) return 'Not Running';
  // Thermostat
  if (/thermostat|temperature.*wrong|temp.*off/i.test(text)) return 'Thermostat';
  // Maintenance
  if (/maintenance|tune.?up|check.?up|seasonal|filter/i.test(text)) return 'Maintenance';

  return undefined;
}
