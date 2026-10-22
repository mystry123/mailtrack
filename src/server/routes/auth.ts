import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type CookieOptions, type NextFunction, type Request, type Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { encrypt } from '../crypto.js';
import { env, isProd } from '../env.js';
import { oauthClient, SCOPES } from '../google.js';
import { logger } from '../logger.js';
import { AccountModel } from '../models.js';
import { SELF_COOKIE } from './track.js';

const SESSION_COOKIE = 'mt_session';
const STATE_COOKIE = 'mt_oauth_state';
const SESSION_DAYS = 30;
const secret = new TextEncoder().encode(env.SESSION_SECRET);

const baseCookie: CookieOptions = { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' };

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret);
      if (payload.sub === env.ALLOWED_EMAIL) {
        res.locals.email = payload.sub;
        return next();
      }
    } catch {
      // fall through
    }
  }
  res.status(401).json({ error: 'unauthenticated' });
}

// Mutating API calls must come from our own page (cookie is SameSite=Lax, and
// this blocks cross-site form posts outright).
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('origin') !== env.PUBLIC_URL) {
    res.status(403).json({ error: 'bad origin' });
    return;
  }
  next();
}

export const authRouter = Router();

authRouter.get('/google', (_req, res) => {
  const state = randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60_000 });
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    login_hint: env.ALLOWED_EMAIL,
    include_granted_scopes: true,
  });
  res.redirect(url);
});

authRouter.get('/google/callback', async (req, res) => {
  const fail = (reason: string) => res.redirect(`/app/#/login?error=${encodeURIComponent(reason)}`);

  const state = String(req.query.state ?? '');
  const expected = String(req.cookies?.[STATE_COOKIE] ?? '');
  res.clearCookie(STATE_COOKIE, baseCookie);
  if (!state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return fail('Sign-in expired, try again');
  }
  if (req.query.error) return fail(String(req.query.error));

  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code ?? ''));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token!, audience: env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    const email = profile?.email?.toLowerCase();
    if (!email || !profile?.email_verified || email !== env.ALLOWED_EMAIL) {
      logger.warn({ email }, 'rejected sign-in from non-allowed account');
      return fail('This account is not allowed');
    }
    const granted = (tokens.scope ?? '').split(' ');
    if (!granted.includes('https://www.googleapis.com/auth/gmail.send')) {
      return fail('Gmail send permission was not granted; tick it on the consent screen');
    }

    const update: Record<string, unknown> = { name: profile.name ?? '', scopes: granted, needsReauth: false };
    if (tokens.refresh_token) update.refreshTokenEnc = encrypt(tokens.refresh_token);
    const existing = await AccountModel.findOne({ email });
    if (!existing && !tokens.refresh_token) return fail('Google did not return a refresh token; try again');
    await AccountModel.updateOne({ email }, { $set: update }, { upsert: true });

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(email)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_DAYS}d`)
      .sign(secret);
    res.cookie(SESSION_COOKIE, jwt, { ...baseCookie, maxAge: SESSION_DAYS * 86_400_000 });
    // Marks this browser as yours so your own clicks on tracked links don't count.
    res.cookie(SELF_COOKIE, '1', { ...baseCookie, maxAge: 5 * 365 * 86_400_000 });
    res.redirect('/app/');
  } catch (err) {
    logger.error({ err }, 'oauth callback failed');
    fail('Sign-in failed');
  }
});

authRouter.post('/logout', requireSameOrigin, (_req, res) => {
  res.clearCookie(SESSION_COOKIE, baseCookie);
  res.json({ ok: true });
});
