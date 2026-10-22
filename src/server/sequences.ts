// Automatic follow-ups. A first email can carry a sequence (e.g. 4 and 9
// working days later). Each step is drafted by Gemini right after the first
// email goes out (so you can read and edit it), and sent on its due date
// into the same Gmail thread, unless someone replied, the application moved
// on, or you stopped it.

import type { Types } from 'mongoose';
import { draftFollowUp } from './ai.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { AccountModel, ApplicationModel, MessageModel, type Message } from './models.js';
import { addBusinessDays, isOpenStage, stageRank } from '../shared/stages.js';
import { currentUserId } from './context.js';

export interface StepInput {
  afterDays: number;
  dueAt: Date;
  status: 'pending';
}

export function buildSteps(sentAt: Date, days: number[]): StepInput[] {
  return [...new Set(days)]
    .filter((d) => d > 0 && d <= 60)
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((afterDays) => ({ afterDays, dueAt: addBusinessDays(sentAt, afterDays), status: 'pending' as const }));
}

// Why a sequence should stop now, if it should.
export function stopReason(input: {
  threadReplies: number;
  stage?: string;
  rootStatus?: string | null;
  archived?: boolean;
}): string | null {
  if (input.threadReplies > 0) return 'They replied';
  if (input.archived) return 'Email archived';
  if (input.rootStatus && input.rootStatus !== 'sent') return 'First email was not sent';
  if (input.stage && (!isOpenStage(input.stage) || stageRank(input.stage) >= stageRank('replied'))) return `Application moved to ${input.stage}`;
  return null;
}

function fallbackBody(n: number): string {
  return n === 1
    ? 'Hi,\n\nFollowing up on my note below in case it got buried. Happy to share more, or to jump on a quick call if that’s easier.\n\nThanks'
    : 'Hi,\n\nOne last note from me on this. If the timing isn’t right, no worries at all, and thanks for reading.\n\nBest';
}

// Drafts every step that has no text yet. Never overwrites one you edited.
export async function draftMissingSteps(rootId: Types.ObjectId | string): Promise<void> {
  const root = await MessageModel.findById(rootId);
  if (!root?.sequence || root.sequence.status !== 'active') return;
  const account = await AccountModel.findById(currentUserId()).select('aboutMe').lean();
  const app = root.applicationId ? await ApplicationModel.findById(root.applicationId).select('company role jobUrl jobDescription').lean() : null;

  for (const [i, step] of root.sequence.steps.entries()) {
    if (step.status !== 'pending' || step.body || step.edited) continue;
    let subject = /^re:/i.test(root.subject) ? root.subject : `Re: ${root.subject}`;
    let body = fallbackBody(i + 1);
    try {
      const d = await draftFollowUp({
        original: { subject: root.subject, body: root.body, sentAt: root.sentAt, to: root.to.map((r) => r.name || r.email).join(', ') },
        followUpNumber: i + 1,
        daysSince: step.afterDays,
        aboutMe: account?.aboutMe ?? '',
        job: app ? { company: app.company, role: app.role, jobUrl: app.jobUrl, jobDescription: app.jobDescription } : undefined,
      });
      if (d.body.trim()) body = d.body;
      if (d.subject.trim()) subject = /^re:/i.test(d.subject) ? d.subject : subject;
    } catch (err) {
      logger.warn({ err }, 'follow-up draft failed; using the plain fallback');
    }
    // Re-read: you may have edited it while Gemini was thinking.
    await MessageModel.updateOne(
      { _id: root._id, [`sequence.steps.${i}.edited`]: { $ne: true }, [`sequence.steps.${i}.status`]: 'pending' },
      { $set: { [`sequence.steps.${i}.subject`]: subject, [`sequence.steps.${i}.body`]: body, [`sequence.steps.${i}.draftedAt`]: new Date() } },
    );
  }
}

export interface SendStep {
  (root: Message, step: { subject: string; body: string }, followUpOf: Types.ObjectId): Promise<Types.ObjectId>;
}

// One pass over active sequences: stop finished ones, send due steps.
// `send` is injected (delivery imports this module).
export async function tickSequences(send: SendStep, now = new Date()): Promise<{ sent: number; stopped: number }> {
  const roots = await MessageModel.find({ 'sequence.status': 'active' }).lean<Message[]>();
  let sent = 0;
  let stopped = 0;
  for (const root of roots) {
    const thread = root.gmailThreadId
      ? await MessageModel.find({ gmailThreadId: root.gmailThreadId, kind: 'email' }).sort({ sentAt: 1 }).lean<Message[]>()
      : [root];
    const app = root.applicationId ? await ApplicationModel.findById(root.applicationId).select('stage').lean() : null;
    const reason = stopReason({
      threadReplies: thread.reduce((n, m) => n + (m.stats?.replies ?? 0), 0),
      stage: app?.stage,
      rootStatus: root.status,
      archived: root.archived,
    });
    if (reason) {
      await MessageModel.updateOne(
        { _id: root._id },
        {
          $set: { 'sequence.status': 'stopped', 'sequence.stopReason': reason, 'sequence.steps.$[p].status': 'cancelled' },
        },
        { arrayFilters: [{ 'p.status': 'pending' }] },
      );
      stopped++;
      continue;
    }

    const steps = root.sequence!.steps;
    const i = steps.findIndex((s) => s.status === 'pending');
    if (i === -1) {
      await MessageModel.updateOne({ _id: root._id }, { $set: { 'sequence.status': 'done' } });
      continue;
    }
    const step = steps[i];
    if (new Date(step.dueAt) > now) continue;
    if (!step.body) {
      await draftMissingSteps(root._id);
      continue; // send on the next tick, with the draft in place
    }
    // Claim the step so two ticks can't both send it.
    const claimed = await MessageModel.updateOne(
      { _id: root._id, [`sequence.steps.${i}.status`]: 'pending', 'sequence.status': 'active' },
      { $set: { [`sequence.steps.${i}.status`]: 'sent', [`sequence.steps.${i}.error`]: '' } },
    );
    if (!claimed.modifiedCount) continue;
    const last = thread.filter((m) => m.status === 'sent' || !m.status).at(-1) ?? root;
    try {
      const id = await send(root, { subject: step.subject, body: step.body }, last._id);
      await MessageModel.updateOne({ _id: root._id }, { $set: { [`sequence.steps.${i}.messageId`]: id } });
      sent++;
    } catch (err) {
      // Put it back so it's retried; say why on the step.
      await MessageModel.updateOne(
        { _id: root._id },
        { $set: { [`sequence.steps.${i}.status`]: 'pending', [`sequence.steps.${i}.error`]: (err as Error).message } },
      );
      logger.warn({ err, root: String(root._id) }, 'sequence step not sent');
    }
  }
  return { sent, stopped };
}
