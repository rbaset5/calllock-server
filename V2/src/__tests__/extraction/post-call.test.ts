import { describe, it, expect } from 'vitest';
import { extractCustomerName, extractSafetyEmergency } from '../../extraction/post-call.js';

describe('extractCustomerName', () => {
  it('extracts "my name is Jonas" from user utterance', () => {
    const transcript = 'Agent: How can I help?\nUser: My name is Jonas, I have an AC problem.';
    expect(extractCustomerName(transcript)).toBe('Jonas');
  });

  it('does NOT extract agent name from greeting', () => {
    const transcript = 'Agent: Thanks for calling, this is Alex from ACE Cooling.\nUser: Hi, I need help.';
    expect(extractCustomerName(transcript)).not.toBe('Alex');
    expect(extractCustomerName(transcript)).toBeUndefined();
  });

  it('extracts name with "I\'m" prefix', () => {
    const transcript = "Agent: What's your name?\nUser: I'm Sarah Johnson.";
    expect(extractCustomerName(transcript)).toBe('Sarah Johnson');
  });

  it('extracts name with "this is" prefix from user line', () => {
    const transcript = "Agent: Who am I speaking with?\nUser: This is Mike Rivera.";
    expect(extractCustomerName(transcript)).toBe('Mike Rivera');
  });

  it('returns undefined when no name found', () => {
    const transcript = 'Agent: Hello?\nUser: My AC is broken.';
    expect(extractCustomerName(transcript)).toBeUndefined();
  });

  it('returns undefined for undefined transcript', () => {
    expect(extractCustomerName(undefined)).toBeUndefined();
  });

  it('returns undefined for empty transcript', () => {
    expect(extractCustomerName('')).toBeUndefined();
  });

  it('ignores agent self-introduction with "this is"', () => {
    const transcript = 'Agent: Hi, this is Maria from CallLock.\nUser: Yeah, my furnace is not working.';
    expect(extractCustomerName(transcript)).toBeUndefined();
  });
});

describe('extractSafetyEmergency', () => {
  it('detects gas leak in transcript', () => {
    expect(extractSafetyEmergency('I smell gas in my house')).toBe(true);
  });

  it('detects carbon monoxide', () => {
    expect(extractSafetyEmergency('carbon monoxide detector is going off')).toBe(true);
  });

  it('detects electrical fire indicators', () => {
    expect(extractSafetyEmergency('sparking from the furnace unit')).toBe(true);
  });

  it('detects smoke from unit', () => {
    expect(extractSafetyEmergency('there is smoke from the furnace')).toBe(true);
  });

  it('returns false for routine issues', () => {
    expect(extractSafetyEmergency('my AC is making a noise')).toBe(false);
  });

  it('returns false for undefined transcript', () => {
    expect(extractSafetyEmergency(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(extractSafetyEmergency('')).toBe(false);
  });
});
