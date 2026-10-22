import { describe, expect, it } from 'vitest';
import { detectPattern, domainFromUrl, guessEmails } from './finder.js';

describe('finder', () => {
  it('detects the pattern of a known address', () => {
    expect(detectPattern('ritik.patel@acme.com', 'Ritik Patel')).toBe('first.last');
    expect(detectPattern('rpatel@acme.com', 'Ritik Patel')).toBe('flast');
    expect(detectPattern('zz@acme.com', 'Ritik Patel')).toBeUndefined();
  });

  it('ranks the pattern already seen at the domain first', () => {
    const g = guessEmails('Jane Doe', 'acme.com', [{ email: 'rpatel@acme.com', name: 'Ritik Patel' }]);
    expect(g[0]).toMatchObject({ email: 'jdoe@acme.com', confidence: 'likely' });
    expect(g.map((x) => x.email)).toContain('jane.doe@acme.com');
  });

  it('handles accents and single names', () => {
    expect(guessEmails('José Ñúñez', 'x.io')[1].email).toBe('jose.nunez@x.io');
    expect(guessEmails('Prince', 'x.io').map((x) => x.email)).toEqual(['prince@x.io']);
  });

  it('normalises domains from URLs', () => {
    expect(domainFromUrl('https://www.cardboard.ai/careers')).toBe('cardboard.ai');
    expect(domainFromUrl('Cardboard.ai')).toBe('cardboard.ai');
  });
});
