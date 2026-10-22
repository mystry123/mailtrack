// Dev harness: screenshots of the dashboard in headless Chrome with a minted session.
// Run the server locally first (jobs stay off), then:
//   OUT=/tmp/shots node --env-file=.env deploy/screenshot.mjs "today=/" "board=/pipeline"   (W, H, THEME=dark, FULL=1)
// Headless Chrome via CDP: set the session cookie, open pages, save screenshots.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';

const OUT = process.env.OUT;
const [width, height, theme] = [Number(process.env.W || 1440), Number(process.env.H || 1000), process.env.THEME || 'light'];
const pages = process.argv.slice(2);
const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(process.env.ALLOWED_EMAIL).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
const profile = mkdtempSync(join(tmpdir(), 'mtshot-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Network.enable');
await send('Network.setCookie', { name: 'mt_session', value: jwt, domain: 'localhost', path: '/' });
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:4100/app/' });
await sleep(1500);
await send('Runtime.evaluate', { expression: `localStorage.setItem('mt-theme','${theme}')` });
for (const p of pages) {
  const i = p.indexOf('=');
  const [name, hash] = [p.slice(0, i), p.slice(i + 1)];
  await send('Runtime.evaluate', { expression: `location.hash = '${hash}'; location.reload()` });
  await sleep(2500);
  const full = process.env.FULL === '1';
  let clip;
  if (full) {
    const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true });
    clip = { x: 0, y: 0, width, height: Math.min(result.result.value, 4000), scale: 1 };
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', name);
}
ws.close(); chrome.kill();
