import { describe, it, expect } from 'vitest';
import { mapUrgencyToDashboard } from '../../classification/call-type.js';

describe('mapUrgencyToDashboard', () => {
  // urgencyTier mapping (when set)
  it('maps LifeSafety urgencyTier to emergency', () => {
    expect(mapUrgencyToDashboard({ urgencyTier: 'LifeSafety' })).toBe('emergency');
  });

  it('maps Urgent urgencyTier to high', () => {
    expect(mapUrgencyToDashboard({ urgencyTier: 'Urgent' })).toBe('high');
  });

  it('maps Routine urgencyTier to medium', () => {
    expect(mapUrgencyToDashboard({ urgencyTier: 'Routine' })).toBe('medium');
  });

  it('maps Estimate urgencyTier to low', () => {
    expect(mapUrgencyToDashboard({ urgencyTier: 'Estimate' })).toBe('low');
  });

  // endCallReason overrides
  it('returns emergency for safety_emergency endCallReason', () => {
    expect(mapUrgencyToDashboard({ endCallReason: 'safety_emergency' })).toBe('emergency');
  });

  it('returns high for urgent_escalation endCallReason', () => {
    expect(mapUrgencyToDashboard({ endCallReason: 'urgent_escalation' })).toBe('high');
  });

  // urgencyLevel fallback (THE BUG FIX)
  it('maps Emergency urgencyLevel to emergency when urgencyTier is undefined', () => {
    expect(mapUrgencyToDashboard({ urgencyLevel: 'Emergency' })).toBe('emergency');
  });

  it('maps Urgent urgencyLevel to high when urgencyTier is undefined', () => {
    expect(mapUrgencyToDashboard({ urgencyLevel: 'Urgent' })).toBe('high');
  });

  it('maps Routine urgencyLevel to medium when urgencyTier is undefined', () => {
    expect(mapUrgencyToDashboard({ urgencyLevel: 'Routine' })).toBe('medium');
  });

  it('maps Estimate urgencyLevel to low when urgencyTier is undefined', () => {
    expect(mapUrgencyToDashboard({ urgencyLevel: 'Estimate' })).toBe('low');
  });

  // Priority: urgencyTier > urgencyLevel
  it('prefers urgencyTier over urgencyLevel when both set', () => {
    expect(mapUrgencyToDashboard({ urgencyTier: 'LifeSafety', urgencyLevel: 'Routine' })).toBe('emergency');
  });

  // Default
  it('returns low when all inputs are undefined', () => {
    expect(mapUrgencyToDashboard({})).toBe('low');
  });

  // endCallReason takes highest priority
  it('safety_emergency overrides even LifeSafety urgencyTier', () => {
    expect(mapUrgencyToDashboard({ urgencyTier: 'Estimate', endCallReason: 'safety_emergency' })).toBe('emergency');
  });
});
