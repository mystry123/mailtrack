// End-to-end tests: a real server on a throwaway database, with fake Gmail,
// Calendar and Gemini (FAKE_GOOGLE / FAKE_AI). Every flow goes through the
// HTTP API exactly as the dashboard and extension use it.
//
//   pnpm build && pnpm e2e          (needs MONGODB_URI, e.g. from .env)
//
// The database (mailtrack_e2e_<random>) is dropped at the end, pass or fail.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { SignJWT } from 'jose';

const PORT = 4199;
const BASE = `http://localhost:${PORT}`;
const DB = `mailtrack_e2e_${randomBytes(4).toString('hex')}`;
const ME = 'me@example.com';
const SECRET = 'e2e-session-secret-0123456789abcdef0123';
const DAY = 86_400_000;

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  MONGODB_DB: DB,
  GOOGLE_CLIENT_ID: 'e2e',
  GOOGLE_CLIENT_SECRET: 'e2e',
  ALLOWED_EMAIL: ME,
  SESSION_SECRET: SECRET,
  TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
  FAKE_GOOGLE: 'true',
  FAKE_AI: 'true',
  RUN_JOBS: 'false',
  HUNTER_API_KEY: '',
  LOG_LEVEL: 'warn',
};

let server;
let passed = 0;
const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
};

const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ME).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));
const COOKIE = `mt_session=${jwt}`;
const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

async function call(method, path, body, { origin = BASE, cookie = COOKIE, headers = {}, expect = [200] } = {}) {
  const r = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, data, headers: r.headers };
}
const get = (p, o) => call('GET', p, undefined, o);
const post = (p, b = {}, o) => call('POST', p, b, o);
const patch = (p, b, o) => call('PATCH', p, b, o);
const jobs = (body = {}) => post('/api/test/jobs', body);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > timeout) throw new Error(`timed out waiting for ${label}`);
    await wait(150);
  }
}

let db;
const outbox = () => db.collection('fake_outbox').find().sort({ at: 1 }).toArray();
// Mail to other people (not Mailtrack's alerts and digests to you).
const outgoing = async () => (await outbox()).filter((m) => !m.to.includes(ME));
// The text and HTML parts of a raw message, decoded from base64.
const decoded = (raw) =>
  raw
    .split(/\r\n--mt_[0-9a-f]+/)
    .map((part) => part.split('\r\n\r\n')[1] ?? '')
    .map((b64) => Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8'))
    .join('\n');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: DB });
  db = mongoose.connection.db;
  // An account as if you had signed in with every permission.
  await db.collection('accounts').insertOne({
    email: ME,
    name: 'Test User',
    fromName: 'Test User',
    signature: '**Test User**',
    aboutMe: 'Fullstack engineer who built Shotline.',
    refreshTokenEnc: 'unused-in-fake-mode',
    scopes: [
      'openid',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
    needsReauth: false,
    weeklyGoal: 20,
    followUpDays: 4,
    dailyCap: 50,
    timezone: 'Asia/Kolkata',
    weeklyDigest: true,
  });

  server = spawn('node', ['dist/server/index.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 'server start', 20000);
  console.log(`e2e on database ${DB}\n`);

  const ids = {};

  console.log('Security');
  await step('API needs a session', async () => {
    await get('/api/me', { cookie: '', expect: [401] });
  });
  await step('mutations need our origin', async () => {
    await post('/api/applications', { company: 'X' }, { origin: 'https://evil.example', expect: [403] });
  });
  await step('extension origin only works on /capture', async () => {
    await post('/api/applications', { company: 'X' }, { origin: EXT_ORIGIN, headers: { 'x-mailtrack-extension': '1' }, expect: [403] });
    await post('/api/applications/capture', { url: 'https://x.co/j', company: 'X' }, { origin: EXT_ORIGIN, expect: [403] }); // no marker header
  });
  await step('test routes refuse no session', async () => {
    await post('/api/test/jobs', {}, { cookie: '', expect: [401] });
  });

  console.log('\nSettings');
  await step('me reports the new settings and permissions', async () => {
    const { data } = await get('/api/me');
    assert.equal(data.replyReading, true);
    assert.equal(data.calendarSync, true);
    assert.deepEqual(data.sequenceDays, [4, 9]);
    assert.equal(data.dailyCap, 50);
    assert.equal(data.sentToday, 0);
  });
  await step('settings validate time zones and save', async () => {
    await call('PUT', '/api/me', { timezone: 'Not/AZone' }, { expect: [400] });
    await call('PUT', '/api/me', { timezone: 'Asia/Kolkata', sequenceDays: [3, 7], dailyCap: 50 });
    assert.deepEqual((await get('/api/me')).data.sequenceDays, [3, 7]);
    await call('PUT', '/api/me', { sequenceDays: [4, 9] });
  });

  console.log('\nSending, templates and contacts');
  await step('save a template and a resume link', async () => {
    const { data } = await post('/api/templates', { name: 'Founder note', subject: 'Hi', body: 'Body' });
    ids.template = data.template._id;
    await call('PUT', '/api/saved-links', { links: [{ label: 'Resume (backend)', url: 'https://example.com/cv-backend' }] });
  });
  await step('send a first email with automatic follow-ups to a new company', async () => {
    const { data } = await post('/api/messages/send', {
      to: [{ email: 'jane@acme.example', name: 'Jane Doe' }],
      subject: 'Fullstack role at Acme',
      body: 'Hi Jane, here is [my resume](https://example.com/cv-backend).',
      newApplication: { company: 'Acme', role: 'Fullstack Engineer', source: 'cold_email' },
      sequenceDays: [4, 9],
      templateId: ids.template,
      includeSignature: true,
    });
    ids.root = data.message._id;
    const box = await outbox();
    assert.equal(box.length, 1);
    assert.match(decoded(box[0].raw), /\/o\/[A-Za-z0-9]+\.gif/, 'has the open pixel');
    assert.match(decoded(box[0].raw), /\/l\/[A-Za-z0-9]+/, 'links are tracked');
    assert.doesNotMatch(decoded(box[0].raw), /example\.com\/cv-backend/, 'raw URL is not exposed');
    assert.deepEqual(box[0].to, ['jane@acme.example']);
  });
  await step('the company was created at Reached out, with a contact', async () => {
    const { data } = await get(`/api/messages/${ids.root}`);
    ids.app = data.application._id;
    assert.equal(data.application.stage, 'reached_out');
    const c = await get('/api/contacts?q=jane');
    assert.equal(c.data.contacts.length, 1);
    assert.equal(c.data.contacts[0].company, 'Acme');
    assert.ok(c.data.contacts[0].applicationIds.includes(ids.app));
    ids.contact = c.data.contacts[0]._id;
  });
  await step('the sequence has two steps with due dates and Gemini drafts', async () => {
    const m = await until(async () => {
      const { data } = await get(`/api/messages/${ids.root}`);
      return data.message.sequence.steps.every((s) => s.body) && data.message;
    }, 'drafts');
    assert.equal(m.sequence.status, 'active');
    assert.deepEqual(m.sequence.steps.map((s) => s.afterDays), [4, 9]);
    assert.ok(new Date(m.sequence.steps[0].dueAt) > new Date(Date.now() + 2 * DAY));
    assert.match(m.sequence.steps[0].subject, /^Re: /);
  });
  await step('a second email with open tracking off has no pixel', async () => {
    await post('/api/messages/send', { to: [{ email: 'bob@other.example' }], subject: 'Quick note', body: 'Hi Bob', trackOpens: false, includeSignature: false });
    const box = await outbox();
    assert.match(decoded(box.at(-1).raw), /Hi Bob/);
    assert.doesNotMatch(decoded(box.at(-1).raw), /\.gif/);
  });
  await step('duplicate check warns about the same domain', async () => {
    const { data } = await get('/api/contacts/check?emails=someone@acme.example&company=acme');
    assert.equal(data.messages.length, 1);
    assert.equal(data.applications.length, 1);
  });

  console.log('\nTracking');
  await step('a browser click counts and redirects to the stored URL', async () => {
    // A click seconds after sending is (rightly) treated as a mail scanner: pretend it was sent an hour ago.
    await db.collection('messages').updateOne({ _id: new mongoose.Types.ObjectId(ids.root) }, { $set: { sentAt: new Date(Date.now() - 3_600_000) } });
    const m = (await get(`/api/messages/${ids.root}`)).data.message;
    const tok = m.links[0].token;
    const r = await fetch(`${BASE}/l/${tok}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 Chrome/131', 'accept-language': 'en' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://example.com/cv-backend');
    await until(async () => (await get(`/api/messages/${ids.root}`)).data.message.stats.clicks === 1, 'click counted');
  });
  await step('the first real click emails you an alert', async () => {
    const alerts = await until(async () => {
      const a = (await outbox()).filter((m) => m.to.includes(ME));
      return a.length ? a : null;
    }, 'alert');
    assert.match(alerts[0].subject, /clicked/);
  });
  await step('a Google delivery scan is ignored', async () => {
    const m = (await get(`/api/messages/${ids.root}`)).data.message;
    await fetch(`${BASE}/o/${m.token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/131', 'x-forwarded-for': '72.14.199.232' } });
    await wait(400);
    assert.equal((await get(`/api/messages/${ids.root}`)).data.message.stats.opens, 0);
  });
  await step('the extension marks your own Gmail view as you', async () => {
    const m = (await get(`/api/messages/${ids.root}`)).data.message;
    const gmailUa = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
    await fetch(`${BASE}/o/${m.token}.gif`, { headers: { 'user-agent': gmailUa, 'x-forwarded-for': '66.249.84.160' } });
    await until(async () => (await get(`/api/messages/${ids.root}`)).data.message.stats.opens === 1, 'open counted');
    const r = await fetch(`${BASE}/x/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m.token }) });
    assert.equal(r.status, 204);
    await until(async () => (await get(`/api/messages/${ids.root}`)).data.message.stats.opens === 0, 'open reclassified');
  });

  console.log('\nAutomatic follow-ups');
  await step('editing a step keeps your text', async () => {
    const { data } = await patch(`/api/messages/${ids.root}/sequence/0`, { body: 'Hi Jane, edited follow-up text.' });
    assert.equal(data.sequence.steps[0].edited, true);
  });
  await step('nothing goes out before it is due', async () => {
    const { data } = await jobs({ only: ['sequences'] });
    assert.equal(data.sequences.sent, 0);
    assert.equal((await outgoing()).length, 2);
  });
  await step('step 1 goes out on its due date, in the same thread, as a reply', async () => {
    const { data } = await jobs({ only: ['sequences'], now: new Date(Date.now() + 7 * DAY).toISOString() });
    assert.equal(data.sequences.sent, 1);
    const box = await outgoing();
    const first = box[0];
    const fu = box.at(-1);
    assert.equal(fu.threadId, first.threadId);
    assert.match(fu.subject, /^Re: Fullstack role at Acme/);
    assert.match(fu.raw, /In-Reply-To: <fake-/);
    assert.match(decoded(fu.raw), /edited follow-up text/);
    const m = (await get(`/api/messages/${ids.root}`)).data.message;
    assert.equal(m.sequence.steps[0].status, 'sent');
    const sentMsg = (await get(`/api/messages/${m.sequence.steps[0].messageId}`)).data.message;
    assert.equal(sentMsg.automatic, true);
    assert.equal(sentMsg.body, 'Hi Jane, edited follow-up text.');
  });
  await step('running the tick again does not double-send', async () => {
    const before = (await outgoing()).length;
    await jobs({ only: ['sequences'], now: new Date(Date.now() + 7 * DAY).toISOString() });
    assert.equal((await outgoing()).length, before);
  });
  await step('Today hides manual follow-up nudges while a sequence runs', async () => {
    const { data } = await get('/api/today');
    assert.equal(data.followUps.filter((f) => f.application._id === ids.app).length, 0);
  });

  console.log('\nReplies');
  await step('a reply is detected, summarised, stops the sequence and suggests a stage', async () => {
    const root = (await get(`/api/messages/${ids.root}`)).data.message;
    await db.collection('fake_threads').updateOne(
      { threadId: root.gmailThreadId },
      { $push: { messages: { id: 'reply1', at: new Date(), from: 'Jane Doe <jane@acme.example>', fromEmail: 'jane@acme.example', sentByMe: false, text: 'Thanks! Can we schedule a call on Thursday?\n\nOn Tue, Ritik wrote:\n> Hi Jane' } } },
    );
    const { data } = await jobs({ only: ['replies'] });
    assert.equal(data.replies, 1);
    const m = (await get(`/api/messages/${ids.root}`)).data;
    assert.equal(m.message.sequence.status, 'stopped');
    assert.equal(m.message.sequence.stopReason, 'They replied');
    assert.equal(m.message.sequence.steps[1].status, 'cancelled');
    const app = (await get(`/api/applications/${ids.app}`)).data.application;
    assert.equal(app.stage, 'replied');
    assert.equal(app.suggestion.stage, 'screening');
    const sent = (await get(`/api/messages/${m.message.sequence.steps[0].messageId}`)).data.events.find((e) => e.type === 'reply');
    assert.match(sent.summary, /screening/);
  });
  await step('the same reply is not counted twice', async () => {
    await db.collection('messages').updateMany({}, { $unset: { replyCheckedAt: '' } });
    const { data } = await jobs({ only: ['replies'] });
    assert.equal(data.replies, 0);
  });
  await step('accepting the suggestion moves the stage', async () => {
    const t = (await get('/api/today')).data;
    assert.ok(t.suggestions.some((s) => s.application._id === ids.app && s.stage === 'screening'));
    await post(`/api/applications/${ids.app}/suggestion/accept`);
    const app = (await get(`/api/applications/${ids.app}`)).data.application;
    assert.equal(app.stage, 'screening');
    assert.equal(app.suggestion, undefined);
  });

  console.log('\nSequence controls on another email');
  await step('start, skip, send-now and stop', async () => {
    const { data } = await post('/api/messages/send', {
      to: [{ email: 'cto@beta.example', name: 'Sam' }],
      subject: 'Hello Beta',
      body: 'Hi Sam, Beta looks great.',
      newApplication: { company: 'Beta', role: '' },
    });
    const id = data.message._id;
    await post(`/api/messages/${id}/sequence`, { days: [2, 5] });
    await post(`/api/messages/${id}/sequence`, { days: [2] }, { expect: [409] });
    await until(async () => (await get(`/api/messages/${id}`)).data.message.sequence.steps.every((s) => s.body), 'beta drafts');
    await post(`/api/messages/${id}/sequence/1/send-now`, {}, { expect: [409] }); // step 0 still pending
    await post(`/api/messages/${id}/sequence/0/skip`);
    const before = (await outbox()).length;
    const r = await post(`/api/messages/${id}/sequence/1/send-now`);
    assert.equal(r.data.sequence.steps[1].status, 'sent');
    assert.equal((await outbox()).length, before + 1);
    await post(`/api/messages/${id}/sequence/stop`);
    const m = (await get(`/api/messages/${id}`)).data.message;
    assert.equal(m.sequence.status, 'stopped');
  });
  await step('a sequence stops when you close the application', async () => {
    const { data } = await post('/api/messages/send', {
      to: [{ email: 'x@gamma.example' }],
      subject: 'Hello Gamma',
      body: 'Hi',
      newApplication: { company: 'Gamma', role: '' },
      sequenceDays: [3],
    });
    const m = (await get(`/api/messages/${data.message._id}`)).data;
    await patch(`/api/applications/${m.application._id}`, { stage: 'rejected' });
    const res = await jobs({ only: ['sequences'], now: new Date(Date.now() + 10 * DAY).toISOString() });
    assert.ok(res.data.sequences.stopped >= 1);
    assert.match((await get(`/api/messages/${data.message._id}`)).data.message.sequence.stopReason, /rejected/);
  });

  console.log('\nDaily cap and scheduling');
  await step('the daily cap blocks sending and defers scheduled mail', async () => {
    const sent = (await get('/api/me')).data.sentToday;
    await call('PUT', '/api/me', { dailyCap: sent });
    await post('/api/messages/send', { to: [{ email: 'z@cap.example' }], subject: 'Over cap', body: 'Hi' }, { expect: [429] });
    const { data } = await post('/api/messages/send', { to: [{ email: 'z@cap.example' }], subject: 'Scheduled', body: 'Hi', scheduledAt: new Date(Date.now() + 120_000).toISOString() });
    await db.collection('messages').updateOne({ _id: new mongoose.Types.ObjectId(data.message._id) }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
    await jobs({ only: ['scheduled'] });
    let m = (await get(`/api/messages/${data.message._id}`)).data.message;
    assert.equal(m.status, 'scheduled');
    assert.match(m.sendError, /Daily limit/);
    await call('PUT', '/api/me', { dailyCap: 50 });
    await db.collection('messages').updateOne({ _id: new mongoose.Types.ObjectId(data.message._id) }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
    await jobs({ only: ['scheduled'] });
    m = (await get(`/api/messages/${data.message._id}`)).data.message;
    assert.equal(m.status, 'sent');
  });
  await step('cancel a scheduled email', async () => {
    const { data } = await post('/api/messages/send', { to: [{ email: 'c@cancel.example' }], subject: 'Later', body: 'Hi', scheduledAt: new Date(Date.now() + DAY).toISOString() });
    await post(`/api/messages/${data.message._id}/cancel`);
    await post(`/api/messages/${data.message._id}/cancel`, {}, { expect: [409] });
  });

  console.log('\nCalendar and thank-yous');
  await step('an interview on the calendar attaches to the company', async () => {
    await db.collection('fake_calendar').insertOne({
      id: 'ev1',
      title: 'Acme technical interview',
      description: '',
      start: new Date(Date.now() - 3 * 3_600_000),
      end: new Date(Date.now() - 2 * 3_600_000),
      attendees: ['jane@acme.example', ME],
    });
    const { data } = await jobs({ only: ['calendar'] });
    assert.ok(data.calendar >= 1);
    const app = (await get(`/api/applications/${ids.app}`)).data.application;
    assert.equal(app.interviews.length, 1);
    assert.equal(app.interviews[0].matchedBy, 'attendee');
    assert.deepEqual(app.interviews[0].attendees, ['jane@acme.example']);
    assert.equal(app.suggestion.stage, 'interviewing');
  });
  await step('Today asks for a thank-you; sending one clears it', async () => {
    let t = (await get('/api/today')).data;
    const ty = t.thankYous.find((x) => x.application._id === ids.app);
    assert.ok(ty);
    const draft = (await post('/api/ai/thankyou', { applicationId: ids.app, key: ty.key })).data;
    assert.deepEqual(draft.to, ['jane@acme.example']);
    assert.ok(draft.body.length > 10);
    await post('/api/messages/send', { to: [{ email: 'jane@acme.example' }], subject: draft.subject, body: draft.body, applicationId: ids.app, thankYouFor: { applicationId: ids.app, key: ty.key } });
    t = (await get('/api/today')).data;
    assert.equal(t.thankYous.filter((x) => x.application._id === ids.app).length, 0);
  });

  console.log('\nSaving jobs from the extension');
  await step('capture creates a wishlist card with posting signals', async () => {
    const body = {
      url: 'https://jobs.lever.co/delta/123#apply',
      company: 'Delta',
      role: 'Backend Engineer',
      location: 'Remote',
      description: 'Build APIs.',
      salary: '',
      postedAt: new Date(Date.now() - 45 * DAY).toISOString(),
      reposted: true,
      site: 'lever',
    };
    const opts = { origin: EXT_ORIGIN, headers: { 'x-mailtrack-extension': '1' } };
    const r1 = await post('/api/applications/capture', body, opts);
    assert.equal(r1.data.created, true);
    const app = (await get(`/api/applications/${r1.data.application._id}`)).data.application;
    assert.equal(app.stage, 'wishlist');
    assert.equal(app.source, 'careers_page');
    assert.equal(app.jobUrl, 'https://jobs.lever.co/delta/123');
    assert.equal(app.posting.reposted, true);
    const r2 = await post('/api/applications/capture', body, opts);
    assert.equal(r2.data.created, false);
    ids.delta = r1.data.application._id;
  });
  await step('capture rejects bad input', async () => {
    await post('/api/applications/capture', { url: 'not a url', company: '' }, { origin: EXT_ORIGIN, headers: { 'x-mailtrack-extension': '1' }, expect: [400] });
  });

  console.log('\nPeople finder and referrals');
  await step('finds people and likely emails, ranked by known patterns', async () => {
    await post('/api/contacts', { name: 'Ritik Patel', email: 'rpatel@google.com', company: 'Delta' });
    const { data } = await post(`/api/applications/${ids.delta}/people`, { domain: 'google.com' });
    assert.equal(data.domain, 'google.com');
    assert.equal(data.mailOk, true);
    assert.equal(data.people[0].name, 'Jane Founder');
    assert.equal(data.people[0].emails[0].email, 'jfounder@google.com');
    assert.equal(data.people[0].emails[0].confidence, 'likely');
  });
  await step('asks for a domain when it cannot tell', async () => {
    const { data } = await post(`/api/applications/${ids.delta}/people`, {});
    assert.equal(data.needDomain, true);
  });
  await step('contacts: create, conflict, update, referral draft, delete', async () => {
    const c = (await post('/api/contacts', { name: 'Priya', email: 'priya@delta.example', company: 'Delta', relationship: 'friend', applicationIds: [ids.delta] })).data.contact;
    await post('/api/contacts', { email: 'priya@delta.example' }, { expect: [409] });
    await post('/api/contacts', { email: 'not-an-email' }, { expect: [400] });
    await patch(`/api/contacts/${c._id}`, { title: 'Staff Engineer' });
    const d = (await get(`/api/contacts/${c._id}`)).data;
    assert.equal(d.contact.title, 'Staff Engineer');
    assert.equal(d.applications[0].company, 'Delta');
    const draft = (await post('/api/ai/referral', { contactId: c._id })).data;
    assert.equal(draft.applicationId, ids.delta);
    assert.ok(draft.body.length > 10);
    await call('DELETE', `/api/contacts/${c._id}`);
    await get(`/api/contacts/${c._id}`, { expect: [404] });
  });

  console.log('\nGemini features (fake model)');
  await step('enhance, follow-up draft, brief and prep respond in shape', async () => {
    const e = (await post('/api/ai/enhance', { subject: 'Hi', body: 'Hi there, [my resume](https://example.com/cv)', applicationId: ids.app })).data;
    assert.ok(e.subject && e.body && Array.isArray(e.warnings));
    assert.deepEqual(e.warnings, []);
    await post('/api/ai/enhance', {}, { expect: [400] });
    const f = (await post('/api/ai/followup', { messageId: ids.root })).data;
    assert.match(f.subject, /^Re:/);
    assert.ok(f.followUpOf);
    const b = (await post(`/api/applications/${ids.app}/brief`)).data;
    assert.ok(b.brief.text);
    const p = (await post(`/api/applications/${ids.app}/prep/generate`)).data;
    assert.equal(p.prep.length, 3);
    const p2 = (await post(`/api/applications/${ids.app}/prep/generate`)).data;
    assert.equal(p2.prep.length, 3, 'no duplicate items');
  });

  console.log('\nInsights, digest and import');
  await step('insights include templates, links and sequences', async () => {
    const { data } = await get('/api/insights');
    assert.equal(data.byTemplate[0].name, 'Founder note');
    assert.equal(data.byTemplate[0].sent, 1);
    assert.equal(data.byTemplate[0].replied, 1);
    assert.equal(data.byLink[0].label, 'Resume (backend)');
    assert.ok(data.sequences.sent >= 2);
  });
  await step('the digest previews, sends to you, and only once a week', async () => {
    const p = (await get('/api/digest/preview')).data;
    assert.match(p.subject, /Your job search this week/);
    assert.match(p.markdown, /Best template/);
    const before = (await outbox()).length;
    await post('/api/digest/send');
    const box = await outbox();
    assert.equal(box.length, before + 1);
    assert.deepEqual(box.at(-1).to, [ME]);
    const monday9 = '2026-11-02T03:40:00Z'; // Monday 9:10 IST
    await db.collection('accounts').updateOne({ email: ME }, { $set: { lastDigestAt: new Date('2026-11-02T03:35:00Z') } });
    assert.equal((await jobs({ only: ['digest'], now: monday9 })).data.digest, false);
    await db.collection('accounts').updateOne({ email: ME }, { $set: { lastDigestAt: new Date('2026-10-26T03:35:00Z') } });
    assert.equal((await jobs({ only: ['digest'], now: monday9 })).data.digest, true);
  });
  await step('emails sent before the pipeline import in one click', async () => {
    await db.collection('messages').insertOne({
      kind: 'email', token: 'legacyTok1234', label: 'Epsilon', to: [{ email: 'a@eps.example' }], cc: [], subject: 'Old', body: '', html: '',
      links: [], sentAt: new Date(Date.now() - 5 * DAY), stats: { opens: 0, clicks: 0, replies: 0 }, archived: false,
    });
    assert.equal((await get('/api/applications/unlinked')).data.emails, 1);
    const r = (await post('/api/applications/import')).data;
    assert.deepEqual(r, { created: 1, linked: 1 });
    assert.equal((await get('/api/applications/unlinked')).data.emails, 0);
  });
  await step('Today and the board still load with everything in place', async () => {
    const t = (await get('/api/today')).data;
    assert.ok(Array.isArray(t.upcomingAuto) && Array.isArray(t.suggestions) && Array.isArray(t.thankYous));
    const a = (await get('/api/applications')).data.applications;
    assert.ok(a.length >= 5);
  });
}

try {
  await main();
} catch (err) {
  failures.push('setup');
  console.error(err);
} finally {
  server?.kill();
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
  process.exit(failures.length ? 1 : 0);
}
