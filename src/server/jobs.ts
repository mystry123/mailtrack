import { mayUse } from './access.js';
import { readReply } from './ai.js';
import { syncCalendar } from './calendar.js';
import { assertUnderCap, createEmail, DailyCapReached, deliver } from './delivery.js';
import { digestDue, sendDigest } from './digest.js';
import { env } from './env.js';
import { getMessageText, getThread, hasScope, METADATA_SCOPE, myEmail, READ_SCOPE, ReauthRequired, sendGmail } from './google.js';
import { logger } from './logger.js';
import { AccountModel, ApplicationModel, EventModel, MessageModel, type Message } from './models.js';
import { advance } from './pipeline.js';
import { tickSequences, type SendStep } from './sequences.js';
import { recomputeStats } from './stats.js';
import { renderBody } from '../shared/render.js';
import { isOpenStage, stageRank } from '../shared/stages.js';
import { asSystem, currentUserId, withUser } from './context.js';

const SCHEDULE_EVERY_MS = 30_000;
const REPLIES_EVERY_MS = 10 * 60_000;
const CALENDAR_EVERY_MS = 30 * 60_000;
const DIGEST_EVERY_MS = 30 * 60_000;
// Threads older than this aren't checked for replies any more.
const REPLY_WINDOW_DAYS = 60;

// Scheduled emails whose time has come. findOneAndUpdate claims each one, so
// a slow send is never picked up twice.
export async function sendDueScheduled(): Promise<number> {
  // A send interrupted by a restart can't be retried blindly (it may have gone out).
  await MessageModel.updateMany(
    { status: 'sending', updatedAt: { $lt: new Date(Date.now() - 10 * 60_000) } },
    { status: 'failed', sendError: 'Interrupted while sending. Check Gmail Sent before sending again.' },
  );
  let sent = 0;
  for (;;) {
    const message = await MessageModel.findOneAndUpdate(
      { status: 'scheduled', scheduledAt: { $lte: new Date() } },
      { status: 'sending' },
      { new: true },
    );
    if (!message) return sent;
    try {
      await assertUnderCap(1);
      await deliver(message);
      sent++;
      logger.info({ id: String(message._id) }, 'scheduled email sent');
    } catch (err) {
      if (err instanceof DailyCapReached) {
        // Try again in an hour; it stays scheduled.
        await MessageModel.updateOne(
          { _id: message._id },
          { status: 'scheduled', scheduledAt: new Date(Date.now() + 60 * 60_000), sendError: err.message },
        );
        return sent;
      }
      const reason = err instanceof ReauthRequired ? 'Google access expired: reconnect in Settings, then reschedule.' : 'Gmail rejected it.';
      await MessageModel.updateOne({ _id: message._id }, { status: 'failed', sendError: reason });
      logger.error({ err, id: String(message._id) }, 'scheduled send failed');
      if (err instanceof ReauthRequired) return sent;
    }
  }
}

// Sends one automatic follow-up as a reply in the thread.
export const sendSequenceStep: SendStep = async (root, step, followUpOf) => {
  await assertUnderCap();
  const message = await createEmail({
    to: root.to.map((r) => ({ email: r.email!, name: r.name ?? undefined })),
    cc: root.cc.map((r) => ({ email: r.email!, name: r.name ?? undefined })),
    subject: step.subject || (/^re:/i.test(root.subject) ? root.subject : `Re: ${root.subject}`),
    body: step.body,
    label: root.label,
    includeSignature: root.includeSignature ?? false,
    applicationId: root.applicationId ?? undefined,
    followUpOf,
    trackOpens: root.trackOpens ?? true,
    automatic: true,
  });
  try {
    await deliver(message);
  } catch (err) {
    await MessageModel.deleteOne({ _id: message._id });
    throw err;
  }
  return message._id;
};

// Reads headers of the threads you sent from here; any message in them not
// from you is a reply. Needs the gmail.metadata permission; with read access
// Gemini also summarises the reply and suggests the next stage.
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
  const canRead = await hasScope(READ_SCOPE);
  let found = 0;
  for (const threadId of threads) {
    try {
      found += await checkThread(threadId, canRead);
    } catch (err) {
      if (err instanceof ReauthRequired) return found;
      logger.warn({ err, threadId }, 'reply check failed for thread');
    }
    await MessageModel.updateMany({ gmailThreadId: threadId }, { replyCheckedAt: new Date() });
  }
  return found;
}

async function checkThread(threadId: string, canRead: boolean): Promise<number> {
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
    const event = await EventModel.create({
      messageId: target._id,
      type: 'reply',
      at: msg.at,
      from: msg.from,
      gmailId: msg.id,
      source: 'gmail',
      signal: 'real',
    });
    await MessageModel.updateOne({ _id: target._id }, { $addToSet: { replyIds: msg.id } });
    await recomputeStats(target._id);
    await advance(target.applicationId, 'replied', msg.at);
    // Stop automatic follow-ups in this thread right away.
    await MessageModel.updateMany(
      { gmailThreadId: threadId, 'sequence.status': 'active' },
      { $set: { 'sequence.status': 'stopped', 'sequence.stopReason': 'They replied', 'sequence.steps.$[p].status': 'cancelled' } },
      { arrayFilters: [{ 'p.status': 'pending' }] },
    );
    found++;

    let summary = '';
    if (canRead) {
      try {
        const app = target.applicationId ? await ApplicationModel.findById(target.applicationId).select('company role stage') : null;
        const text = await getMessageText(msg.id);
        if (text) {
          const r = await readReply({ text, subject: target.subject, company: app?.company, role: app?.role });
          summary = r.summary;
          await EventModel.updateOne({ _id: event._id }, { summary: r.summary, suggestedStage: r.suggestedStage });
          const closing = r.suggestedStage === 'rejected';
          if (app && isOpenStage(app.stage) && (closing || stageRank(r.suggestedStage) > stageRank(app.stage))) {
            app.suggestion = { stage: r.suggestedStage, reason: r.summary, at: new Date() };
            await app.save();
          }
        }
      } catch (err) {
        logger.warn({ err }, 'reply summary failed');
      }
    }
    void notifyReply(target, msg.from, summary);
  }
  return found;
}

async function notifyReply(m: Message, from: string, summary: string): Promise<void> {
  try {
    const app = m.applicationId ? await ApplicationModel.findById(m.applicationId).select('company').lean() : null;
    const who = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from;
    const subject = `${who} replied${app ? ` (${app.company})` : ''}`;
    const { html, text } = renderBody(
      `**${who}** replied to **${m.subject}**.${summary ? `\n\n“${summary}”` : ''}\n\n${env.PUBLIC_URL}/app/#/m/${m._id}`,
    );
    await sendGmail({ to: [{ email: await myEmail() }], cc: [], subject, html, text });
  } catch (err) {
    logger.warn({ err }, 'reply notification failed');
  }
}

export async function maybeSendDigest(now = new Date()): Promise<boolean> {
  const account = await AccountModel.findById(currentUserId()).select('weeklyDigest timezone lastDigestAt').lean();
  if (!account?.weeklyDigest || !digestDue(now, account.timezone || 'Asia/Kolkata', account.lastDigestAt)) return false;
  await sendDigest(now);
  return true;
}

// Runs a job once for each person, as that person (their Gmail, their data).
export async function forEachUser<T>(fn: () => Promise<T>): Promise<T[]> {
  const accounts = await AccountModel.find({ needsReauth: { $ne: true } }).select('_id email').lean();
  const out: T[] = [];
  for (const a of accounts) {
    if (!(await mayUse(a.email))) continue; // invite removed
    try {
      out.push(await withUser(a._id, fn));
    } catch (err) {
      logger.error({ err, user: a.email }, 'job failed for a user');
    }
  }
  return out;
}

export type JobName = 'scheduled' | 'sequences' | 'replies' | 'calendar' | 'digest';

// One pass of the background jobs for everyone (also used by test mode with a fake "now").
export async function runJobs(only: JobName[], now = new Date()): Promise<Record<string, unknown>> {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const out: Record<string, unknown> = {};
  if (only.includes('scheduled')) out.scheduled = sum(await forEachUser(() => sendDueScheduled()));
  if (only.includes('sequences')) {
    const r = await forEachUser(() => tickSequences(sendSequenceStep, now));
    out.sequences = { sent: sum(r.map((x) => x.sent)), stopped: sum(r.map((x) => x.stopped)) };
  }
  if (only.includes('replies')) out.replies = sum(await forEachUser(() => checkReplies(200)));
  if (only.includes('calendar')) out.calendar = sum(await forEachUser(() => syncCalendar(now)));
  if (only.includes('digest')) out.digest = (await forEachUser(() => maybeSendDigest(now))).some(Boolean);
  return out;
}

const running: Record<string, boolean> = {};

export function startJobs(): void {
  const tick = (key: string, fn: () => Promise<unknown>) => async () => {
    if (running[key]) return;
    running[key] = true;
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: key }, 'background job failed');
    } finally {
      running[key] = false;
    }
  };
  const schedule = tick('schedule', () => asSystem(() => runJobs(['scheduled', 'sequences'])));
  const replies = tick('replies', () => asSystem(() => runJobs(['replies'])));
  const calendar = tick('calendar', () => asSystem(() => runJobs(['calendar'])));
  const digest = tick('digest', () => asSystem(() => runJobs(['digest'])));
  setInterval(schedule, SCHEDULE_EVERY_MS).unref();
  setInterval(replies, REPLIES_EVERY_MS).unref();
  setInterval(calendar, CALENDAR_EVERY_MS).unref();
  setInterval(digest, DIGEST_EVERY_MS).unref();
  setTimeout(replies, 20_000).unref();
  setTimeout(calendar, 40_000).unref();
}
