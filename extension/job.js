// "Save to Mailtrack" on job pages: a small floating button that opens a
// panel with what was read off the page (editable), then saves it to your
// pipeline's Wishlist. Also opened from the toolbar icon on any page.
(function () {
  'use strict';
  if (window.__mailtrackJob) {
    window.__mailtrackJob.open();
    return;
  }

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:Inter,-apple-system,"Helvetica Neue",Arial,sans-serif}' +
    '.fab{display:flex;align-items:center;gap:8px;height:40px;padding:0 16px;border-radius:999px;border:0;background:#2447F9;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(36,71,249,.35)}' +
    '.fab:hover{background:#1B38D1}' +
    '.panel{width:320px;background:#fff;color:#141414;border:1px solid #E2E0DA;border-radius:14px;box-shadow:0 12px 40px rgba(20,20,20,.18);padding:14px;font-size:13px}' +
    '.row{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}label{font-size:12px;color:#6B6964;font-weight:500}' +
    'input{height:34px;border:1px solid #E2E0DA;border-radius:9px;padding:0 10px;font-size:13px;color:#141414}input:focus{outline:none;border-color:#2447F9;box-shadow:0 0 0 3px #E9EDFE}' +
    '.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-weight:600}' +
    '.x{border:0;background:none;color:#6B6964;font-size:16px;cursor:pointer}' +
    '.meta{font-size:12px;color:#6B6964;margin-bottom:10px}.warn{color:#B45309}' +
    '.go{width:100%;height:36px;border-radius:999px;border:0;background:#2447F9;color:#fff;font-weight:600;cursor:pointer}.go:disabled{opacity:.6}' +
    '.msg{margin-top:10px;font-size:12.5px}.msg a{color:#2447F9}.err{color:#E11D48}' +
    '</style>' +
    '<button class="fab" part="fab">' +
    '<svg width="14" height="14" viewBox="0 0 22 22" fill="none" stroke-width="2.4" stroke-linecap="round"><path d="M3 8V3h5M19 14v5h-5" stroke="#fff"/><path d="M11 1v20" stroke="#fff"/></svg>' +
    'Save to Mailtrack</button>' +
    '<div class="panel" hidden>' +
    '<div class="head"><span>Save to Mailtrack</span><button class="x" aria-label="Close">×</button></div>' +
    '<div class="row"><label>Company</label><input name="company"></div>' +
    '<div class="row"><label>Role</label><input name="role"></div>' +
    '<div class="meta"></div>' +
    '<button class="go">Save to Wishlist</button>' +
    '<div class="msg"></div>' +
    '</div>';

  var fab = shadow.querySelector('.fab');
  var panel = shadow.querySelector('.panel');
  var company = shadow.querySelector('input[name=company]');
  var role = shadow.querySelector('input[name=role]');
  var meta = shadow.querySelector('.meta');
  var go = shadow.querySelector('.go');
  var msg = shadow.querySelector('.msg');
  var data = null;
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function open() {
    data = window.mailtrackExtract(document, location.href);
    if (!data) return;
    company.value = data.company;
    role.value = data.role;
    var bits = [];
    if (data.location) bits.push(esc(data.location));
    if (data.salary) bits.push(esc(data.salary));
    if (data.postedAt) {
      var days = Math.floor((Date.now() - Date.parse(data.postedAt)) / 864e5);
      bits.push('<span class="' + (days > 30 ? 'warn' : '') + '">posted ' + (days <= 0 ? 'today' : days + ' days ago') + '</span>');
    }
    if (data.reposted) bits.push('<span class="warn">reposted</span>');
    meta.innerHTML = bits.join(' · ');
    msg.textContent = '';
    go.disabled = false;
    fab.hidden = true;
    panel.hidden = false;
    (company.value ? role : company).focus();
  }

  fab.addEventListener('click', open);
  shadow.querySelector('.x').addEventListener('click', function () {
    panel.hidden = true;
    fab.hidden = false;
  });
  go.addEventListener('click', function () {
    if (!company.value.trim()) {
      msg.innerHTML = '<span class="err">Add the company name.</span>';
      return;
    }
    go.disabled = true;
    msg.textContent = 'Saving…';
    var payload = Object.assign({}, data, { company: company.value.trim(), role: role.value.trim() });
    chrome.runtime.sendMessage({ type: 'capture', data: payload }, function (res) {
      if (!res || !res.ok) {
        go.disabled = false;
        msg.innerHTML =
          res && res.status === 401
            ? '<span class="err">Sign in at <a href="https://track.shotline.in/app" target="_blank">track.shotline.in</a> in this Chrome profile, then try again.</span>'
            : '<span class="err">' + esc((res && res.message) || 'Could not save. Try again.') + '</span>';
        return;
      }
      var a = res.application;
      msg.innerHTML =
        (res.created ? 'Saved to your Wishlist. ' : 'Already in your pipeline; updated. ') +
        '<a href="https://track.shotline.in/app/#/a/' + encodeURIComponent(a._id) + '" target="_blank">Open</a>';
    });
  });

  document.documentElement.appendChild(host);
  window.__mailtrackJob = { open: open };
  if (window.__mailtrackOpenNow) open();
})();
