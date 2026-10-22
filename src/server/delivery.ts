import { randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { newToken } from './crypto.js';
import { env } from './env.js';
import { getRfcMessageId, hasScope, METADATA_SCOPE, ReauthRequired, sendGmail } from './google.js';
import { logger } from './logger.js';
import { AccountModel, ApplicationModel, MessageModel } from './models.js';
import { advance } from './pipeline.js';
import { renderBody, withSignature } from '../shared/render.js';

export const trackedUrl = (token: string) => `${env.PUBLIC_URL}/l/${token}`;
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
}

type MessageDoc = InstanceType<typeof MessageModel>;

// Renders and stores the email. Scheduled ones wait for the scheduler; the
// rest are marked "sending" for the caller to deliver right away.
export async function createEmail(input: ComposeInput): Promise<MessageDoc> {
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).lean();
  const full = input.includeSignature ? withSignature(input.body, account?.signature) : input.body;
  const linkTokens: string[] = [];
  const rendered = renderBody(full, (_link, i) => trackedUrl((linkTokens[i] = newToken())));

  let label = input.label;
  if (input.applicationId && !label) {
    label = (await ApplicationModel.findById(input.applicationId).select('company').lean())?.company ?? '';
  }

  return MessageModel.create({
    kind: 'email',
    token: newToken(),
    label,
    applicationId: input.applicationId,
    followUpOf: input.followUpOf,
    status: input.scheduledAt ? 'scheduled' : 'sending',
    scheduledAt: input.scheduledAt,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    includeSignature: input.includeSignature,
    html: rendered.html,
    text: rendered.text,
    links: rendered.links.map((l, i) => ({ ...l, token: linkTokens[i] })),
    sentAt: input.scheduledAt ?? new Date(),
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
    html: message.html + pixelTag(message.token),
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
}

export function sendFailure(err: unknown): { status: number; error: string; message: string } {
  if (err instanceof ReauthRequired) return { status: 401, error: 'reauth', message: err.message };
  logger.error({ err }, 'gmail send failed');
  return { status: 502, error: 'send_failed', message: 'Gmail rejected the message' };
}
