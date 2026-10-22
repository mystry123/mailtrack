// Test mode only (mounted when NODE_ENV=test): run the background jobs on
// demand, optionally pretending it's a later time.
import { Router } from 'express';
import { syncCalendar } from '../calendar.js';
import { checkReplies, maybeSendDigest, sendDueScheduled, sendSequenceStep } from '../jobs.js';
import { tickSequences } from '../sequences.js';
import { h } from './api.js';
import { requireSession } from './auth.js';

export const testingRouter = Router();
testingRouter.use(requireSession);

testingRouter.post(
  '/jobs',
  h(async (req, res) => {
    const now = req.body?.now ? new Date(req.body.now) : new Date();
    const only: string[] = req.body?.only ?? ['scheduled', 'sequences', 'replies', 'calendar', 'digest'];
    const out: Record<string, unknown> = {};
    if (only.includes('scheduled')) out.scheduled = await sendDueScheduled();
    if (only.includes('sequences')) out.sequences = await tickSequences(sendSequenceStep, now);
    if (only.includes('replies')) out.replies = await checkReplies(200);
    if (only.includes('calendar')) out.calendar = await syncCalendar(now);
    if (only.includes('digest')) out.digest = await maybeSendDigest(now);
    res.json(out);
  }),
);
