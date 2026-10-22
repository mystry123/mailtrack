import { describe, expect, it } from 'vitest';
import { addBusinessDays, furthestRank, stageRank } from './stages.js';

describe('stages', () => {
  it('skips weekends when adding working days', () => {
    // Thu 22 Oct 2026 + 4 working days = Wed 28 Oct
    expect(addBusinessDays(new Date('2026-10-22T10:00:00Z'), 4).toISOString().slice(0, 10)).toBe('2026-10-28');
    // Fri + 1 = Mon
    expect(addBusinessDays(new Date('2026-10-23T10:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-10-26');
  });

  it('remembers the furthest stage after a rejection', () => {
    const history = [{ stage: 'reached_out' }, { stage: 'replied' }, { stage: 'interviewing' }, { stage: 'rejected' }];
    expect(furthestRank(history, 'rejected')).toBe(stageRank('interviewing'));
    expect(furthestRank([], 'accepted')).toBe(stageRank('offer'));
  });
});
