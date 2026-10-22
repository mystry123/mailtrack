import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { env } from './env.js';
import { decrypt } from './crypto.js';
import { AccountModel } from './models.js';
import { buildMime, type MimeInput } from './mime.js';

export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// Headers only (From, Date, Message-ID): enough to see that someone replied,
// never the text of any message.
export const METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';

export const SCOPES = ['openid', 'email', 'profile', SEND_SCOPE, METADATA_SCOPE];

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

async function gmail<T>(path: string, init: { method?: 'GET' | 'POST'; data?: unknown } = {}): Promise<T> {
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL });
  if (!account || account.needsReauth) throw new ReauthRequired();
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(account.refreshTokenEnc) });
  try {
    const res = await client.request<T>({
      url: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      method: init.method ?? 'GET',
      data: init.data,
    });
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
  return gmail<SentRef>('messages/send', {
    method: 'POST',
    data: { raw: Buffer.from(raw, 'utf8').toString('base64url'), ...(message.threadId ? { threadId: message.threadId } : {}) },
  });
}

interface MetaMessage {
  id: string;
  internalDate: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }> };
}

const header = (m: MetaMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

// The Message-ID Gmail actually used for a sent message.
export async function getRfcMessageId(gmailId: string): Promise<string | undefined> {
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
  const t = await gmail<{ messages?: MetaMessage[] }>(
    `threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Date`,
  );
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
