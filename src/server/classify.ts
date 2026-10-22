import type { Signal } from './models.js';

export interface HitContext {
  type: 'open' | 'click';
  kind: 'email' | 'link';
  ua: string;
  ip: string;
  method: string;
  acceptLanguage: string | undefined;
  // Our own dashboard cookie travelled with the request (you clicked your link).
  selfCookie: boolean;
  // The Chrome extension just reported this email open in your own Gmail.
  selfViewing?: boolean;
  sentAt: Date;
  now: Date;
  graceSec: number;
}

export interface Classified {
  source: string;
  signal: Signal;
  reason: string;
}

// Apple Mail Privacy Protection fetches every pixel from Apple's own ranges,
// whether or not the message is ever read.
function isAppleIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^17\./.test(v4)) return true;
  return /^(2620:149:|2a01:b740:|2403:300:)/i.test(ip);
}

// Google's own ranges. Gmail's image proxy fetches from here with a
// GoogleImageProxy user agent; anything else from here is Google scanning the
// message on delivery (seen with a desktop-Chrome user agent within seconds).
const GOOGLE_V4 = [
  [66, 249, 64, 19],
  [72, 14, 192, 18],
  [74, 125, 0, 16],
  [209, 85, 128, 17],
  [64, 233, 160, 19],
  [108, 177, 0, 17],
  [173, 194, 0, 16],
  [142, 250, 0, 15],
  [172, 217, 0, 16],
  [216, 58, 192, 19],
] as const;

function isGoogleIp(ip: string): boolean {
  const parts = ip.replace(/^::ffff:/, '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return /^2001:4860:/i.test(ip);
  const n = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return GOOGLE_V4.some(([a, b, c, bits]) => {
    const base = ((a << 24) | (b << 16) | (c << 8)) >>> 0;
    const mask = (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

// Link previewers, security gateways and scripts that "click" without a human.
const BOT_UA =
  /bot|crawler|spider|preview|scanner|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|headless|phantom|safelinks|proofpoint|mimecast|barracuda|bitdefender|symantec|forcepoint|facebookexternalhit|whatsapp|embedly|outbrain/i;

export function sourceOf(ua: string, ip: string): string {
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'gmail';
  if (/YahooMailProxy/i.test(ua)) return 'yahoo';
  if (isAppleIp(ip)) return 'apple';
  if (/Microsoft Outlook|ms-office|Outlook-iOS|Outlook-Android/i.test(ua)) return 'outlook';
  if (/Mozilla\//.test(ua)) return 'browser';
  return 'unknown';
}

export function classify(ctx: HitContext): Classified {
  const source = sourceOf(ctx.ua, ctx.ip);
  const ageSec = (ctx.now.getTime() - ctx.sentAt.getTime()) / 1000;

  if (ctx.selfCookie) return { source, signal: 'self', reason: 'your dashboard cookie was present' };
  if (ctx.selfViewing && ctx.type === 'open') return { source, signal: 'self', reason: 'you were viewing it in Gmail (extension)' };
  if (source !== 'gmail' && isGoogleIp(ctx.ip)) return { source, signal: 'bot', reason: 'Google scanning the message' };

  if (ctx.type === 'open') {
    if (ctx.kind === 'email' && ageSec < ctx.graceSec) {
      return { source, signal: 'self', reason: `within ${ctx.graceSec}s of sending (likely your Sent view)` };
    }
    if (source === 'apple') return { source, signal: 'auto', reason: 'Apple Mail Privacy Protection prefetch' };
    if (!ctx.ua) return { source, signal: 'bot', reason: 'no user agent' };
    if (BOT_UA.test(ctx.ua)) return { source, signal: 'bot', reason: 'scanner or preview user agent' };
    return { source, signal: 'real', reason: '' };
  }

  if (ctx.method === 'HEAD') return { source, signal: 'bot', reason: 'HEAD request (link checker)' };
  if (!ctx.ua) return { source, signal: 'bot', reason: 'no user agent' };
  if (BOT_UA.test(ctx.ua)) return { source, signal: 'bot', reason: 'scanner or preview user agent' };
  if (source === 'apple') return { source, signal: 'bot', reason: 'Apple proxy range' };
  if (ctx.kind === 'email' && ageSec < 10) {
    return { source, signal: 'bot', reason: 'clicked within 10s of sending (mail gateway scan)' };
  }
  if (!ctx.acceptLanguage) return { source, signal: 'bot', reason: 'no Accept-Language (not a real browser)' };
  return { source, signal: 'real', reason: '' };
}
