// StockIQ — dashboard rendering, interactions, bootstrap

// ── Utilities ───────────────────────────────────────────────────────────────
function fmt(n, dp) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
}

function rupee(n, dp) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
  return '₹' + fmt(n, dp === undefined ? 2 : dp);
}

function ago(iso) {
  if (!iso) return 'no data';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// Sheet datetime 'yyyy-MM-dd HH:mm' -> ISO-ish (IST) so ago() can parse it.
function toISO(s) {
  if (!s) return null;
  if (String(s).indexOf('T') > 0) return s;
  return String(s).replace(' ', 'T') + ':00+05:30';
}

function toast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok === false ? 'bad' : 'ok');
  setTimeout(() => { t.className = 'toast'; }, 3200);
}

function errBox(containerId, e) {
  document.getElementById(containerId).innerHTML =
    '<div class="err">⚠ ' + (e.message || e) + ' <button class="btn small ml-8" data-act="reload">Retry</button></div>';
}

// Promise-based confirm modal (house style bans window.confirm).
function uiConfirm(message) {
  return new Promise(resolve => {
    const bg = document.getElementById('confirmBg');
    const yes = document.getElementById('confirmYes');
    const no = document.getElementById('confirmNo');
    document.getElementById('confirmMsg').textContent = message;
    bg.classList.add('show');
    const done = val => {
      bg.classList.remove('show');
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      resolve(val);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
  });
}

// ── Market health ─────────────────────────────────────────────────────────
async function loadHealth() {
  try {
    const [h, s] = await Promise.all([api('getMarketHealth'), api('getPortfolioSummary')]);
    _health = h;
    _summary = s;
    _config.paper = s.paperTradeMode;

    const badge = document.getElementById('modeBadge');
    badge.textContent = s.paperTradeMode ? 'PAPER' : 'LIVE ₹';
    badge.className = 'pill mode-badge ' + (s.paperTradeMode ? 'blue' : 'red');

    const statusPill = h.isAbove200DMA === null
      ? '<span class="pill grey">◌ DATA BUILDING</span>'
      : (h.isAbove200DMA ? '<span class="pill green">🟢 HEALTHY</span>' : '<span class="pill red">🔴 CAUTION</span>');
    const dma = h.dma200 ? fmt(h.dma200, 0) : 'building ' + (h.samples || 0) + '/200';
    const pct = s.phaseCapitalLimit ? Math.min(100, (s.capitalDeployed / s.phaseCapitalLimit) * 100) : 0;

    document.getElementById('healthBody').innerHTML =
      '<div class="health-row">' +
        '<div class="stat health-stat"><div class="k">Nifty 50</div><div class="v">' + fmt(h.currentLevel, 0) + '</div>' +
          '<div class="sub">200 DMA: ' + dma + '</div></div>' +
        '<div class="stat health-stat"><div class="k">Market</div><div class="v">' + statusPill + '</div></div>' +
        '<div class="stat health-stat"><div class="k">Phase capital</div><div class="v">' +
          rupee(s.capitalDeployed) + ' / ' + rupee(s.phaseCapitalLimit, 0) + '</div>' +
          '<div class="progress"><div class="progress-bar' + (pct > 90 ? ' danger' : '') + '" style="width:' + pct + '%"></div></div></div>' +
      '</div>';
    document.getElementById('healthFresh').textContent = 'updated ' + ago(h.fetchedAt) + (h._stale ? ' · stale' : '');
  } catch (e) {
    errBox('healthBody', e);
  }
}

// ── Alerts ──────────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const a = await api('getAlerts');
    const wrap = document.getElementById('alertsWrap');
    if (!a.open.length) { wrap.innerHTML = ''; return; }

    let html = '<div class="panel"><div class="spread"><h2>⚡ Active Alerts <span class="pill red">' +
      a.openCount + '</span></h2></div><div class="mt-10">';
    a.open.forEach(al => {
      const pri = ALERT_PRI[al.alert_type] || 6;
      const action = al.action_required ? ' <b class="action">→ ' + al.action_required + '</b>' : '';
      html += '<div class="alert p' + pri + '">' +
        '<div class="ico">' + (ALERT_ICON[al.alert_type] || '•') + '</div>' +
        '<div class="msg"><div class="t">' + al.symbol + ' · ' + al.alert_type.replace(/_/g, ' ') + '</div>' +
          '<div class="d">' + al.message + action + '</div></div>' +
        '<button class="btn small" data-act="markDone" data-created="' + (al.created_at || '') +
          '" data-symbol="' + al.symbol + '" data-type="' + al.alert_type + '">Mark done</button>' +
      '</div>';
    });
    wrap.innerHTML = html + '</div></div>';
  } catch (e) {
    errBox('alertsWrap', e);
  }
}

async function markDone(createdAt, symbol, type) {
  try {
    await api('actionAlert', createdAt ? { created_at: createdAt } : { symbol, alert_type: type });
    toast('Alert cleared');
    loadAlerts();
  } catch (e) {
    toast(e.message, false);
  }
}

// ── Opportunities ─────────────────────────────────────────────────────────
async function loadOpportunities() {
  try {
    const d = await api('getOpportunityData');
    _opps = d.opportunities;
    _oppSymbols = d.opportunities.map(o => o.symbol);
    const analyzed = d.analyzedCount || 0;
    const n = d.shortlistSize || 5;

    document.getElementById('oppCount').textContent =
      d.count ? '(' + d.count + ' candidates · top ' + n + ' shortlisted · 🔬' + analyzed + ' analyzed)' : '';
    document.getElementById('oppFresh').textContent = d.lastUpdated ? 'screened ' + ago(toISO(d.lastUpdated)) : '';
    document.getElementById('deepPanel').classList.toggle('hidden', !d.count);

    if (!d.opportunities.length) {
      document.getElementById('oppBody').innerHTML =
        '<div class="center">No opportunities meet the criteria right now.<br>' +
        '<span class="sub">This is intentional — quality over quantity. Capital waits.</span></div>';
      return;
    }

    const shortlist = d.opportunities.filter(o => o.shortlisted);
    const bench = d.opportunities.filter(o => !o.shortlisted);
    let html = '';

    // 10-name candidate strip (max 3 per sector) — quick glance over the pool.
    const chips = d.opportunities.map(o =>
      '<span class="chip' + (o.shortlisted ? ' short' : '') + '">' + (o.shortlisted ? '★ ' : '') + o.symbol +
      '<span class="chip-sec">' + (o.sector || '') + '</span></span>').join('');
    html += '<div class="sub mb-8">' + d.count + ' candidates · max 3 per sector · ★ = shortlist</div>';
    html += '<div class="chips">' + chips + '</div>';

    if (d.noConviction) {
      html += '<div class="err mb-12">⚠️ No high-conviction ideas right now — every analyzed name looks ' +
        'fundamentally weak. Holding cash is a valid move; don\'t force a buy.</div>';
    }
    html += '<div class="sub mb-8">★ SHORTLIST — best ' + n + ' by valuation + fundamentals</div>';
    html += '<div class="opps">' + shortlist.map(oppCard).join('') + '</div>';
    if (bench.length) {
      html += '<div class="sub mt-16 mb-8">Bench — also cheap; analyze fundamentals, may rotate into the shortlist</div>';
      html += '<div class="opps">' + bench.map(oppCard).join('') + '</div>';
    }
    document.getElementById('oppBody').innerHTML = html;
  } catch (e) {
    errBox('oppBody', e);
  }
}

function oppCard(o) {
  const disc = (o.pe_discount_pct !== '' && o.pe_discount_pct !== null) ? Number(o.pe_discount_pct).toFixed(0) + '%' : '—';
  const cheap = Number(o.pe_discount_pct) < 0 ? 'v pos' : '';
  const usingDD = o.avg_pe_5yr === '' || o.avg_pe_5yr === null;   // GF drawdown vs PE-average
  const valLine = usingDD
    ? '<div class="kv"><span class="lbl">Off 52wk high</span><span class="' + cheap + '">' + disc + '</span></div>'
    : '<div class="kv"><span class="lbl">Avg PE</span><span>' + fmt(o.avg_pe_5yr, 1) + 'x <span class="' + cheap + '">(' + disc + ')</span></span></div>';
  const mark = (o.shortlisted ? '★ ' : '') + (o.analyzed ? '🔬' : '⚠️');

  return '<div class="card ' + o.valuation_status + '">' +
    '<div class="head"><div><div class="sym">' + mark + ' ' + o.symbol + '</div>' +
      '<div class="sub card-sector">' + (o.sector || '') + '</div>' +
      '<div class="price">' + rupee(o.current_price) + '</div></div>' +
      '<span class="pill pill-head">' + o.valuation_status.replace('_', ' ') + '</span></div>' +
    '<div class="body">' +
      '<div class="kv"><span class="lbl">Current PE</span><span>' + fmt(o.current_pe, 1) + 'x</span></div>' +
      valLine +
      '<div class="kv"><span class="lbl">Valuation conf.</span><span>' + fmt(o.confidence_score, 0) + '/100</span></div>' +
      '<div class="kv"><span class="lbl">Risk : Reward</span><span>1 : ' + fmt(o.risk_reward_ratio, 1) + '</span></div>' +
      deepBlock(o) +
      '<div class="targets">' +
        '<div class="tbox t1"><div class="t">Target 1</div><div class="n">' + rupee(o.target_1_price, 0) + '</div><div class="sub">+' + fmt(o.target_1_upside_pct, 0) + '%</div></div>' +
        '<div class="tbox t2"><div class="t">Target 2</div><div class="n">' + rupee(o.target_2_price, 0) + '</div><div class="sub">+' + fmt(o.target_2_upside_pct, 0) + '%</div></div>' +
        '<div class="tbox sl"><div class="t">Stop</div><div class="n">' + rupee(o.stop_loss_price, 0) + '</div><div class="sub">-' + fmt(o.stop_loss_pct, 0) + '%</div></div>' +
      '</div>' +
      '<div class="reason"><b>WHY:</b> ' + (o.entry_reason || '') + '</div>' +
      '<div class="reason exit"><b>EXIT IF:</b> ' + (o.exit_reason || '') + '</div>' +
      '<div class="reason risk"><b>RISK:</b> ' + (o.risk_reason || '') + '</div>' +
      '<button class="btn primary" data-act="openModal" data-symbol="' + o.symbol + '" data-price="' + (o.current_price || 0) + '">Add to Portfolio</button>' +
    '</div></div>';
}

function deepBlock(o) {
  const d = o.deep;
  if (!d) {
    return '<div class="reason none"><b>FUNDAMENTALS:</b> ⚠️ Not analyzed yet — use “Copy Analysis Prompt” below (3 min via Claude).</div>';
  }
  const chk = v => (v !== '' && v !== null && !isNaN(Number(v))) ? (Number(v) >= 15 ? '✅' : Number(v) >= 10 ? '•' : '⚠️') : '';
  const flags = (s, icon) => {
    const a = (s || '').split('|').map(x => x.trim()).filter(Boolean);
    return a.length ? '<div class="sub">' + icon + ' ' + a.join('<br>' + icon + ' ') + '</div>' : '';
  };
  const stale = o.fundamentals_stale ? ' <span class="pill amber">' + o.fundamentals_age_days + 'd old — re-analyse</span>' : '';
  const pill = VERDICT_PILL[String(d.verdict).toUpperCase()] || 'grey';

  return '<div class="reason fund">' +
    '<div class="spread mb-4"><b>FUNDAMENTALS <span class="faint">(AI est.)</span></b>' +
      '<span class="pill ' + pill + '">' + (d.verdict || '—') + ' · ' + fmt(d.confidence, 0) + '</span></div>' +
    '<div class="kv"><span class="lbl">Rev CAGR 5y</span><span>' + fmt(d.revenue_cagr_5yr, 1) + '% ' + chk(d.revenue_cagr_5yr) + '</span></div>' +
    '<div class="kv"><span class="lbl">Profit CAGR 5y</span><span>' + fmt(d.profit_cagr_5yr, 1) + '% ' + chk(d.profit_cagr_5yr) + '</span></div>' +
    '<div class="kv"><span class="lbl">ROE 5y avg</span><span>' + fmt(d.roe_avg_5yr, 1) + '% ' + chk(d.roe_avg_5yr) + '</span></div>' +
    '<div class="kv"><span class="lbl">Debt/Equity</span><span>' + fmt(d.debt_to_equity, 2) + ' (' + (d.debt_trend || '—') + ')</span></div>' +
    '<div class="kv"><span class="lbl">Promoter</span><span>' + fmt(d.promoter_holding, 1) + '% (' + (d.promoter_trend || '—') + '), pledge ' + fmt(d.promoter_pledge, 1) + '%</span></div>' +
    '<div class="kv"><span class="lbl">AI risk</span><span>' + (d.ai_disruption_risk || '—') + '</span></div>' +
    (d.business_moat ? '<div class="sub mt-4">✅ Moat: ' + d.business_moat + '</div>' : '') +
    flags(d.red_flags, '⚠️') + flags(d.green_flags, '✅') + stale +
  '</div>';
}

// ── Fundamental analysis (human-in-the-loop) ────────────────────────────────
function buildDeepPrompt(symbols) {
  return [
    'You are a fundamental analyst for Indian large-cap (NSE) stocks.',
    'Analyse these stocks and return ONLY a single JSON object — no prose, no markdown, no backticks.',
    'If you add ANY text outside the JSON, the tool fails to parse it.',
    '',
    'Stocks: ' + symbols.join(', '),
    '',
    'For EACH stock return these keys:',
    'revenue_cagr_3yr, revenue_cagr_5yr, profit_cagr_3yr, profit_cagr_5yr (numbers, %),',
    'roe_latest, roe_avg_3yr, roe_avg_5yr, roce_latest (numbers, %),',
    'debt_to_equity (number), debt_trend (INCREASING|DECREASING|STABLE|ZERO),',
    'cf_quality (Operating CF / Net Profit, number),',
    'promoter_holding, promoter_pledge (numbers, %), promoter_trend (INCREASING|DECREASING|STABLE),',
    'red_flags (array of strings), green_flags (array of strings),',
    'business_moat (one line), ai_disruption_risk (\'HIGH|MEDIUM|LOW — reason\'),',
    'verdict (STRONG|MODERATE|WEAK|AVOID), confidence (0-100), analysis_date (YYYY-MM-DD).',
    '',
    'Be conservative. If unsure of a number, give your best estimate AND add to red_flags: \'Data unverified — manual check recommended\'.',
    '',
    'Shape (keys are the stock symbols):',
    '{ "' + (symbols[0] || 'SYM') + '": { "revenue_cagr_5yr": 11.4, "profit_cagr_5yr": 13.8, "roe_avg_5yr": 41.8, ' +
      '"debt_to_equity": 0.0, "debt_trend": "ZERO", "cf_quality": 0.94, "promoter_holding": 72.3, "promoter_pledge": 0.0, ' +
      '"promoter_trend": "STABLE", "red_flags": [], "green_flags": ["Zero debt"], "business_moat": "...", ' +
      '"ai_disruption_risk": "MEDIUM — ...", "verdict": "STRONG", "confidence": 88, "analysis_date": "' +
      new Date().toISOString().slice(0, 10) + '" } }',
  ].join('\n');
}

async function copyDeepPrompt() {
  if (!_oppSymbols.length) { toast('No opportunities to analyse', false); return; }
  const text = buildDeepPrompt(_oppSymbols);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Prompt copied — paste into Claude.ai');
  } catch (e) {
    document.getElementById('deepJson').value = text;   // last resort: copy manually
    deepCount();
    toast('Copy blocked — prompt placed in the box; copy it manually', false);
  }
}

function deepCount() {
  const len = (document.getElementById('deepJson').value || '').length;
  document.getElementById('deepCountLbl').textContent = len + ' chars';
}

function cleanJson(s) {
  let t = (s || '').trim();
  if (t.indexOf('```') >= 0) t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

async function saveDeep() {
  const box = document.getElementById('deepJson');
  let parsed;
  try {
    parsed = JSON.parse(cleanJson(box.value));
  } catch (e) {
    toast('Invalid JSON — check Claude\'s reply and retry', false);
    return;
  }
  const symbols = Object.keys(parsed).filter(k => parsed[k] && typeof parsed[k] === 'object');
  if (!symbols.length) { toast('No stock objects found in the JSON', false); return; }

  const btn = document.getElementById('saveDeepBtn');
  btn.disabled = true;
  // One stock per request — keeps each URL short (no doPost / URL-length issues).
  let saved = 0;
  try {
    for (const sym of symbols) {
      btn.textContent = 'Saving ' + (saved + 1) + '/' + symbols.length + '…';
      await api('saveDeepAnalysis', { analysis: { [sym]: parsed[sym] } });
      saved++;
    }
    toast('Saved fundamentals for ' + saved + ' stock(s)');
    document.getElementById('deepFresh').textContent = 'saved just now';
    box.value = '';
    deepCount();
    loadOpportunities();
  } catch (e) {
    toast('Saved ' + saved + '/' + symbols.length + ' — ' + e.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save Fundamental Data';
  }
}

// ── Buy plan ────────────────────────────────────────────────────────────────
// Score-weighted, whole-share allocation across the shortlist within available
// capital. Tranches in a weak market (deploy ~60%, keep dry powder), caps any
// single name at 40% (when >=3 names), then tops up leftover by conviction.
function buildBuyPlan(capital) {
  const caution = _health && _health.isAbove200DMA === false;
  const deployFrac = caution ? 0.6 : 1.0;
  const deployable = Math.floor(capital * deployFrac);
  const reserved = capital - deployable;

  const eligible = (_opps || []).filter(o =>
    o.shortlisted &&
    (o.valuation_status === 'STRONG_BUY' || o.valuation_status === 'BUY') &&
    o.verdict !== 'WEAK' && o.verdict !== 'AVOID' &&
    Number(o.current_price) > 0 && Number(o.current_price) <= deployable);

  if (!eligible.length) {
    return { rows: [], deployable, reserved, invested: 0, leftover: deployable, caution,
      note: 'No buy-worthy names within budget right now — holding cash is fine.' };
  }

  const n = eligible.length;
  const maxW = n >= 3 ? 0.40 : 0.60;                       // per-name concentration cap
  const cap = Math.floor(deployable * maxW);
  const totalScore = eligible.reduce((a, o) => a + (Number(o.final_score) || Number(o.confidence_score) || 1), 0);

  // Base whole-share allocation, weighted by score, clamped to the cap.
  const plan = eligible.map(o => {
    const score = Number(o.final_score) || Number(o.confidence_score) || 1;
    const price = Number(o.current_price);
    const target = Math.min(deployable * (score / totalScore), cap);
    return { o, price, score, shares: Math.floor(target / price) };
  });

  // Greedy top-up: spend leftover on the highest-score name that still fits.
  let spent = plan.reduce((a, p) => a + p.shares * p.price, 0);
  let leftover = deployable - spent;
  let added = true;
  while (added) {
    added = false;
    const cands = plan.filter(p => p.price <= leftover && (p.shares + 1) * p.price <= cap);
    if (cands.length) {
      cands.sort((a, b) => b.score - a.score);
      cands[0].shares += 1;
      leftover -= cands[0].price;
      spent += cands[0].price;
      added = true;
    }
  }

  const rows = plan.filter(p => p.shares > 0).map(p => ({
    symbol: p.o.symbol, sector: p.o.sector || '', status: p.o.valuation_status,
    verdict: p.o.verdict, score: Math.round(p.score), price: p.price,
    shares: p.shares, amount: p.shares * p.price,
    weight: spent > 0 ? (p.shares * p.price / spent) * 100 : 0,
  })).sort((a, b) => b.amount - a.amount);

  const sectorMix = {};
  rows.forEach(r => { sectorMix[r.sector] = (sectorMix[r.sector] || 0) + r.amount; });

  return { rows, deployable, reserved, invested: spent, leftover: deployable - spent, caution, sectorMix, note: null };
}

function renderBuyPlan() {
  const inp = document.getElementById('planCapital');
  let capital = Number(inp.value);
  if (!capital || capital <= 0) {
    capital = (_summary && _summary.capitalRemaining) || 0;
    if (capital > 0) inp.value = capital;
  }
  const body = document.getElementById('planBody');
  if (!capital || capital <= 0) {
    body.innerHTML = '<div class="center">No capital available within the phase limit. Free up capital or raise the limit in config.</div>';
    return;
  }
  if (!_opps || !_opps.length) {
    body.innerHTML = '<div class="center">No opportunities to plan from yet.</div>';
    return;
  }

  const p = buildBuyPlan(capital);
  if (!p.rows.length) {
    body.innerHTML = '<div class="center">' + p.note + '</div>';
    return;
  }

  let html = '';
  if (p.caution) {
    html += '<div class="reason exit mb-12"><b>Market caution:</b> Nifty is below its 200-DMA, so this plan deploys ' +
      'only ~60% now (' + rupee(p.deployable, 0) + ') and keeps ' + rupee(p.reserved, 0) + ' as dry powder for a deeper dip.</div>';
  }
  html += '<div class="grid pf-summary mb-12">' +
    statCard('Deploy now', rupee(p.invested, 0)) +
    statCard('Leftover cash', rupee(p.leftover, 0)) +
    statCard('Dry powder', rupee(p.reserved, 0)) +
    statCard('Names', String(p.rows.length)) +
    '</div>';

  html += '<div class="scroll-x"><table><thead><tr>' +
    '<th>Stock</th><th>Price</th><th>Shares</th><th>Amount</th><th>Weight</th>' +
    '<th class="hide">Score</th><th>Add</th></tr></thead><tbody>';
  p.rows.forEach(r => {
    html += '<tr>' +
      '<td><b>' + r.symbol + '</b><div class="sub">' + r.sector + '</div></td>' +
      '<td>' + rupee(r.price) + '</td>' +
      '<td>' + r.shares + '</td>' +
      '<td>' + rupee(r.amount, 0) + '</td>' +
      '<td>' + fmt(r.weight, 0) + '%</td>' +
      '<td class="hide">' + r.score + '</td>' +
      '<td><button class="btn small" data-act="planAdd" data-symbol="' + r.symbol + '" data-price="' + r.price + '" data-qty="' + r.shares + '">Add</button></td>' +
    '</tr>';
  });
  html += '</tbody></table></div>';

  const mix = Object.keys(p.sectorMix).sort((a, b) => p.sectorMix[b] - p.sectorMix[a])
    .map(s => s + ' ' + Math.round(p.sectorMix[s] / p.invested * 100) + '%').join(' · ');
  html += '<div class="sub mt-8">Sector mix: ' + mix + ' · whole shares only · suggestion, verify before buying.</div>';

  body.innerHTML = html;
}

// ── Portfolio ─────────────────────────────────────────────────────────────
async function loadPortfolio() {
  try {
    const d = await api('getPortfolioData');
    const s = d.summary;
    document.getElementById('pfFresh').textContent = 'updated ' + ago(s.timestamp);
    document.getElementById('pfSummary').innerHTML =
      statCard('Invested', rupee(s.totalInvested)) +
      statCard('Current', rupee(s.currentValue)) +
      statCard('P&L', rupee(s.totalPnL) + ' (' + fmt(s.totalPnLPct, 1) + '%)', s.totalPnL >= 0 ? 'pos' : 'neg') +
      statCard('Positions', s.positionCount) +
      statCard('Capital left', rupee(s.capitalRemaining));

    const active = d.positions.filter(p => Number(p.quantity) > 0);
    if (!active.length) {
      document.getElementById('pfBody').innerHTML = '<div class="center">No open positions yet. Add one from an opportunity above.</div>';
      return;
    }

    let html = '<div class="scroll-x"><table><thead><tr>' +
      '<th>Stock</th><th>LTP</th><th class="hide">Qty</th><th class="hide">Invested</th>' +
      '<th>Value</th><th>P&L</th><th class="hide">T1 / T2 / SL</th><th>Status</th><th>Actions</th>' +
      '</tr></thead><tbody>';
    active.forEach(p => {
      const pnl = Number(p.unrealised_pnl) || 0;
      const cls = pnl >= 0 ? 'v pos' : 'v neg';
      const paper = (p.paper_trade === true || String(p.paper_trade).toUpperCase() === 'TRUE') ? 'paper' : 'live';
      const status = p.alert_status || 'HOLD';
      html += '<tr>' +
        '<td><b>' + p.symbol + '</b><div class="sub">' + paper + ' · ' + (p.days_held || 0) + 'd</div></td>' +
        '<td>' + rupee(p.current_price) + '</td>' +
        '<td class="hide">' + fmt(p.quantity, 0) + '</td>' +
        '<td class="hide">' + rupee(p.invested_amount) + '</td>' +
        '<td>' + rupee(p.current_value) + '</td>' +
        '<td class="' + cls + '">' + rupee(pnl) + '<div class="sub ' + cls + '">' + fmt(p.unrealised_pnl_pct, 1) + '%</div></td>' +
        '<td class="hide sub">' + rupee(p.target_1_price, 0) + ' / ' + rupee(p.target_2_price, 0) + ' / ' + rupee(p.stop_loss_price, 0) + '</td>' +
        '<td><span class="badge ' + status + '">' + status.replace(/_/g, ' ') + '</span></td>' +
        '<td><button class="btn small" data-act="book" data-id="' + p.id + '" data-pct="50">Book 50%</button> ' +
          '<button class="btn small danger" data-act="book" data-id="' + p.id + '" data-pct="100">Exit</button></td>' +
      '</tr>';
    });
    document.getElementById('pfBody').innerHTML = html + '</tbody></table></div>';
  } catch (e) {
    errBox('pfBody', e);
  }
}

function statCard(k, v, cls) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v v-sm ' + (cls || '') + '">' + v + '</div></div>';
}

async function book(id, pct) {
  const ok = await uiConfirm(pct === 100 ? 'Exit this position fully?' : 'Book 50% of this position?');
  if (!ok) return;
  try {
    const r = await api('bookProfit', { positionId: id, percentage: pct });
    toast('Booked ' + r.soldQty + ' @ ' + rupee(r.price) + ' · profit ' + rupee(r.profit));
    loadAll();
  } catch (e) {
    toast(e.message, false);
  }
}

// ── Screener ────────────────────────────────────────────────────────────────
function toggleScreener() {
  const panel = document.getElementById('scrPanel');
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  document.getElementById('scrCaret').textContent = open ? '▾' : '▸';
  if (open && !_scrLoaded) loadScreener();
}

async function loadScreener() {
  try {
    const d = await api('getScreenerData');
    _screenerRows = d.rows;
    _scrLoaded = true;
    document.getElementById('scrCounts').textContent =
      '(✓' + (d.counts.PASS || 0) + ' ✗' + (d.counts.FAIL || 0) + ' ◌' + (d.counts.INSUFFICIENT_DATA || 0) + ')';
    document.getElementById('scrFresh').textContent = d.lastUpdated ? 'screened ' + ago(toISO(d.lastUpdated)) : 'never run';
    const sectors = [...new Set(d.rows.map(r => r.sector).filter(Boolean))].sort();
    document.getElementById('scrSector').innerHTML =
      '<option value="">All sectors</option>' + sectors.map(s => '<option>' + s + '</option>').join('');
    renderScreener();
  } catch (e) {
    errBox('scrBody', e);
  }
}

function renderScreener() {
  const sec = document.getElementById('scrSector').value;
  const st = document.getElementById('scrStatus').value;
  const sort = document.getElementById('scrSort').value;
  const rows = _screenerRows
    .filter(r => (!sec || r.sector === sec) && (!st || r.screening_status === st))
    .sort((a, b) => (Number(b[sort]) || -999) - (Number(a[sort]) || -999));
  if (!rows.length) {
    document.getElementById('scrBody').innerHTML = '<div class="center">No rows. Run the screener first.</div>';
    return;
  }
  const sc = s => s === 'PASS' ? 'green' : s === 'FAIL' ? 'red' : 'grey';
  let html = '<div class="scroll-x"><table><thead><tr>' +
    '<th>Stock</th><th>Sector</th><th>Rev CAGR</th><th>Profit CAGR</th><th>ROE</th>' +
    '<th class="hide">D/E</th><th>Conf</th><th>Status</th><th class="hide">Reasons</th>' +
    '</tr></thead><tbody>';
  rows.forEach(r => {
    html += '<tr>' +
      '<td><b>' + r.symbol + '</b></td><td class="sub">' + (r.sector || '') + '</td>' +
      '<td>' + fmt(r.revenue_cagr_5yr, 1) + '%</td><td>' + fmt(r.profit_cagr_5yr, 1) + '%</td>' +
      '<td>' + fmt(r.roe_avg_5yr, 1) + '%</td><td class="hide">' + fmt(r.debt_to_equity, 2) + '</td>' +
      '<td>' + fmt(r.confidence_score, 0) + '</td>' +
      '<td><span class="pill ' + sc(r.screening_status) + '">' + r.screening_status.replace('INSUFFICIENT_DATA', 'NO DATA') + '</span></td>' +
      '<td class="hide sub reasons">' + (r.fail_reasons || '') + '</td>' +
    '</tr>';
  });
  document.getElementById('scrBody').innerHTML = html + '</tbody></table></div>';
}

async function runFullScreener() {
  const ok = await uiConfirm('Run the full fundamental screen now? Takes a few minutes; normally automatic on Sundays.');
  if (!ok) return;
  const btn = document.getElementById('runScrBtn');
  btn.disabled = true;
  btn.textContent = 'Running… (keep tab open)';
  try {
    const r = await api('runFundamentalScreener');
    toast('Screen done: ' + r.passed + ' pass / ' + r.failed + ' fail / ' + r.insufficient + ' no-data');
    _scrLoaded = false;
    loadScreener();
  } catch (e) {
    toast(e.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Full Screener (weekly · ~10–15 min)';
  }
}

// ── Add-position modal ──────────────────────────────────────────────────────
function openModal(symbol, price, qty) {
  document.getElementById('mSymbol').value = symbol;
  document.getElementById('mPrice').value = price || '';
  document.getElementById('mQty').value = qty || '';
  document.getElementById('mWarn').textContent = _config.paper
    ? 'Paper-trade mode: this is simulated, no real order.'
    : 'LIVE mode: this will mirror to your real-money sheet.';
  mCalc();
  document.getElementById('modalBg').classList.add('show');
}

function closeModal() {
  document.getElementById('modalBg').classList.remove('show');
}

function mCalc() {
  const p = Number(document.getElementById('mPrice').value) || 0;
  const q = Number(document.getElementById('mQty').value) || 0;
  document.getElementById('mAmt').value = (p && q) ? rupee(p * q) : '';
}

async function confirmAdd() {
  const symbol = document.getElementById('mSymbol').value;
  const entry_price = Number(document.getElementById('mPrice').value);
  const quantity = Number(document.getElementById('mQty').value);
  if (!entry_price || !quantity) { toast('Enter price and quantity', false); return; }
  const btn = document.getElementById('mConfirm');
  btn.disabled = true;
  try {
    const r = await api('addPosition', { symbol, entry_price, quantity });
    if (r.success === false) {
      toast(r.error + (r.detail ? ' — ' + r.detail : ''), false);
    } else {
      toast('Added ' + symbol + (r.warnings && r.warnings.length ? ' (with warnings)' : ''));
      closeModal();
      loadAll();
    }
  } catch (e) {
    toast(e.message, false);
  } finally {
    btn.disabled = false;
  }
}

// ── Key gate ────────────────────────────────────────────────────────────────
function showGate(invalid) {
  const gate = document.getElementById('gate');
  document.getElementById('gateErr').classList.toggle('hidden', !invalid);
  gate.classList.add('show');
  const input = document.getElementById('gateInput');
  input.value = '';
  input.focus();
}

// Validate the entered key with one real call. 'unauthorized' -> reject;
// success -> unlock; any other (network) error -> let in, matching VaultZero.
async function tryUnlock() {
  const input = document.getElementById('gateInput');
  const btn = document.getElementById('gateBtn');
  const key = input.value.trim();
  if (!key) return;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  localStorage.setItem('stockiq_token', key);
  try {
    await api('getConfig');
    document.getElementById('gate').classList.remove('show');
    loadAll();
  } catch (e) {
    if (e.message === 'unauthorized') {
      localStorage.removeItem('stockiq_token');
      showGate(true);
    } else {
      document.getElementById('gate').classList.remove('show');
      loadAll();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

function reKey() {
  localStorage.removeItem('stockiq_token');
  showGate(false);
}

// ── Event wiring ────────────────────────────────────────────────────────────
function wireEvents() {
  document.getElementById('tokenBtn').addEventListener('click', reKey);
  document.getElementById('refreshAll').addEventListener('click', loadAll);
  document.getElementById('copyPromptBtn').addEventListener('click', copyDeepPrompt);
  document.getElementById('saveDeepBtn').addEventListener('click', saveDeep);
  document.getElementById('deepJson').addEventListener('input', deepCount);
  document.getElementById('scrHeader').addEventListener('click', toggleScreener);
  document.getElementById('runScrBtn').addEventListener('click', runFullScreener);
  document.getElementById('mCancel').addEventListener('click', closeModal);
  document.getElementById('mConfirm').addEventListener('click', confirmAdd);
  document.getElementById('mQty').addEventListener('input', mCalc);
  document.getElementById('planBtn').addEventListener('click', renderBuyPlan);
  document.getElementById('planCapital').addEventListener('keydown', e => { if (e.key === 'Enter') renderBuyPlan(); });
  document.getElementById('gateBtn').addEventListener('click', tryUnlock);
  document.getElementById('gateInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  ['scrSector', 'scrStatus', 'scrSort'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderScreener);
  });

  // Delegated clicks for dynamically rendered controls.
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'reload') loadAll();
    else if (act === 'openModal') openModal(el.dataset.symbol, Number(el.dataset.price) || 0);
    else if (act === 'book') book(el.dataset.id, Number(el.dataset.pct));
    else if (act === 'planAdd') openModal(el.dataset.symbol, Number(el.dataset.price) || 0, Number(el.dataset.qty) || '');
    else if (act === 'markDone') markDone(el.dataset.created || '', el.dataset.symbol, el.dataset.type);
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
async function loadAll() {
  const refresh = document.getElementById('refreshAll');
  refresh.disabled = true;
  await Promise.all([loadHealth(), loadAlerts(), loadOpportunities(), loadPortfolio()]);
  renderBuyPlan();                       // uses the freshly loaded opps + health + capital
  if (_scrLoaded) loadScreener();
  refresh.disabled = false;
}

window.addEventListener('DOMContentLoaded', () => {
  if (WEB_APP_URL.indexOf('PASTE_') === 0) {
    document.querySelector('.wrap').insertAdjacentHTML('afterbegin',
      '<div class="err mb-14">Set <b>WEB_APP_URL</b> in <code>js/config.js</code> to your Apps Script Web App URL, then reload.</div>');
  }
  wireEvents();
  // Gate first: block the app until a key is present (VaultZero behaviour).
  if (!localStorage.getItem('stockiq_token')) {
    showGate(false);
    return;
  }
  loadAll();
});
