import { deliver } from './delivery.js';
import { env } from './env.js';
import { getThread, hasScope, METADATA_SCOPE, ReauthRequired, sendGmail } from './google.js';
import { logger } from './logger.js';
import { ApplicationModel, EventModel, MessageModel, type Message } from './models.js';
import { advance } from './pipeline.js';
import { recomputeStats } from './stats.js';
import { renderBody } from '../shared/render.js';

const SCHEDULE_EVERY_MS = 30_000;
const REPLIES_EVERY_MS = 10 * 60_000;
// Threads older than this aren't checked for replies any more.
const REPLY_WINDOW_DAYS = 60;

// Scheduled emails whose time has come. findOneAndUpdate claims each one, so
// a slow send is never picked up twice.
export async function sendDueScheduled(): Promise<void> {
  // A send interrupted by a restart can't be retried blindly (it may have gone out).
  await MessageModel.updateMany(
    { status: 'sending', updatedAt: { $lt: new Date(Date.now() - 10 * 60_000) } },
    { status: 'failed', sendError: 'Interrupted while sending. Check Gmail Sent before sending again.' },
  );
  for (;;) {
    const message = await MessageModel.findOneAndUpdate(
      { status: 'scheduled', scheduledAt: { $lte: new Date() } },
      { status: 'sending' },
      { new: true },
    );
    if (!message) return;
    try {
      await deliver(message);
      logger.info({ id: String(message._id) }, 'scheduled email sent');
    } catch (err) {
      const reason = err instanceof ReauthRequired ? 'Google access expired: reconnect in Settings, then reschedule.' : 'Gmail rejected it.';
      await MessageModel.updateOne({ _id: message._id }, { status: 'failed', sendError: reason });
      logger.error({ err, id: String(message._id) }, 'scheduled send failed');
      if (err instanceof ReauthRequired) return;
    }
  }
}

// Reads headers of the threads you sent from here; any message in them not
// from you is a reply. Needs the gmail.metadata permission.
export async function checkReplies(limit = 40): Promise<number> {
  if (!(await hasScope(METADATA_SCOPE))) return 0;
  const since = new Date(Date.now() - REPLY_WINDOW_DAYS * 86_400_000);
  const stale = new Date(Date.now() - REPLIES_EVERY_MS + 30_000);
  const due = await MessageModel.find({
    kind: 'email',
    status: { $in: ['sent', null] },
    gmailThreadId: { $exists: true },
    sentAt: { $gte: since },
    $or: [{ replyCheckedAt: { $exists: false } }, { replyCheckedAt: { $lt: stale } }],
  })
    .sort({ replyCheckedAt: 1 })
    .limit(limit)
    .lean<Message[]>();

  const threads = [...new Set(due.map((m) => m.gmailThreadId!))];
  let found = 0;
  for (const threadId of threads) {
    try {
      found += await checkThread(threadId);
    } catch (err) {
      if (err instanceof ReauthRequired) return found;
      logger.warn({ err, threadId }, 'reply check failed for thread');
    }
    await MessageModel.updateMany({ gmailThreadId: threadId }, { replyCheckedAt: new Date() });
  }
  return found;
}

async function checkThread(threadId: string): Promise<number> {
  const [thread, ours] = await Promise.all([
    getThread(threadId),
    MessageModel.find({ gmailThreadId: threadId, kind: 'email' }).sort({ sentAt: 1 }).lean<Message[]>(),
  ]);
  if (!ours.length) return 0;
  const known = new Set(ours.flatMap((m) => m.replyIds ?? []));
  let found = 0;

  for (const msg of thread) {
    if (msg.sentByMe || known.has(msg.id)) continue;
    // Attach the reply to the latest email of ours sent before it.
    const target = [...ours].reverse().find((m) => m.sentAt <= msg.at) ?? ours[0];
    await EventModel.create({
      messageId: target._id,
      type: 'reply',
      at: msg.at,
      from: msg.from,
      source: 'gmail',
      signal: 'real',
    });
    await MessageModel.updateOne({ _id: target._id }, { $addToSet: { replyIds: msg.id } });
    await recomputeStats(target._id);
    await advance(target.applicationId, 'replied', msg.at);
    found++;
    void notifyReply(target, msg.from);
  }
  return found;
}

async function notifyReply(m: Message, from: string): Promise<void> {
  try {
    const app = m.applicationId ? await ApplicationModel.findById(m.applicationId).select('company').lean() : null;
    const who = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from;
    const subject = `${who} replied${app ? ` (${app.company})` : ''}`;
    const { html, text } = renderBody(`**${who}** replied to **${m.subject}**.\n\n${env.PUBLIC_URL}/app/#/m/${m._id}`);
    await sendGmail({ to: [{ email: env.ALLOWED_EMAIL }], cc: [], subject, html, text });
  } catch (err) {
    logger.warn({ err }, 'reply notification failed');
  }
}

let running = { schedule: false, replies: false };

export function startJobs(): void {
  const tick = (key: keyof typeof running, fn: () => Promise<unknown>) => async () => {
    if (running[key]) return;
    running = { ...running, [key]: true };
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: key }, 'background job failed');
    } finally {
      running = { ...running, [key]: false };
    }
  };
  setInterval(tick('schedule', sendDueScheduled), SCHEDULE_EVERY_MS).unref();
  setInterval(tick('replies', () => checkReplies()), REPLIES_EVERY_MS).unref();
  setTimeout(tick('replies', () => checkReplies()), 20_000).unref();
}
