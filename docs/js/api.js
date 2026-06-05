// StockIQ — API layer (Apps Script Web App calls) + write token

// ── Request ─────────────────────────────────────────────────────────────────
// GET-only: Apps Script returns CORS-safe responses for GET (via the
// googleusercontent redirect); cross-origin POST from a browser trips CORS.
// The write token (if set on this device) rides along on every call — harmless
// for reads, required for gated writes (add/sell/config).
async function api(action, dataObj) {
  if (!WEB_APP_URL || WEB_APP_URL.indexOf('PASTE_') === 0) {
    throw new Error('WEB_APP_URL is not set in js/config.js');
  }
  const tok = localStorage.getItem('stockiq_token');
  const payload = tok ? { ...(dataObj || {}), token: tok } : dataObj;
  let url = WEB_APP_URL + '?action=' + encodeURIComponent(action);
  if (payload) url += '&data=' + encodeURIComponent(JSON.stringify(payload));

  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Request failed');
  return json.data;
}

// ── Write token ─────────────────────────────────────────────────────────────
function setTokenPrompt() {
  const cur = localStorage.getItem('stockiq_token') || '';
  const t = prompt(
    'Write token — must match the one set via TEST_setApiToken() in Apps Script.\n' +
    'Leave blank to clear. (Stored only in this browser.)', cur);
  if (t === null) return;
  if (t.trim()) {
    localStorage.setItem('stockiq_token', t.trim());
    toast('Token saved on this device');
  } else {
    localStorage.removeItem('stockiq_token');
    toast('Token cleared');
  }
}
