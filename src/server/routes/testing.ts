// Test mode only (mounted when NODE_ENV=test): run the background jobs on
// demand, optionally pretending it's a later time.
import { Router } from 'express';
import { asSystem } from '../context.js';
import { runJobs, type JobName } from '../jobs.js';
import { h } from './api.js';
import { requireSession } from './auth.js';

export const testingRouter = Router();
testingRouter.use(requireSession);

testingRouter.post(
  '/jobs',
  h(async (req, res) => {
    const now = req.body?.now ? new Date(req.body.now) : new Date();
    const only: JobName[] = req.body?.only ?? ['scheduled', 'sequences', 'replies', 'calendar', 'digest'];
    // Like the real scheduler: every user, each as themselves.
    const out = await asSystem(() => runJobs(only, now));
    res.json(out);
  }),
);
