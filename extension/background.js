// Content scripts can't call track.shotline.in (Gmail's CORS); the extension can.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'seen' || typeof msg.token !== 'string') return;
  fetch('https://track.shotline.in/x/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: msg.token }),
  }).catch(() => undefined);
});
