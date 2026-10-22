// "9:30 tomorrow in New York" → a UTC instant, without a timezone library.

export const ZONES: { id: string; label: string }[] = [
  { id: '', label: 'My time' },
  { id: 'Asia/Kolkata', label: 'India (IST)' },
  { id: 'America/Los_Angeles', label: 'US Pacific' },
  { id: 'America/New_York', label: 'US Eastern' },
  { id: 'Europe/London', label: 'UK' },
  { id: 'Europe/Berlin', label: 'Central Europe' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Dubai', label: 'Dubai' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

// Offset (ms) of `tz` from UTC at instant `t`.
function offsetAt(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

// `local` is "YYYY-MM-DDTHH:mm" as typed in a datetime-local input.
export function wallTimeToDate(local: string, tz: string): Date {
  if (!tz) return new Date(local);
  const [d, t] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  let utc = guess - offsetAt(guess, tz);
  utc = guess - offsetAt(utc, tz); // second pass settles DST edges
  return new Date(utc);
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Wall-clock presets (interpreted in the chosen zone).
export function presets(now = new Date()): { label: string; value: string }[] {
  const at = (days: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return fmt(d);
  };
  const dow = now.getDay();
  const toMonday = ((8 - dow) % 7) || 7;
  const out = [{ label: 'Tomorrow 9:30 AM', value: at(1, 9, 30) }];
  if (dow !== 5 && dow !== 6) out.push({ label: 'Tomorrow 2:00 PM', value: at(1, 14, 0) });
  out.push({ label: 'Monday 9:30 AM', value: at(toMonday, 9, 30) });
  return out;
}

export function describe(date: Date, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  const mine = date.toLocaleString(undefined, opts);
  if (!tz) return mine;
  const theirs = date.toLocaleString(undefined, { ...opts, timeZone: tz });
  return `${theirs} their time (${mine} yours)`;
}
