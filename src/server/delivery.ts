import { randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { newToken } from './crypto.js';
import { env } from './env.js';
import { getRfcMessageId, hasScope, METADATA_SCOPE, ReauthRequired, sendGmail } from './google.js';
import { logger } from './logger.js';
import { AccountModel, ApplicationModel, ContactModel, MessageModel } from './models.js';
import { advance } from './pipeline.js';
import { buildSteps, draftMissingSteps } from './sequences.js';
import { isDirectLink, renderBody, withSignature } from '../shared/render.js';
import { currentUserId } from './context.js';

export const trackedUrl = (token: string) => `${env.PUBLIC_URL}/l/${token}`;

// Markdown to email HTML. Links become tracked redirects, except Drive/Docs ones.
export function renderForSend(markdown: string) {
  const linkTokens: string[] = [];
  const rendered = renderBody(markdown, (l, i) => (isDirectLink(l.url) ? l.url : trackedUrl((linkTokens[i] = newToken()))));
  return { ...rendered, links: rendered.links.map((l, i) => ({ ...l, token: linkTokens[i] })).filter((l) => l.token) };
}

const pixelTag = (token: string) =>
  `<img src="${env.PUBLIC_URL}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;

export interface ComposeInput {
  to: { email: string; name?: string }[];
  cc: { email: string; name?: string }[];
  subject: string;
  body: string;
  label: string;
  includeSignature: boolean;
  applicationId?: Types.ObjectId | string;
  followUpOf?: Types.ObjectId | string;
  scheduledAt?: Date;
  trackOpens?: boolean;
  templateId?: Types.ObjectId | string;
  // Working days after sending for automatic follow-ups (first emails only).
  sequenceDays?: number[];
  automatic?: boolean;
}

type MessageDoc = InstanceType<typeof MessageModel>;

export class DailyCapReached extends Error {
  constructor(public cap: number) {
    super(`Daily limit reached: ${cap} emails in the last 24 hours. It protects your Gmail reputation; change it in Settings.`);
  }
}

const DAY = 86_400_000;

// Emails that went out in the last 24 hours (plus ones being sent right now).
export async function sentInLastDay(): Promise<number> {
  return MessageModel.countDocuments({
    kind: 'email',
    $or: [{ status: { $in: ['sent', null] }, sentAt: { $gte: new Date(Date.now() - DAY) } }, { status: 'sending' }],
  });
}

export async function assertUnderCap(extra = 0): Promise<void> {
  const account = await AccountModel.findById(currentUserId()).select('dailyCap').lean();
  const cap = account?.dailyCap ?? 50;
  if (cap > 0 && (await sentInLastDay()) - extra >= cap) throw new DailyCapReached(cap);
}

// Renders and stores the email. Scheduled ones wait for the scheduler; the
// rest are marked "sending" for the caller to deliver right away.
export async function createEmail(input: ComposeInput): Promise<MessageDoc> {
  const account = await AccountModel.findById(currentUserId()).lean();
  const full = input.includeSignature ? withSignature(input.body, account?.signature) : input.body;
  const rendered = renderForSend(full);

  let label = input.label;
  if (input.applicationId && !label) {
    label = (await ApplicationModel.findById(input.applicationId).select('company').lean())?.company ?? '';
  }

  const days = !input.followUpOf && input.sequenceDays?.length ? input.sequenceDays : undefined;
  return MessageModel.create({
    kind: 'email',
    token: newToken(),
    label,
    applicationId: input.applicationId,
    followUpOf: input.followUpOf,
    automatic: input.automatic ?? false,
    status: input.scheduledAt ? 'scheduled' : 'sending',
    scheduledAt: input.scheduledAt,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    includeSignature: input.includeSignature,
    html: rendered.html,
    text: rendered.text,
    links: rendered.links,
    sentAt: input.scheduledAt ?? new Date(),
    trackOpens: input.trackOpens ?? true,
    templateId: input.templateId,
    // Steps get real due dates once it's actually sent.
    sequence: days ? { status: 'active', steps: days.map((d) => ({ afterDays: d, dueAt: new Date(8.64e15), status: 'pending' })) } : undefined,
  });
}

// Sends a stored email through Gmail. Follow-ups go into the original thread.
export async function deliver(message: MessageDoc): Promise<void> {
  const parent = message.followUpOf ? await MessageModel.findById(message.followUpOf).lean() : null;
  const host = new URL(env.PUBLIC_URL).hostname;
  const ownId = `<${message.token}.${randomBytes(6).toString('hex')}@${host}>`;

  const sent = await sendGmail({
    to: message.to.map((r) => ({ email: r.email!, name: r.name ?? undefined })),
    cc: message.cc.map((r) => ({ email: r.email!, name: r.name ?? undefined })),
    subject: message.subject,
    text: message.text || message.subject,
    html: message.html + (message.trackOpens === false ? '' : pixelTag(message.token)),
    messageId: ownId,
    threadId: parent?.gmailThreadId ?? undefined,
    inReplyTo: parent?.rfcMessageId ?? undefined,
  });

  message.gmailMessageId = sent.id;
  message.gmailThreadId = sent.threadId;
  message.rfcMessageId = ownId;
  message.status = 'sent';
  message.sendError = undefined;
  message.sentAt = new Date();
  if (message.sequence?.steps.length) {
    const steps = buildSteps(message.sentAt, message.sequence.steps.map((s) => s.afterDays));
    message.set('sequence', { status: 'active', steps });
  }
  await message.save();

  // Gmail may replace our Message-ID; with header access we can read the real one.
  if (await hasScope(METADATA_SCOPE)) {
    try {
      const real = await getRfcMessageId(sent.id);
      if (real && real !== ownId) await MessageModel.updateOne({ _id: message._id }, { rfcMessageId: real });
    } catch (err) {
      logger.warn({ err }, 'could not read Message-ID');
    }
  }

  await advance(message.applicationId, 'reached_out');
  await rememberContacts(message);
  if (message.sequence?.steps.length) void draftMissingSteps(message._id).catch((err) => logger.warn({ err }, 'sequence drafting failed'));
}

// Everyone you email becomes a contact, linked to the company.
async function rememberContacts(message: MessageDoc): Promise<void> {
  for (const r of [...message.to, ...message.cc]) {
    const email = (r.email ?? '').toLowerCase();
    if (!email) continue;
    try {
      await ContactModel.updateOne(
        { email },
        {
          $setOnInsert: { email, name: r.name ?? '', company: message.label ?? '' },
          $set: { lastContactAt: message.sentAt },
          ...(message.applicationId ? { $addToSet: { applicationIds: message.applicationId } } : {}),
        },
        { upsert: true },
      );
    } catch (err) {
      logger.warn({ err, email }, 'could not save contact');
    }
  }
}

export function sendFailure(err: unknown): { status: number; error: string; message: string } {
  if (err instanceof ReauthRequired) return { status: 401, error: 'reauth', message: err.message };
  if (err instanceof DailyCapReached) return { status: 429, error: 'daily_cap', message: err.message };
  logger.error({ err }, 'gmail send failed');
  return { status: 502, error: 'send_failed', message: 'Gmail rejected the message' };
}
