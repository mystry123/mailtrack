# Mailtrack

Personal email open/click tracker at `https://track.shotline.in`. It sends mail through your Gmail account with a tracking pixel added and every link rewritten to a tracked redirect, then shows opens and clicks on a dashboard at `/app`.

- `GET /o/:token.gif`: the open pixel
- `GET /l/:token`: records a click, then 302s to the stored URL (only that URL; no open redirect)
- `/auth/google`: Google sign-in; only `ALLOWED_EMAIL` gets in. Scopes: `gmail.send` + profile. It never reads mail.
- `/api/*`: the dashboard API (session cookie + same-origin check)
- `/`: redirects to shotline.in, so the bare domain says nothing about tracking

## What the numbers mean

Every hit is stored as an event with a `signal`, and only `real` counts:

| signal | when |
| --- | --- |
| `self` | open within `SELF_OPEN_GRACE_SEC` of sending (your Sent view), or a click carrying the `mt_self` cookie set at sign-in |
| `auto` | Apple Mail Privacy Protection prefetch (Apple IP ranges): fires whether or not anyone read it |
| `bot` | HEAD requests, scanner/preview user agents, clicks within 10s of sending, clicks without `Accept-Language` |
| `real` | everything else |

Gmail loads images through its proxy, so a Gmail open is real but has no location, and repeat opens are often cached. Clicks are the strong signal. Any event can be flipped in the dashboard ("That was me" / "Count it").

Viewing your own Sent copy later still counts as an open, because it is indistinguishable from the recipient's Gmail. Use "That was me".

## Develop

```bash
cp .env.example .env   # PUBLIC_URL=http://localhost:5173 for dev
pnpm install
pnpm dev               # API :4100, Vite :5173 (proxies /api, /auth, /o, /l)
pnpm test && pnpm typecheck
```

Google OAuth client: Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application). Authorized redirect URIs: `https://track.shotline.in/auth/google/callback` and `http://localhost:5173/auth/google/callback`. Enable the Gmail API on the project. Put the consent screen **In production**, not Testing: in Testing mode Google expires refresh tokens after 7 days. An unverified app with only you as a user just shows a "Google hasn't verified this app" warning once.

## Deploy (shotline-prod EC2)

Separate pm2 app on port 4100 behind nginx. Files in `deploy/`.

- First time: DNS `A track.shotline.in → 3.6.143.223`, then from your Mac `bash deploy/setup-box.sh`. That one SSM command writes the box `.env`, the nginx site and the certificate, then clones, builds and starts the pm2 app.
- Later: push to main, then re-run `deploy/setup-box.sh` (it leaves the existing `.env` alone), or on the box run `deploy/deploy.sh`.
# mailtrack
