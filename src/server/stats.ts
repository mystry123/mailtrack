import type { Types } from 'mongoose';
import { EventModel, MessageModel } from './models.js';

// Recomputes a message's counters from its events. Cheap (a message has a
// handful of events) and keeps manual "that was me" overrides consistent.
export async function recomputeStats(messageId: Types.ObjectId): Promise<void> {
  const events = await EventModel.find({ messageId }).sort({ at: 1 }).lean();
  const real = events.filter((e) => e.signal === 'real');
  const opens = real.filter((e) => e.type === 'open');
  const clicks = real.filter((e) => e.type === 'click');
  const replies = real.filter((e) => e.type === 'reply');

  const clicksByLink = new Map<string, number>();
  for (const c of clicks) if (c.linkToken) clicksByLink.set(c.linkToken, (clicksByLink.get(c.linkToken) ?? 0) + 1);

  const message = await MessageModel.findById(messageId).select('links').lean();
  if (!message) return;

  // Plain $set, not doc.save(): simultaneous hits would trip Mongoose's array
  // versioning. A stale write self-heals on the next recompute.
  const stats = {
    opens: opens.length,
    clicks: clicks.length,
    autoOpens: events.filter((e) => e.type === 'open' && e.signal === 'auto').length,
    botClicks: events.filter((e) => e.type === 'click' && e.signal === 'bot').length,
    firstOpenAt: opens[0]?.at,
    lastOpenAt: opens.at(-1)?.at,
    firstClickAt: clicks[0]?.at,
    lastClickAt: clicks.at(-1)?.at,
    replies: replies.length,
    firstReplyAt: replies[0]?.at,
    lastActivityAt: real.at(-1)?.at,
  };
  const links = message.links.map((l) => ({ ...l, clicks: clicksByLink.get(l.token) ?? 0 }));
  await MessageModel.updateOne({ _id: messageId }, { $set: { stats, links } });
}
