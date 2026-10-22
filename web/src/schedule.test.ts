import { describe, expect, it } from 'vitest';
import { wallTimeToDate } from './schedule';

describe('wallTimeToDate', () => {
  it('converts a wall time in another zone to UTC', () => {
    expect(wallTimeToDate('2026-10-23T09:30', 'Asia/Kolkata').toISOString()).toBe('2026-10-23T04:00:00.000Z');
    // New York is on EDT (UTC-4) in October, EST (UTC-5) in December.
    expect(wallTimeToDate('2026-10-23T09:30', 'America/New_York').toISOString()).toBe('2026-10-23T13:30:00.000Z');
    expect(wallTimeToDate('2026-12-01T09:30', 'America/New_York').toISOString()).toBe('2026-12-01T14:30:00.000Z');
  });
});
