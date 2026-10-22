# Mailtrack

Personal job-search tracker at `https://track.shotline.in`: a pipeline of applications (Wishlist → Applied → Reached out → Replied → Screening → Interviewing → Offer, plus Accepted/Rejected/Ghosted/Withdrawn) fed by tracked emails, opens, clicks and replies. Today shows follow-ups due, hot leads, replies, interviews and a weekly goal; Insights shows the funnel, reply rate by source and when people engage. Gemini (Vertex, 3.1 Pro) rewrites and tailors emails, drafts follow-ups, researches companies (Google Search grounding) and builds interview-prep checklists.

Background jobs (`src/server/jobs.ts`) send scheduled emails every 30s and check reply headers every 10 min (`gmail.metadata`). They only run in production (or with `RUN_JOBS=true`), because a dev machine shares the production database.

The rest of this file covers the tracking itself. It sends mail through your Gmail account with a tracking pixel added and every link rewritten to a tracked redirect, then shows opens and clicks on a dashboard at `/app`.

- `GET /o/:token.gif`: the open pixel
- `GET /l/:token`: records a click, then 302s to the stored URL (only that URL; no open redirect)
- `/auth/google`: Google sign-in; only `ALLOWED_EMAIL` gets in. Scopes: `gmail.send` + profile. It never reads mail.
- `/api/*`: the dashboard API (session cookie + same-origin check)
- `/`: redirects to shotline.in, so the bare domain says nothing about tracking

## What the numbers mean

Every hit is stored as an event with a `signal`, and only `real` counts:

| signal | when |
| --- | --- |
| `self` | a click carrying the `mt_self` cookie set at sign-in; optionally opens within `SELF_OPEN_GRACE_SEC` of sending (default 0 = off; a later real click turns those back into real opens) |
| `auto` | Apple Mail Privacy Protection prefetch (Apple IP ranges): fires whether or not anyone read it |
| `bot` | HEAD requests, scanner/preview user agents, clicks within 10s of sending, clicks without `Accept-Language` |
| `real` | everything else |

Gmail loads images through its proxy, so a Gmail open is real but has no location, and repeat opens are often cached. Clicks are the strong signal. Any event can be flipped in the dashboard ("That was me" / "Count it").

Viewing your own Sent copy goes through the same Gmail image proxy as the recipient's open, so the server can't tell them apart. The Chrome extension in `extension/` fixes that for desktop Chrome: it blanks the pixel in your Gmail and reports `POST /x/seen`, and opens within 2 minutes of that count as "You". Gmail phone app views still count; use "That was me". Fetches from Google's IP ranges without the GoogleImageProxy user agent are Google scanning the message on delivery, and are ignored.

## Features (round 4)

- **Automatic follow-ups**: a first email can carry up to three follow-ups (default 4 and 9 working days). Gemini drafts them right after sending; you can read, edit, skip, send now or stop them on the email's page. They go into the same Gmail thread and stop when anyone replies, the application moves past Reached out, or it's closed (`src/server/sequences.ts`).
- **Reply summaries**: with the optional read permission (`/auth/google?add=read`), Gemini summarises each reply and suggests the next stage; you accept or dismiss it on Today or the application page.
- **Interviews from Google Calendar** (`/auth/google?add=calendar`): events matched to companies by attendee domain or name; prep reminders and a thank-you prompt after each (`src/server/calendar.ts`).
- **People**: everyone you email becomes a contact; add friends and ex-colleagues; Gemini drafts referral asks; "Find who to email" searches for founders/hiring managers and guesses addresses from common patterns and ones you've already emailed (optional `HUNTER_API_KEY` for verified lookups).
- **Chrome extension**: Save to Mailtrack on job pages (JSON-LD first, then per-site selectors), with ghost-job signals (age, reposts, no salary).
- **Sending safety**: daily cap (default 50, counts everything incl. automatic), pre-send checks (`src/shared/lint.ts`), optional open tracking per email.
- **Insights**: reply rate by template, by resume version (saved links) and by subject; weekly Monday digest email.

## Tests

```bash
pnpm test        # unit tests (no network, no database)
pnpm build && pnpm e2e   # end-to-end: real server on a throwaway database with fake Gmail/Calendar/Gemini,
                         # every flow through the API, then a click-through in headless Chrome (test/ui.mjs)
```

`pnpm e2e` needs `MONGODB_URI` (from `.env`) and Chrome. It creates `mailtrack_e2e_<random>` and drops it at the end (`E2E_KEEP=1` keeps it, `E2E_UI=0` skips the browser part). Test mode (`NODE_ENV=test`, `FAKE_GOOGLE`, `FAKE_AI`) is refused in production. `deploy/screenshot.mjs` takes screenshots of any page for visual checks.

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
