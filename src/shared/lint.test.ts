import { describe, expect, it } from 'vitest';
import { lintEmail } from './lint.js';

const msgs = (i: Parameters<typeof lintEmail>[0]) => lintEmail(i).map((x) => `${x.level}:${x.message}`);

describe('lintEmail', () => {
  it('passes a clean, personal email', () => {
    expect(lintEmail({ subject: 'Fullstack role at Cardboard', body: 'Hi Saksham, I built Shotline… [my resume](https://x.co/cv)', recipientName: 'Saksham A', company: 'Cardboard' })).toEqual([]);
  });

  it('catches placeholders and fake attachments as errors', () => {
    const r = msgs({ subject: 'Hello [Company]', body: 'Hi {{name}}, please see attached.' });
    expect(r.some((m) => m.startsWith('error:Placeholder'))).toBe(true);
    expect(r.some((m) => m.startsWith('error:Mentions an attachment'))).toBe(true);
  });

  it('warns about spammy, long or impersonal emails', () => {
    const long = Array.from({ length: 260 }, () => 'word').join(' ');
    const r = msgs({ subject: 'URGENT OPPORTUNITY FOR YOU', body: `Act now!!! ${long} [here](https://a.co)`, recipientName: 'Jane', company: 'Acme' });
    expect(r.filter((m) => m.startsWith('warn:')).length).toBeGreaterThanOrEqual(4);
  });

  it('does not flag personalization when there is no recipient name', () => {
    expect(msgs({ subject: 'Hi', body: 'Hello team' })).toEqual([]);
  });
});
