// Finds interviews on your Google Calendar and attaches them to applications.

import { env } from './env.js';
import { CALENDAR_SCOPE, hasScope, listCalendarEvents, myEmail, type CalendarEvent } from './google.js';
import { AccountModel, ApplicationModel, ContactModel, MessageModel, type Application } from './models.js';
import { isOpenStage, stageRank } from '../shared/stages.js';
import { currentUserId } from './context.js';

const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'live.com']);
const INTERVIEW_WORDS = /\b(interview|screen(ing)?|call|chat|round|onsite|on-site|technical|coffee|intro|sync|meet)\b/i;
const HARD_INTERVIEW = /\b(interview|technical|onsite|on-site|round|system design|coding|take[- ]home)\b/i;

export interface Match {
  matchedBy: 'attendee' | 'name';
}

// Does this calendar event look like an interview with this company?
export function matchEvent(event: Pick<CalendarEvent, 'title' | 'description' | 'attendees'>, company: string, domains: string[]): Match | null {
  const doms = domains.filter((d) => d && !PUBLIC_DOMAINS.has(d));
  if (event.attendees.some((a) => doms.includes(a.split('@')[1] ?? ''))) return { matchedBy: 'attendee' };
  const name = company.trim();
  if (name.length < 3) return null;
  const rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const text = `${event.title}\n${event.description}`;
  if (rx.test(text) && INTERVIEW_WORDS.test(text)) return { matchedBy: 'name' };
  return null;
}

export function interviewStageFor(title: string): 'interviewing' | 'screening' {
  return HARD_INTERVIEW.test(title) ? 'interviewing' : 'screening';
}

type Lean<T> = T & { _id: { toString(): string } };

export async function syncCalendar(now = new Date()): Promise<number> {
  if (!(await hasScope(CALENDAR_SCOPE))) return 0;
  const events = await listCalendarEvents(new Date(now.getTime() - 3 * 86_400_000), new Date(now.getTime() + 21 * 86_400_000));
  const apps = await ApplicationModel.find({ archived: false }).lean<Lean<Application>[]>();
  const me = await myEmail();
  let matched = 0;

  for (const app of apps) {
    if (!isOpenStage(app.stage)) continue;
    const [msgs, contacts] = await Promise.all([
      MessageModel.find({ applicationId: app._id, kind: 'email' }).select('to cc').lean(),
      ContactModel.find({ applicationIds: app._id }).select('email').lean(),
    ]);
    const domains = [
      ...msgs.flatMap((m) => [...m.to, ...m.cc].map((r) => (r.email ?? '').toLowerCase().split('@')[1] ?? '')),
      ...contacts.map((c) => c.email.split('@')[1] ?? ''),
    ];
    const found = events
      .map((e) => ({ e, m: matchEvent(e, app.company, [...new Set(domains)]) }))
      .filter((x): x is { e: CalendarEvent; m: Match } => !!x.m);
    if (!found.length) continue;
    matched += found.length;

    const doc = await ApplicationModel.findById(app._id);
    if (!doc) continue;
    const prev = new Map(doc.interviews.map((i) => [i.eventId, i]));
    doc.set(
      'interviews',
      found.map(({ e, m }) => ({
        eventId: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        attendees: e.attendees.filter((a) => a !== me),
        matchedBy: m.matchedBy,
        thankYouDone: prev.get(e.id)?.thankYouDone ?? false,
      })),
    );
    const upcoming = found.map((f) => f.e).filter((e) => e.end.getTime() > now.getTime()).sort((a, b) => +a.start - +b.start)[0];
    if (upcoming) doc.interviewAt = upcoming.start;
    // Suggest (not force) the stage the calendar implies.
    const next = interviewStageFor(found[0].e.title);
    if (stageRank(doc.stage) < stageRank(next) && doc.suggestion?.stage !== next) {
      doc.suggestion = { stage: next, reason: `On your calendar: “${found[0].e.title}”`, at: now };
    }
    await doc.save();
  }
  await AccountModel.updateOne({ _id: currentUserId() }, { calendarSyncedAt: now });
  return matched;
}
