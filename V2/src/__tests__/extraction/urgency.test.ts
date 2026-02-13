import { describe, it, expect } from 'vitest';
import { inferUrgencyFromContext } from '../../extraction/urgency.js';

describe('inferUrgencyFromContext', () => {
  it('returns Emergency for gas leak mentions', () => {
    expect(inferUrgencyFromContext('I smell gas leak')).toBe('Emergency');
  });

  it('returns Emergency for carbon monoxide mentions', () => {
    expect(inferUrgencyFromContext('carbon monoxide detector going off')).toBe('Emergency');
  });

  it('returns Emergency for fire/smoke mentions', () => {
    expect(inferUrgencyFromContext('smoke coming from the furnace')).toBe('Emergency');
  });

  it('returns Urgent for water leak', () => {
    expect(inferUrgencyFromContext('water leak inside the house')).toBe('Urgent');
  });

  it('returns Urgent for no heat', () => {
    expect(inferUrgencyFromContext('no heat at all, freezing')).toBe('Urgent');
  });

  it('returns Urgent for no AC', () => {
    expect(inferUrgencyFromContext('no ac and it is 100 degrees')).toBe('Urgent');
  });

  it('returns Estimate for quote requests', () => {
    expect(inferUrgencyFromContext('I need an estimate for a new unit')).toBe('Estimate');
  });

  it('returns Estimate for no rush requests', () => {
    expect(inferUrgencyFromContext('no rush, whenever you can get here')).toBe('Estimate');
  });

  it('returns Routine for maintenance', () => {
    expect(inferUrgencyFromContext('need a tune-up this week')).toBe('Routine');
  });

  it('returns Routine as default for ambiguous text', () => {
    expect(inferUrgencyFromContext('my AC is making a weird sound')).toBe('Routine');
  });

  it('returns undefined for empty input', () => {
    expect(inferUrgencyFromContext()).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(inferUrgencyFromContext(undefined, undefined)).toBeUndefined();
  });

  it('combines problemDesc and transcript for analysis', () => {
    expect(inferUrgencyFromContext('routine issue', 'gas leak detected')).toBe('Emergency');
  });
});
