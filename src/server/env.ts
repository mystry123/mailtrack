import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4100),
  // Origin the dashboard, pixel and redirect links are served from. Tracked
  // links embed it, so changing it later breaks links in already-sent emails.
  PUBLIC_URL: z.string().url().transform((s) => s.replace(/\/$/, '')),
  MONGODB_URI: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // The only Google account allowed to sign in (and the one mail is sent from).
  ALLOWED_EMAIL: z.string().email().transform((s) => s.toLowerCase()),
  SESSION_SECRET: z.string().min(32),
  // 32 bytes, base64. Encrypts the stored Google refresh token.
  TOKEN_ENC_KEY: z.string().refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 bytes base64'),
  // Opens this soon after sending are treated as you viewing your Sent copy.
  // Off by default: it hid real opens from fast readers.
  SELF_OPEN_GRACE_SEC: z.coerce.number().default(0),
  NOTIFY_ON_CLICK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((s) => s === 'true'),
  NOTIFY_ON_OPEN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((s) => s === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
