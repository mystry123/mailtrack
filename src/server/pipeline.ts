import type { Types } from 'mongoose';
import { ApplicationModel } from './models.js';
import { isOpenStage, stageRank, STARTED_STAGES, type Stage } from '../shared/stages.js';

// Moves an application forward automatically (an email went out, a reply came
// in). Never moves it backwards, and leaves closed ones (rejected, ghosted...) alone.
export async function advance(applicationId: Types.ObjectId | null | undefined, stage: Stage, at = new Date()): Promise<void> {
  if (!applicationId) return;
  const app = await ApplicationModel.findById(applicationId);
  if (!app) return;
  if (isOpenStage(app.stage) && stageRank(app.stage) < stageRank(stage)) {
    app.stage = stage;
    app.stageHistory.push({ stage, at });
    if (!app.startedAt && STARTED_STAGES.includes(stage)) app.startedAt = at;
    // Replied counts as started too (they wrote back to something you sent).
    if (!app.startedAt && stageRank(stage) >= stageRank('reached_out')) app.startedAt = at;
  }
  await app.save();
}

// A stage you picked by hand: any direction.
export function applyManualStage(app: InstanceType<typeof ApplicationModel>, stage: Stage, at = new Date()): void {
  if (app.stage === stage) return;
  app.stage = stage;
  app.stageHistory.push({ stage, at });
  if (!app.startedAt && (STARTED_STAGES.includes(stage) || (isOpenStage(stage) && stageRank(stage) > stageRank('reached_out')))) {
    app.startedAt = at;
  }
}

export function createApplication(data: Record<string, unknown>, stage: Stage = 'wishlist', at = new Date()) {
  const app = new ApplicationModel({ ...data, stage, stageHistory: [{ stage, at }] });
  if (STARTED_STAGES.includes(stage) || (isOpenStage(stage) && stageRank(stage) > stageRank('reached_out'))) app.startedAt = at;
  return app;
}
