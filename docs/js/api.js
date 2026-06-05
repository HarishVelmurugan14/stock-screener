// StockIQ — API layer (Apps Script Web App calls) + write token

// ── Request ─────────────────────────────────────────────────────────────────
// GET-only: Apps Script returns CORS-safe responses for GET (the
// googleusercontent redirect carries Access-Control-Allow-Origin); POST needs a
// doPost handler and is avoided. Keep payloads small — large ones (the pasted
// analysis) are split into per-stock calls by the caller so each URL stays short.
// The write token (if set on this device) rides along on every call.
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
  if (!json.success) {
    // A stale/wrong stored key surfaces the gate again from anywhere.
    if (json.error === 'unauthorized' && typeof showGate === 'function') showGate(true);
    throw new Error(json.error || 'Request failed');
  }
  return json.data;
}
