import { describe, it, expect } from 'vitest';
import {
  extractCustomerName,
  extractSafetyEmergency,
  mapUrgencyLevelFromAnalysis,
  extractAddressFromTranscript,
  mapDisconnectionReason,
  extractProblemDuration,
} from '../../extraction/post-call.js';

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

describe('mapUrgencyLevelFromAnalysis', () => {
  it('maps emergency string to Emergency', () => {
    expect(mapUrgencyLevelFromAnalysis('emergency')).toBe('Emergency');
  });

  it('maps urgent string to Urgent', () => {
    expect(mapUrgencyLevelFromAnalysis('Urgent')).toBe('Urgent');
  });

  it('maps routine string to Routine', () => {
    expect(mapUrgencyLevelFromAnalysis('routine')).toBe('Routine');
  });

  it('maps estimate string to Estimate', () => {
    expect(mapUrgencyLevelFromAnalysis('estimate')).toBe('Estimate');
  });

  it('returns undefined for unknown strings', () => {
    expect(mapUrgencyLevelFromAnalysis('unknown')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(mapUrgencyLevelFromAnalysis()).toBeUndefined();
  });
});

describe('mapDisconnectionReason', () => {
  it('maps user_hangup to customer_hangup', () => {
    expect(mapDisconnectionReason('user_hangup')).toBe('customer_hangup');
  });

  it('maps voicemail to callback_later', () => {
    expect(mapDisconnectionReason('voicemail')).toBe('callback_later');
  });

  it('returns undefined for agent_hangup', () => {
    expect(mapDisconnectionReason('agent_hangup')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(mapDisconnectionReason()).toBeUndefined();
  });
});

describe('extractAddressFromTranscript', () => {
  it('extracts address with Texas zip code', () => {
    const transcript = 'I live at 1234 Oak Street, Austin, TX 78701';
    expect(extractAddressFromTranscript(transcript)).toContain('1234 Oak Street');
  });

  it('returns undefined for no address', () => {
    expect(extractAddressFromTranscript('my AC is broken')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(extractAddressFromTranscript()).toBeUndefined();
  });
});

describe('extractProblemDuration', () => {
  // Acute (<24h)
  it('extracts "this morning" as acute', () => {
    const transcript = 'Agent: How can I help?\nUser: Yeah my AC stopped working this morning.';
    const result = extractProblemDuration(transcript);
    expect(result).toEqual({ raw: 'this morning', category: 'acute' });
  });

  it('extracts "today" as acute', () => {
    const transcript = 'Agent: What happened?\nUser: It just stopped working today.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  it('extracts "just started" as acute', () => {
    const transcript = 'Agent: Tell me more.\nUser: The noise just started about an hour ago.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  it('extracts "a few hours" as acute', () => {
    const transcript = 'Agent: How long?\nUser: It has been making that sound for a few hours.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  it('extracts "tonight" as acute', () => {
    const transcript = 'Agent: When did it start?\nUser: The heater stopped tonight.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('acute');
  });

  // Recent (1-7d)
  it('extracts "yesterday" as recent', () => {
    const transcript = 'Agent: What is going on?\nUser: Started acting up yesterday.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "2 days" as recent', () => {
    const transcript = 'Agent: How long?\nUser: It has been about 2 days now.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "since Monday" as recent', () => {
    const transcript = 'Agent: When did this start?\nUser: Since Monday it has been leaking.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "a few days" as recent', () => {
    const transcript = 'Agent: How long?\nUser: A few days now, maybe three or four.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  it('extracts "this week" as recent', () => {
    const transcript = 'Agent: Tell me more.\nUser: It started doing this earlier this week.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('recent');
  });

  // Ongoing (>7d)
  it('extracts "a couple weeks" as ongoing', () => {
    const transcript = 'Agent: How long?\nUser: Been going on a couple weeks now.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "a month" as ongoing', () => {
    const transcript = 'Agent: When did you notice?\nUser: About a month ago it started.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "for years" as ongoing', () => {
    const transcript = 'Agent: Tell me more.\nUser: This has been a problem for years honestly.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "a while" as ongoing', () => {
    const transcript = 'Agent: How long has this been happening?\nUser: It has been going on for a while now.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  it('extracts "for some time" as ongoing', () => {
    const transcript = 'Agent: When?\nUser: This has been happening for some time.';
    const result = extractProblemDuration(transcript);
    expect(result?.category).toBe('ongoing');
  });

  // Edge cases
  it('returns undefined when no temporal phrase found', () => {
    const transcript = 'Agent: How can I help?\nUser: My AC is not working.';
    expect(extractProblemDuration(transcript)).toBeUndefined();
  });

  it('returns undefined for undefined transcript', () => {
    expect(extractProblemDuration(undefined)).toBeUndefined();
  });

  it('returns undefined for empty transcript', () => {
    expect(extractProblemDuration('')).toBeUndefined();
  });

  it('ignores agent utterances — agent saying "how long" does not match', () => {
    const transcript = 'Agent: How long has this been going on since this morning?\nUser: My AC is broken.';
    expect(extractProblemDuration(transcript)).toBeUndefined();
  });

  it('extracts from user line even with agent temporal phrase', () => {
    const transcript = 'Agent: How long has this been happening?\nUser: Since yesterday the unit has been making noise.';
    const result = extractProblemDuration(transcript);
    expect(result).toEqual({ raw: 'yesterday', category: 'recent' });
  });
});
