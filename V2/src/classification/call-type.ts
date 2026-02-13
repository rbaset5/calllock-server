import type { UrgencyTier, UrgencyLevel, EndCallReason } from '../types/retell.js';

export type DashboardUrgency = 'emergency' | 'high' | 'medium' | 'low';

/**
 * Map urgency to dashboard format.
 *
 * IMPORTANT: urgencyTier is almost never populated by the voice agent.
 * The primary source is urgencyLevel (state.urgency). This function
 * accepts both and prefers endCallReason > urgencyTier > urgencyLevel.
 *
 * This fixes the bug where all calls showed as 'low' urgency on the dashboard
 * because we only checked urgencyTier (which was always undefined).
 */
export function mapUrgencyToDashboard(opts: {
  urgencyTier?: UrgencyTier;
  urgencyLevel?: UrgencyLevel;
  endCallReason?: EndCallReason;
}): DashboardUrgency {
  const { urgencyTier, urgencyLevel, endCallReason } = opts;

  // Safety emergencies are always highest priority
  if (endCallReason === 'safety_emergency') return 'emergency';
  if (endCallReason === 'urgent_escalation') return 'high';

  // Prefer urgencyTier if set
  if (urgencyTier) {
    const tierMap: Record<string, DashboardUrgency> = {
      'LifeSafety': 'emergency',
      'Urgent': 'high',
      'Routine': 'medium',
      'Estimate': 'low',
    };
    return tierMap[urgencyTier] || 'low';
  }

  // Fall back to urgencyLevel (the field that's actually populated)
  if (urgencyLevel) {
    const levelMap: Record<string, DashboardUrgency> = {
      'Emergency': 'emergency',
      'Urgent': 'high',
      'Routine': 'medium',
      'Estimate': 'low',
    };
    return levelMap[urgencyLevel] || 'low';
  }

  return 'low';
}
