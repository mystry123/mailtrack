// Regenerate: node scripts/extension-icons.mjs extension/icons
// Renders the extension icon (Shotline mark, white on Shotline blue) at each size with headless Chrome.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sizes = [16, 32, 48, 128];
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 22 22"><rect width="22" height="22" rx="5" fill="#2447F9"/><g fill="none" stroke-width="${s <= 16 ? 2.4 : 2}" stroke-linecap="round" transform="translate(3.3 3.3) scale(0.7)"><path d="M3 8V3h5M19 14v5h-5" stroke="#fff"/><path d="M11 1v20" stroke="#fff"/></g></svg>`;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9335', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ic-'))}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 40 && !t; i++) { await sleep(250); try { t = (await (await fetch('http://127.0.0.1:9335/json')).json()).find((x) => x.type === 'page'); } catch {} }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const p = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
for (const s of sizes) {
  await send('Emulation.setDeviceMetricsOverride', { width: s, height: s, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(s)}</body></html>`) });
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: s, height: s, scale: 1 } });
  writeFileSync(`${process.argv[2]}/icon-${s}.png`, Buffer.from(shot.result.data, 'base64'));
}
ws.close(); chrome.kill(); console.log('icons written');
