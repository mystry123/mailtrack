// Content scripts can't call track.shotline.in (the page's CORS); the extension can.
const BASE = 'https://track.shotline.in';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'seen' && typeof msg.token === 'string') {
    fetch(`${BASE}/x/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: msg.token }),
    }).catch(() => undefined);
    return false;
  }
  if (msg?.type === 'capture') {
    // Uses your dashboard session cookie (sign in once in this Chrome profile).
    fetch(`${BASE}/api/applications/capture`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Mailtrack-Extension': '1' },
      body: JSON.stringify(msg.data),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        reply(r.ok ? { ok: true, ...body } : { ok: false, status: r.status, message: body.message || body.issues?.join('; ') });
      })
      .catch(() => reply({ ok: false, message: 'Could not reach Mailtrack' }));
    return true; // reply asynchronously
  }
  return false;
});

// Toolbar icon: open the save panel on any page (job pages outside the usual sites).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => (window.__mailtrackOpenNow = true) });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js', 'job.js'] });
});
