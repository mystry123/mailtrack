import { promises as dns } from 'node:dns';
import { env } from './env.js';
import { logger } from './logger.js';

export interface EmailGuess {
  email: string;
  confidence: 'verified' | 'likely' | 'possible';
  why: string;
}

const clean = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const PATTERNS: Array<[string, (f: string, l: string) => string]> = [
  ['first', (f) => f],
  ['first.last', (f, l) => `${f}.${l}`],
  ['firstlast', (f, l) => `${f}${l}`],
  ['flast', (f, l) => `${f[0]}${l}`],
  ['f.last', (f, l) => `${f[0]}.${l}`],
  ['first_last', (f, l) => `${f}_${l}`],
  ['firstl', (f, l) => `${f}${l[0]}`],
  ['last', (_f, l) => l],
];

// Which pattern a known address at the domain follows ("ritik.patel@" → first.last).
export function detectPattern(email: string, name: string): string | undefined {
  const [local] = email.toLowerCase().split('@');
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const f = clean(parts[0]);
  const l = clean(parts[parts.length - 1]);
  return PATTERNS.find(([, make]) => make(f, l) === local)?.[0];
}

// Likely addresses for a person at a domain, best first. Patterns seen in
// addresses you've already emailed at that domain rank highest.
export function guessEmails(fullName: string, domain: string, known: { email: string; name: string }[] = []): EmailGuess[] {
  const parts = fullName.trim().split(/\s+/);
  const f = clean(parts[0] ?? '');
  const l = clean(parts.length > 1 ? parts[parts.length - 1] : '');
  if (!f) return [];
  const seen = new Map<string, number>();
  for (const k of known) {
    const p = detectPattern(k.email, k.name);
    if (p) seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  const usable = PATTERNS.filter(([key]) => l || key === 'first');
  const ranked = [...usable].sort(([a], [b]) => (seen.get(b) ?? 0) - (seen.get(a) ?? 0));
  return ranked.map(([key, make], i) => ({
    email: `${make(f, l)}@${domain}`,
    confidence: seen.has(key) ? 'likely' : i < 2 ? 'possible' : 'possible',
    why: seen.has(key) ? `matches ${seen.get(key)} address${seen.get(key) === 1 ? '' : 'es'} you've emailed at ${domain}` : `common pattern (${key})`,
  }));
}

export async function domainAcceptsMail(domain: string): Promise<boolean> {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0;
  } catch {
    return false;
  }
}

// Optional: Hunter.io finder + verifier when HUNTER_API_KEY is set.
export async function hunterFind(fullName: string, domain: string): Promise<EmailGuess | null> {
  if (!env.HUNTER_API_KEY) return null;
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const params = new URLSearchParams({ domain, first_name: first, last_name: rest.join(' '), api_key: env.HUNTER_API_KEY });
  try {
    const r = await fetch(`https://api.hunter.io/v2/email-finder?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = (await r.json()) as { data?: { email?: string; score?: number; verification?: { status?: string } } };
    if (!d.data?.email) return null;
    const verified = d.data.verification?.status === 'valid';
    return { email: d.data.email, confidence: verified ? 'verified' : 'likely', why: `Hunter.io (score ${d.data.score ?? '?'})` };
  } catch (err) {
    logger.warn({ err }, 'hunter lookup failed');
    return null;
  }
}

export function domainFromUrl(input: string): string {
  const s = input.trim().toLowerCase();
  try {
    const host = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return s.replace(/^www\./, '');
  }
}
