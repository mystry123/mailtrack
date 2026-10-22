import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { env } from './env.js';
import { decrypt } from './crypto.js';
import { AccountModel } from './models.js';
import { buildMime, type MimeInput } from './mime.js';

export const SCOPES = [
  'openid',
  'email',
  'profile',
  // Send only: the app never reads your mailbox.
  'https://www.googleapis.com/auth/gmail.send',
];

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

export async function sendGmail(message: Omit<MimeInput, 'from'>): Promise<SentRef> {
  const account = await AccountModel.findOne({ email: env.ALLOWED_EMAIL });
  if (!account || account.needsReauth) throw new ReauthRequired();

  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(account.refreshTokenEnc) });

  const raw = buildMime(
    { ...message, from: { email: account.email, name: account.fromName || account.name } },
    `mt_${randomBytes(12).toString('hex')}`,
  );

  try {
    const res = await client.request<SentRef>({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      method: 'POST',
      data: { raw: Buffer.from(raw, 'utf8').toString('base64url') },
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
