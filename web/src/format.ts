import type { Message, TrackEvent } from './api';

export function ago(iso?: string | null): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return inFuture(iso);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function inFuture(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return 'in a moment';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// Monday 00:00 local time of the week containing `d`.
export function weekStart(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// Consecutive days (ending today, or yesterday if nothing yet today) with at least one start.
export function streak(dates: string[]): number {
  const days = new Set(dates.map((d) => new Date(d).toDateString()));
  const cur = new Date();
  if (!days.has(cur.toDateString())) cur.setDate(cur.getDate() - 1);
  let n = 0;
  while (days.has(cur.toDateString())) {
    n++;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

export type Status = 'replied' | 'clicked' | 'opened' | 'auto' | 'sent' | 'waiting' | 'scheduled' | 'failed';

export function statusOf(m: Message): Status {
  if (m.status === 'scheduled' || m.status === 'sending') return 'scheduled';
  if (m.status === 'failed') return 'failed';
  if ((m.stats.replies ?? 0) > 0) return 'replied';
  if (m.stats.clicks > 0) return 'clicked';
  if (m.stats.opens > 0) return 'opened';
  if (m.stats.autoOpens > 0) return 'auto';
  return m.kind === 'link' ? 'waiting' : 'sent';
}

export const STATUS_LABEL: Record<Status, string> = {
  replied: 'Replied',
  scheduled: 'Scheduled',
  failed: 'Failed',
  clicked: 'Clicked',
  opened: 'Opened',
  auto: 'Auto-opened',
  sent: 'Sent',
  waiting: 'No clicks',
};

export function recipients(m: Message): string {
  if (m.kind === 'link') return m.label || 'Tracked link';
  return m.to.map((r) => r.name || r.email).join(', ');
}

export function place(e: TrackEvent): string {
  return [e.city, e.region, e.country].filter(Boolean).join(', ');
}

export const SOURCE_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  apple: 'Apple Mail proxy',
  yahoo: 'Yahoo Mail',
  outlook: 'Outlook',
  browser: 'Browser',
  unknown: 'Unknown client',
};

export const SIGNAL_LABEL = {
  real: 'Counted',
  self: 'You',
  auto: 'Auto-fetch',
  bot: 'Bot / scanner',
} as const;

// "Name <a@b.c>, d@e.f" → recipients. Returns the bad chunks too.
export function parseAddresses(input: string): { ok: { email: string; name?: string }[]; bad: string[] } {
  const ok: { email: string; name?: string }[] = [];
  const bad: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(.*)<([^>]+)>$/);
    const email = (m ? m[2] : part).trim();
    const name = m ? m[1].trim().replace(/^"|"$/g, '') : undefined;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ok.push(name ? { email, name } : { email });
    else bad.push(part);
  }
  return { ok, bad };
}
