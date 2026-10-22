import { env } from './env.js';
import { AccountModel, ApplicationModel, EventModel, MessageModel, SettingModel, TemplateModel, type Application, type Message } from './models.js';
import { addBusinessDays, furthestRank, isOpenStage, stageRank, SOURCES } from '../shared/stages.js';

const DAY = 86_400_000;
// After two follow-ups, suggest "Ghosted" once it's been this quiet.
const GHOST_AFTER_DAYS = 14;
const MAX_FOLLOW_UPS = 2;

type Lean<T> = T & { _id: { toString(): string } };

const sentOnly = { kind: 'email', status: { $in: ['sent', null] } };

function summary(m: Lean<Message>) {
  return {
    _id: String(m._id),
    subject: m.subject,
    to: m.to,
    label: m.label,
    sentAt: m.sentAt,
    stats: m.stats,
    applicationId: m.applicationId ? String(m.applicationId) : undefined,
  };
}

function appSummary(a: Lean<Application>) {
  return {
    _id: String(a._id),
    company: a.company,
    role: a.role,
    stage: a.stage,
    priority: a.priority,
    interviewAt: a.interviewAt,
  };
}

export async function today() {
  const now = Date.now();
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).select('weeklyGoal followUpDays').lean();
  const followUpDays = account?.followUpDays ?? 4;

  const apps = await ApplicationModel.find({ archived: false }).lean<Lean<Application>[]>();
  const appById = new Map(apps.map((a) => [String(a._id), a]));
  const emails = await MessageModel.find({ ...sentOnly, applicationId: { $in: apps.map((a) => a._id) } })
    .select('-html -text -body')
    .sort({ sentAt: 1 })
    .lean<Lean<Message>[]>();
  const byApp = new Map<string, Lean<Message>[]>();
  for (const m of emails) {
    const key = String(m.applicationId);
    byApp.set(key, [...(byApp.get(key) ?? []), m]);
  }

  const followUps: unknown[] = [];
  const ghosted: unknown[] = [];
  for (const app of apps) {
    if (app.stage !== 'reached_out' && app.stage !== 'applied') continue;
    if (app.snoozedUntil && app.snoozedUntil.getTime() > now) continue;
    const thread = byApp.get(String(app._id)) ?? [];
    const last = thread.at(-1);
    if (!last || thread.some((m) => (m.stats?.replies ?? 0) > 0)) continue;
    // Automatic follow-ups are already on it.
    if (thread.some((m) => m.sequence?.status === 'active')) continue;
    const sent = thread.filter((m) => m.followUpOf).length;
    const daysSince = Math.floor((now - new Date(last.sentAt).getTime()) / DAY);
    if (sent >= MAX_FOLLOW_UPS) {
      if (daysSince >= GHOST_AFTER_DAYS) ghosted.push({ application: appSummary(app), daysSince });
      continue;
    }
    // First nudge after followUpDays working days, the second after twice that.
    const dueAt = addBusinessDays(new Date(last.sentAt), followUpDays * (sent + 1));
    if (dueAt.getTime() <= now) {
      followUps.push({ application: appSummary(app), message: summary(last), followUpNumber: sent + 1, daysSince });
    }
  }

  // Opens and clicks in the last 48h on emails/links nobody has replied to.
  const recent = await EventModel.find({ type: { $in: ['open', 'click'] }, signal: 'real', at: { $gte: new Date(now - 2 * DAY) } })
    .sort({ at: -1 })
    .lean();
  const hotIds = [...new Set(recent.map((e) => String(e.messageId)))];
  const hotMessages = await MessageModel.find({ _id: { $in: hotIds } })
    .select('-html -text -body')
    .lean<Lean<Message>[]>();
  const hot = hotMessages
    .filter((m) => !(m.stats?.replies ?? 0))
    .map((m) => {
      const evs = recent.filter((e) => String(e.messageId) === String(m._id));
      const clickedLabels = [
        ...new Set(evs.filter((e) => e.type === 'click').map((e) => m.links.find((l) => l.token === e.linkToken)?.label ?? 'a link')),
      ];
      const app = m.applicationId ? appById.get(String(m.applicationId)) : undefined;
      return {
        message: { ...summary(m), kind: m.kind },
        application: app ? appSummary(app) : undefined,
        opens: evs.filter((e) => e.type === 'open').length,
        clicks: evs.filter((e) => e.type === 'click').length,
        clickedLabels,
        lastAt: evs[0]?.at,
      };
    })
    .sort((a, b) => new Date(b.lastAt!).getTime() - new Date(a.lastAt!).getTime())
    .slice(0, 8);

  const replyEvents = await EventModel.find({ type: 'reply', at: { $gte: new Date(now - 14 * DAY) } })
    .sort({ at: -1 })
    .limit(10)
    .lean();
  const replyMsgs = await MessageModel.find({ _id: { $in: replyEvents.map((e) => e.messageId) } })
    .select('subject applicationId label to sentAt stats')
    .lean<Lean<Message>[]>();
  const replies = replyEvents.map((e) => {
    const m = replyMsgs.find((x) => String(x._id) === String(e.messageId));
    const app = m?.applicationId ? appById.get(String(m.applicationId)) : undefined;
    return { at: e.at, from: e.from, message: m ? summary(m) : undefined, application: app ? appSummary(app) : undefined };
  });

  const scheduled = await MessageModel.find({ status: { $in: ['scheduled', 'failed'] } })
    .select('subject to label scheduledAt status sendError applicationId')
    .sort({ scheduledAt: 1 })
    .lean();

  const interviews = apps
    .filter((a) => a.interviewAt && a.interviewAt.getTime() > now - DAY && a.interviewAt.getTime() < now + 14 * DAY)
    .sort((a, b) => a.interviewAt!.getTime() - b.interviewAt!.getTime())
    .map(appSummary);

  // Gemini's proposed stage changes (from a reply or the calendar).
  const suggestions = apps
    .filter((a) => a.suggestion?.stage && a.suggestion.stage !== a.stage && isOpenStage(a.stage))
    .map((a) => ({ application: appSummary(a), stage: a.suggestion!.stage, reason: a.suggestion!.reason, at: a.suggestion!.at }));

  // Interviews that ended 1h–3 days ago without a thank-you.
  const thankYous: { application: ReturnType<typeof appSummary>; key: string; title: string; end: Date }[] = [];
  for (const a of apps) {
    const done = new Set(a.thankYous ?? []);
    const recent = (end?: Date | null) => !!end && end.getTime() < now - 3_600_000 && end.getTime() > now - 3 * DAY;
    for (const i of a.interviews ?? []) {
      if (i.eventId && recent(i.end) && !i.thankYouDone && !done.has(i.eventId)) {
        thankYous.push({ application: appSummary(a), key: i.eventId, title: i.title ?? 'Interview', end: i.end! });
      }
    }
    if (!a.interviews?.length && a.interviewAt) {
      const key = `manual:${a.interviewAt.toISOString()}`;
      const end = new Date(a.interviewAt.getTime() + 3_600_000);
      if (recent(end) && !done.has(key)) thankYous.push({ application: appSummary(a), key, title: `Interview with ${a.company}`, end });
    }
  }

  // Automatic follow-ups going out in the next two days (to review or edit).
  const autoSoon = await MessageModel.find({ 'sequence.status': 'active' }).select('subject to label applicationId sequence').lean<Lean<Message>[]>();
  const upcomingAuto = autoSoon
    .flatMap((m) => {
      const steps = m.sequence?.steps ?? [];
      const i = steps.findIndex((s) => s.status === 'pending');
      if (i === -1) return [];
      const step = steps[i];
      if (new Date(step.dueAt).getTime() > now + 2 * DAY) return [];
      const app = m.applicationId ? appById.get(String(m.applicationId)) : undefined;
      return [{ message: summary(m), application: app ? appSummary(app) : undefined, step: i + 1, dueAt: step.dueAt, drafted: !!step.body }];
    })
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  const stageCounts: Record<string, number> = {};
  for (const a of apps) stageCounts[a.stage] = (stageCounts[a.stage] ?? 0) + 1;

  const allStarted = await ApplicationModel.find({ startedAt: { $gte: new Date(now - 120 * DAY) } })
    .select('startedAt')
    .lean();

  return {
    goal: account?.weeklyGoal ?? 20,
    suggestions,
    thankYous,
    upcomingAuto,
    followUps,
    ghosted,
    hot,
    replies,
    scheduled,
    interviews,
    stageCounts,
    started: allStarted.map((a) => a.startedAt),
    active: apps.filter((a) => isOpenStage(a.stage)).length,
  };
}

export async function insights() {
  const apps = await ApplicationModel.find({}).lean<Lean<Application>[]>();
  const started = apps.filter((a) => a.startedAt || furthestRank(a.stageHistory, a.stage) >= stageRank('applied'));
  const reach = (min: string) => started.filter((a) => furthestRank(a.stageHistory, a.stage) >= stageRank(min)).length;

  const funnel = [
    { stage: 'applied', label: 'Applied or reached out', count: started.length },
    { stage: 'replied', label: 'Got a reply', count: reach('replied') },
    { stage: 'screening', label: 'Screening', count: reach('screening') },
    { stage: 'interviewing', label: 'Interviewing', count: reach('interviewing') },
    { stage: 'offer', label: 'Offer', count: reach('offer') },
  ];

  const bySource = SOURCES.map((source) => {
    const group = started.filter((a) => a.source === source);
    return {
      source,
      started: group.length,
      replied: group.filter((a) => furthestRank(a.stageHistory, a.stage) >= stageRank('replied')).length,
      interviewing: group.filter((a) => furthestRank(a.stageHistory, a.stage) >= stageRank('interviewing')).length,
    };
  }).filter((s) => s.started > 0);

  const emails = await MessageModel.find(sentOnly).select('sentAt stats followUpOf templateId subject links automatic gmailThreadId').lean<Lean<Message>[]>();
  const firsts = emails.filter((m) => !m.followUpOf);
  const replyDays = firsts
    .filter((m) => m.stats?.firstReplyAt)
    .map((m) => (new Date(m.stats!.firstReplyAt!).getTime() - new Date(m.sentAt).getTime()) / DAY);

  const engagement = await EventModel.find({
    type: { $in: ['open', 'click', 'reply'] },
    signal: 'real',
    at: { $gte: new Date(Date.now() - 120 * DAY) },
  })
    .select('type at')
    .lean();

  // A thread counts as replied if any email in it got a reply.
  const repliedThreads = new Set(emails.filter((m) => (m.stats?.replies ?? 0) > 0).map((m) => m.gmailThreadId ?? String(m._id)));
  const threadReplied = (m: Lean<Message>) => repliedThreads.has(m.gmailThreadId ?? String(m._id));
  const rate = (group: Lean<Message>[]) => ({ sent: group.length, replied: group.filter(threadReplied).length, clicked: group.filter((m) => (m.stats?.clicks ?? 0) > 0).length });

  const templates = await TemplateModel.find().select('name').lean();
  const byTemplate = templates
    .map((t) => ({ name: t.name, ...rate(firsts.filter((m) => String(m.templateId) === String(t._id))) }))
    .filter((t) => t.sent > 0)
    .sort((a, b) => b.replied / b.sent - a.replied / a.sent);

  // Saved links (resume versions, portfolio…): how emails containing each one did.
  const saved = ((await SettingModel.findOne({ key: 'savedLinks' }).lean())?.value ?? []) as { label: string; url: string }[];
  const byLink = saved
    .map((l) => {
      const group = firsts.filter((m) => m.links.some((x) => x.url === l.url));
      return { label: l.label, ...rate(group), linkClicks: group.reduce((n, m) => n + m.links.filter((x) => x.url === l.url).reduce((c, x) => c + (x.clicks ?? 0), 0), 0) };
    })
    .filter((l) => l.sent > 0);

  // Subjects used for at least two first emails.
  const bySubjectMap = new Map<string, Lean<Message>[]>();
  for (const m of firsts) bySubjectMap.set(m.subject, [...(bySubjectMap.get(m.subject) ?? []), m]);
  const bySubject = [...bySubjectMap.entries()]
    .filter(([, g]) => g.length >= 2)
    .map(([subject, g]) => ({ subject, ...rate(g) }))
    .sort((a, b) => b.replied / b.sent - a.replied / a.sent)
    .slice(0, 6);

  // Replies that came after an automatic follow-up (the follow-up got the reply).
  const autoReplies = emails.filter((m) => m.automatic && (m.stats?.replies ?? 0) > 0).length;

  return {
    funnel,
    bySource,
    byTemplate,
    byLink,
    bySubject,
    sequences: { sent: emails.filter((m) => m.automatic).length, replies: autoReplies },
    emails: {
      sent: emails.length,
      opened: emails.filter((m) => (m.stats?.opens ?? 0) > 0).length,
      clicked: emails.filter((m) => (m.stats?.clicks ?? 0) > 0).length,
      replied: emails.filter((m) => (m.stats?.replies ?? 0) > 0).length,
      followUps: emails.length - firsts.length,
      avgReplyDays: replyDays.length ? replyDays.reduce((a, b) => a + b, 0) / replyDays.length : null,
    },
    engagement: engagement.map((e) => ({ type: e.type, at: e.at })),
    started: started.map((a) => a.startedAt).filter(Boolean),
    closed: {
      rejected: apps.filter((a) => a.stage === 'rejected').length,
      ghosted: apps.filter((a) => a.stage === 'ghosted').length,
      withdrawn: apps.filter((a) => a.stage === 'withdrawn').length,
      accepted: apps.filter((a) => a.stage === 'accepted').length,
    },
  };
}
