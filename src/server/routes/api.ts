import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidObjectId, type FilterQuery } from 'mongoose';
import { z } from 'zod';
import { AiUnavailable, draftFollowUp, enhanceEmail } from '../ai.js';
import { newToken } from '../crypto.js';
import { createEmail, deliver, sendFailure, trackedUrl } from '../delivery.js';
import { env } from '../env.js';
import { METADATA_SCOPE } from '../google.js';
import { checkReplies } from '../jobs.js';
import { logger } from '../logger.js';
import {
  AccountModel,
  ApplicationModel,
  EventModel,
  MessageModel,
  SettingModel,
  SIGNALS,
  TemplateModel,
  type Message,
} from '../models.js';
import { insights, today } from '../overview.js';
import { createApplication } from '../pipeline.js';
import { recomputeStats } from '../stats.js';
import { SOURCES } from '../../shared/stages.js';
import { requireSameOrigin, requireSession } from './auth.js';

export const apiRouter = Router();
apiRouter.use(requireSession, requireSameOrigin);

type Handler = (req: Request, res: Response) => Promise<unknown>;
export const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const address = z.object({ email: z.string().trim().email(), name: z.string().trim().max(100).optional() });
export const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');
export const objectId = z.string().refine((s) => isValidObjectId(s), 'invalid id');

const LIST_FIELDS = '-body -html -text -replyIds';
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const aiLimit = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false });

function aiFailure(res: Response, err: unknown) {
  if (err instanceof AiUnavailable) return res.status(503).json({ error: 'ai_unavailable', message: err.message });
  logger.error({ err }, 'gemini failed');
  res.status(502).json({ error: 'ai_failed', message: 'Gemini is busy or failed; try again in a moment' });
}

apiRouter.get(
  '/me',
  h(async (_req, res) => {
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).lean();
    res.json({
      email: env.ALLOWED_EMAIL,
      name: account?.name ?? '',
      fromName: account?.fromName ?? '',
      signature: account?.signature ?? '',
      aboutMe: account?.aboutMe ?? '',
      weeklyGoal: account?.weeklyGoal ?? 20,
      followUpDays: account?.followUpDays ?? 4,
      replyDetection: (account?.scopes ?? []).includes(METADATA_SCOPE),
      needsReauth: !account || account.needsReauth,
      publicUrl: env.PUBLIC_URL,
    });
  }),
);

apiRouter.put(
  '/me',
  h(async (req, res) => {
    const patch = z
      .object({
        fromName: z.string().trim().max(100).optional(),
        signature: z.string().max(2_000).optional(),
        aboutMe: z.string().max(5_000).optional(),
        weeklyGoal: z.number().int().min(0).max(200).optional(),
        followUpDays: z.number().int().min(1).max(30).optional(),
      })
      .parse(req.body);
    await AccountModel.updateOne({ email: env.ALLOWED_EMAIL }, patch);
    res.json({ ok: true });
  }),
);

apiRouter.get('/today', h(async (_req, res) => res.json(await today())));
apiRouter.get('/insights', h(async (_req, res) => res.json(await insights())));

apiRouter.post(
  '/replies/check',
  rateLimit({ windowMs: 60_000, limit: 4 }),
  h(async (_req, res) => res.json({ found: await checkReplies(100) })),
);

apiRouter.get(
  '/messages',
  h(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const filter = String(req.query.filter ?? 'all');
    const where: FilterQuery<Message> = { archived: req.query.archived === '1', status: { $ne: 'cancelled' } };
    if (filter === 'clicked') where['stats.clicks'] = { $gt: 0 };
    else if (filter === 'replied') where['stats.replies'] = { $gt: 0 };
    else if (filter === 'opened') Object.assign(where, { 'stats.opens': { $gt: 0 }, 'stats.clicks': 0 });
    else if (filter === 'quiet') Object.assign(where, { 'stats.opens': 0, 'stats.clicks': 0, kind: 'email' });
    else if (filter === 'links') where.kind = 'link';
    else if (filter === 'scheduled') where.status = { $in: ['scheduled', 'failed'] };
    if (q) {
      const rx = new RegExp(escapeRx(q), 'i');
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
    const message = await MessageModel.findById(req.params.id).select('-replyIds').lean();
    if (!message) return res.status(404).json({ error: 'not found' });
    const [events, application, thread] = await Promise.all([
      EventModel.find({ messageId: message._id }).sort({ at: -1 }).lean(),
      message.applicationId ? ApplicationModel.findById(message.applicationId).select('company role stage').lean() : null,
      message.gmailThreadId
        ? MessageModel.find({ gmailThreadId: message.gmailThreadId, _id: { $ne: message._id } })
            .select('subject sentAt stats status followUpOf')
            .sort({ sentAt: 1 })
            .lean()
        : [],
    ]);
    res.json({ message, events, application, thread });
  }),
);

apiRouter.patch(
  '/messages/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const patch = z
      .object({
        archived: z.boolean().optional(),
        label: z.string().trim().max(100).optional(),
        applicationId: objectId.nullable().optional(),
      })
      .parse(req.body);
    const r = await MessageModel.updateOne({ _id: req.params.id }, patch);
    if (!r.matchedCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  }),
);

apiRouter.post(
  '/messages/:id/cancel',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const r = await MessageModel.updateOne({ _id: req.params.id, status: { $in: ['scheduled', 'failed'] } }, { status: 'cancelled' });
    if (!r.modifiedCount) return res.status(409).json({ error: 'conflict', message: 'It was already sent or cancelled' });
    res.json({ ok: true });
  }),
);

apiRouter.post(
  '/messages/:id/send-now',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const message = await MessageModel.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ['scheduled', 'failed'] } },
      { status: 'sending', sendError: undefined },
      { new: true },
    );
    if (!message) return res.status(409).json({ error: 'conflict', message: 'It was already sent or cancelled' });
    try {
      await deliver(message);
      res.json({ ok: true });
    } catch (err) {
      const f = sendFailure(err);
      await MessageModel.updateOne({ _id: message._id }, { status: 'failed', sendError: f.message });
      res.status(f.status).json(f);
    }
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

const newApplication = z.object({
  company: z.string().trim().min(1).max(100),
  role: z.string().trim().max(150).default(''),
  source: z.enum(SOURCES).default('cold_email'),
});

const sendSchema = z.object({
  to: z.array(address).min(1).max(20),
  cc: z.array(address).max(20).default([]),
  subject: z.string().trim().min(1).max(300),
  body: z.string().min(1).max(50_000),
  label: z.string().trim().max(100).default(''),
  includeSignature: z.boolean().default(true),
  applicationId: objectId.optional(),
  newApplication: newApplication.optional(),
  followUpOf: objectId.optional(),
  scheduledAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now() - 60_000, 'must be in the future')
    .refine((d) => d.getTime() < Date.now() + 90 * 86_400_000, 'must be within 90 days')
    .optional(),
});

async function resolveApplication(input: { applicationId?: string; newApplication?: z.infer<typeof newApplication> }) {
  if (input.applicationId) return input.applicationId;
  if (!input.newApplication) return undefined;
  const app = createApplication(input.newApplication);
  await app.save();
  return String(app._id);
}

apiRouter.post(
  '/messages/send',
  h(async (req, res) => {
    const input = sendSchema.parse(req.body);
    let applicationId = input.applicationId;
    if (input.followUpOf) {
      const parent = await MessageModel.findById(input.followUpOf).select('applicationId').lean();
      if (!parent) return res.status(404).json({ error: 'not found', message: 'The original email is gone' });
      applicationId ??= parent.applicationId ? String(parent.applicationId) : undefined;
    }
    applicationId = await resolveApplication({ applicationId, newApplication: input.newApplication });

    const message = await createEmail({ ...input, applicationId });
    if (input.scheduledAt) return res.json({ message: { _id: message._id, status: 'scheduled' } });

    try {
      await deliver(message);
      res.json({ message: { _id: message._id, status: 'sent' } });
    } catch (err) {
      await MessageModel.deleteOne({ _id: message._id });
      const f = sendFailure(err);
      res.status(f.status).json(f);
    }
  }),
);

// Before sending: have you already contacted this person, their company domain, or this company?
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'live.com']);

apiRouter.get(
  '/contacts/check',
  h(async (req, res) => {
    const emails = String(req.query.emails ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /@/.test(e))
      .slice(0, 20);
    const company = String(req.query.company ?? '').trim();
    const domains = [...new Set(emails.map((e) => e.split('@')[1]).filter((d) => d && !PUBLIC_DOMAINS.has(d)))];
    const or: FilterQuery<Message>[] = [];
    if (emails.length) or.push({ 'to.email': { $in: emails.map((e) => new RegExp(`^${escapeRx(e)}$`, 'i')) } });
    for (const d of domains) or.push({ 'to.email': new RegExp(`@${escapeRx(d)}$`, 'i') });
    const messages = or.length
      ? await MessageModel.find({ kind: 'email', status: { $in: ['sent', 'scheduled', null] }, $or: or })
          .select('subject to sentAt stats status applicationId')
          .sort({ sentAt: -1 })
          .limit(5)
          .lean()
      : [];
    const applications = company
      ? await ApplicationModel.find({ company: new RegExp(`^${escapeRx(company)}$`, 'i') })
          .select('company role stage')
          .limit(5)
          .lean()
      : [];
    res.json({ messages, applications });
  }),
);

apiRouter.post(
  '/links',
  h(async (req, res) => {
    const input = z
      .object({
        url: httpUrl,
        label: z.string().trim().min(1).max(100),
        linkLabel: z.string().trim().max(100).default(''),
        applicationId: objectId.optional(),
        newApplication: newApplication.optional(),
      })
      .parse(req.body);
    const applicationId = await resolveApplication(input);
    const linkToken = newToken();
    const message = await MessageModel.create({
      kind: 'link',
      token: newToken(),
      label: input.label,
      applicationId,
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

const templateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  subject: z.string().max(300).default(''),
  body: z.string().max(50_000).default(''),
});

apiRouter.get(
  '/templates',
  h(async (_req, res) => res.json({ templates: await TemplateModel.find().sort({ updatedAt: -1 }).lean() })),
);

apiRouter.post(
  '/templates',
  h(async (req, res) => {
    const input = templateSchema.parse(req.body);
    // Same name overwrites, so "Save as template" twice updates it.
    const template = await TemplateModel.findOneAndUpdate({ name: input.name }, input, { upsert: true, new: true });
    res.json({ template });
  }),
);

apiRouter.delete(
  '/templates/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    await TemplateModel.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  }),
);

async function jobFor(applicationId?: string) {
  if (!applicationId) return undefined;
  const app = await ApplicationModel.findById(applicationId).select('company role jobUrl jobDescription').lean();
  return app ? { company: app.company, role: app.role, jobUrl: app.jobUrl, jobDescription: app.jobDescription } : undefined;
}

const enhanceSchema = z.object({
  subject: z.string().max(300).default(''),
  body: z.string().max(20_000).default(''),
  instruction: z.string().trim().max(2_000).default(''),
  to: z.string().max(500).default(''),
  label: z.string().max(100).default(''),
  applicationId: objectId.optional(),
});

apiRouter.post(
  '/ai/enhance',
  aiLimit,
  h(async (req, res) => {
    const input = enhanceSchema.parse(req.body);
    if (!input.body.trim() && !input.instruction && !input.applicationId) {
      return res.status(400).json({ error: 'invalid', message: 'Write a draft or tell Gemini what to write' });
    }
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).lean();
    try {
      res.json(await enhanceEmail({ ...input, aboutMe: account?.aboutMe ?? '', job: await jobFor(input.applicationId) }));
    } catch (err) {
      aiFailure(res, err);
    }
  }),
);

apiRouter.post(
  '/ai/followup',
  aiLimit,
  h(async (req, res) => {
    const { messageId, instruction } = z
      .object({ messageId: objectId, instruction: z.string().trim().max(1_000).default('') })
      .parse(req.body);
    const message = await MessageModel.findById(messageId).lean();
    if (!message) return res.status(404).json({ error: 'not found' });
    // Follow up on the whole thread: count earlier follow-ups, quote the first email.
    const thread = message.gmailThreadId
      ? await MessageModel.find({ gmailThreadId: message.gmailThreadId, kind: 'email' }).sort({ sentAt: 1 }).lean()
      : [message];
    const first = thread[0] ?? message;
    const last = thread.at(-1) ?? message;
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).lean();
    try {
      const draft = await draftFollowUp({
        original: {
          subject: first.subject,
          body: first.body,
          sentAt: first.sentAt,
          to: first.to.map((r) => r.name || r.email).join(', '),
        },
        followUpNumber: thread.filter((m) => m.followUpOf).length + 1,
        daysSince: Math.floor((Date.now() - new Date(last.sentAt).getTime()) / 86_400_000),
        aboutMe: account?.aboutMe ?? '',
        job: await jobFor(message.applicationId ? String(message.applicationId) : undefined),
        instruction,
      });
      res.json({ ...draft, followUpOf: String(last._id) });
    } catch (err) {
      aiFailure(res, err);
    }
  }),
);
