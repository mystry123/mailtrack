import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { env } from './env.js';
import { decrypt } from './crypto.js';
import { fakeGoogle } from './fakes.js';
import { AccountModel } from './models.js';
import { buildMime, type MimeInput } from './mime.js';

export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// Headers only (From, Date, Message-ID): enough to see that someone replied,
// never the text of any message.
export const METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
// Optional, asked for separately: lets Gemini read replies to emails sent from here.
export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// Optional: finds interviews on your calendar.
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

export const SCOPES = ['openid', 'email', 'profile', SEND_SCOPE, METADATA_SCOPE];
export const EXTRA_SCOPES: Record<string, string> = { read: READ_SCOPE, calendar: CALENDAR_SCOPE };

export const redirectUri = () => `${env.PUBLIC_URL}/auth/google/callback`;

export function oauthClient(): OAuth2Client {
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri());
}

export class ReauthRequired extends Error {
  constructor() {
    super('Google access expired or was revoked; sign in again');
  }
}

export interface SentRef {
  id: string;
  threadId: string;
}

async function google<T>(url: string, init: { method?: 'GET' | 'POST'; data?: unknown } = {}): Promise<T> {
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL });
  if (!account || account.needsReauth) throw new ReauthRequired();
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(account.refreshTokenEnc) });
  try {
    const res = await client.request<T>({ url, method: init.method ?? 'GET', data: init.data });
    return res.data;
  } catch (err) {
    const data = (err as { response?: { data?: { error?: string } } }).response?.data;
    if (data?.error === 'invalid_grant' || /invalid_grant/.test(String((err as Error).message))) {
      await AccountModel.updateOne({ _id: account._id }, { needsReauth: true });
      throw new ReauthRequired();
    }
    throw err;
  }
}

const gmail = <T>(path: string, init?: { method?: 'GET' | 'POST'; data?: unknown }) =>
  google<T>(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, init);

export async function hasScope(scope: string): Promise<boolean> {
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).select('scopes needsReauth').lean();
  return !!account && !account.needsReauth && (account.scopes ?? []).includes(scope);
}

export interface OutgoingMail extends Omit<MimeInput, 'from' | 'headers'> {
  // Follow-ups: keep them in the original Gmail thread.
  threadId?: string;
  inReplyTo?: string;
  messageId?: string;
}

export async function sendGmail(message: OutgoingMail): Promise<SentRef> {
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL }).lean();
  if (!account) throw new ReauthRequired();
  const headers: Record<string, string> = {};
  if (message.messageId) headers['Message-ID'] = message.messageId;
  if (message.inReplyTo) {
    headers['In-Reply-To'] = message.inReplyTo;
    headers.References = message.inReplyTo;
  }
  const raw = buildMime(
    { ...message, headers, from: { email: account.email, name: account.fromName || account.name } },
    `mt_${randomBytes(12).toString('hex')}`,
  );
  if (env.FAKE_GOOGLE) return fakeGoogle.send(message, raw);
  return gmail<SentRef>('messages/send', {
    method: 'POST',
    data: { raw: Buffer.from(raw, 'utf8').toString('base64url'), ...(message.threadId ? { threadId: message.threadId } : {}) },
  });
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

interface MetaMessage {
  id: string;
  internalDate: string;
  labelIds?: string[];
  payload?: Part & { headers?: Array<{ name: string; value: string }> };
}

const header = (m: MetaMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

// The Message-ID Gmail actually used for a sent message.
export async function getRfcMessageId(gmailId: string): Promise<string | undefined> {
  if (env.FAKE_GOOGLE) return fakeGoogle.rfcMessageId(gmailId);
  const m = await gmail<MetaMessage>(`messages/${gmailId}?format=metadata&metadataHeaders=Message-ID`);
  return header(m, 'Message-ID') || undefined;
}

export interface ThreadMessage {
  id: string;
  at: Date;
  from: string;
  fromEmail: string;
  sentByMe: boolean;
}

export async function getThread(threadId: string): Promise<ThreadMessage[]> {
  if (env.FAKE_GOOGLE) return fakeGoogle.thread(threadId);
  const t = await gmail<{ messages?: MetaMessage[] }>(`threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Date`);
  return (t.messages ?? []).map((m) => {
    const from = header(m, 'From');
    const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
    return {
      id: m.id,
      at: new Date(Number(m.internalDate)),
      from,
      fromEmail,
      sentByMe: fromEmail === env.ALLOWED_EMAIL || !!m.labelIds?.includes('SENT'),
    };
  });
}

function plainText(part: Part | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url')
      .toString('utf8')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>|<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ');
  }
  return '';
}

// Drops the quoted original ("On … wrote:", "> …") so only the new reply is left.
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From: .+/.test(line.trim())) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim().slice(0, 4_000);
}

// Text of one reply (needs the read permission).
export async function getMessageText(gmailId: string): Promise<string> {
  if (env.FAKE_GOOGLE) return stripQuoted(await fakeGoogle.text(gmailId));
  const m = await gmail<MetaMessage>(`messages/${gmailId}?format=full`);
  return stripQuoted(plainText(m.payload));
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start: Date;
  end: Date;
  attendees: string[];
}

export async function listCalendarEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  if (env.FAKE_GOOGLE) return fakeGoogle.events(from, to);
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const r = await google<{
    items?: Array<{
      id: string;
      status?: string;
      summary?: string;
      description?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      attendees?: Array<{ email?: string }>;
    }>;
  }>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return (r.items ?? [])
    .filter((e) => e.status !== 'cancelled' && e.start?.dateTime)
    .map((e) => ({
      id: e.id,
      title: e.summary ?? '',
      description: (e.description ?? '').slice(0, 2_000),
      start: new Date(e.start!.dateTime!),
      end: new Date(e.end?.dateTime ?? e.start!.dateTime!),
      attendees: (e.attendees ?? []).map((a) => (a.email ?? '').toLowerCase()).filter(Boolean),
    }));
}
