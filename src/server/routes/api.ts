import { Router, type NextFunction, type Request, type Response } from 'express';
import { isValidObjectId, type FilterQuery } from 'mongoose';
import { z } from 'zod';
import { newToken } from '../crypto.js';
import { env } from '../env.js';
import { ReauthRequired, sendGmail } from '../google.js';
import { logger } from '../logger.js';
import { AccountModel, EventModel, MessageModel, SettingModel, SIGNALS, type Message } from '../models.js';
import { recomputeStats } from '../stats.js';
import { renderBody } from '../../shared/render.js';
import { requireSameOrigin, requireSession } from './auth.js';

export const apiRouter = Router();
apiRouter.use(requireSession, requireSameOrigin);

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const address = z.object({ email: z.string().trim().email(), name: z.string().trim().max(100).optional() });
const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');

const trackedUrl = (token: string) => `${env.PUBLIC_URL}/l/${token}`;
const pixelTag = (token: string) =>
  `<img src="${env.PUBLIC_URL}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;

const LIST_FIELDS = '-body -html';

apiRouter.get(
  '/me',
  h(async (_req, res) => {
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).lean();
    res.json({
      email: env.ALLOWED_EMAIL,
      name: account?.name ?? '',
      fromName: account?.fromName ?? '',
      needsReauth: !account || account.needsReauth,
      publicUrl: env.PUBLIC_URL,
    });
  }),
);

apiRouter.put(
  '/me',
  h(async (req, res) => {
    const { fromName } = z.object({ fromName: z.string().trim().max(100) }).parse(req.body);
    await AccountModel.updateOne({ email: env.ALLOWED_EMAIL }, { fromName });
    res.json({ ok: true });
  }),
);

apiRouter.get(
  '/messages',
  h(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const filter = String(req.query.filter ?? 'all');
    const where: FilterQuery<Message> = { archived: req.query.archived === '1' };
    if (filter === 'clicked') where['stats.clicks'] = { $gt: 0 };
    else if (filter === 'opened') Object.assign(where, { 'stats.opens': { $gt: 0 }, 'stats.clicks': 0 });
    else if (filter === 'quiet') Object.assign(where, { 'stats.opens': 0, 'stats.clicks': 0 });
    else if (filter === 'links') where.kind = 'link';
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      where.$or = [{ subject: rx }, { label: rx }, { 'to.email': rx }, { 'to.name': rx }];
    }
    const messages = await MessageModel.find(where).select(LIST_FIELDS).sort({ sentAt: -1 }).limit(500).lean();
    res.json({ messages });
  }),
);

apiRouter.get(
  '/messages/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const message = await MessageModel.findById(req.params.id).lean();
    if (!message) return res.status(404).json({ error: 'not found' });
    const events = await EventModel.find({ messageId: message._id }).sort({ at: -1 }).lean();
    res.json({ message, events });
  }),
);

apiRouter.patch(
  '/messages/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const patch = z
      .object({ archived: z.boolean().optional(), label: z.string().trim().max(100).optional() })
      .parse(req.body);
    const r = await MessageModel.updateOne({ _id: req.params.id }, patch);
    if (!r.matchedCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  }),
);

apiRouter.patch(
  '/events/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { signal } = z.object({ signal: z.enum(SIGNALS) }).parse(req.body);
    const event = await EventModel.findByIdAndUpdate(req.params.id, { signal, manual: true }, { new: true });
    if (!event) return res.status(404).json({ error: 'not found' });
    await recomputeStats(event.messageId);
    res.json({ ok: true });
  }),
);

const sendSchema = z.object({
  to: z.array(address).min(1).max(20),
  cc: z.array(address).max(20).default([]),
  subject: z.string().trim().min(1).max(300),
  body: z.string().min(1).max(50_000),
  label: z.string().trim().max(100).default(''),
});

apiRouter.post(
  '/messages/send',
  h(async (req, res) => {
    const input = sendSchema.parse(req.body);
    const token = newToken();
    const linkTokens: string[] = [];
    const rendered = renderBody(input.body, (_link, i) => trackedUrl((linkTokens[i] = newToken())));

    // Saved before sending so an instant open/click has something to attach to.
    const message = await MessageModel.create({
      kind: 'email',
      token,
      label: input.label,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      html: rendered.html,
      links: rendered.links.map((l, i) => ({ ...l, token: linkTokens[i] })),
      sentAt: new Date(),
    });

    try {
      const sent = await sendGmail({
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        text: rendered.text,
        html: rendered.html + pixelTag(token),
      });
      message.gmailMessageId = sent.id;
      message.gmailThreadId = sent.threadId;
      message.sentAt = new Date();
      await message.save();
      res.json({ message: { _id: message._id } });
    } catch (err) {
      await MessageModel.deleteOne({ _id: message._id });
      if (err instanceof ReauthRequired) return res.status(401).json({ error: 'reauth', message: err.message });
      logger.error({ err }, 'gmail send failed');
      res.status(502).json({ error: 'send_failed', message: 'Gmail rejected the message' });
    }
  }),
);

apiRouter.post(
  '/links',
  h(async (req, res) => {
    const input = z
      .object({ url: httpUrl, label: z.string().trim().min(1).max(100), linkLabel: z.string().trim().max(100).default('') })
      .parse(req.body);
    const linkToken = newToken();
    const message = await MessageModel.create({
      kind: 'link',
      token: newToken(),
      label: input.label,
      links: [{ token: linkToken, url: input.url, label: input.linkLabel || input.label }],
      sentAt: new Date(),
    });
    res.json({ message: { _id: message._id }, trackedUrl: trackedUrl(linkToken) });
  }),
);

const savedLinksSchema = z.array(z.object({ label: z.string().trim().min(1).max(60), url: httpUrl })).max(30);

apiRouter.get(
  '/saved-links',
  h(async (_req, res) => {
    const doc = await SettingModel.findOne({ key: 'savedLinks' }).lean();
    res.json({ links: doc?.value ?? [] });
  }),
);

apiRouter.put(
  '/saved-links',
  h(async (req, res) => {
    const links = savedLinksSchema.parse(req.body.links);
    await SettingModel.updateOne({ key: 'savedLinks' }, { value: links }, { upsert: true });
    res.json({ links });
  }),
);
