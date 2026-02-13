import { describe, it, expect } from 'vitest';
import { inferHvacIssueType } from '../../extraction/hvac-issue.js';

describe('inferHvacIssueType', () => {
  it('detects Leaking from water leak patterns', () => {
    expect(inferHvacIssueType('water leak near the unit')).toBe('Leaking');
  });

  it('detects No Cool from AC not cooling', () => {
    expect(inferHvacIssueType('AC is not cooling at all')).toBe('No Cool');
  });

  it('detects No Heat from furnace not heating', () => {
    expect(inferHvacIssueType('no heat coming from the vents')).toBe('No Heat');
  });

  it('detects Noisy System from noise patterns', () => {
    expect(inferHvacIssueType('loud banging noise from the unit')).toBe('Noisy System');
  });

  it('detects Odor from smell patterns', () => {
    expect(inferHvacIssueType('musty smell from the vents')).toBe('Odor');
  });

  it('detects Not Running from dead unit', () => {
    expect(inferHvacIssueType("unit won't start at all")).toBe('Not Running');
  });

  it('detects Thermostat issues', () => {
    expect(inferHvacIssueType('thermostat is blank')).toBe('Thermostat');
  });

  it('detects Maintenance from tune-up requests', () => {
    expect(inferHvacIssueType('need a seasonal tune-up')).toBe('Maintenance');
  });

  it('returns undefined for empty input', () => {
    expect(inferHvacIssueType()).toBeUndefined();
  });

  it('returns undefined for unrecognized text', () => {
    expect(inferHvacIssueType('I have a question about my bill')).toBeUndefined();
  });

  it('combines problemDesc and transcript', () => {
    expect(inferHvacIssueType('some problem', 'water puddle inside the house')).toBe('Leaking');
  });
});
