import express, { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import geoip from 'geoip-lite';
import { classify } from '../classify.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { asSystem, withUser } from '../context.js';
import { AccountModel, EventModel, MessageModel, type Message } from '../models.js';
import { notifyFirst } from '../notify.js';
import { recomputeStats } from '../stats.js';

export const SELF_COOKIE = 'mt_self';

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const TOKEN_RE = /^[A-Za-z0-9]{8,32}$/;

// Tracking links are public: find the message by its unguessable token across
// all users, then record everything as the message's owner.
// .exec() inside asSystem: a query runs (and is scoped) when executed, not when built.
const findByToken = (filter: Record<string, string>) => asSystem(() => MessageModel.findOne(filter).lean<Message>().exec());

// The "this is you" cookie holds your account id ("1" from before multi-user meant the owner).
let ownerId: string | null = null;
async function isSelf(cookie: string | undefined, message: Message): Promise<boolean> {
  if (!cookie) return false;
  if (cookie === String(message.userId)) return true;
  if (cookie !== '1') return false;
  ownerId ??= String((await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).select('_id').lean())?._id ?? '');
  return ownerId === String(message.userId);
}

// How long after the extension reports you viewing an email its opens count as yours.
const SELF_VIEW_MS = 2 * 60_000;

function record(req: Request, message: Message, type: 'open' | 'click', linkToken?: string): Promise<void> {
  if (!message.userId) return Promise.resolve();
  return withUser(message.userId, () => recordAsOwner(req, message, type, linkToken));
}

async function recordAsOwner(req: Request, message: Message, type: 'open' | 'click', linkToken?: string): Promise<void> {
  const now = new Date();
  const ua = req.get('user-agent') ?? '';
  const ip = req.ip ?? '';
  const verdict = classify({
    type,
    kind: message.kind,
    ua,
    ip,
    method: req.method,
    acceptLanguage: req.get('accept-language'),
    selfCookie: await isSelf(req.cookies?.[SELF_COOKIE], message),
    selfViewing: !!message.selfSeenAt && now.getTime() - new Date(message.selfSeenAt).getTime() < SELF_VIEW_MS,
    sentAt: message.sentAt,
    now,
    graceSec: env.SELF_OPEN_GRACE_SEC,
  });
  // Proxied opens (Gmail, Apple) carry the proxy's IP, not the reader's.
  const geo = verdict.source === 'browser' || verdict.source === 'outlook' ? geoip.lookup(ip.replace(/^::ffff:/, '')) : null;

  const event = await EventModel.create({
    messageId: message._id,
    type,
    linkToken,
    at: now,
    ip,
    ua: ua.slice(0, 500),
    method: req.method,
    country: geo?.country,
    region: geo?.region,
    city: geo?.city,
    source: verdict.source,
    signal: verdict.signal,
    reason: verdict.reason,
  });

  const before = type === 'open' ? message.stats?.opens ?? 0 : message.stats?.clicks ?? 0;
  if (type === 'click' && verdict.signal === 'real') {
    // A click proves the email was read, so opens set aside only for timing count after all.
    await EventModel.updateMany(
      { messageId: message._id, type: 'open', signal: 'self', manual: false, reason: /^within \d+s of sending/ },
      { signal: 'real', reason: 'a click followed' },
    );
  }
  await recomputeStats(message._id);
  if (verdict.signal === 'real' && before === 0) {
    void notifyFirst(message, event.toObject());
  }
}

export const trackRouter = Router();

// Per-route, not router.use: this router is mounted at the root.
const limiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });

trackRouter.get('/o/:file', limiter, (req, res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(PIXEL);

  const token = req.params.file.replace(/\.gif$/, '');
  if (!TOKEN_RE.test(token) || req.method === 'HEAD') return;
  findByToken({ token })
    .then((m) => (m ? record(req, m, 'open') : undefined))
    .catch((err) => logger.error({ err }, 'open tracking failed'));
});

trackRouter.get('/l/:token', limiter, async (req, res, next) => {
  const { token } = req.params;
  let message: Message | null = null;
  try {
    message = TOKEN_RE.test(token) ? await findByToken({ 'links.token': token }) : null;
  } catch (err) {
    return next(err);
  }
  const link = message?.links.find((l) => l.token === token);
  if (!message || !link) {
    res.status(404).type('text/plain').send('Link not found');
    return;
  }

  // Only ever redirect to the URL stored at send time: no open redirect.
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.redirect(302, link.url);

  record(req, message, 'click', token).catch((err) => logger.error({ err }, 'click tracking failed'));
});

// From the Chrome extension: you have this email open in your own Gmail. Opens
// in the window around it are yours. Unauthenticated on purpose (the extension
// has no session); the worst a forged call can do is hide one email's opens.
trackRouter.post('/x/seen', limiter, express.json({ limit: '1kb' }), async (req, res, next) => {
  const token = String(req.body?.token ?? '');
  res.status(204).end();
  if (!TOKEN_RE.test(token)) return;
  try {
    const message = await asSystem(() => MessageModel.findOneAndUpdate({ token }, { selfSeenAt: new Date() }).lean<Message>().exec());
    if (!message?.userId) return;
    await withUser(message.userId, async () => {
      const since = new Date(Date.now() - SELF_VIEW_MS);
      const r = await EventModel.updateMany(
        { messageId: message._id, type: 'open', at: { $gte: since }, signal: { $ne: 'self' }, manual: false },
        { signal: 'self', reason: 'you were viewing it in Gmail (extension)' },
      );
      if (r.modifiedCount) await recomputeStats(message._id);
    });
  } catch (err) {
    next(err);
  }
});
