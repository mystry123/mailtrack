import { describe, expect, it } from 'vitest';
import { interviewStageFor, matchEvent } from './calendar.js';
import { digestDue, localParts } from './digest.js';
import { stripQuoted } from './google.js';
import { buildSteps, stopReason } from './sequences.js';

describe('sequences', () => {
  it('builds working-day steps, sorted, deduped, at most 3', () => {
    const steps = buildSteps(new Date('2026-10-22T10:00:00Z'), [9, 4, 4, 15, 20]);
    expect(steps.map((s) => s.afterDays)).toEqual([4, 9, 15]);
    expect(steps[0].dueAt.toISOString().slice(0, 10)).toBe('2026-10-28'); // Thu + 4 working days
    expect(buildSteps(new Date(), [0, -1, 99])).toEqual([]);
  });

  it('stops on replies, stage changes, archive or unsent root', () => {
    expect(stopReason({ threadReplies: 1, stage: 'reached_out', rootStatus: 'sent' })).toBe('They replied');
    expect(stopReason({ threadReplies: 0, stage: 'screening', rootStatus: 'sent' })).toMatch(/screening/);
    expect(stopReason({ threadReplies: 0, stage: 'rejected', rootStatus: 'sent' })).toMatch(/rejected/);
    expect(stopReason({ threadReplies: 0, stage: 'reached_out', rootStatus: 'failed' })).toMatch(/not sent/);
    expect(stopReason({ threadReplies: 0, stage: 'reached_out', rootStatus: 'sent', archived: true })).toMatch(/archived/);
    expect(stopReason({ threadReplies: 0, stage: 'reached_out', rootStatus: 'sent' })).toBeNull();
    expect(stopReason({ threadReplies: 0, rootStatus: null })).toBeNull();
  });
});

describe('calendar matching', () => {
  const ev = (title: string, attendees: string[] = [], description = '') => ({ title, attendees, description });
  it('matches by attendee domain, ignoring public mail domains', () => {
    expect(matchEvent(ev('Sync', ['jane@cardboard.ai']), 'Cardboard', ['cardboard.ai'])).toEqual({ matchedBy: 'attendee' });
    expect(matchEvent(ev('Sync', ['jane@gmail.com']), 'Cardboard', ['gmail.com'])).toBeNull();
  });
  it('matches by company name only with an interview-ish word', () => {
    expect(matchEvent(ev('Cardboard <> Ritik: technical interview'), 'Cardboard', [])).toEqual({ matchedBy: 'name' });
    expect(matchEvent(ev('Buy cardboard boxes'), 'Cardboard', [])).toBeNull();
    expect(matchEvent(ev('AI chat'), 'AI', [])).toBeNull(); // too short a name
  });
  it('maps titles to stages', () => {
    expect(interviewStageFor('Onsite round 2')).toBe('interviewing');
    expect(interviewStageFor('Intro call with recruiter')).toBe('screening');
  });
});

describe('digest timing', () => {
  it('reads weekday and hour in a time zone', () => {
    // 2026-10-26 is a Monday; 03:30 UTC = 09:00 IST
    expect(localParts(new Date('2026-10-26T03:30:00Z'), 'Asia/Kolkata')).toEqual({ weekday: 1, hour: 9 });
  });
  it('is due Monday from 9am local, once a week', () => {
    const monday9 = new Date('2026-10-26T03:30:00Z');
    expect(digestDue(monday9, 'Asia/Kolkata', null)).toBe(true);
    expect(digestDue(new Date('2026-10-26T02:00:00Z'), 'Asia/Kolkata', null)).toBe(false); // 7:30 IST
    expect(digestDue(new Date('2026-10-27T05:00:00Z'), 'Asia/Kolkata', null)).toBe(false); // Tuesday
    expect(digestDue(monday9, 'Asia/Kolkata', new Date('2026-10-26T03:35:00Z'))).toBe(false); // already sent
    expect(digestDue(monday9, 'Asia/Kolkata', new Date('2026-10-19T04:00:00Z'))).toBe(true); // last week's
  });
});

describe('stripQuoted', () => {
  it('keeps only the new reply', () => {
    const text = 'Sounds great, can you do Thursday 3pm?\n\nBest,\nJane\n\nOn Tue, 22 Oct 2026 at 11:00, Ritik <r@x.com> wrote:\n> Hi Jane\n> blah';
    expect(stripQuoted(text)).toBe('Sounds great, can you do Thursday 3pm?\n\nBest,\nJane');
  });
});
