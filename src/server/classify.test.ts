import { describe, expect, it } from 'vitest';
import { classify, type HitContext } from './classify.js';

const sentAt = new Date('2026-10-22T10:00:00Z');
const later = new Date('2026-10-22T12:00:00Z');
const chrome =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function ctx(over: Partial<HitContext>): HitContext {
  return {
    type: 'open',
    kind: 'email',
    ua: chrome,
    ip: '49.36.1.1',
    method: 'GET',
    acceptLanguage: 'en-US',
    selfCookie: false,
    sentAt,
    now: later,
    graceSec: 60,
    ...over,
  };
}

describe('classify', () => {
  it('counts a Gmail proxy open as real', () => {
    const r = classify(ctx({ ua: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' }));
    expect(r).toMatchObject({ source: 'gmail', signal: 'real' });
  });

  it('treats an open right after sending as self', () => {
    const r = classify(ctx({ now: new Date(sentAt.getTime() + 5_000) }));
    expect(r.signal).toBe('self');
  });

  it('flags Apple MPP prefetches', () => {
    expect(classify(ctx({ ip: '17.58.1.2' })).signal).toBe('auto');
    expect(classify(ctx({ ip: '::ffff:17.58.1.2' })).signal).toBe('auto');
  });

  it('flags scanner clicks', () => {
    expect(classify(ctx({ type: 'click', method: 'HEAD' })).signal).toBe('bot');
    expect(classify(ctx({ type: 'click', ua: 'LinkedInBot/1.0' })).signal).toBe('bot');
    expect(classify(ctx({ type: 'click', acceptLanguage: undefined })).signal).toBe('bot');
    expect(classify(ctx({ type: 'click', now: new Date(sentAt.getTime() + 3_000) })).signal).toBe('bot');
  });

  it('counts a browser click as real, and your own as self', () => {
    expect(classify(ctx({ type: 'click' })).signal).toBe('real');
    expect(classify(ctx({ type: 'click', selfCookie: true })).signal).toBe('self');
  });

  it('flags Google delivery scans but not Gmail proxy opens', () => {
    expect(classify(ctx({ ip: '72.14.199.232' }))).toMatchObject({ signal: 'bot' });
    const proxied = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
    expect(classify(ctx({ ip: '66.249.84.160', ua: proxied }))).toMatchObject({ source: 'gmail', signal: 'real' });
  });

  it('treats opens while the extension sees you viewing as self', () => {
    expect(classify(ctx({ selfViewing: true })).signal).toBe('self');
    expect(classify(ctx({ type: 'click', selfViewing: true })).signal).toBe('real');
  });

  it('does not apply the send-time window to standalone links', () => {
    const r = classify(ctx({ type: 'click', kind: 'link', now: new Date(sentAt.getTime() + 3_000) }));
    expect(r.signal).toBe('real');
  });
});
