import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { AiUnavailable, companyBrief, interviewPrep } from '../ai.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { AccountModel, ApplicationModel, EventModel, MessageModel } from '../models.js';
import { applyManualStage, createApplication } from '../pipeline.js';
import { SOURCES, STAGES } from '../../shared/stages.js';
import { requireSameOrigin, requireSession } from './auth.js';
import { h } from './api.js';

export const applicationsRouter = Router();
applicationsRouter.use(requireSession, requireSameOrigin);

const aiLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

const optionalUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine((u) => u === '' || /^https?:\/\/\S+$/i.test(u), 'must be an http(s) URL');

const fields = z.object({
  company: z.string().trim().min(1).max(100),
  role: z.string().trim().max(150),
  jobUrl: optionalUrl,
  jobDescription: z.string().max(30_000),
  source: z.enum(SOURCES),
  location: z.string().trim().max(150),
  salary: z.string().trim().max(100),
  priority: z.number().int().min(1).max(3),
  contacts: z
    .array(
      z.object({
        name: z.string().trim().max(100).default(''),
        email: z.string().trim().max(200).default(''),
        title: z.string().trim().max(100).default(''),
        linkedin: z.string().trim().max(300).default(''),
      }),
    )
    .max(20),
  interviewAt: z.coerce.date().nullable(),
  snoozedUntil: z.coerce.date().nullable(),
  archived: z.boolean(),
});

const load = async (id: string) => (isValidObjectId(id) ? ApplicationModel.findById(id) : null);

applicationsRouter.get(
  '/',
  h(async (req, res) => {
    const archived = req.query.archived === '1';
    const apps = await ApplicationModel.find({ archived })
      .select('-jobDescription -brief -prep -notes')
      .sort({ updatedAt: -1 })
      .limit(1000)
      .lean();
    const agg = await MessageModel.aggregate<{
      _id: Types.ObjectId;
      emails: number;
      links: number;
      opens: number;
      clicks: number;
      replies: number;
      lastSentAt: Date;
      lastActivityAt: Date | null;
      scheduled: number;
    }>([
      { $match: { applicationId: { $in: apps.map((a) => a._id) }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$applicationId',
          emails: { $sum: { $cond: [{ $eq: ['$kind', 'email'] }, 1, 0] } },
          links: { $sum: { $cond: [{ $eq: ['$kind', 'link'] }, 1, 0] } },
          opens: { $sum: '$stats.opens' },
          clicks: { $sum: '$stats.clicks' },
          replies: { $sum: '$stats.replies' },
          lastSentAt: { $max: '$sentAt' },
          lastActivityAt: { $max: '$stats.lastActivityAt' },
          scheduled: { $sum: { $cond: [{ $eq: ['$status', 'scheduled'] }, 1, 0] } },
        },
      },
    ]);
    const byId = new Map(agg.map((a) => [String(a._id), a]));
    res.json({
      applications: apps.map((a) => {
        const s = byId.get(String(a._id));
        return {
          ...a,
          activity: {
            emails: s?.emails ?? 0,
            links: s?.links ?? 0,
            opens: s?.opens ?? 0,
            clicks: s?.clicks ?? 0,
            replies: s?.replies ?? 0,
            scheduled: s?.scheduled ?? 0,
            lastSentAt: s?.lastSentAt,
            lastActivityAt: s?.lastActivityAt ?? s?.lastSentAt ?? a.updatedAt,
          },
        };
      }),
    });
  }),
);

// Emails sent before they belonged to a company, grouped by the company name typed at the time.
async function unlinkedByCompany() {
  const messages = await MessageModel.find({
    kind: 'email',
    applicationId: { $exists: false },
    label: { $nin: ['', null] },
    status: { $in: ['sent', null] },
    archived: false,
  })
    .select('label sentAt stats')
    .sort({ sentAt: 1 })
    .lean();
  const groups = new Map<string, typeof messages>();
  for (const m of messages) {
    const key = m.label.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return groups;
}

applicationsRouter.get(
  '/unlinked',
  h(async (_req, res) => {
    const groups = await unlinkedByCompany();
    res.json({
      emails: [...groups.values()].reduce((n, g) => n + g.length, 0),
      companies: [...groups.values()].map((g) => g[0].label.trim()),
    });
  }),
);

// One click: create (or reuse) an application per company and attach the emails.
applicationsRouter.post(
  '/import',
  h(async (_req, res) => {
    const groups = await unlinkedByCompany();
    let created = 0;
    for (const msgs of groups.values()) {
      const company = msgs[0].label.trim();
      let app = await ApplicationModel.findOne({ company: new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (!app) {
        const first = msgs[0].sentAt;
        const replied = msgs.find((m) => (m.stats?.replies ?? 0) > 0);
        app = createApplication({ company, source: 'cold_email' }, 'reached_out', first);
        if (replied?.stats?.firstReplyAt) applyManualStage(app, 'replied', replied.stats.firstReplyAt);
        await app.save();
        created++;
      }
      await MessageModel.updateMany({ _id: { $in: msgs.map((m) => m._id) } }, { applicationId: app._id });
    }
    res.json({ created, linked: [...groups.values()].reduce((n, g) => n + g.length, 0) });
  }),
);

applicationsRouter.post(
  '/',
  h(async (req, res) => {
    const input = fields
      .partial()
      .required({ company: true })
      .extend({ stage: z.enum(STAGES).default('wishlist') })
      .parse(req.body);
    const { stage, ...rest } = input;
    const app = createApplication(rest, stage);
    await app.save();
    res.json({ application: app });
  }),
);

applicationsRouter.get(
  '/:id',
  h(async (req, res) => {
    const app = isValidObjectId(req.params.id) ? await ApplicationModel.findById(req.params.id).lean() : null;
    if (!app) return res.status(404).json({ error: 'not found' });
    const messages = await MessageModel.find({ applicationId: app._id, status: { $ne: 'cancelled' } })
      .select('-html -text -replyIds')
      .sort({ sentAt: 1 })
      .lean();
    const events = await EventModel.find({ messageId: { $in: messages.map((m) => m._id) }, signal: 'real' })
      .sort({ at: -1 })
      .limit(300)
      .lean();
    res.json({ application: app, messages, events });
  }),
);

applicationsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const app = await load(req.params.id);
    if (!app) return res.status(404).json({ error: 'not found' });
    const { stage, ...patch } = fields.partial().extend({ stage: z.enum(STAGES).optional() }).parse(req.body);
    app.set(patch);
    if (stage) applyManualStage(app, stage);
    await app.save();
    res.json({ application: app });
  }),
);

applicationsRouter.post(
  '/:id/notes',
  h(async (req, res) => {
    const app = await load(req.params.id);
    if (!app) return res.status(404).json({ error: 'not found' });
    const { text } = z.object({ text: z.string().trim().min(1).max(5_000) }).parse(req.body);
    app.notes.push({ text, at: new Date() });
    await app.save();
    res.json({ notes: app.notes });
  }),
);

applicationsRouter.delete(
  '/:id/notes/:noteId',
  h(async (req, res) => {
    const app = await load(req.params.id);
    if (!app) return res.status(404).json({ error: 'not found' });
    app.notes.pull({ _id: req.params.noteId });
    await app.save();
    res.json({ notes: app.notes });
  }),
);

applicationsRouter.put(
  '/:id/prep',
  h(async (req, res) => {
    const app = await load(req.params.id);
    if (!app) return res.status(404).json({ error: 'not found' });
    const items = z
      .array(z.object({ text: z.string().trim().min(1).max(500), done: z.boolean().default(false) }))
      .max(40)
      .parse(req.body.items);
    app.set('prep', items);
    await app.save();
    res.json({ prep: app.prep });
  }),
);

function aiError(res: import('express').Response, err: unknown) {
  if (err instanceof AiUnavailable) return res.status(503).json({ error: 'ai_unavailable', message: err.message });
  logger.error({ err }, 'gemini failed');
  res.status(502).json({ error: 'ai_failed', message: 'Gemini is busy or failed; try again in a moment' });
}

applicationsRouter.post(
  '/:id/brief',
  aiLimit,
  h(async (req, res) => {
    const app = await load(req.params.id);
    if (!app) return res.status(404).json({ error: 'not found' });
    try {
      const brief = await companyBrief({ company: app.company, role: app.role, jobUrl: app.jobUrl, jobDescription: app.jobDescription });
      app.set('brief', { text: brief.text, sources: brief.sources, at: new Date() });
      await app.save();
      res.json({ brief: app.brief });
    } catch (err) {
      aiError(res, err);
    }
  }),
);

applicationsRouter.post(
  '/:id/prep/generate',
  aiLimit,
  h(async (req, res) => {
    const app = await load(req.params.id);
    if (!app) return res.status(404).json({ error: 'not found' });
    const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).select('aboutMe').lean();
    try {
      const prep = await interviewPrep(
        { company: app.company, role: app.role, jobUrl: app.jobUrl, jobDescription: app.jobDescription },
        account?.aboutMe ?? '',
        app.brief?.text ?? undefined,
      );
      // Keep what you already ticked or wrote; add the new items after.
      const existing = app.prep.map((p) => ({ text: p.text, done: p.done }));
      const seen = new Set(existing.map((p) => p.text.toLowerCase()));
      app.set('prep', [...existing, ...prep.items.filter((t) => !seen.has(t.toLowerCase())).map((text) => ({ text, done: false }))]);
      await app.save();
      res.json({ prep: app.prep });
    } catch (err) {
      aiError(res, err);
    }
  }),
);
