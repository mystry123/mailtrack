import { describe, expect, it } from 'vitest';
import { buildMime, formatAddress } from './mime.js';

describe('mime', () => {
  it('blocks header injection through subject and names', () => {
    const raw = buildMime(
      {
        from: { email: 'me@x.com', name: 'Me' },
        to: [{ email: 'a@y.com', name: 'A\r\nBcc: evil@z.com' }],
        cc: [],
        subject: 'Hi\r\nBcc: evil@z.com',
        text: 't',
        html: '<p>h</p>',
      },
      'b',
    );
    const headerBlock = raw.split('\r\n\r\n')[0];
    expect(headerBlock.split('\r\n').some((l) => l.startsWith('Bcc:'))).toBe(false);
  });

  it('encodes non-ASCII display names and subjects', () => {
    expect(formatAddress({ email: 'r@x.com', name: 'Ritík' })).toBe('"=?UTF-8?B?Uml0w61r?=" <r@x.com>');
    const raw = buildMime({ from: { email: 'a@b.c' }, to: [{ email: 'd@e.f' }], cc: [], subject: 'Héllo', text: '', html: '' }, 'b');
    expect(raw).toContain('Subject: =?UTF-8?B?');
  });
});
