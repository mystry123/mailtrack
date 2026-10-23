// Click-through UI test in headless Chrome against a test-mode server
// (FAKE_GOOGLE / FAKE_AI, throwaway database). Drives the real dashboard:
// types, clicks, and checks what's on screen.
//
//   node --env-file=<test env> test/ui.mjs        (server already running on PORT)

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';

const BASE = process.env.PUBLIC_URL ?? 'http://localhost:4100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(process.env.ALLOWED_EMAIL).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));

const profile = mkdtempSync(join(tmpdir(), 'mtui-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try {
    target = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((t) => t.type === 'page');
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
  if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.result?.value;
};
// Waits until an expression is truthy in the page.
const until = async (expr, label, timeout = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await evaluate(expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t > timeout) throw new Error(`timed out: ${label}`);
    await sleep(150);
  }
};
const go = async (hash) => {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(600);
};
// React-controlled inputs need the native setter plus an input event.
const type = (selector, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no element ' + ${JSON.stringify(selector)});
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
const clickText = (text, scope = 'button, a') =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) throw new Error('no clickable ' + ${JSON.stringify(text)});
    el.click();
    return true;
  })()`);
const bodyText = () => evaluate('document.body.innerText');

let passed = 0;
const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(err.message || err).split('\n')[0]}`);
  }
};

await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCookie', { name: 'mt_session', value: jwt, domain: new URL(BASE).hostname, path: '/' });
await send('Page.navigate', { url: `${BASE}/app/` });
await until('!!document.querySelector(".page h1")', 'app loads').catch(async (e) => {
  console.log('page text:', await evaluate('document.body.innerText').catch(() => '?'), 'url:', await evaluate('location.href').catch(() => '?'));
  throw e;
});

await step('every page renders without errors', async () => {
  for (const [hash, expect] of [
    ['/', 'Up next'],
    ['/pipeline', 'Pipeline'],
    ['/sent', 'Sent'],
    ['/people', 'People'],
    ['/insights', 'Insights'],
    ['/link', 'Tracked link'],
    ['/settings', 'Weekly digest'],
    ['/compose', 'Automatic follow-ups'],
  ]) {
    await go(hash);
    await until(`document.body.innerText.includes(${JSON.stringify(expect)})`, `${hash} shows ${expect}`);
  }
  assert.deepEqual(consoleErrors, []);
});

await step('compose: live checks, confirm on errors, send with follow-ups', async () => {
  await go('/compose?to=Jane%20Doe%20%3Cjane%40ui-test.example%3E');
  await until('!!document.querySelector("textarea")', 'editor');
  await type('.picker input', 'UiTestCo');
  await type('.two label:nth-child(2) input', 'Hello [Company]');
  await type('.editor textarea', 'Hi, please see attached.');
  await until('!!document.querySelector(".lint")?.innerText.includes("Placeholder left in")', 'placeholder warning');
  assert.match(await bodyText(), /Mentions an attachment/);
  await clickText('Send tracked email');
  await until('!!document.querySelector(".modal")?.innerText.includes("Send anyway?")', 'confirm modal');
  await clickText('Fix it');
  await type('.two label:nth-child(2) input', 'Fullstack role at UiTestCo');
  await type('.editor textarea', 'Hi Jane, I built Shotline. [My resume](https://example.com/cv)');
  await until('!document.querySelector(".lint li.error")', 'errors cleared');
  await clickText('Send tracked email');
  await until('location.hash.startsWith("#/m/")', 'navigates to the email');
  await until('document.body.innerText.includes("Automatic follow-ups") && document.body.innerText.includes("Follow-up 2")', 'sequence card');
  await until('document.querySelectorAll(".seq-actions button").length >= 2', 'drafts ready', 10000);
});

await step('read, edit and save a follow-up draft', async () => {
  await clickText('Read');
  await until('!!document.querySelector(".seq-body")', 'draft shown');
  await clickText('Edit');
  await type('.seq-draft textarea', 'Hi Jane, a short follow-up written in the UI test.');
  await clickText('Save');
  await until('document.body.innerText.includes("edited by you")', 'edited marker');
});

await step('stop all follow-ups', async () => {
  await clickText('Stop all');
  await until('document.body.innerText.includes("Stopped by you")', 'stopped');
});

await step('compose: pick a resume and swap it', async () => {
  await go('/compose');
  await until('!!document.querySelector(".resume-row")', 'resume picker');
  await type('.editor textarea', 'Hi Maya,\n\nThanks,\nRitik');
  const body = () => evaluate('document.querySelector(".editor textarea").value');
  await clickText('Voice AI', '.resume-row button');
  await until('document.querySelector(".editor textarea").value.includes("VOICEresume123")', 'voice resume inserted');
  assert.match(await body(), /\*\*Resume:\*\* \[View Resume\]\(https:\/\/drive\.google\.com\/file\/d\/VOICEresume123\/view\)\n\nThanks,/);
  assert.equal(await evaluate('document.querySelector(".resume-row .chip.on")?.textContent'), 'Voice AI');
  await clickText('AI Engineer', '.resume-row button');
  await until('document.querySelector(".editor textarea").value.includes("AIresume12345")', 'swapped');
  assert.doesNotMatch(await body(), /VOICEresume123/);
  assert.match(await bodyText(), /Direct \(not tracked\): View Resume/);
  await clickText('Clear');
  await go('/settings');
  await until('document.body.innerText.includes("Resumes") && document.body.innerText.includes("Voice AI")', 'resumes in Settings');
});

await step('Today: accept a stage suggestion', async () => {
  await go('/');
  const has = await until('document.body.innerText', 'today');
  if (!/Move .+ to /.test(has)) return; // nothing to suggest in this dataset
  await clickText('Move');
  await until('!!document.querySelector(".toast")', 'toast');
});

await step('People: add a person, then search for them', async () => {
  await go('/people');
  await clickText('Add person');
  await until('!!document.querySelector(".modal")', 'modal');
  const who = `Ui Person ${Date.now().toString(36)}`;
  await type('.modal input', who);
  await type('.modal .two input[placeholder="name@company.com"]', `ui.${Date.now()}@ui-test.example`);
  await clickText('Save');
  await until(`document.body.innerText.includes(${JSON.stringify('Saved ' + who)})`, 'saved');
  await type('.search-box input', who);
  await until('document.querySelectorAll(".person-row").length === 1', 'search narrows to one').catch(async (e) => {
    console.log('      rows:', await evaluate('[...document.querySelectorAll(".person-row")].map((r) => r.innerText.split("\\n")[0]).join(" | ")'), '| search value:', await evaluate('document.querySelector(".search-box input").value'));
    throw e;
  });
});

await step('Settings: save follow-up defaults and preview the digest', async () => {
  await go('/settings');
  await until('document.body.innerText.includes("Daily sending limit")', 'settings');
  assert.match(await bodyText(), /Who can use Mailtrack/, 'owner sees invites');
  await clickText('Preview');
  await until('!!document.querySelector(".digest-preview")?.innerText.includes("Your job search this week")', 'digest preview');
  await clickText('Save settings');
  await until('document.body.innerText.includes("Settings saved")', 'saved');
});

const ext = (f) => readFileSync(new URL(`../extension/${f}`, import.meta.url), 'utf8');
// Stand-in for the extension runtime: records messages, answers like the background script.
const stubChrome = `window.__sent = []; window.chrome = { runtime: { sendMessage: (m, cb) => { window.__sent.push(m); cb && cb({ ok: true, created: true, application: { _id: 'abc' } }); } } };`;

await step('extension: Save to Mailtrack reads a job page and sends it', async () => {
  const ld = JSON.stringify({ '@type': 'JobPosting', title: 'Founding Engineer', hiringOrganization: { name: 'Cardboard' }, datePosted: new Date(Date.now() - 40 * 864e5).toISOString(), jobLocationType: 'TELECOMMUTE' });
  await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(`<html><head><script type="application/ld+json">${ld}</script></head><body><h1>Founding Engineer</h1></body></html>`) });
  await sleep(500);
  await evaluate(stubChrome + ext('extract.js') + ';' + ext('job.js'));
  const host = 'document.documentElement.lastElementChild.shadowRoot';
  await evaluate(`${host}.querySelector('.fab').click()`);
  await until(`!${host}.querySelector('.panel').hidden`, 'panel open');
  assert.equal(await evaluate(`${host}.querySelector('input[name=company]').value`), 'Cardboard');
  assert.equal(await evaluate(`${host}.querySelector('input[name=role]').value`), 'Founding Engineer');
  assert.match(await evaluate(`${host}.querySelector('.meta').innerText`), /Remote · posted 40 days ago/);
  await evaluate(`${host}.querySelector('.go').click()`);
  await until(`${host}.querySelector('.msg').innerText.includes('Saved to your Wishlist')`, 'saved message');
  const sent = await evaluate('window.__sent[0]');
  assert.equal(sent.type, 'capture');
  assert.equal(sent.data.company, 'Cardboard');
  assert.equal(sent.data.site, 'web');
});

await step('extension: your own Gmail view blanks the pixel and reports it', async () => {
  await send('Page.navigate', { url: 'data:text/html,<html><body></body></html>' });
  await sleep(300);
  await evaluate(stubChrome + ext('content.js'));
  await evaluate(`(() => { const i = document.createElement('img'); i.src = 'https://ci3.googleusercontent.com/meips/x#https://track.shotline.in/o/AbCdEfGhJkMn.gif'; document.body.appendChild(i); })()`);
  await until('window.__sent.length === 1', 'reported');
  assert.deepEqual(await evaluate('window.__sent[0]'), { type: 'seen', token: 'AbCdEfGhJkMn' });
  assert.match(await evaluate('document.querySelector("img").getAttribute("src")'), /^data:image\/gif/);
});

await step('no uncaught errors in the console', async () => {
  assert.deepEqual(consoleErrors, []);
});

ws.close();
chrome.kill();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
