import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidObjectId, type FilterQuery } from 'mongoose';
import { z } from 'zod';
import { AiUnavailable, draftFollowUp, draftReferralAsk, draftThankYou, enhanceEmail } from '../ai.js';
import { syncCalendar } from '../calendar.js';
import { buildDigest, sendDigest } from '../digest.js';
import { newToken } from '../crypto.js';
import { assertUnderCap, createEmail, deliver, sendFailure, sentInLastDay, trackedUrl } from '../delivery.js';
import { env } from '../env.js';
import { CALENDAR_SCOPE, METADATA_SCOPE, READ_SCOPE } from '../google.js';
import { checkReplies, sendSequenceStep } from '../jobs.js';
import { tickSequences } from '../sequences.js';
import { logger } from '../logger.js';
import {
  AccountModel,
  ApplicationModel,
  ContactModel,
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
      replyReading: (account?.scopes ?? []).includes(READ_SCOPE),
      calendarSync: (account?.scopes ?? []).includes(CALENDAR_SCOPE),
      calendarSyncedAt: account?.calendarSyncedAt,
      sequenceDays: account?.sequenceDays ?? [4, 9],
      sequenceByDefault: account?.sequenceByDefault ?? true,
      dailyCap: account?.dailyCap ?? 50,
      sentToday: await sentInLastDay(),
      timezone: account?.timezone ?? 'Asia/Kolkata',
      weeklyDigest: account?.weeklyDigest ?? true,
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
        sequenceDays: z.array(z.number().int().min(1).max(60)).max(3).optional(),
        sequenceByDefault: z.boolean().optional(),
        dailyCap: z.number().int().min(0).max(500).optional(),
        timezone: z
          .string()
          .refine((tz) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: tz });
              return true;
            } catch {
              return false;
            }
          }, 'unknown time zone')
          .optional(),
        weeklyDigest: z.boolean().optional(),
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
  trackOpens: z.boolean().default(true),
  templateId: objectId.optional(),
  sequenceDays: z.array(z.number().int().min(1).max(60)).max(3).optional(),
  // A thank-you for this interview: marks it done once sent.
  thankYouFor: z.object({ applicationId: objectId, key: z.string().min(1).max(200) }).optional(),
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
    if (!input.scheduledAt) {
      try {
        await assertUnderCap();
      } catch (err) {
        const f = sendFailure(err);
        return res.status(f.status).json(f);
      }
    }
    applicationId = await resolveApplication({ applicationId, newApplication: input.newApplication });

    const message = await createEmail({ ...input, applicationId, sequenceDays: input.followUpOf ? undefined : input.sequenceDays });
    const markThankYou = async () => {
      if (input.thankYouFor) await ApplicationModel.updateOne({ _id: input.thankYouFor.applicationId }, { $addToSet: { thankYous: input.thankYouFor.key } });
    };
    if (input.scheduledAt) {
      await markThankYou();
      return res.json({ message: { _id: message._id, status: 'scheduled' } });
    }

    try {
      await deliver(message);
      await markThankYou();
      res.json({ message: { _id: message._id, status: 'sent' } });
    } catch (err) {
      await MessageModel.deleteOne({ _id: message._id });
      const f = sendFailure(err);
      res.status(f.status).json(f);
    }
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

// ---------- automatic follow-up sequences ----------

const stepIndex = (req: Request) => Number(req.params.i);

async function loadSequenceRoot(req: Request, res: Response) {
  if (!isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  const root = await MessageModel.findById(req.params.id);
  if (!root?.sequence) {
    res.status(404).json({ error: 'not found', message: 'This email has no automatic follow-ups' });
    return null;
  }
  return root;
}

// Start automatic follow-ups on an email that was sent without them.
apiRouter.post(
  '/messages/:id/sequence',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { days } = z.object({ days: z.array(z.number().int().min(1).max(60)).min(1).max(3) }).parse(req.body);
    const root = await MessageModel.findById(req.params.id);
    if (!root || root.kind !== 'email' || root.followUpOf) return res.status(400).json({ error: 'invalid', message: 'Only first emails can have automatic follow-ups' });
    if (root.status && root.status !== 'sent') return res.status(400).json({ error: 'invalid', message: 'Send it first' });
    if (root.sequence?.status === 'active') return res.status(409).json({ error: 'conflict', message: 'Already has automatic follow-ups' });
    const { buildSteps, draftMissingSteps } = await import('../sequences.js');
    // Count from now for an old email, so nothing fires instantly.
    const base = new Date(Math.max(root.sentAt.getTime(), Date.now()));
    root.set('sequence', { status: 'active', steps: buildSteps(base, days) });
    await root.save();
    void draftMissingSteps(root._id).catch((err) => logger.warn({ err }, 'sequence drafting failed'));
    res.json({ sequence: root.sequence });
  }),
);

apiRouter.patch(
  '/messages/:id/sequence/:i',
  h(async (req, res) => {
    const root = await loadSequenceRoot(req, res);
    if (!root) return;
    const i = stepIndex(req);
    const step = root.sequence!.steps[i];
    if (!step || step.status !== 'pending') return res.status(409).json({ error: 'conflict', message: 'That follow-up already went out or was cancelled' });
    const patch = z.object({ subject: z.string().max(300).optional(), body: z.string().min(1).max(20_000).optional() }).parse(req.body);
    if (patch.subject !== undefined) step.subject = patch.subject;
    if (patch.body !== undefined) step.body = patch.body;
    step.edited = true;
    await root.save();
    res.json({ sequence: root.sequence });
  }),
);

apiRouter.post(
  '/messages/:id/sequence/:i/skip',
  h(async (req, res) => {
    const root = await loadSequenceRoot(req, res);
    if (!root) return;
    const step = root.sequence!.steps[stepIndex(req)];
    if (!step || step.status !== 'pending') return res.status(409).json({ error: 'conflict', message: 'Nothing to skip' });
    step.status = 'skipped';
    if (!root.sequence!.steps.some((s) => s.status === 'pending')) root.sequence!.status = 'done';
    await root.save();
    res.json({ sequence: root.sequence });
  }),
);

apiRouter.post(
  '/messages/:id/sequence/:i/send-now',
  h(async (req, res) => {
    const root = await loadSequenceRoot(req, res);
    if (!root) return;
    const i = stepIndex(req);
    const step = root.sequence!.steps[i];
    if (!step || step.status !== 'pending' || root.sequence!.status !== 'active') return res.status(409).json({ error: 'conflict', message: 'Nothing to send' });
    if (root.sequence!.steps.slice(0, i).some((s) => s.status === 'pending')) {
      return res.status(409).json({ error: 'conflict', message: 'Send or skip the earlier follow-up first' });
    }
    step.dueAt = new Date();
    await root.save();
    await tickSequences(sendSequenceStep);
    const after = await MessageModel.findById(root._id).lean();
    const s = after?.sequence?.steps[i];
    if (s?.status !== 'sent') return res.status(502).json({ error: 'send_failed', message: s?.error || 'Not sent yet: Gemini is still drafting it, try again in a moment' });
    res.json({ sequence: after!.sequence });
  }),
);

apiRouter.post(
  '/messages/:id/sequence/stop',
  h(async (req, res) => {
    const root = await loadSequenceRoot(req, res);
    if (!root) return;
    root.sequence!.status = 'stopped';
    root.sequence!.stopReason = 'Stopped by you';
    for (const s of root.sequence!.steps) if (s.status === 'pending') s.status = 'cancelled';
    await root.save();
    res.json({ sequence: root.sequence });
  }),
);

// ---------- thank-you notes and referral asks ----------

apiRouter.post(
  '/ai/thankyou',
  aiLimit,
  h(async (req, res) => {
    const { applicationId, key } = z.object({ applicationId: objectId, key: z.string().min(1).max(200) }).parse(req.body);
    const app = await ApplicationModel.findById(applicationId).lean();
    if (!app) return res.status(404).json({ error: 'not found' });
    const interview = app.interviews.find((i) => i.eventId === key);
    // Who to thank: the interviewers, else whoever you last emailed there.
    let to = (interview?.attendees ?? []).filter((a) => a && a !== env.ALLOWED_EMAIL);
    if (!to.length) {
      const last = await MessageModel.findOne({ applicationId: app._id, kind: 'email' }).sort({ sentAt: -1 }).select('to').lean();
      to = (last?.to ?? []).map((r) => r.email ?? '').filter(Boolean);
    }
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).select('aboutMe').lean();
    try {
      const draft = await draftThankYou({
        job: { company: app.company, role: app.role, jobUrl: app.jobUrl, jobDescription: app.jobDescription },
        interviewTitle: interview?.title ?? `Interview with ${app.company}`,
        interviewers: to.join(', '),
        aboutMe: account?.aboutMe ?? '',
        notes: app.notes.slice(-5).map((n) => n.text).join('\n'),
      });
      res.json({ ...draft, to });
    } catch (err) {
      aiFailure(res, err);
    }
  }),
);

apiRouter.post(
  '/ai/referral',
  aiLimit,
  h(async (req, res) => {
    const { contactId, applicationId } = z.object({ contactId: objectId, applicationId: objectId.optional() }).parse(req.body);
    const contact = await ContactModel.findById(contactId).lean();
    if (!contact) return res.status(404).json({ error: 'not found' });
    const appId = applicationId ?? (contact.applicationIds[0] ? String(contact.applicationIds[0]) : undefined);
    const job = (await jobFor(appId)) ?? { company: contact.company };
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).select('aboutMe').lean();
    try {
      const draft = await draftReferralAsk({
        contact: { name: contact.name, title: contact.title, relationship: contact.relationship, notes: contact.notes },
        job,
        aboutMe: account?.aboutMe ?? '',
      });
      res.json({ ...draft, applicationId: appId });
    } catch (err) {
      aiFailure(res, err);
    }
  }),
);

// ---------- digest and calendar ----------

apiRouter.get('/digest/preview', h(async (_req, res) => res.json(await buildDigest())));

apiRouter.post(
  '/digest/send',
  rateLimit({ windowMs: 60_000, limit: 3 }),
  h(async (_req, res) => {
    try {
      res.json(await sendDigest());
    } catch (err) {
      const f = sendFailure(err);
      res.status(f.status).json(f);
    }
  }),
);

apiRouter.post(
  '/calendar/sync',
  rateLimit({ windowMs: 60_000, limit: 4 }),
  h(async (_req, res) => res.json({ matched: await syncCalendar() })),
);
