// Monday-morning summary email: last week's numbers, what worked, what's next.

import { env } from './env.js';
import { myEmail, sendGmail } from './google.js';
import { AccountModel, ApplicationModel, EventModel, MessageModel, TemplateModel } from './models.js';
import { today } from './overview.js';
import { renderBody } from '../shared/render.js';
import { STAGE_LABEL, type Stage } from '../shared/stages.js';
import { currentUserId } from './context.js';

const DAY = 86_400_000;

// Weekday (0 = Sunday) and hour in a time zone.
export function localParts(d: Date, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) };
}

// Due: it's Monday 9:00 or later where you are, and none went out in the last 5 days.
export function digestDue(now: Date, timeZone: string, lastDigestAt?: Date | null): boolean {
  const { weekday, hour } = localParts(now, timeZone);
  if (weekday !== 1 || hour < 9) return false;
  return !lastDigestAt || now.getTime() - lastDigestAt.getTime() > 5 * DAY;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');

export async function buildDigest(now = new Date()): Promise<{ subject: string; markdown: string }> {
  const since = new Date(now.getTime() - 7 * DAY);
  const [emails, events, moved, account, t] = await Promise.all([
    MessageModel.find({ kind: 'email', status: { $in: ['sent', null] }, sentAt: { $gte: since } }).select('stats subject templateId followUpOf automatic').lean(),
    EventModel.find({ signal: 'real', at: { $gte: since } }).select('type').lean(),
    ApplicationModel.find({ 'stageHistory.at': { $gte: since } }).select('company stage stageHistory').lean(),
    AccountModel.findById(currentUserId()).select('weeklyGoal followUpDays').lean(),
    today(),
  ]);
  const firsts = emails.filter((m) => !m.followUpOf);
  const replies = events.filter((e) => e.type === 'reply').length;
  const started = t.started.filter((s) => s && new Date(s).getTime() >= since.getTime()).length;
  const goal = account?.weeklyGoal ?? 20;

  // Best template by replies among this week's first emails.
  const byTemplate = new Map<string, { sent: number; replied: number }>();
  for (const m of firsts) {
    if (!m.templateId) continue;
    const k = String(m.templateId);
    const v = byTemplate.get(k) ?? { sent: 0, replied: 0 };
    v.sent++;
    if ((m.stats?.replies ?? 0) > 0) v.replied++;
    byTemplate.set(k, v);
  }
  const bestId = [...byTemplate.entries()].sort((a, b) => b[1].replied / b[1].sent - a[1].replied / a[1].sent)[0];
  const best = bestId ? await TemplateModel.findById(bestId[0]).select('name').lean() : null;

  const stageLines = moved
    .map((a) => {
      const recent = a.stageHistory.filter((h) => h.at && new Date(h.at).getTime() >= since.getTime()).at(-1);
      return recent ? `- **${a.company}** → ${STAGE_LABEL[recent.stage as Stage] ?? recent.stage}` : '';
    })
    .filter(Boolean)
    .slice(0, 10);

  const md = [
    `**Last week:** ${started} of ${goal} applications started · ${emails.length} emails sent (${emails.filter((m) => m.automatic).length} automatic follow-ups)`,
    `**How they did:** ${pct(firsts.filter((m) => (m.stats?.opens ?? 0) > 0).length, firsts.length)} opened · ${pct(firsts.filter((m) => (m.stats?.clicks ?? 0) > 0).length, firsts.length)} clicked · ${replies} repl${replies === 1 ? 'y' : 'ies'}`,
    best && bestId ? `**Best template:** “${best.name}”, ${bestId[1].replied} of ${bestId[1].sent} replied` : '',
    stageLines.length ? `**Moved this week**\n${stageLines.join('\n')}` : '',
    `**This week**`,
    [
      `- ${t.followUps.length} follow-up${t.followUps.length === 1 ? '' : 's'} due`,
      t.interviews.length ? `- ${t.interviews.length} interview${t.interviews.length === 1 ? '' : 's'} coming up: ${t.interviews.map((i) => i.company).join(', ')}` : '',
      t.hot.length ? `- ${t.hot.length} warm lead${t.hot.length === 1 ? '' : 's'} (opened or clicked, no reply yet)` : '',
      `- Goal: ${goal} new applications`,
    ]
      .filter(Boolean)
      .join('\n'),
    `${env.PUBLIC_URL}/app/`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { subject: `Your job search this week: ${replies} repl${replies === 1 ? 'y' : 'ies'}, ${started}/${goal} started`, markdown: md };
}

export async function sendDigest(now = new Date()): Promise<{ subject: string; markdown: string }> {
  const d = await buildDigest(now);
  const { html, text } = renderBody(d.markdown);
  await sendGmail({ to: [{ email: await myEmail() }], cc: [], subject: d.subject, html, text });
  await AccountModel.updateOne({ _id: currentUserId() }, { lastDigestAt: now });
  return d;
}
