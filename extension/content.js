// Runs inside your Gmail. Any tracking pixel that shows up here is you looking
// at your own email (the Sent copy or a thread), so blank it before it loads
// and tell the server, in case the image was already on its way.
const MARK = 'track.shotline.in/o/';
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const reported = new Map(); // token -> last report time

function tokenOf(src) {
  // Gmail serves images through its proxy: https://ciN.googleusercontent.com/...#https://track.shotline.in/o/<token>.gif
  const i = src.indexOf(MARK);
  if (i < 0) return null;
  const m = /^([A-Za-z0-9]{8,32})\.gif/.exec(src.slice(i + MARK.length));
  return m ? m[1] : null;
}

function check(img) {
  const token = tokenOf(img.getAttribute('src') || '');
  if (!token) return;
  img.setAttribute('src', BLANK);
  img.removeAttribute('srcset');
  const last = reported.get(token) || 0;
  if (Date.now() - last > 30_000) {
    reported.set(token, Date.now());
    chrome.runtime.sendMessage({ type: 'seen', token });
  }
}

new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes') {
      if (m.target.tagName === 'IMG') check(m.target);
      continue;
    }
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'IMG') check(node);
      else if (node.querySelectorAll) node.querySelectorAll('img').forEach(check);
    }
  }
}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
