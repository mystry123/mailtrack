import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';
import { ApplicationModel, ContactModel, MessageModel, type Message } from '../models.js';
import { requireSameOrigin, requireSession } from './auth.js';
import { h } from './api.js';

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const contactsRouter = Router();
contactsRouter.use(requireSession, requireSameOrigin);

const RELATIONSHIPS = ['referral', 'recruiter', 'hiring_manager', 'founder', 'friend', 'other'] as const;

const fields = z.object({
  name: z.string().trim().max(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((e) => e === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e), 'not an email address'),
  company: z.string().trim().max(100),
  title: z.string().trim().max(100),
  linkedin: z.string().trim().max(300),
  relationship: z.enum(RELATIONSHIPS),
  notes: z.string().max(5_000),
  applicationIds: z.array(z.string().refine(isValidObjectId)).max(50),
});

// Before sending: have you already contacted this person, their company domain, or this company?
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'live.com']);

contactsRouter.get(
  '/check',
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

contactsRouter.get(
  '/',
  h(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const appId = String(req.query.applicationId ?? '');
    const where = {
      ...(rx ? { $or: [{ name: rx }, { email: rx }, { company: rx }, { title: rx }] } : {}),
      ...(isValidObjectId(appId) ? { applicationIds: appId } : {}),
    };
    const contacts = await ContactModel.find(where).sort({ lastContactAt: -1, updatedAt: -1 }).limit(500).lean();
    res.json({ contacts });
  }),
);

contactsRouter.post(
  '/',
  h(async (req, res) => {
    const input = fields.partial().parse(req.body);
    if (!input.name && !input.email) return res.status(400).json({ error: 'invalid', message: 'Add a name or an email' });
    if (input.email && (await ContactModel.exists({ email: input.email }))) {
      return res.status(409).json({ error: 'conflict', message: 'You already have a contact with that email' });
    }
    const contact = await ContactModel.create(input);
    res.json({ contact });
  }),
);

contactsRouter.get(
  '/:id',
  h(async (req, res) => {
    const contact = isValidObjectId(req.params.id) ? await ContactModel.findById(req.params.id).lean() : null;
    if (!contact) return res.status(404).json({ error: 'not found' });
    const [messages, applications] = await Promise.all([
      contact.email
        ? MessageModel.find({ kind: 'email', 'to.email': new RegExp(`^${contact.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
            .select('subject sentAt stats status applicationId')
            .sort({ sentAt: -1 })
            .limit(50)
            .lean()
        : [],
      ApplicationModel.find({ _id: { $in: contact.applicationIds } }).select('company role stage').lean(),
    ]);
    res.json({ contact, messages, applications });
  }),
);

contactsRouter.patch(
  '/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const patch = fields.partial().parse(req.body);
    if (patch.email && (await ContactModel.exists({ email: patch.email, _id: { $ne: req.params.id } }))) {
      return res.status(409).json({ error: 'conflict', message: 'Another contact has that email' });
    }
    const contact = await ContactModel.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!contact) return res.status(404).json({ error: 'not found' });
    res.json({ contact });
  }),
);

contactsRouter.delete(
  '/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    await ContactModel.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  }),
);
