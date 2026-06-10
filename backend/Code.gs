// StockIQ — Google Apps Script backend

// ── GLOBAL CONSTANTS ─────────────────────────────────────────────────────────

const SHEET_ID = '1R4yXbxb6YgXh-rDqnnw3iWOZe2ABcYMD96iN5hvDi5A';

// VaultZero tabs — READ ONLY. Never alter their structure.
const VZ_ASSETS_TAB       = 'indian_equity_stocks_assets';
const VZ_TRANSACTIONS_TAB = 'indian_equity_stocks_transactions';

// StockIQ-owned tabs.
const TAB_FUNDAMENTALS  = 'SCREENER_FUNDAMENTALS';
const TAB_OPPORTUNITIES = 'SCREENER_OPPORTUNITIES';
const TAB_PORTFOLIO     = 'SCREENER_PORTFOLIO';
const TAB_ALERTS        = 'SCREENER_ALERTS';
const TAB_CONFIG        = 'SCREENER_CONFIG';
const TAB_DEEP          = 'SCREENER_DEEP_ANALYSIS'; // Claude (LLM) fundamental analysis
const TAB_CLOSED        = 'SCREENER_CLOSED';        // closed-trade ledger (realised P&L + Nifty alpha)
const TAB_GF            = '_GF_SCRATCH';   // hidden helper for GOOGLEFINANCE round-trips

// Rate-limit / cache tuning.
const SCREENER_SLEEP_MS   = 2000;   // 2s between screener.in calls (legacy/API path)
const SCREENER_CACHE_SEC  = 24 * 60 * 60; // 24h
const PRICE_CACHE_SEC     = 60 * 60;      // 1h
const PE_CACHE_SEC        = 24 * 60 * 60; // 24h

// Alert type vocabulary.
const ALERT = {
  TARGET_1_HIT:          'TARGET_1_HIT',
  TARGET_2_HIT:          'TARGET_2_HIT',
  STOP_LOSS_HIT:         'STOP_LOSS_HIT',
  ROTATION_OPPORTUNITY:  'ROTATION_OPPORTUNITY',
  THESIS_BROKEN:         'THESIS_BROKEN',
  NEW_OPPORTUNITY:       'NEW_OPPORTUNITY',
  PROFIT_BOOKED:         'PROFIT_BOOKED'
};

// Tab header definitions (single source of truth for column order).
const HEADERS = {};
HEADERS[TAB_CONFIG]        = ['key', 'value'];
HEADERS[TAB_FUNDAMENTALS]  = [
  'symbol', 'company_name', 'sector', 'is_banking',
  'revenue_cagr_5yr', 'profit_cagr_5yr', 'roe_avg_5yr',
  'debt_to_equity', 'cf_quality', 'promoter_holding',
  'promoter_pledge', 'roce', 'sales_growth_3yr',
  'profit_growth_3yr', 'screening_status', 'fail_reasons',
  'confidence_score', 'last_updated'
];
HEADERS[TAB_OPPORTUNITIES] = [
  'rank', 'symbol', 'company_name', 'sector',
  'current_price', 'current_pe', 'avg_pe_5yr', 'avg_pe_10yr',
  'pe_discount_pct', 'valuation_status',
  'target_1_price', 'target_1_upside_pct',
  'target_2_price', 'target_2_upside_pct',
  'stop_loss_price', 'stop_loss_pct',
  'risk_reward_ratio', 'confidence_score',
  'entry_reason', 'exit_reason', 'risk_reason',
  'nifty_above_200dma', 'last_updated'
];
HEADERS[TAB_PORTFOLIO]     = [
  'id', 'symbol', 'company_name', 'entry_date',
  'entry_price', 'quantity', 'invested_amount',
  'current_price', 'current_value', 'unrealised_pnl',
  'unrealised_pnl_pct', 'target_1_price', 'target_1_hit',
  'target_2_price', 'target_2_hit', 'stop_loss_price',
  'alert_status', 'days_held', 'annualised_return',
  'paper_trade', 'notes', 'last_updated', 'nifty_at_entry'
];
// Closed-trade ledger — one row per sale (partial or full), with the Nifty
// return over the same holding period so alpha (stock_vs_nifty_pct) is measurable.
HEADERS[TAB_CLOSED]        = [
  'id', 'symbol', 'company_name', 'sector', 'entry_date', 'exit_date', 'holding_days',
  'entry_price', 'exit_price', 'quantity', 'invested', 'proceeds',
  'realised_pnl', 'realised_pnl_pct',
  'nifty_at_entry', 'nifty_at_exit', 'nifty_return_pct', 'stock_vs_nifty_pct',
  'exit_reason', 'paper_trade', 'created_at'
];
HEADERS[TAB_ALERTS]        = [
  'alert_date', 'symbol', 'alert_type',
  'message', 'action_required', 'is_actioned',
  'current_price', 'trigger_price', 'created_at'
];
// Deep fundamentals from a Claude analysis paste (human-in-the-loop, sector-aware
// mean-reversion schema). LLM ESTIMATES — surfaced as such, never treated as verified.
HEADERS[TAB_DEEP]          = [
  'symbol', 'sector', 'analysis_date',
  'valuation_metric', 'current_valuation', 'historical_avg_valuation_5yr', 'valuation_discount_pct', 'fair_value_upside_pct',
  'is_deflating_hype', 'hype_check_reasoning', 'peg_or_growth_justifies_valuation',
  'revenue_cagr_3yr', 'profit_cagr_3yr',
  'roe_current', 'roe_5yr_avg', 'debt_to_equity', 'operating_cf_to_net_profit',
  'promoter_holding_pct', 'promoter_holding_trend',
  'business_healthy', 'health_score', 'sector_specific_metrics',
  'correction_reason', 'correction_reasoning', 'is_value_trap_risk',
  'suggested_exit_t1_pct', 'suggested_exit_t2_pct', 'valuation_floor', 'floor_downside_pct', 'suggested_stop_pct',
  'mean_reversion_thesis', 'recovery_catalyst', 'thesis_invalidation',
  'key_risks', 'worst_case_scenario', 'max_drawdown_risk_pct',
  'verdict', 'confidence', 'data_quality_flag', 'source', 'last_updated'
];

// Default config values used by setupStockIQ(). phase dates filled at runtime.
function defaultConfig_() {
  const today = new Date();
  const sixMonths = new Date(today.getTime());
  sixMonths.setMonth(sixMonths.getMonth() + 6);
  return [
    ['phase_capital_limit', 25000],
    ['universe', 'NIFTY50'],             // 'NIFTY50' (safer, default) or 'NIFTY100'
    ['max_opportunities', 5],
    ['candidate_pool_size', 10],
    ['max_per_sector', 3],
    ['stop_loss_pct', 12],
    ['target_1_pct', 20],
    ['target_2_pct', 35],
    ['min_risk_reward', 2.5],
    ['pe_discount_strong_buy', 0.70],
    ['pe_discount_buy', 0.80],
    ['pe_discount_watch', 0.90],
    ['rotation_trigger_multiplier', 2.0],
    ['min_revenue_cagr', 10],
    ['min_profit_cagr', 10],
    ['min_roe', 15],
    ['max_debt_equity', 1.0],
    ['min_cf_quality', 0.70],
    ['max_promoter_pledge', 20],
    ['paper_trade_mode', false],
    ['data_mode', 'GF'],                 // 'GF' = GOOGLEFINANCE only; 'API' = external fundamentals (future)
    ['value_dd_strong_buy', -25],        // % off 52w high for STRONG_BUY (GF valuation)
    ['value_dd_buy', -15],
    ['value_dd_watch', -8],
    ['vaultzero_subcategory_id', 22],
    ['vaultzero_strategy', 'Long Term'],
    ['phase_start_date', fmtDate_(today)],
    ['phase_end_date', fmtDate_(sixMonths)]
  ];
}

// ── NIFTY 100 UNIVERSE ───────────────────────────────────────────────────────
//  { symbol, name, sector, isBanking }
//  symbol = NSE/screener.in consolidated code. isBanking exempts the stock
//  from the debt/equity filter (banks carry structurally high leverage).

const NIFTY100 = [
  // IT
  { symbol: 'TCS',        name: 'Tata Consultancy Services', sector: 'IT',        isBanking: false },
  { symbol: 'INFY',       name: 'Infosys',                   sector: 'IT',        isBanking: false },
  { symbol: 'WIPRO',      name: 'Wipro',                     sector: 'IT',        isBanking: false },
  { symbol: 'HCLTECH',    name: 'HCL Technologies',          sector: 'IT',        isBanking: false },
  { symbol: 'TECHM',      name: 'Tech Mahindra',             sector: 'IT',        isBanking: false },
  { symbol: 'LTIM',       name: 'LTIMindtree',               sector: 'IT',        isBanking: false },
  { symbol: 'PERSISTENT', name: 'Persistent Systems',        sector: 'IT',        isBanking: false },
  { symbol: 'COFORGE',    name: 'Coforge',                   sector: 'IT',        isBanking: false },
  { symbol: 'MPHASIS',    name: 'Mphasis',                   sector: 'IT',        isBanking: false },
  { symbol: 'TATAELXSI',  name: 'Tata Elxsi',                sector: 'IT',        isBanking: false },

  // Banking
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',                 sector: 'Banking',   isBanking: true },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',                sector: 'Banking',   isBanking: true },
  { symbol: 'SBIN',       name: 'State Bank of India',       sector: 'Banking',   isBanking: true },
  { symbol: 'KOTAKBANK',  name: 'Kotak Mahindra Bank',       sector: 'Banking',   isBanking: true },
  { symbol: 'AXISBANK',   name: 'Axis Bank',                 sector: 'Banking',   isBanking: true },
  { symbol: 'INDUSINDBK', name: 'IndusInd Bank',             sector: 'Banking',   isBanking: true },
  { symbol: 'BANDHANBNK', name: 'Bandhan Bank',              sector: 'Banking',   isBanking: true },
  { symbol: 'FEDERALBNK', name: 'Federal Bank',              sector: 'Banking',   isBanking: true },

  // NBFC / Finance
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance',             sector: 'NBFC',      isBanking: true },
  { symbol: 'BAJAJFINSV', name: 'Bajaj Finserv',             sector: 'NBFC',      isBanking: true },
  { symbol: 'CHOLAFIN',   name: 'Cholamandalam Finance',     sector: 'NBFC',      isBanking: true },
  { symbol: 'MUTHOOTFIN', name: 'Muthoot Finance',           sector: 'NBFC',      isBanking: true },

  // Insurance
  { symbol: 'HDFCLIFE',   name: 'HDFC Life Insurance',       sector: 'Insurance', isBanking: true },
  { symbol: 'SBILIFE',    name: 'SBI Life Insurance',        sector: 'Insurance', isBanking: true },
  { symbol: 'ICICIGI',    name: 'ICICI Lombard GI',          sector: 'Insurance', isBanking: true },
  { symbol: 'LICI',       name: 'Life Insurance Corp',       sector: 'Insurance', isBanking: true },

  // FMCG
  { symbol: 'ITC',        name: 'ITC',                       sector: 'FMCG',      isBanking: false },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever',        sector: 'FMCG',      isBanking: false },
  { symbol: 'NESTLEIND',  name: 'Nestle India',              sector: 'FMCG',      isBanking: false },
  { symbol: 'BRITANNIA',  name: 'Britannia Industries',      sector: 'FMCG',      isBanking: false },
  { symbol: 'DABUR',      name: 'Dabur India',               sector: 'FMCG',      isBanking: false },
  { symbol: 'MARICO',     name: 'Marico',                    sector: 'FMCG',      isBanking: false },
  { symbol: 'GODREJCP',   name: 'Godrej Consumer',           sector: 'FMCG',      isBanking: false },
  { symbol: 'TATACONSUM', name: 'Tata Consumer Products',    sector: 'FMCG',      isBanking: false },

  // Auto
  { symbol: 'MARUTI',     name: 'Maruti Suzuki',             sector: 'Auto',      isBanking: false },
  { symbol: 'TATAMOTORS', name: 'Tata Motors',               sector: 'Auto',      isBanking: false },
  { symbol: 'M&M',        name: 'Mahindra & Mahindra',       sector: 'Auto',      isBanking: false },
  { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto',                sector: 'Auto',      isBanking: false },
  { symbol: 'HEROMOTOCO', name: 'Hero MotoCorp',             sector: 'Auto',      isBanking: false },
  { symbol: 'EICHERMOT',  name: 'Eicher Motors',             sector: 'Auto',      isBanking: false },
  { symbol: 'TVSMOTORS',  name: 'TVS Motor Company',         sector: 'Auto',      isBanking: false },

  // Pharma / Healthcare
  { symbol: 'SUNPHARMA',  name: 'Sun Pharmaceutical',        sector: 'Pharma',    isBanking: false },
  { symbol: 'DRREDDY',    name: "Dr Reddy's Labs",           sector: 'Pharma',    isBanking: false },
  { symbol: 'CIPLA',      name: 'Cipla',                     sector: 'Pharma',    isBanking: false },
  { symbol: 'DIVISLAB',   name: "Divi's Laboratories",       sector: 'Pharma',    isBanking: false },
  { symbol: 'APOLLOHOSP', name: 'Apollo Hospitals',          sector: 'Pharma',    isBanking: false },
  { symbol: 'MANKIND',    name: 'Mankind Pharma',            sector: 'Pharma',    isBanking: false },

  // Energy
  { symbol: 'RELIANCE',   name: 'Reliance Industries',       sector: 'Energy',    isBanking: false },
  { symbol: 'ONGC',       name: 'Oil & Natural Gas Corp',    sector: 'Energy',    isBanking: false },
  { symbol: 'BPCL',       name: 'Bharat Petroleum',          sector: 'Energy',    isBanking: false },
  { symbol: 'IOC',        name: 'Indian Oil Corp',           sector: 'Energy',    isBanking: false },
  { symbol: 'POWERGRID',  name: 'Power Grid Corp',           sector: 'Energy',    isBanking: false },
  { symbol: 'NTPC',       name: 'NTPC',                      sector: 'Energy',    isBanking: false },
  { symbol: 'ADANIGREEN', name: 'Adani Green Energy',        sector: 'Energy',    isBanking: false },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ',         sector: 'Energy',    isBanking: false },

  // Metals
  { symbol: 'TATASTEEL',  name: 'Tata Steel',                sector: 'Metals',    isBanking: false },
  { symbol: 'HINDALCO',   name: 'Hindalco Industries',       sector: 'Metals',    isBanking: false },
  { symbol: 'JSWSTEEL',   name: 'JSW Steel',                 sector: 'Metals',    isBanking: false },
  { symbol: 'COALINDIA',  name: 'Coal India',                sector: 'Metals',    isBanking: false },
  { symbol: 'VEDL',       name: 'Vedanta',                   sector: 'Metals',    isBanking: false },

  // Cement
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement',          sector: 'Cement',    isBanking: false },
  { symbol: 'SHREECEM',   name: 'Shree Cement',              sector: 'Cement',    isBanking: false },
  { symbol: 'AMBUJACEM',  name: 'Ambuja Cements',            sector: 'Cement',    isBanking: false },
  { symbol: 'ACC',        name: 'ACC',                       sector: 'Cement',    isBanking: false },
  { symbol: 'DALMIACEM',  name: 'Dalmia Bharat',             sector: 'Cement',    isBanking: false },

  // Telecom
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel',             sector: 'Telecom',   isBanking: false },

  // Infra / Engineering
  { symbol: 'LT',         name: 'Larsen & Toubro',           sector: 'Infra',     isBanking: false },
  { symbol: 'SIEMENS',    name: 'Siemens',                   sector: 'Infra',     isBanking: false },
  { symbol: 'ABB',        name: 'ABB India',                 sector: 'Infra',     isBanking: false },
  { symbol: 'BHEL',       name: 'Bharat Heavy Electricals',  sector: 'Infra',     isBanking: false },
  { symbol: 'IRFC',       name: 'Indian Railway Finance',    sector: 'Infra',     isBanking: true },

  // Consumer / Retail
  { symbol: 'TITAN',      name: 'Titan Company',             sector: 'Consumer',  isBanking: false },
  { symbol: 'KALYANKJIL', name: 'Kalyan Jewellers',          sector: 'Consumer',  isBanking: false },
  { symbol: 'TRENT',      name: 'Trent',                     sector: 'Consumer',  isBanking: false },
  { symbol: 'DMART',      name: 'Avenue Supermarts',         sector: 'Consumer',  isBanking: false },

  // Real Estate
  { symbol: 'DLF',        name: 'DLF',                       sector: 'Realty',    isBanking: false },
  { symbol: 'GODREJPROP', name: 'Godrej Properties',         sector: 'Realty',    isBanking: false },
  { symbol: 'OBEROIRLTY', name: 'Oberoi Realty',             sector: 'Realty',    isBanking: false },

  // Others
  { symbol: 'ASIANPAINT', name: 'Asian Paints',              sector: 'Others',    isBanking: false },
  { symbol: 'BSE',        name: 'BSE',                       sector: 'Others',    isBanking: false },
  { symbol: 'CDSL',       name: 'Central Depository Svcs',   sector: 'Others',    isBanking: false },
  { symbol: 'PIDILITIND', name: 'Pidilite Industries',       sector: 'Others',    isBanking: false },
  { symbol: 'ZOMATO',     name: 'Zomato (Eternal)',          sector: 'Others',    isBanking: false },
  { symbol: 'IRCTC',      name: 'IRCTC',                     sector: 'Others',    isBanking: false },
  { symbol: 'HAVELLS',    name: 'Havells India',             sector: 'Others',    isBanking: false },
  { symbol: 'DIXON',      name: 'Dixon Technologies',        sector: 'Others',    isBanking: false },
  { symbol: 'MOTHERSON',  name: 'Samvardhana Motherson',     sector: 'Others',    isBanking: false },
  { symbol: 'ASTRAL',     name: 'Astral',                    sector: 'Others',    isBanking: false },
  { symbol: 'SUPREMEIND', name: 'Supreme Industries',        sector: 'Others',    isBanking: false },
  { symbol: 'BERGEPAINT', name: 'Berger Paints',             sector: 'Others',    isBanking: false },
  { symbol: 'CONCOR',     name: 'Container Corp of India',   sector: 'Others',    isBanking: false },
  { symbol: 'UPL',        name: 'UPL',                       sector: 'Others',    isBanking: false },
  { symbol: 'NYKAA',      name: 'FSN E-Commerce (Nykaa)',    sector: 'Others',    isBanking: false },
  { symbol: 'PAYTM',      name: 'One97 (Paytm)',             sector: 'Others',    isBanking: false },
  { symbol: 'POLICYBZR',  name: 'PB Fintech (Policybazaar)', sector: 'Others',    isBanking: false }
];

function getStockMeta_(symbol) {
  for (let i = 0; i < NIFTY100.length; i++) {
    if (NIFTY100[i].symbol === symbol) return NIFTY100[i];
  }
  return null;
}

// Approximate Nifty 50 membership (index rebalances periodically — adjust here
// if it drifts). When config.universe = 'NIFTY50', screening is limited to these.
const NIFTY50_SET = {
  TCS:1, INFY:1, WIPRO:1, HCLTECH:1, TECHM:1, LTIM:1,
  HDFCBANK:1, ICICIBANK:1, SBIN:1, KOTAKBANK:1, AXISBANK:1, INDUSINDBK:1,
  BAJFINANCE:1, BAJAJFINSV:1, HDFCLIFE:1, SBILIFE:1,
  ITC:1, HINDUNILVR:1, NESTLEIND:1, BRITANNIA:1, TATACONSUM:1,
  MARUTI:1, TATAMOTORS:1, 'M&M':1, 'BAJAJ-AUTO':1, HEROMOTOCO:1, EICHERMOT:1,
  SUNPHARMA:1, DRREDDY:1, CIPLA:1, APOLLOHOSP:1,
  RELIANCE:1, ONGC:1, BPCL:1, POWERGRID:1, NTPC:1, ADANIPORTS:1,
  TATASTEEL:1, HINDALCO:1, JSWSTEEL:1, COALINDIA:1,
  ULTRACEMCO:1, BHARTIARTL:1, LT:1, TITAN:1, TRENT:1, ASIANPAINT:1
};

// The active screening universe per config.universe ('NIFTY50' default).
function activeUniverse_(cfg) {
  cfg = cfg || getConfig();
  if (String(cfg.universe).toUpperCase() === 'NIFTY100') return NIFTY100;
  return NIFTY100.filter(function (m) { return NIFTY50_SET[m.symbol]; });
}

// ── LOW-LEVEL UTILITIES ──────────────────────────────────────────────────────

function log_(msg)  { Logger.log('[StockIQ] ' + msg); }

function nowISO_()  { return new Date().toISOString(); }

function fmtDate_(d) {
  return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
}

function fmtDateTime_(d) {
  return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm');
}

// Parse a number from messy strings ("1,234.5", "12%", "-"). Null if not numeric.
function toNum_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/,/g, '').replace(/%/g, '').replace(/₹/g, '').trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'nan') return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function round2_(n) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function pct_(n) { return round2_(n); }

// Mean of numeric values, ignoring nulls. Null if none.
function mean_(arr) {
  const xs = (arr || []).filter(function (x) { return x !== null && x !== undefined && isFinite(x); });
  if (!xs.length) return null;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i];
  return sum / xs.length;
}

function stdDev_(arr) {
  const xs = (arr || []).filter(function (x) { return x !== null && isFinite(x); });
  if (xs.length < 2) return null;
  const m = mean_(xs);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) acc += Math.pow(xs[i] - m, 2);
  return Math.sqrt(acc / (xs.length - 1));
}

// ── SHEET ACCESS HELPERS ─────────────────────────────────────────────────────

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

// Get a tab, creating it with headers if it is one of ours and missing.
function getOrCreateTab_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    if (!HEADERS[name]) {
      throw new Error('Refusing to create unknown tab: ' + name);
    }
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS[name].length).setFontWeight('bold');
    log_('Created tab: ' + name);
  }
  return sh;
}

// Rewrite row 1 to the canonical HEADERS if it has drifted (schema evolution).
// wipeData=true (re-derivable tabs like the deep analysis): when the header
// actually changes, also clear existing data rows so old-layout values can't sit
// misaligned under the new columns — they repopulate on the next analysis paste.
function ensureHeaders_(name, wipeData) {
  const sh = ss_().getSheetByName(name);
  if (!sh || !HEADERS[name]) return;
  const want = HEADERS[name];
  const width = Math.max(sh.getLastColumn(), want.length);
  const cur = sh.getRange(1, 1, 1, width).getValues()[0];
  let diff = cur.length < want.length;
  for (let i = 0; i < want.length && !diff; i++) if (String(cur[i] || '') !== want[i]) diff = true;
  if (!diff) return;
  if (wipeData) {
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  }
  sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
  sh.setFrozenRows(1);
  log_('ensureHeaders_ updated header for ' + name + (wipeData ? ' (stale rows cleared)' : ''));
}

// Read a StockIQ tab as array-of-objects keyed by header.
function readTabObjects_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.join('') === '') continue; // skip blank rows
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    obj.__row = r + 1; // 1-based sheet row
    out.push(obj);
  }
  return out;
}

// Build a row array in the canonical header order from an object.
function objToRow_(name, obj) {
  const headers = HEADERS[name];
  return headers.map(function (h) {
    const v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  });
}

// Upsert by a key column. Replaces the row in place if key exists, else appends.
function upsertByKey_(name, keyCol, obj) {
  const sh = getOrCreateTab_(name);
  const headers = HEADERS[name];
  const keyIdx = headers.indexOf(keyCol);
  if (keyIdx < 0) throw new Error('Key column ' + keyCol + ' not in ' + name);

  const row = objToRow_(name, obj);
  const data = sh.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][keyIdx]) === String(obj[keyCol])) {
      sh.getRange(r + 1, 1, 1, row.length).setValues([row]);
      return { action: 'updated', row: r + 1 };
    }
  }
  sh.appendRow(row);
  return { action: 'inserted', row: sh.getLastRow() };
}

// Replace all data rows of a tab in one batch (header preserved).
function replaceAllRows_(name, objects) {
  const sh = getOrCreateTab_(name);
  const headers = HEADERS[name];
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, headers.length).clearContent();
  if (!objects || !objects.length) return 0;
  const rows = objects.map(function (o) { return objToRow_(name, o); });
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function appendRow_(name, obj) {
  const sh = getOrCreateTab_(name);
  sh.appendRow(objToRow_(name, obj));
  return sh.getLastRow();
}

// ── CONFIG  (every threshold flows through here) ─────────────────────────────

// Returns config as a typed object. Booleans/numbers coerced.
function getConfig() {
  const rows = readTabObjects_(TAB_CONFIG);
  const cfg = {};
  rows.forEach(function (r) {
    const key = String(r.key).trim();
    if (!key) return;
    cfg[key] = coerceConfigValue_(r.value);
  });
  // Fill any missing defaults so logic never reads undefined.
  defaultConfig_().forEach(function (pair) {
    if (cfg[pair[0]] === undefined) cfg[pair[0]] = pair[1];
  });
  return cfg;
}

function coerceConfigValue_(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim();
  if (/^true$/i.test(s))  return true;
  if (/^false$/i.test(s)) return false;
  const n = toNum_(s);
  if (n !== null && /^-?\d*\.?\d+$/.test(s)) return n;
  return v; // dates / strings pass through
}

function getConfigValue_(key) {
  const cfg = getConfig();
  return cfg[key];
}

// Update one or more config keys. data = { key: value, ... }
function updateConfig(data) {
  if (!data || typeof data !== 'object') throw new Error('updateConfig: data object required');
  const updated = [];
  Object.keys(data).forEach(function (k) {
    upsertByKey_(TAB_CONFIG, 'key', { key: k, value: data[k] });
    updated.push(k);
  });
  log_('Config updated: ' + updated.join(', '));
  return { updated: updated, config: getConfig() };
}

// ── SETUP ────────────────────────────────────────────────────────────────────

// Master setup. Run ONCE from the editor (or via ?action=setupStockIQ).
// Creates the 5 StockIQ tabs, seeds config, installs triggers. Idempotent.
function setupStockIQ() {
  log_('setupStockIQ: start');
  const summary = { tabsCreated: [], tabsExisting: [], configSeeded: 0, triggers: null };

  // 1. Tabs.
  [TAB_CONFIG, TAB_FUNDAMENTALS, TAB_OPPORTUNITIES, TAB_PORTFOLIO, TAB_ALERTS, TAB_DEEP, TAB_CLOSED].forEach(function (name) {
    const existed = !!ss_().getSheetByName(name);
    getOrCreateTab_(name);
    ensureHeaders_(name, name === TAB_DEEP); // reconcile columns; deep tab self-clears on schema change
    (existed ? summary.tabsExisting : summary.tabsCreated).push(name);
  });
  // Hidden GOOGLEFINANCE scratch tab (formula round-trips).
  gfPrepScratch_();
  summary.scratchTab = TAB_GF;

  // 2. Seed config only for keys that don't already exist (don't clobber edits).
  const existingCfg = {};
  readTabObjects_(TAB_CONFIG).forEach(function (r) { existingCfg[String(r.key)] = true; });
  defaultConfig_().forEach(function (pair) {
    if (!existingCfg[pair[0]]) {
      appendRow_(TAB_CONFIG, { key: pair[0], value: pair[1] });
      summary.configSeeded++;
    }
  });

  // 3. Verify VaultZero tabs exist (read-only sanity check; never created here).
  summary.vaultZero = {
    assets:       !!ss_().getSheetByName(VZ_ASSETS_TAB),
    transactions: !!ss_().getSheetByName(VZ_TRANSACTIONS_TAB)
  };

  // 4. Triggers.
  summary.triggers = setupTimeTriggers();

  summary.timestamp = nowISO_();
  log_('setupStockIQ: done -> ' + JSON.stringify(summary));
  return summary;
}

// Install time-driven triggers without creating duplicates:
//   - Weekly  Sun 08:00 IST -> runFundamentalScreener
//   - Daily   wk  08:30 IST -> runDailyUpdate
//   - Daily   wk  21:00 IST -> runEndOfDayAlerts
// Apps Script triggers fire in the project's timezone; ensure it is IST.
function setupTimeTriggers() {
  const wanted = {
    runFundamentalScreener: false,
    runDailyUpdate: false,
    runEndOfDayAlerts: false
  };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (wanted.hasOwnProperty(fn)) wanted[fn] = true;
  });

  const created = [];
  if (!wanted.runFundamentalScreener) {
    ScriptApp.newTrigger('runFundamentalScreener').timeBased()
      .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(8).nearMinute(0).create();
    created.push('runFundamentalScreener (Sun 08:00)');
  }
  if (!wanted.runDailyUpdate) {
    ScriptApp.newTrigger('runDailyUpdate').timeBased()
      .everyDays(1).atHour(8).nearMinute(30).create();
    created.push('runDailyUpdate (daily 08:30)');
  }
  if (!wanted.runEndOfDayAlerts) {
    ScriptApp.newTrigger('runEndOfDayAlerts').timeBased()
      .everyDays(1).atHour(21).nearMinute(0).create();
    created.push('runEndOfDayAlerts (daily 21:00)');
  }
  log_('Triggers created: ' + (created.length ? created.join('; ') : 'none (all present)'));
  return { created: created, note: 'Daily triggers fire every day; weekday-only logic is enforced inside the functions via isTradingDay_().' };
}

// True Mon–Fri. Use to no-op daily jobs on weekends.
function isTradingDay_(d) {
  const day = (d || new Date()).getDay(); // 0=Sun..6=Sat
  return day >= 1 && day <= 5;
}

// ── CACHE  (PropertiesService with embedded expiry — values stay < 9KB) ──────

function cacheGet_(key, maxAgeSec) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return null;
    const wrapped = JSON.parse(raw);
    const ageSec = (Date.now() - wrapped._cachedAt) / 1000;
    if (ageSec > maxAgeSec) return null;
    wrapped.payload._cacheAgeSec = Math.round(ageSec);
    return wrapped.payload;
  } catch (e) {
    return null;
  }
}

function cachePut_(key, payload) {
  try {
    const wrapped = { _cachedAt: Date.now(), payload: payload };
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(wrapped));
  } catch (e) {
    log_('cachePut_ failed for ' + key + ': ' + e);
  }
}

// Last-resort stale read (ignores expiry) for graceful degradation.
function cacheGetStale_(key) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return null;
    const wrapped = JSON.parse(raw);
    wrapped.payload._stale = true;
    wrapped.payload._cacheAgeSec = Math.round((Date.now() - wrapped._cachedAt) / 1000);
    return wrapped.payload;
  } catch (e) { return null; }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

function httpGet_(url, headers) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: headers || BROWSER_HEADERS,
      muteHttpExceptions: true,
      followRedirects: true
    });
    return { code: resp.getResponseCode(), body: resp.getContentText(), headers: resp.getAllHeaders() };
  } catch (e) {
    log_('httpGet_ error ' + url + ' : ' + e);
    return { code: 0, body: '', headers: {}, error: String(e) };
  }
}

// ── HTML PARSING HELPERS  (tolerant; return null when a value can't be found) ───

function stripTags_(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

// Slice out a <section id="..."> ... </section> block (best-effort).
function extractSection_(html, sectionId) {
  const start = html.indexOf('id="' + sectionId + '"');
  if (start < 0) return '';
  // Walk back to the opening tag of this element.
  const openTag = html.lastIndexOf('<', start);
  // Heuristic: take a generous window forward; screener sections are < ~60KB.
  return html.substring(openTag, Math.min(html.length, openTag + 80000));
}

// From a screener data-table section, return the numeric row matching label.
// Looks for <tr>...<td class="text">LABEL...</td><td>n</td>...</tr>.
function extractTableRow_(sectionHtml, labelRegex) {
  if (!sectionHtml) return null;
  const rows = sectionHtml.match(/<tr[\s\S]*?<\/tr>/g);
  if (!rows) return null;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].match(/<td[\s\S]*?<\/td>/g);
    if (!cells || cells.length < 2) continue;
    const label = stripTags_(cells[0]);
    if (labelRegex.test(label)) {
      const nums = [];
      for (let c = 1; c < cells.length; c++) nums.push(toNum_(stripTags_(cells[c])));
      return nums;
    }
  }
  return null;
}

// Read a value from the #top-ratios list (e.g. "Stock P/E", "ROCE").
function extractTopRatio_(html, nameRegex) {
  const ul = extractSection_(html, 'top-ratios');
  const scope = ul || html;
  const items = scope.match(/<li[\s\S]*?<\/li>/g);
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const txt = stripTags_(items[i]);
    if (nameRegex.test(txt)) {
      // value is usually the trailing number(s); take the last number token
      const m = txt.match(/-?[\d,]+\.?\d*/g);
      if (m && m.length) return toNum_(m[m.length - 1]);
    }
  }
  return null;
}

// Promoter holding latest % from the shareholding quarterly table.
function extractPromoterHolding_(html) {
  const sec = extractSection_(html, 'shareholding');
  const row = extractTableRow_(sec, /^Promoters?\b/i);
  if (row && row.length) {
    for (let i = row.length - 1; i >= 0; i--) if (row[i] !== null) return row[i];
  }
  return null;
}

// Promoter pledge % if disclosed ("Pledged"/"Promoter pledge").
function extractPromoterPledge_(html) {
  const sec = extractSection_(html, 'shareholding');
  const row = extractTableRow_(sec, /pledg/i);
  if (row && row.length) {
    for (let i = row.length - 1; i >= 0; i--) if (row[i] !== null) return row[i];
  }
  return null;
}

// ── DATA FETCHING — SCREENER.IN (fundamentals) ───────────────────────────────

// Fetch + parse screener.in for a symbol. Tries the consolidated page first,
// then the standalone page. Returns a structured object or null on failure.
// Caches the PARSED object (small) for 24h. Sleeps 2s after a live fetch.
function fetchFromScreener(symbol) {
  const cacheKey = 'scr_' + symbol;
  const cached = cacheGet_(cacheKey, SCREENER_CACHE_SEC);
  if (cached) { log_('screener cache hit: ' + symbol); return cached; }

  const urls = [
    'https://www.screener.in/company/' + encodeURIComponent(symbol) + '/consolidated/',
    'https://www.screener.in/company/' + encodeURIComponent(symbol) + '/'
  ];

  let html = '';
  let usedUrl = '';
  for (let i = 0; i < urls.length; i++) {
    const r = httpGet_(urls[i], BROWSER_HEADERS);
    Utilities.sleep(SCREENER_SLEEP_MS);
    if (r.code === 200 && r.body && r.body.indexOf('Profit & Loss') >= 0) {
      html = r.body; usedUrl = urls[i]; break;
    }
  }
  if (!html) {
    log_('screener fetch FAILED for ' + symbol + ' -> trying stale cache');
    return cacheGetStale_(cacheKey); // may be null
  }

  try {
    const pnl   = extractSection_(html, 'profit-loss');
    const cf    = extractSection_(html, 'cash-flow');
    const ratio = extractSection_(html, 'ratios');

    const sales      = extractTableRow_(pnl, /^Sales\b|^Revenue\b/i)     || [];
    const netProfit  = extractTableRow_(pnl, /^Net Profit\b/i)           || [];
    const roeRow     = extractTableRow_(ratio, /Return on Equity|^ROE\b/i) || [];
    const roceRow    = extractTableRow_(ratio, /Return on Capital|^ROCE\b/i) || [];
    const opCashRow  = extractTableRow_(cf, /Operating Activ/i)          || [];

    const stockPE    = extractTopRatio_(html, /Stock P\/?E|^P\/?E\b/i);
    const roceTop    = extractTopRatio_(html, /ROCE/i);
    const roeTop     = extractTopRatio_(html, /\bROE\b/i);
    const curPrice   = extractTopRatio_(html, /Current Price/i);
    const debtEquity = extractDebtToEquity_(html, ratio);

    const result = {
      symbol: symbol,
      source: usedUrl,
      sales: sales,                 // oldest..newest (last col often TTM)
      netProfit: netProfit,
      roe: roeRow.length ? roeRow : (roeTop !== null ? [roeTop] : []),
      roce: roceRow.length ? roceRow : (roceTop !== null ? [roceTop] : []),
      operatingCashFlow: opCashRow,
      currentPE: stockPE,
      currentPrice: curPrice,
      debtToEquity: debtEquity,
      promoterHolding: extractPromoterHolding_(html),
      promoterPledge: extractPromoterPledge_(html),
      fetchedAt: nowISO_()
    };
    cachePut_(cacheKey, result);
    log_('screener parsed: ' + symbol + ' (sales=' + sales.length + ' yrs, PE=' + stockPE + ')');
    return result;
  } catch (e) {
    log_('screener parse error ' + symbol + ': ' + e);
    return cacheGetStale_(cacheKey);
  }
}

// Debt to equity: top-ratio if present, else last value of a ratios row.
function extractDebtToEquity_(html, ratioSection) {
  const top = extractTopRatio_(html, /Debt to equity/i);
  if (top !== null) return top;
  const row = extractTableRow_(ratioSection, /Debt to Equity/i);
  if (row && row.length) {
    for (let i = row.length - 1; i >= 0; i--) if (row[i] !== null) return row[i];
  }
  return null;
}

// ── DATA FETCHING — PRICE + 200 DMA  (via GOOGLEFINANCE; see GF layer below) ───

// Current quote via GOOGLEFINANCE (NSE was unreachable from Apps Script).
// Returns price + 52wk range + PE/EPS. Cached 1h; stale cache on failure.
function fetchNSEPrice(symbol) {
  const cacheKey = 'px_' + symbol;
  const cached = cacheGet_(cacheKey, PRICE_CACHE_SEC);
  if (cached) return cached;

  const q = gfQuote_(symbol);
  if (!q || q.price === null) {
    log_('GF price unavailable for ' + symbol + ' -> stale cache');
    return cacheGetStale_(cacheKey);
  }
  const prevClose = (q.changepct !== null && (1 + q.changepct / 100) !== 0)
    ? round2_(q.price / (1 + q.changepct / 100)) : null;
  const out = {
    symbol: symbol,
    lastPrice: q.price,
    previousClose: prevClose,
    dayHigh: null,           // GOOGLEFINANCE quote has no reliable intraday hi/lo
    dayLow: null,
    yearHigh: q.high52,
    yearLow: q.low52,
    pe: q.pe,
    eps: q.eps,
    fetchedAt: nowISO_()
  };
  cachePut_(cacheKey, out);
  return out;
}

// Market health: Nifty 50 level vs its true 200-day moving average, both from
// GOOGLEFINANCE historical closes (real 200-DMA available immediately, no
// multi-month warm-up). Cached 1h; stale cache on failure.
function fetchNifty200DMA() {
  const cacheKey = 'nifty_health';
  const cached = cacheGet_(cacheKey, PRICE_CACHE_SEC);
  if (cached) return cached;

  // ~320 calendar days comfortably covers 200 trading days.
  const h = gfHistoricalAvgClose_('INDEXNSE:NIFTY_50', 320, 200);
  const liveIdx = gfQuote_('INDEXNSE:NIFTY_50');
  const currentLevel = (liveIdx && liveIdx.price !== null) ? liveIdx.price : h.current;

  const out = {
    currentLevel: currentLevel,
    dma200: h.dma,
    samples: h.samples,
    isAbove200DMA: (currentLevel !== null && h.dma !== null) ? currentLevel >= h.dma : null,
    dataComplete: h.samples >= 200,
    fetchedAt: nowISO_()
  };
  if (currentLevel !== null) cachePut_(cacheKey, out);
  else { const stale = cacheGetStale_(cacheKey); if (stale) return stale; }
  return out;
}

// ── DATA FETCHING — HISTORICAL PE ────────────────────────────────────────────

// Current PE from GOOGLEFINANCE plus a self-built rolling-average PE (since
// GOOGLEFINANCE has no historical PE). avg5yr/avg10yr stay null until ~20 daily
// samples accumulate; valuation then upgrades from 52w-drawdown to PE-vs-avg.
// Not cached here (so the daily series records every run); the per-run cost is
// one GF round-trip.
function fetchHistoricalPE(symbol) {
  const q = gfQuote_(symbol);
  const currentPE = q ? q.pe : null;
  const hist = updatePERollingSeries_(symbol, currentPE);
  return {
    symbol: symbol,
    avg5yr: hist.avg,         // rolling mean of recorded PEs (null < 20 samples)
    avg10yr: hist.avg,        // same series; no separate 10yr source
    stdDev: hist.stdDev,
    currentPE: currentPE,
    currentPercentile: hist.percentile,
    samples: hist.samples,
    dataAvailable: hist.avg !== null,
    fetchedAt: nowISO_()
  };
}

// ── CALCULATION LAYER ────────────────────────────────────────────────────────

// CAGR % from an array ordered oldest..newest.
// Returns null if <2 points or base year <= 0 (negative base is meaningless).
function calculateCAGR(valuesArray) {
  const xs = (valuesArray || []).filter(function (x) { return x !== null && isFinite(x); });
  if (xs.length < 2) return null;
  const begin = xs[0];
  const end = xs[xs.length - 1];
  if (begin === null || end === null || begin <= 0) return null;
  if (end <= 0) return null;
  const years = xs.length - 1;
  const cagr = (Math.pow(end / begin, 1 / years) - 1) * 100;
  return isFinite(cagr) ? round2_(cagr) : null;
}

// CAGR over the last `n` year-on-year points (e.g. 3yr) from oldest..newest.
function calculateTrailingCAGR_(valuesArray, n) {
  const xs = (valuesArray || []).filter(function (x) { return x !== null && isFinite(x); });
  if (xs.length < 2) return null;
  const slice = xs.slice(Math.max(0, xs.length - (n + 1)));
  return calculateCAGR(slice);
}

// Cash-flow quality = sum(operating cash flow) / sum(net profit) over the
// overlapping window. >1 means profits are backed by real cash. Null if N/A.
function calculateCFQuality_(opCash, netProfit) {
  const a = (opCash || []).filter(function (x) { return x !== null && isFinite(x); });
  const b = (netProfit || []).filter(function (x) { return x !== null && isFinite(x); });
  if (!a.length || !b.length) return null;
  const n = Math.min(a.length, b.length);
  const cf = a.slice(a.length - n);
  const np = b.slice(b.length - n);
  let sumCF = 0, sumNP = 0;
  for (let i = 0; i < n; i++) { sumCF += cf[i]; sumNP += np[i]; }
  if (sumNP <= 0) return null;
  return round2_(sumCF / sumNP);
}

// Average of the last up-to-5 ROE values. Null if none.
function avgROE_(roeArray) {
  const xs = (roeArray || []).filter(function (x) { return x !== null && isFinite(x); });
  if (!xs.length) return null;
  return round2_(mean_(xs.slice(Math.max(0, xs.length - 5))));
}

// Count how many of the last 5 ROE readings clear a threshold.
function roeYearsAbove_(roeArray, threshold) {
  const xs = (roeArray || []).filter(function (x) { return x !== null && isFinite(x); });
  const last5 = xs.slice(Math.max(0, xs.length - 5));
  return last5.filter(function (x) { return x >= threshold; }).length;
}

// Confidence score 0-100 (weights per spec). Each component degrades to 0
// when its input is missing rather than throwing.
function calculateConfidenceScore(f) {
  let score = 0;

  // Revenue CAGR — max 20
  const rev = f.revenue_cagr_5yr;
  if (rev !== null) score += rev > 20 ? 20 : rev > 15 ? 15 : rev > 10 ? 10 : rev > 5 ? 5 : 0;

  // Profit CAGR — max 20
  const pro = f.profit_cagr_5yr;
  if (pro !== null) score += pro > 20 ? 20 : pro > 15 ? 15 : pro > 10 ? 10 : pro > 5 ? 5 : 0;

  // ROE — max 20
  const roe = f.roe_avg_5yr;
  if (roe !== null) score += roe > 25 ? 20 : roe > 20 ? 15 : roe > 15 ? 10 : roe > 12 ? 5 : 0;

  // Debt — max 15 (banks exempt: give neutral-positive 10)
  if (f.is_banking) {
    score += 10;
  } else {
    const de = f.debt_to_equity;
    if (de !== null) score += de === 0 ? 15 : de <= 0.3 ? 12 : de <= 0.5 ? 10 : de <= 1.0 ? 5 : 0;
  }

  // CF quality — max 15
  const cf = f.cf_quality;
  if (cf !== null) score += cf > 0.9 ? 15 : cf > 0.8 ? 10 : cf > 0.7 ? 5 : 0;

  // Promoter holding — max 10
  const ph = f.promoter_holding;
  if (ph !== null) score += ph > 60 ? 10 : ph > 50 ? 7 : ph > 40 ? 5 : ph > 25 ? 2 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Valuation status from current vs 5yr-avg PE using config discount bands.
// Returns { status, discountPct } where discountPct is negative when cheap.
function calculateValuationStatus(currentPE, avg5yrPE, cfg) {
  cfg = cfg || getConfig();
  if (currentPE === null || avg5yrPE === null || avg5yrPE <= 0 || currentPE <= 0) {
    return { status: 'DATA_UNAVAILABLE', discountPct: null, ratio: null };
  }
  const ratio = currentPE / avg5yrPE;                 // <1 = cheaper than history
  const discountPct = round2_((ratio - 1) * 100);     // e.g. -30 => 30% below avg
  let status;
  if (ratio < cfg.pe_discount_strong_buy)      status = 'STRONG_BUY';
  else if (ratio < cfg.pe_discount_buy)        status = 'BUY';
  else if (ratio < cfg.pe_discount_watch)      status = 'WATCH';
  else if (ratio <= 1.20)                      status = 'FAIR_VALUE';
  else                                         status = 'EXPENSIVE';
  return { status: status, discountPct: discountPct, ratio: round2_(ratio) };
}

// Price targets + stop loss + risk:reward from config percentages.
//   riskReward    = upside-to-T1 / downside-to-SL   (spec definition; displayed)
//   riskRewardT2  = upside-to-T2 / downside-to-SL   (used as the qualifying gate)
// NOTE: because targets are fixed config %, both ratios are identical for every
// stock — they are effectively a global asymmetry sanity gate, not a per-stock
// discriminator. The T2 ratio is what the opportunity monitor screens on so the
// default config (T1 20% / T2 35% / SL 12% / min_rr 2.5) is internally
// consistent (35/12 = 2.92 >= 2.5); the per-stock ranking is driven by the
// composite score (PE discount, confidence, percentile).
function calculateTargets(currentPrice, cfg) {
  cfg = cfg || getConfig();
  if (currentPrice === null || !isFinite(currentPrice) || currentPrice <= 0) {
    return { valid: false };
  }
  const t1 = currentPrice * (1 + cfg.target_1_pct / 100);
  const t2 = currentPrice * (1 + cfg.target_2_pct / 100);
  const sl = currentPrice * (1 - cfg.stop_loss_pct / 100);
  const risk = currentPrice - sl;
  const rr   = risk > 0 ? (t1 - currentPrice) / risk : null;
  const rrT2 = risk > 0 ? (t2 - currentPrice) / risk : null;
  return {
    valid: true,
    target1Price: round2_(t1),
    target1Pct: cfg.target_1_pct,
    target2Price: round2_(t2),
    target2Pct: cfg.target_2_pct,
    stopLossPrice: round2_(sl),
    stopLossPct: cfg.stop_loss_pct,
    riskReward: rr !== null ? round2_(rr) : null,
    riskRewardT2: rrT2 !== null ? round2_(rrT2) : null
  };
}

// Should we rotate capital out of an existing position into a richer one?
// Compares the new opportunity's upside to the weakest active position's
// remaining upside-to-target1, scaled by rotation_trigger_multiplier.
function checkRotationOpportunity(newOpportunityUpsidePct, cfg) {
  cfg = cfg || getConfig();
  const positions = readTabObjects_(TAB_PORTFOLIO).filter(function (p) {
    return p.symbol && toNum_(p.quantity) > 0;
  });
  if (!positions.length) return { shouldRotate: false, reason: 'No active positions' };

  let weakest = null;
  positions.forEach(function (p) {
    const cur = toNum_(p.current_price);
    const t1 = toNum_(p.target_1_price);
    if (cur === null || t1 === null || cur <= 0) return;
    const remainingUpside = ((t1 - cur) / cur) * 100;
    if (weakest === null || remainingUpside < weakest.remainingUpside) {
      weakest = { symbol: p.symbol, remainingUpside: remainingUpside, capital: toNum_(p.current_value), row: p };
    }
  });
  if (!weakest) return { shouldRotate: false, reason: 'No comparable positions' };

  const trigger = weakest.remainingUpside * cfg.rotation_trigger_multiplier;
  if (newOpportunityUpsidePct > trigger) {
    return {
      shouldRotate: true,
      exitSymbol: weakest.symbol,
      exitReason: 'Remaining upside to T1 only ' + round2_(weakest.remainingUpside) +
                  '% vs new opportunity ' + round2_(newOpportunityUpsidePct) + '%',
      capitalAvailable: round2_(weakest.capital),
      recommendation: 'Consider exiting ' + weakest.symbol + ' (~₹' + round2_(weakest.capital) +
                      ') to fund the higher-upside opportunity. Trigger = ' +
                      round2_(trigger) + '% (' + cfg.rotation_trigger_multiplier + 'x weakest upside).'
    };
  }
  return {
    shouldRotate: false,
    reason: 'New upside ' + round2_(newOpportunityUpsidePct) + '% does not exceed ' +
            round2_(trigger) + '% rotation trigger',
    weakestSymbol: weakest.symbol
  };
}

// ── CORE ENGINE ──────────────────────────────────────────────────────────────

// Build the fundamentals object for ONE symbol (fetch -> derive -> score).
// Pure-ish: returns the row object; does not write to the sheet.
function screenOneStock_(meta, cfg) {
  // Data-source switch. Default 'GF' uses GOOGLEFINANCE (scraping is blocked
  // from Apps Script). 'API' would route to an external fundamentals provider.
  if (!cfg.data_mode || cfg.data_mode === 'GF') return screenOneStockGF_(meta, cfg);

  const raw = fetchFromScreener(meta.symbol);
  const base = {
    symbol: meta.symbol,
    company_name: meta.name,
    sector: meta.sector,
    is_banking: meta.isBanking,
    revenue_cagr_5yr: null, profit_cagr_5yr: null, roe_avg_5yr: null,
    debt_to_equity: null, cf_quality: null, promoter_holding: null,
    promoter_pledge: null, roce: null, sales_growth_3yr: null,
    profit_growth_3yr: null, screening_status: 'INSUFFICIENT_DATA',
    fail_reasons: '', confidence_score: 0, last_updated: fmtDateTime_(new Date())
  };

  if (!raw) { base.fail_reasons = 'No data from source'; return base; }

  // Many screener rows include a trailing TTM column; CAGR uses full-year
  // points oldest..newest, which is acceptable for a 5yr growth proxy.
  base.revenue_cagr_5yr = calculateCAGR(raw.sales);
  base.profit_cagr_5yr  = calculateCAGR(raw.netProfit);
  base.sales_growth_3yr = calculateTrailingCAGR_(raw.sales, 3);
  base.profit_growth_3yr= calculateTrailingCAGR_(raw.netProfit, 3);
  base.roe_avg_5yr      = avgROE_(raw.roe);
  base.roce             = (raw.roce && raw.roce.length) ? raw.roce[raw.roce.length - 1] : null;
  base.debt_to_equity   = raw.debtToEquity;
  base.cf_quality       = calculateCFQuality_(raw.operatingCashFlow, raw.netProfit);
  base.promoter_holding = raw.promoterHolding;
  base.promoter_pledge  = raw.promoterPledge;

  base.confidence_score = calculateConfidenceScore(base);

  // Data sufficiency: need the growth + quality inputs to judge fairly.
  const haveCore = base.revenue_cagr_5yr !== null && base.profit_cagr_5yr !== null &&
                   base.roe_avg_5yr !== null;
  if (!haveCore) {
    base.screening_status = 'INSUFFICIENT_DATA';
    base.fail_reasons = 'Missing: ' +
      [['revenue', base.revenue_cagr_5yr], ['profit', base.profit_cagr_5yr], ['roe', base.roe_avg_5yr]]
        .filter(function (x) { return x[1] === null; }).map(function (x) { return x[0]; }).join(', ');
    return base;
  }

  // Apply config filters; collect every reason it fails.
  const fails = [];
  if (base.revenue_cagr_5yr < cfg.min_revenue_cagr)
    fails.push('Revenue CAGR ' + base.revenue_cagr_5yr + '% < ' + cfg.min_revenue_cagr + '%');
  if (base.profit_cagr_5yr < cfg.min_profit_cagr)
    fails.push('Profit CAGR ' + base.profit_cagr_5yr + '% < ' + cfg.min_profit_cagr + '%');
  if (roeYearsAbove_(raw.roe, cfg.min_roe) < 3)
    fails.push('ROE >= ' + cfg.min_roe + '% in <3 of last 5 yrs');
  if (!base.is_banking && base.debt_to_equity !== null && base.debt_to_equity > cfg.max_debt_equity)
    fails.push('D/E ' + base.debt_to_equity + ' > ' + cfg.max_debt_equity);
  if (base.cf_quality !== null && base.cf_quality < cfg.min_cf_quality)
    fails.push('CF quality ' + base.cf_quality + ' < ' + cfg.min_cf_quality);
  if (base.promoter_pledge !== null && base.promoter_pledge > cfg.max_promoter_pledge)
    fails.push('Pledge ' + base.promoter_pledge + '% > ' + cfg.max_promoter_pledge + '%');
  if (base.confidence_score < 60)
    fails.push('Confidence ' + base.confidence_score + ' < 60');

  if (fails.length) {
    base.screening_status = 'FAIL';
    base.fail_reasons = fails.join(' | ');
  } else {
    base.screening_status = 'PASS';
    base.fail_reasons = '';
  }
  return base;
}

// Weekly master screen across the whole universe (or a provided subset).
// Writes one idempotent row per symbol to SCREENER_FUNDAMENTALS.
// Designed to run overnight (10-15 min for 100 names with 2s sleeps).
// @param {string[]=} symbols  optional subset for testing (e.g. ['TCS'])
function runFundamentalScreener(symbols) {
  const cfg = getConfig();
  const universe = (symbols && symbols.length)
    ? NIFTY100.filter(function (m) { return symbols.indexOf(m.symbol) >= 0; })
    : activeUniverse_(cfg);

  log_('runFundamentalScreener: ' + universe.length + ' stocks');
  const counts = { total: universe.length, passed: 0, failed: 0, insufficient: 0 };

  for (let i = 0; i < universe.length; i++) {
    const meta = universe[i];
    try {
      const row = screenOneStock_(meta, cfg);
      upsertByKey_(TAB_FUNDAMENTALS, 'symbol', row);
      if (row.screening_status === 'PASS') counts.passed++;
      else if (row.screening_status === 'FAIL') counts.failed++;
      else counts.insufficient++;
      log_('[' + (i + 1) + '/' + universe.length + '] ' + meta.symbol + ' -> ' +
           row.screening_status + ' (conf ' + row.confidence_score + ')');
    } catch (e) {
      counts.insufficient++;
      log_('screen error ' + meta.symbol + ': ' + e);
      upsertByKey_(TAB_FUNDAMENTALS, 'symbol', {
        symbol: meta.symbol, company_name: meta.name, sector: meta.sector,
        is_banking: meta.isBanking, screening_status: 'INSUFFICIENT_DATA',
        fail_reasons: 'Exception: ' + e, confidence_score: 0,
        last_updated: fmtDateTime_(new Date())
      });
    }
  }
  counts.timestamp = nowISO_();
  log_('runFundamentalScreener done: ' + JSON.stringify(counts));
  return counts;
}

// Daily: turn PASS fundamentals into at most `max_opportunities` ranked,
// valuation-screened, risk:reward-qualified opportunities.
function runOpportunityMonitor() {
  const cfg = getConfig();
  const health = fetchNifty200DMA();
  const niftyOK = health.isAbove200DMA === true;
  log_('runOpportunityMonitor: Nifty above 200DMA = ' + health.isAbove200DMA);

  const passers = readTabObjects_(TAB_FUNDAMENTALS).filter(function (r) {
    return r.screening_status === 'PASS';
  });
  log_('PASS universe: ' + passers.length);

  const candidates = [];
  for (let i = 0; i < passers.length; i++) {
    const f = passers[i];
    try {
      const px = fetchNSEPrice(f.symbol);
      const peData = fetchHistoricalPE(f.symbol);
      if (!px || px.lastPrice === null) { log_('skip ' + f.symbol + ': no price'); continue; }

      const currentPE = peData.currentPE;
      const avg5 = peData.avg5yr;
      // Prefer PE-vs-own-average once the rolling history exists; until then
      // fall back to the 52-week-drawdown signal (works from day one).
      const val = (avg5 !== null)
        ? calculateValuationStatus(currentPE, avg5, cfg)
        : calculateValuationStatusGF_(px.lastPrice, px.yearHigh, cfg);
      if (val.status !== 'STRONG_BUY' && val.status !== 'BUY') continue;

      const tg = calculateTargets(px.lastPrice, cfg);
      // Gate on the T2-based asymmetry so the default config is consistent;
      // the T1 ratio (tg.riskReward) is still what we display per spec.
      const rrGate = (tg.riskRewardT2 !== null) ? tg.riskRewardT2 : tg.riskReward;
      if (!tg.valid || rrGate === null || rrGate < cfg.min_risk_reward) continue;

      const conf = toNum_(f.confidence_score) || 0;
      if (conf < 60) continue;

      // Composite score (per spec). pePercentile: lower is better -> invert.
      const peDiscountMag = Math.abs(val.discountPct || 0);          // bigger discount better
      const percentileGood = peData.currentPercentile !== null ? (100 - peData.currentPercentile) : 50;
      const composite = (peDiscountMag * 0.4) + (conf * 0.3) + (tg.riskReward * 0.2) + (percentileGood * 0.1);

      candidates.push({
        symbol: f.symbol, company_name: f.company_name, sector: f.sector,
        current_price: px.lastPrice, current_pe: currentPE,
        avg_pe_5yr: avg5, avg_pe_10yr: peData.avg10yr,
        pe_discount_pct: val.discountPct, valuation_status: val.status,
        target_1_price: tg.target1Price, target_1_upside_pct: tg.target1Pct,
        target_2_price: tg.target2Price, target_2_upside_pct: tg.target2Pct,
        stop_loss_price: tg.stopLossPrice, stop_loss_pct: tg.stopLossPct,
        risk_reward_ratio: tg.riskReward, confidence_score: conf,
        entry_reason: buildEntryReason_(f, val),
        exit_reason: buildExitReason_(f, currentPE),
        risk_reason: buildRiskReason_(f, niftyOK, health),
        nifty_above_200dma: health.isAbove200DMA,
        _composite: composite, _t1UpsidePct: tg.target1Pct
      });
    } catch (e) {
      log_('opportunity error ' + f.symbol + ': ' + e);
    }
  }

  candidates.sort(function (a, b) { return b._composite - a._composite; });

  // Surface a wider candidate pool (default 10) with a per-sector cap (default 3)
  // so the list can't be dominated by one beaten-down sector. The final 5
  // shortlist is chosen later by getOpportunityData once fundamentals are in.
  const poolSize = cfg.candidate_pool_size || 10;
  const perSectorCap = cfg.max_per_sector || 3;
  const sectorCount = {};
  const top = [];
  for (let k = 0; k < candidates.length && top.length < poolSize; k++) {
    const c = candidates[k];
    const sec = c.sector || 'Other';
    if ((sectorCount[sec] || 0) >= perSectorCap) continue;   // sector full -> skip
    sectorCount[sec] = (sectorCount[sec] || 0) + 1;
    top.push(c);
  }

  // Detect newly appearing symbols for NEW_OPPORTUNITY alerts.
  const prev = {};
  readTabObjects_(TAB_OPPORTUNITIES).forEach(function (o) { prev[o.symbol] = true; });

  const rows = top.map(function (c, idx) {
    return {
      rank: idx + 1, symbol: c.symbol, company_name: c.company_name, sector: c.sector,
      current_price: c.current_price, current_pe: c.current_pe,
      avg_pe_5yr: c.avg_pe_5yr, avg_pe_10yr: c.avg_pe_10yr,
      pe_discount_pct: c.pe_discount_pct, valuation_status: c.valuation_status,
      target_1_price: c.target_1_price, target_1_upside_pct: c.target_1_upside_pct,
      target_2_price: c.target_2_price, target_2_upside_pct: c.target_2_upside_pct,
      stop_loss_price: c.stop_loss_price, stop_loss_pct: c.stop_loss_pct,
      risk_reward_ratio: c.risk_reward_ratio, confidence_score: c.confidence_score,
      entry_reason: c.entry_reason, exit_reason: c.exit_reason, risk_reason: c.risk_reason,
      nifty_above_200dma: c.nifty_above_200dma, last_updated: fmtDateTime_(new Date())
    };
  });
  replaceAllRows_(TAB_OPPORTUNITIES, rows);

  // Alerts: new opportunities + rotation hints.
  top.forEach(function (c) {
    if (!prev[c.symbol]) {
      writeAlert_({
        symbol: c.symbol, alert_type: ALERT.NEW_OPPORTUNITY,
        message: c.symbol + ' entered the top opportunities (' + c.valuation_status +
                 ', ' + c.pe_discount_pct + '% vs avg PE).',
        action_required: 'Review for entry', current_price: c.current_price,
        trigger_price: c.current_price
      });
    }
    const rot = checkRotationOpportunity(c._t1UpsidePct, cfg);
    if (rot.shouldRotate) {
      writeAlert_({
        symbol: c.symbol, alert_type: ALERT.ROTATION_OPPORTUNITY,
        message: rot.recommendation, action_required: 'Consider rotating from ' + rot.exitSymbol,
        current_price: c.current_price, trigger_price: c.current_price
      });
    }
  });

  log_('runOpportunityMonitor done: ' + top.length + ' opportunities');
  return { opportunities: rows, marketHealth: health, evaluated: passers.length, qualified: candidates.length, timestamp: nowISO_() };
}

function buildEntryReason_(f, val) {
  const bits = [];
  if (val.basis === '52w_drawdown') {
    bits.push((val.discountPct !== null ? val.discountPct + '% off 52w high' : 'off its highs'));
  } else {
    bits.push('PE ' + (val.discountPct !== null ? val.discountPct + '% vs avg' : 'attractive'));
  }
  if (f.profit_cagr_5yr !== null) bits.push('profit CAGR ' + f.profit_cagr_5yr + '%');
  if (f.roe_avg_5yr !== null) bits.push('ROE ' + f.roe_avg_5yr + '%');
  return 'Quality Nifty-100 large cap on a dip: ' + bits.join(', ') + '. Confidence ' + f.confidence_score + '/100.';
}

function buildExitReason_(f, currentPE) {
  return 'Exit if it re-rates back near its 52w high / PE average, or the business shows two consecutive weak quarters.';
}

function buildRiskReason_(f, niftyOK, health) {
  const r = [];
  if (!niftyOK) r.push('Nifty below 200DMA — broad-market caution');
  if (f.is_banking) r.push('Financials: leverage is structural; watch asset quality');
  if (f.promoter_pledge !== null && f.promoter_pledge > 0) r.push('Promoter pledge ' + f.promoter_pledge + '%');
  if (!r.length) r.push('Standard single-stock & sector risk');
  return r.join('; ') + '.';
}

// Daily 9PM: scan active positions and raise target/stop/thesis alerts.
// Idempotent on hit flags (won't re-fire TARGET_1 once recorded).
function runEndOfDayAlerts() {
  if (!isTradingDay_(new Date())) { log_('runEndOfDayAlerts: weekend, skipping'); return { skipped: 'weekend' }; }
  const cfg = getConfig();
  const positions = readTabObjects_(TAB_PORTFOLIO).filter(function (p) { return p.symbol && toNum_(p.quantity) > 0; });
  const alerts = [];

  positions.forEach(function (p) {
    const px = fetchNSEPrice(p.symbol);
    const cur = (px && px.lastPrice !== null) ? px.lastPrice : toNum_(p.current_price);
    if (cur === null) return;

    const entry = toNum_(p.entry_price);
    const pnlPct = entry > 0 ? ((cur - entry) / entry) * 100 : null;
    let status = p.alert_status || 'HOLD';

    const t1Hit = String(p.target_1_hit).toUpperCase() === 'TRUE';
    const t2Hit = String(p.target_2_hit).toUpperCase() === 'TRUE';
    // Fire against this position's own stored prices (per-stock scaled levels),
    // not a flat % — so each position exits at the level set when it was added.
    const t1 = toNum_(p.target_1_price), t2 = toNum_(p.target_2_price), sl = toNum_(p.stop_loss_price);

    if (sl !== null && cur <= sl) {
      alerts.push(writeAlert_({ symbol: p.symbol, alert_type: ALERT.STOP_LOSS_HIT,
        message: p.symbol + ' hit stop loss: ₹' + round2_(cur) + ' (≤ ₹' + sl + ', ' + round2_(pnlPct) + '%).',
        action_required: 'EXIT NOW — review thesis', current_price: cur, trigger_price: sl }));
      status = 'EXIT_NOW';
    } else if (t2 !== null && cur >= t2 && !t2Hit) {
      alerts.push(writeAlert_({ symbol: p.symbol, alert_type: ALERT.TARGET_2_HIT,
        message: p.symbol + ' reached Target 2: ₹' + round2_(cur) + ' (+' + round2_(pnlPct) + '%).',
        action_required: 'Book remaining / trail', current_price: cur, trigger_price: t2 }));
      setPortfolioFlag_(p.__row, 'target_2_hit', true);
      status = 'BOOK_PROFIT';
    } else if (t1 !== null && cur >= t1 && !t1Hit) {
      alerts.push(writeAlert_({ symbol: p.symbol, alert_type: ALERT.TARGET_1_HIT,
        message: p.symbol + ' reached Target 1: ₹' + round2_(cur) + ' (+' + round2_(pnlPct) + '%).',
        action_required: 'Book 50%', current_price: cur, trigger_price: t1 }));
      setPortfolioFlag_(p.__row, 'target_1_hit', true);
      status = 'BOOK_PROFIT';
    }

    // Thesis break: live PE collapses well below entry PE (proxy via fundamentals tab).
    const fund = findFundamental_(p.symbol);
    if (fund) {
      const livePE = currentPEForSymbol_(p.symbol);
      const entryPE = toNum_(p.notes && String(p.notes).match(/entryPE=([\d.]+)/) ? RegExp.$1 : null);
      if (livePE !== null && entryPE !== null && livePE < entryPE * 0.8) {
        alerts.push(writeAlert_({ symbol: p.symbol, alert_type: ALERT.THESIS_BROKEN,
          message: p.symbol + ' PE fell to ' + livePE + ' (<80% of entry PE ' + entryPE + ') — earnings shock?',
          action_required: 'Re-verify thesis', current_price: cur, trigger_price: cur }));
        if (status === 'HOLD') status = 'REVIEW';
      }
    }

    if (status !== (p.alert_status || 'HOLD')) setPortfolioFlag_(p.__row, 'alert_status', status);
  });

  log_('runEndOfDayAlerts: ' + alerts.length + ' new alerts');
  return { alerts: alerts, positions: positions.length, timestamp: nowISO_() };
}

// Orchestrate the daily run (weekday-gated).
function runDailyUpdate() {
  if (!isTradingDay_(new Date())) { log_('runDailyUpdate: weekend, skipping'); return { skipped: 'weekend' }; }
  log_('runDailyUpdate: start');
  const opp = runOpportunityMonitor();
  const px = updatePortfolioPrices();
  const eod = runEndOfDayAlerts();
  const summary = {
    opportunities: opp.opportunities ? opp.opportunities.length : 0,
    positionsPriced: px.updated || 0,
    alerts: eod.alerts ? eod.alerts.length : 0,
    marketHealth: opp.marketHealth || null,
    timestamp: nowISO_()
  };
  log_('runDailyUpdate done: ' + JSON.stringify(summary));
  return summary;
}

// ── ALERT + small helpers ────────────────────────────────────────────────────

function writeAlert_(a) {
  const row = {
    alert_date: fmtDate_(new Date()),
    symbol: a.symbol,
    alert_type: a.alert_type,
    message: a.message,
    action_required: a.action_required || '',
    is_actioned: false,
    current_price: a.current_price === undefined ? '' : a.current_price,
    trigger_price: a.trigger_price === undefined ? '' : a.trigger_price,
    created_at: nowISO_()
  };
  appendRow_(TAB_ALERTS, row);
  return row;
}

function setPortfolioFlag_(rowNum, col, value) {
  const sh = ss_().getSheetByName(TAB_PORTFOLIO);
  const idx = HEADERS[TAB_PORTFOLIO].indexOf(col);
  if (idx < 0 || !rowNum) return;
  sh.getRange(rowNum, idx + 1).setValue(value);
}

function findFundamental_(symbol) {
  const all = readTabObjects_(TAB_FUNDAMENTALS);
  for (let i = 0; i < all.length; i++) if (all[i].symbol === symbol) return all[i];
  return null;
}

function currentPEForSymbol_(symbol) {
  const pe = fetchHistoricalPE(symbol);
  return pe ? pe.currentPE : null;
}

// ── PORTFOLIO ────────────────────────────────────────────────────────────────

function getPortfolioSummary() {
  const cfg = getConfig();
  const positions = readTabObjects_(TAB_PORTFOLIO).filter(function (p) { return p.symbol; });
  let totalInvested = 0, currentValue = 0;
  const active = [];
  positions.forEach(function (p) {
    const qty = toNum_(p.quantity) || 0;
    if (qty <= 0) return;
    const inv = toNum_(p.invested_amount) || 0;
    const cur = toNum_(p.current_value) || 0;
    totalInvested += inv;
    currentValue += cur;
    active.push(p);
  });
  const totalPnL = currentValue - totalInvested;
  const alerts = readTabObjects_(TAB_ALERTS).filter(function (a) {
    return String(a.is_actioned).toUpperCase() !== 'TRUE';
  });
  return {
    totalInvested: round2_(totalInvested),
    currentValue: round2_(currentValue),
    totalPnL: round2_(totalPnL),
    totalPnLPct: totalInvested > 0 ? round2_((totalPnL / totalInvested) * 100) : 0,
    capitalDeployed: round2_(totalInvested),
    capitalRemaining: round2_(cfg.phase_capital_limit - totalInvested),
    phaseCapitalLimit: cfg.phase_capital_limit,
    positionCount: active.length,
    activeAlerts: alerts.length,
    paperTradeMode: cfg.paper_trade_mode === true,
    phaseStart: cfg.phase_start_date,
    phaseEnd: cfg.phase_end_date,
    timestamp: nowISO_()
  };
}

// Add a position. Hard rules:
//   - capital cap (phase_capital_limit) is a HARD block.
//   - symbol must be PASS in fundamentals (warning, not block).
//   - current opportunity status should be BUY/STRONG_BUY (warning).
// Writes to SCREENER_PORTFOLIO always; to VaultZero tabs only when
// paper_trade_mode = FALSE.
// data = { symbol, entry_price, quantity, notes? }
function addPosition(data) {
  if (!data || !data.symbol) throw new Error('addPosition: symbol required');
  const cfg = getConfig();
  const meta = getStockMeta_(data.symbol) || { name: data.symbol, sector: '', isBanking: false };

  const entryPrice = toNum_(data.entry_price);
  const qty = toNum_(data.quantity);
  if (entryPrice === null || entryPrice <= 0) throw new Error('addPosition: valid entry_price required');
  if (qty === null || qty <= 0) throw new Error('addPosition: valid quantity required');
  const invested = round2_(entryPrice * qty);

  const summary = getPortfolioSummary();
  if (summary.capitalDeployed + invested > cfg.phase_capital_limit + 1e-6) {
    return { success: false, error: 'Phase capital limit reached',
      detail: 'Deployed ₹' + summary.capitalDeployed + ' + new ₹' + invested +
              ' exceeds limit ₹' + cfg.phase_capital_limit, capitalRemaining: summary.capitalRemaining };
  }

  const warnings = [];
  const fund = findFundamental_(data.symbol);
  if (!fund || fund.screening_status !== 'PASS') warnings.push('Stock not in screened PASS universe');
  const opp = readTabObjects_(TAB_OPPORTUNITIES).filter(function (o) { return o.symbol === data.symbol; })[0];
  if (!opp) warnings.push('Not currently in the top opportunities list');
  else if (['BUY', 'STRONG_BUY'].indexOf(opp.valuation_status) < 0) warnings.push('Not in buy zone (status ' + opp.valuation_status + ')');

  // Build position row. Prefer the analyst's per-stock SCALED exits/stop; fall
  // back to the flat config targets only when no analysis exists for this name.
  const tg = calculateTargets(entryPrice, cfg);
  const dp = getDeepAnalysis().bySymbol[String(data.symbol).toUpperCase()] || null;
  let t1Price = tg.target1Price, t2Price = tg.target2Price, slPrice = tg.stopLossPrice;
  if (dp) {
    const t1 = toNum_(dp.suggested_exit_t1_pct), t2 = toNum_(dp.suggested_exit_t2_pct), sl = toNum_(dp.suggested_stop_pct);
    if (t1 !== null && t2 !== null && sl !== null && sl > 0) {
      t1Price = round2_(entryPrice * (1 + t1 / 100));
      t2Price = round2_(entryPrice * (1 + t2 / 100));
      slPrice = round2_(entryPrice * (1 - sl / 100));
    }
  }
  const entryPE = opp ? toNum_(opp.current_pe) : currentPEForSymbol_(data.symbol);
  const notes = (data.notes ? data.notes + ' | ' : '') + (entryPE !== null ? 'entryPE=' + entryPE : '');
  const id = 'POS-' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMddHHmmss') + '-' + data.symbol;

  const row = {
    id: id, symbol: data.symbol, company_name: meta.name, entry_date: fmtDate_(new Date()),
    entry_price: entryPrice, quantity: qty, invested_amount: invested,
    current_price: entryPrice, current_value: invested, unrealised_pnl: 0, unrealised_pnl_pct: 0,
    target_1_price: t1Price, target_1_hit: false,
    target_2_price: t2Price, target_2_hit: false,
    stop_loss_price: slPrice, alert_status: 'HOLD',
    days_held: 0, annualised_return: 0,
    paper_trade: cfg.paper_trade_mode === true, notes: notes, last_updated: fmtDateTime_(new Date()),
    nifty_at_entry: niftyLevelNow_()         // benchmark snapshot — enables alpha vs Nifty on exit
  };
  appendRow_(TAB_PORTFOLIO, row);

  // Real-money mirror only when NOT in paper mode.
  let vaultZero = { written: false, reason: 'paper_trade_mode = TRUE' };
  if (cfg.paper_trade_mode !== true) {
    vaultZero = mirrorToVaultZero_('BUY', data.symbol, meta.name, qty, entryPrice, invested);
  }

  log_('addPosition ' + data.symbol + ' x' + qty + ' @ ' + entryPrice + ' (paper=' + (cfg.paper_trade_mode === true) + ')');
  return { success: true, position: row, warnings: warnings, vaultZero: vaultZero,
           capitalRemaining: round2_(cfg.phase_capital_limit - (summary.capitalDeployed + invested)) };
}

// Refresh live price/value/pnl for every active position (batch write).
function updatePortfolioPrices() {
  const sh = getOrCreateTab_(TAB_PORTFOLIO);
  const positions = readTabObjects_(TAB_PORTFOLIO);
  let updated = 0;
  positions.forEach(function (p) {
    const qty = toNum_(p.quantity) || 0;
    if (qty <= 0) return;
    const px = fetchNSEPrice(p.symbol);
    if (!px || px.lastPrice === null) return;
    const cur = px.lastPrice;
    const invested = toNum_(p.invested_amount) || 0;
    const curVal = round2_(cur * qty);
    const pnl = round2_(curVal - invested);
    const pnlPct = invested > 0 ? round2_((pnl / invested) * 100) : 0;
    const days = daysBetween_(p.entry_date, new Date());
    const ann = (days > 0 && invested > 0)
      ? round2_((Math.pow(curVal / invested, 365 / days) - 1) * 100) : 0;

    writeRowFields_(sh, p.__row, {
      current_price: cur, current_value: curVal, unrealised_pnl: pnl,
      unrealised_pnl_pct: pnlPct, days_held: days, annualised_return: ann,
      last_updated: fmtDateTime_(new Date())
    });
    updated++;
  });
  log_('updatePortfolioPrices: ' + updated + ' positions');
  return { updated: updated, timestamp: nowISO_() };
}

// Book profit / exit. data = { positionId, quantity? , percentage? }:
//   - quantity: exact shares to sell (custom amount) — takes precedence;
//   - percentage: 1-100 fallback (100 = full exit), floored to whole shares.
// Reduces quantity (or closes), logs a PROFIT_BOOKED alert, and mirrors a SELL
// to VaultZero only when paper_trade_mode = FALSE.
function bookProfit(data) {
  const cfg = getConfig();
  const positionId = data && data.positionId;
  if (!positionId) throw new Error('bookProfit: positionId required');

  const sh = getOrCreateTab_(TAB_PORTFOLIO);
  const positions = readTabObjects_(TAB_PORTFOLIO);
  const p = positions.filter(function (x) { return x.id === positionId; })[0];
  if (!p) throw new Error('bookProfit: position not found: ' + positionId);

  const qty = toNum_(p.quantity) || 0;
  if (qty <= 0) throw new Error('bookProfit: nothing to sell');

  // Resolve shares to sell — explicit quantity wins, else percentage of holding.
  let sellQty;
  if (data.quantity !== undefined && data.quantity !== null && data.quantity !== '') {
    sellQty = Math.floor(toNum_(data.quantity));
  } else {
    const pct = toNum_(data.percentage);
    if (pct === null) throw new Error('bookProfit: quantity or percentage required');
    sellQty = pct >= 100 ? qty : Math.floor(qty * pct / 100);
  }
  if (!(sellQty > 0)) throw new Error('bookProfit: sell quantity must be at least 1 share');
  if (sellQty > qty) sellQty = qty;                        // clamp to current holding

  const px = fetchNSEPrice(p.symbol);
  const cur = (px && px.lastPrice !== null) ? px.lastPrice : toNum_(p.current_price);

  const entry = toNum_(p.entry_price);
  const proceeds = round2_(cur * sellQty);
  const profit = round2_((cur - entry) * sellQty);
  const remainingQty = qty - sellQty;

  if (remainingQty <= 0) {
    writeRowFields_(sh, p.__row, {
      quantity: 0, current_price: cur, current_value: 0, unrealised_pnl: 0,
      unrealised_pnl_pct: 0, alert_status: 'CLOSED', last_updated: fmtDateTime_(new Date())
    });
  } else {
    const newInvested = round2_(entry * remainingQty);
    writeRowFields_(sh, p.__row, {
      quantity: remainingQty, invested_amount: newInvested, current_price: cur,
      current_value: round2_(cur * remainingQty),
      unrealised_pnl: round2_((cur - entry) * remainingQty),
      unrealised_pnl_pct: entry > 0 ? round2_(((cur - entry) / entry) * 100) : 0,
      alert_status: 'PARTIAL_BOOKED', last_updated: fmtDateTime_(new Date())
    });
  }

  writeAlert_({ symbol: p.symbol, alert_type: ALERT.PROFIT_BOOKED,
    message: 'Booked ' + sellQty + ' of ' + p.symbol + ' @ ₹' + cur + ' (profit ₹' + profit + ').',
    action_required: '', current_price: cur, trigger_price: cur });

  // Closed-trade ledger row with the Nifty benchmark over the holding period.
  const stockRetPct = entry > 0 ? round2_(((cur - entry) / entry) * 100) : null;
  const niftyEntry = toNum_(p.nifty_at_entry);
  const niftyExit = niftyLevelNow_();
  const niftyRetPct = (niftyEntry && niftyEntry > 0 && niftyExit !== null)
    ? round2_(((niftyExit - niftyEntry) / niftyEntry) * 100) : null;
  const alphaPct = (stockRetPct !== null && niftyRetPct !== null) ? round2_(stockRetPct - niftyRetPct) : '';
  const t1 = toNum_(p.target_1_price), t2 = toNum_(p.target_2_price), sl = toNum_(p.stop_loss_price);
  const exitReason = (sl !== null && cur <= sl) ? 'STOP'
    : (t2 !== null && cur >= t2) ? 'TARGET_2'
    : (t1 !== null && cur >= t1) ? 'TARGET_1' : 'MANUAL';
  appendRow_(TAB_CLOSED, {
    id: p.id, symbol: p.symbol, company_name: p.company_name, sector: (getStockMeta_(p.symbol) || {}).sector || '',
    entry_date: p.entry_date, exit_date: fmtDate_(new Date()), holding_days: daysBetween_(p.entry_date, new Date()),
    entry_price: entry, exit_price: cur, quantity: sellQty,
    invested: round2_(entry * sellQty), proceeds: proceeds,
    realised_pnl: profit, realised_pnl_pct: stockRetPct,
    nifty_at_entry: (niftyEntry === null ? '' : niftyEntry), nifty_at_exit: (niftyExit === null ? '' : niftyExit),
    nifty_return_pct: (niftyRetPct === null ? '' : niftyRetPct), stock_vs_nifty_pct: alphaPct,
    exit_reason: exitReason, paper_trade: cfg.paper_trade_mode === true, created_at: nowISO_()
  });

  let vaultZero = { written: false, reason: 'paper_trade_mode = TRUE' };
  if (cfg.paper_trade_mode !== true) {
    vaultZero = mirrorToVaultZero_('SELL', p.symbol, p.company_name, sellQty, cur, proceeds);
  }

  log_('bookProfit ' + p.symbol + ' sold ' + sellQty + ' @ ' + cur + ' profit ' + profit + ' (' + exitReason + ')');
  return { success: true, symbol: p.symbol, soldQty: sellQty, price: cur, proceeds: proceeds,
           profit: profit, remainingQty: remainingQty, exitReason: exitReason,
           stockVsNiftyPct: alphaPct, vaultZero: vaultZero, timestamp: nowISO_() };
}

// Current Nifty 50 level (cached via market-health; falls back to a direct GF read).
function niftyLevelNow_() {
  try { const h = fetchNifty200DMA(); if (h && h.currentLevel !== null && h.currentLevel !== undefined) return toNum_(h.currentLevel); } catch (e) {}
  try { const q = gfQuote_('INDEXNSE:NIFTY_50'); return q ? toNum_(q.price) : null; } catch (e) { return null; }
}

function daysBetween_(fromDate, toDate) {
  try {
    const a = (fromDate instanceof Date) ? fromDate : new Date(fromDate);
    const b = (toDate instanceof Date) ? toDate : new Date(toDate);
    return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
  } catch (e) { return 0; }
}

function writeRowFields_(sheet, rowNum, fields) {
  const headers = HEADERS[sheet.getName()];
  Object.keys(fields).forEach(function (k) {
    const idx = headers.indexOf(k);
    if (idx >= 0) sheet.getRange(rowNum, idx + 1).setValue(fields[k]);
  });
}

// ── VAULTZERO MIRROR (real money only) — header-mapped, never alters structure ───

// Best-effort append into the existing VaultZero asset & transaction tabs by
// matching their header names. Unknown columns are left blank. Returns what
// was written. Only ever called when paper_trade_mode = FALSE.
function mirrorToVaultZero_(side, symbol, companyName, qty, price, amount) {
  const out = { written: false };
  try {
    const cfg = getConfig();
    const txnType = (String(side).toUpperCase() === 'SELL') ? 'Sell' : 'Buy';

    // 1. Resolve (or create) the asset, get its numeric id for the FK.
    const asset = vzResolveAsset_(symbol, companyName, price, cfg);
    out.assetId = asset.id;
    out.assetCreated = asset.created;

    // 2. Append the transaction referencing asset_id.
    const txnSheet = ss_().getSheetByName(VZ_TRANSACTIONS_TAB);
    if (!txnSheet) throw new Error('Missing tab ' + VZ_TRANSACTIONS_TAB);
    const txnId = vzNextId_(txnSheet);
    vzAppendByHeaders_(txnSheet, {
      id: txnId,
      asset_id: asset.id,
      txn_type: txnType,
      txn_date: fmtDate_(new Date()),
      quantity: qty,
      price_per_share: price,
      amount: amount,
      notes: 'StockIQ ' + txnType,
      created_at: new Date().toISOString()
    });

    out.transactionId = txnId;
    out.written = true;
    log_('VaultZero ' + txnType + ' txn#' + txnId + ' -> asset#' + asset.id + ' (' + symbol + ')');
  } catch (e) {
    log_('mirrorToVaultZero_ error: ' + e);
    out.error = String(e);
  }
  return out;
}

// Next integer id for a VaultZero tab = max(numeric col A) + 1 (1 if empty).
function vzNextId_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  let max = 0;
  for (let i = 0; i < ids.length; i++) {
    const n = toNum_(ids[i][0]);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

// Find an asset row by ticker (case-insensitive). Returns {id, row} or null.
function vzFindAssetByTicker_(ticker) {
  const sh = ss_().getSheetByName(VZ_ASSETS_TAB);
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  if (data.length < 1) return null;
  const headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const idIdx = headers.indexOf('id');
  const tickIdx = headers.indexOf('ticker');
  if (tickIdx < 0 || idIdx < 0) return null;
  const want = String(ticker).trim().toUpperCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][tickIdx]).trim().toUpperCase() === want) {
      return { id: data[r][idIdx], row: r + 1 };
    }
  }
  return null;
}

// Resolve an asset id by ticker; insert a new asset (next id, configured
// subcategory/strategy, is_active TRUE) when it doesn't exist yet.
// Returns { id, created }.
function vzResolveAsset_(symbol, companyName, price, cfg) {
  const existing = vzFindAssetByTicker_(symbol);
  if (existing) return { id: existing.id, created: false };

  const sh = ss_().getSheetByName(VZ_ASSETS_TAB);
  if (!sh) throw new Error('Missing tab ' + VZ_ASSETS_TAB);
  const id = vzNextId_(sh);
  vzAppendByHeaders_(sh, {
    id: id,
    subcategory_id: cfg.vaultzero_subcategory_id || 22,
    company_name: companyName || symbol,
    ticker: symbol,
    strategy: cfg.vaultzero_strategy || 'Long Term',
    is_active: true,
    current_price: (price === null || price === undefined) ? '' : price,
    created_at: new Date().toISOString()
  });
  log_('VaultZero new asset#' + id + ' (' + symbol + ')');
  return { id: id, created: true };
}

// Append a row to an existing VaultZero tab by matching its header names
// (lower-cased). Unknown columns are left blank. Robust to column reordering;
// never alters the tab's structure.
function vzAppendByHeaders_(sheet, valuesByHeader) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });
  const row = headers.map(function (h) {
    return (valuesByHeader[h] !== undefined) ? valuesByHeader[h] : '';
  });
  sheet.appendRow(row);
  return { tab: sheet.getName(), row: sheet.getLastRow() };
}

// ── READ ENDPOINTS (consumed by the frontend) ────────────────────────────────

function getScreenerData() {
  const rows = readTabObjects_(TAB_FUNDAMENTALS).map(function (r) { delete r.__row; return r; });
  let last = '';
  rows.forEach(function (r) { if (r.last_updated && String(r.last_updated) > last) last = String(r.last_updated); });
  const counts = { PASS: 0, FAIL: 0, INSUFFICIENT_DATA: 0 };
  rows.forEach(function (r) { if (counts[r.screening_status] !== undefined) counts[r.screening_status]++; });
  return { rows: rows, counts: counts, lastUpdated: last, total: rows.length };
}

// Opportunities enriched at read time with the manual Claude deep analysis:
// each row gets a `deep` object, a combined `final_score`, an `analyzed` flag
// and a `fundamentals_age_days`. Then:
//   - AVOID verdicts are dropped entirely (hard block);
//   - WEAK verdicts get a value-trap guard: display status forced to WATCH and
//     score heavily cut (so a cheap-but-weak name can't masquerade as a BUY);
//   - the list is ranked by final_score and the top `max_opportunities` (5) are
//     flagged `shortlisted` — the rest (up to candidate_pool_size, 10) are bench;
//   - `noConviction` is set if every analyzed name is WEAK (→ "hold cash").
function getOpportunityData() {
  const cfg = getConfig();
  const rows = readTabObjects_(TAB_OPPORTUNITIES).map(function (r) { delete r.__row; return r; });
  const deepMap = getDeepAnalysis().bySymbol;
  const today = new Date();

  const isTrue_ = function (v) { return v === true || String(v).toUpperCase() === 'TRUE'; };
  const merged = [];
  rows.forEach(function (o) {
    const deep = deepMap[o.symbol] || null;
    const verdict = deep ? String(deep.verdict).toUpperCase() : '';
    // Hard block: AVOID, a deflating hype premium, a value trap, a structural
    // (permanent) decline, or a failed business-health gate — never shown as buys.
    if (deep && (verdict === 'AVOID' || isTrue_(deep.is_deflating_hype) || isTrue_(deep.is_value_trap_risk) ||
        String(deep.correction_reason).toLowerCase() === 'structural' ||
        (deep.business_healthy !== undefined && deep.business_healthy !== '' && !isTrue_(deep.business_healthy)))) {
      return;
    }

    // Holistic, type-fair conviction (quality + value-the-right-way + verdict).
    const score = calculateConviction_(o, deep);

    let ageDays = null, stale = false;
    if (deep) {
      if (verdict === 'WEAK') {
        o.valuation_status = 'WATCH';                       // value-trap guard: not a "BUY"
        o.weak = true;
      }
      // Per-stock SCALED exits/stop from the analyst (override the flat defaults).
      const t1 = toNum_(deep.suggested_exit_t1_pct);
      const t2 = toNum_(deep.suggested_exit_t2_pct);
      const sl = toNum_(deep.suggested_stop_pct);
      const px = toNum_(o.current_price);
      if (px && t1 !== null && t2 !== null && sl !== null && sl > 0) {
        o.target_1_price = round2_(px * (1 + t1 / 100)); o.target_1_upside_pct = t1;
        o.target_2_price = round2_(px * (1 + t2 / 100)); o.target_2_upside_pct = t2;
        o.stop_loss_price = round2_(px * (1 - sl / 100)); o.stop_loss_pct = sl;
        o.risk_reward_ratio = round2_(t1 / sl);            // scaled R:R (no longer constant)
        o.scaled_exits = true;
      }
      if (deep.analysis_date) {
        const d = new Date(deep.analysis_date);
        if (!isNaN(d)) { ageDays = Math.round((today - d) / 86400000); stale = ageDays > 90; }
      }
    }

    o.deep = deep;
    o.analyzed = !!deep;
    o.verdict = verdict;
    o.fundamentals_age_days = ageDays;
    o.fundamentals_stale = stale;
    o.confidence_score = score;              // shown as "Conviction"
    o.final_score = score;                   // ranking = the same score
    merged.push(o);
  });

  merged.sort(function (a, b) { return b.final_score - a.final_score; });
  const shortlistN = cfg.max_opportunities || 5;
  merged.forEach(function (o, i) {
    o.rank = i + 1;
    o.shortlisted = i < shortlistN;
    o.rank_reason = rankReason_(o, shortlistN);   // honest "why shortlisted / why benched"
  });

  const analyzed = merged.filter(function (o) { return o.analyzed; });
  const anyConviction = analyzed.some(function (o) { return o.verdict === 'STRONG' || o.verdict === 'MODERATE'; });
  const noConviction = analyzed.length > 0 && !anyConviction;

  let last = '';
  rows.forEach(function (r) { if (r.last_updated && String(r.last_updated) > last) last = String(r.last_updated); });
  return {
    opportunities: merged,
    count: merged.length,
    shortlistSize: shortlistN,
    analyzedCount: analyzed.length,
    noConviction: noConviction,
    lastUpdated: last
  };
}

// One honest line per card explaining its placement — built from the real
// drivers (value discount, verdict, reward:risk), not a generic blurb. The
// shortlist is purely the top `shortlistN` by conviction, so a low-tier name
// can ride in on rank; this says so plainly instead of implying it's a buy.
function rankReason_(o, shortlistN) {
  const d = o.deep || {};
  const disc = toNum_(d.valuation_discount_pct);
  const metric = String(d.valuation_metric || '').replace(/_/g, '/');
  const rr = toNum_(o.risk_reward_ratio);
  const v = o.verdict;
  const score = toNum_(o.confidence_score);
  const cut = shortlistN || 5;
  const pos = [], neg = [];

  if (disc !== null) {
    const tail = metric ? (' below 5y ' + metric) : ' below 5y avg';
    if (disc >= 30)      pos.push('deep value (' + Math.round(disc) + '%' + tail + ')');
    else if (disc >= 15) pos.push(Math.round(disc) + '%' + tail);
    else if (disc > 0)   neg.push('shallow discount (' + Math.round(disc) + '%' + tail + ')');
    else                 neg.push('not cheap vs its own 5y ' + (metric || 'average'));
  }
  if (v === 'STRONG')    pos.push('STRONG verdict');
  else if (v === 'WEAK') neg.push('WEAK verdict');

  if (rr !== null) {
    if (rr >= 2)     pos.push('strong reward:risk 1:' + (Math.round(rr * 10) / 10));
    else if (rr < 1) neg.push('poor reward:risk 1:' + (Math.round(rr * 10) / 10));
  }

  if (!o.shortlisted) {
    return 'below the top-' + cut + ' cut — ' +
      (neg.length ? neg.join(', ') : 'lowest conviction of the survivors') +
      '. Re-analyse; may rotate in.';
  }
  if (score !== null && score < 60) {
    return 'made the cut by rank, not conviction' +
      (neg.length ? ' — ' + neg.join(', ') : '') + '. Borderline; size small.';
  }
  let s = pos.length ? pos.join(' + ') : ('top-' + cut + ' by conviction');
  if (neg.length) s += '; watch ' + neg.join(', ');
  return s + '.';
}

function getAlerts() {
  const rows = readTabObjects_(TAB_ALERTS).map(function (r) { delete r.__row; return r; });
  const priority = {};
  priority[ALERT.STOP_LOSS_HIT] = 1; priority[ALERT.TARGET_2_HIT] = 2; priority[ALERT.TARGET_1_HIT] = 3;
  priority[ALERT.ROTATION_OPPORTUNITY] = 4; priority[ALERT.THESIS_BROKEN] = 5;
  priority[ALERT.NEW_OPPORTUNITY] = 6; priority[ALERT.PROFIT_BOOKED] = 7;
  const open = rows.filter(function (a) { return String(a.is_actioned).toUpperCase() !== 'TRUE'; });
  open.sort(function (a, b) {
    const pa = priority[a.alert_type] || 99, pb = priority[b.alert_type] || 99;
    if (pa !== pb) return pa - pb;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
  return { open: open, all: rows.slice(-100), openCount: open.length };
}

function getPortfolioData() {
  const rows = readTabObjects_(TAB_PORTFOLIO).map(function (r) { delete r.__row; return r; });
  return { positions: rows, summary: getPortfolioSummary() };
}

// Track record from closed trades — answers "is this beating a Nifty 50 index?"
// honestly, with a verdict the user can act on.
function getClosedSummary() {
  const cfg = getConfig();
  const seed = toNum_(cfg.phase_capital_limit) || 25000;
  const rows = readTabObjects_(TAB_CLOSED).filter(function (r) { return r.symbol; });
  const trades = rows.length;
  const wins = rows.filter(function (r) { return (toNum_(r.realised_pnl) || 0) > 0; }).length;
  const pnlTotal = rows.reduce(function (a, r) { return a + (toNum_(r.realised_pnl) || 0); }, 0);
  const alphas = rows.map(function (r) { return toNum_(r.stock_vs_nifty_pct); }).filter(function (x) { return x !== null; });

  const winRate = trades ? round2_(wins / trades * 100) : 0;
  const expectancy = trades ? round2_(pnlTotal / trades) : 0;
  const returnOnSeed = seed > 0 ? round2_(pnlTotal / seed * 100) : 0;
  const avgAlpha = alphas.length ? round2_(alphas.reduce(function (a, b) { return a + b; }, 0) / alphas.length) : null;

  let verdict, msg;
  if (trades < 8) {
    verdict = 'TOO_EARLY';
    msg = trades + ' closed trade(s) — need 8+ before judging; keep a Nifty 50 index fund as your base.';
  } else if (avgAlpha === null) {
    verdict = 'NO_BENCHMARK';
    msg = 'No Nifty-at-entry was captured on these trades, so alpha can\'t be measured — trades from now on will have it.';
  } else if (avgAlpha > 0 && expectancy > 0) {
    verdict = 'WORKING';
    msg = 'Edge looks real: +' + avgAlpha + '% average alpha vs Nifty with positive expectancy. Continue.';
  } else if (avgAlpha <= 0) {
    verdict = 'STOP';
    msg = 'A plain Nifty SIP did as well or better (' + avgAlpha + '% avg alpha). Move this money to the index fund.';
  } else {
    verdict = 'MIXED';
    msg = 'Inconclusive — keep trading and re-check later.';
  }

  return {
    trades: trades, win_rate_pct: winRate, expectancy_per_trade: expectancy,
    realised_pnl_total: round2_(pnlTotal), return_on_seed_pct: returnOnSeed,
    avg_alpha_vs_nifty_pct: avgAlpha, seed_capital: seed, benchmarked_trades: alphas.length,
    verdict: verdict, verdict_message: msg, timestamp: nowISO_()
  };
}

// Mark an alert actioned. data = { created_at } (unique-ish) or {symbol, alert_type}.
function actionAlert(data) {
  const sh = getOrCreateTab_(TAB_ALERTS);
  const rows = readTabObjects_(TAB_ALERTS);
  let done = 0;
  rows.forEach(function (a) {
    const match = (data.created_at && a.created_at === data.created_at) ||
                  (!data.created_at && a.symbol === data.symbol && a.alert_type === data.alert_type);
    if (match && String(a.is_actioned).toUpperCase() !== 'TRUE') {
      setAlertActioned_(sh, a.__row); done++;
    }
  });
  return { actioned: done };
}

function setAlertActioned_(sheet, rowNum) {
  const idx = HEADERS[TAB_ALERTS].indexOf('is_actioned');
  sheet.getRange(rowNum, idx + 1).setValue(true);
}

// ── DEEP FUNDAMENTAL ANALYSIS (human-in-the-loop via Claude paste) ───────────
//  These values are LLM ESTIMATES, not verified data. Stored separately and
//  always labelled as such in the UI.

// Save a pasted Claude analysis. `data` = { analysis: { SYM: {..fields..}, ... },
// raw?: "<original text>" }. Upserts one row per symbol into SCREENER_DEEP_ANALYSIS.
// Arrays (red_flags/green_flags) are stored pipe-joined. Returns counts.
function saveDeepAnalysis(data) {
  if (!data) throw new Error('saveDeepAnalysis: data required');
  const analysis = data.analysis || data;     // tolerate the bare map
  if (typeof analysis !== 'object') throw new Error('saveDeepAnalysis: analysis object required');
  const raw = data.raw ? String(data.raw).slice(0, 45000) : '';

  const symbols = Object.keys(analysis).filter(function (k) {
    return analysis[k] && typeof analysis[k] === 'object';
  });
  if (!symbols.length) throw new Error('saveDeepAnalysis: no stock objects found in JSON');

  getOrCreateTab_(TAB_DEEP);
  ensureHeaders_(TAB_DEEP, true);              // schema additions + auto-clear any stale-layout rows
  const saved = [];
  symbols.forEach(function (sym) {
    const a = analysis[sym] || {};
    const ssm = a.sector_specific_metrics;
    const bool_ = function (v) { return v === true || String(v).toUpperCase() === 'TRUE'; };
    const row = {
      symbol: String(sym).toUpperCase(),
      sector: a.sector || '',
      analysis_date: a.analysis_date || fmtDate_(new Date()),
      valuation_metric: a.valuation_metric || '',
      current_valuation: toNum_(a.current_valuation),
      historical_avg_valuation_5yr: toNum_(a.historical_avg_valuation_5yr),
      valuation_discount_pct: toNum_(a.valuation_discount_pct),
      fair_value_upside_pct: toNum_(a.fair_value_upside_pct),
      is_deflating_hype: bool_(a.is_deflating_hype),
      hype_check_reasoning: a.hype_check_reasoning || '',
      peg_or_growth_justifies_valuation: bool_(a.peg_or_growth_justifies_valuation),
      revenue_cagr_3yr: toNum_(a.revenue_cagr_3yr), profit_cagr_3yr: toNum_(a.profit_cagr_3yr),
      roe_current: toNum_(a.roe_current), roe_5yr_avg: toNum_(a.roe_5yr_avg),
      debt_to_equity: toNum_(a.debt_to_equity), operating_cf_to_net_profit: toNum_(a.operating_cf_to_net_profit),
      promoter_holding_pct: toNum_(a.promoter_holding_pct), promoter_holding_trend: a.promoter_holding_trend || '',
      business_healthy: bool_(a.business_healthy), health_score: toNum_(a.health_score),
      sector_specific_metrics: (ssm && typeof ssm === 'object') ? JSON.stringify(ssm) : (ssm || ''),
      correction_reason: a.correction_reason || '', correction_reasoning: a.correction_reasoning || '',
      is_value_trap_risk: bool_(a.is_value_trap_risk),
      suggested_exit_t1_pct: toNum_(a.suggested_exit_t1_pct), suggested_exit_t2_pct: toNum_(a.suggested_exit_t2_pct),
      valuation_floor: toNum_(a.valuation_floor), floor_downside_pct: toNum_(a.floor_downside_pct),
      suggested_stop_pct: toNum_(a.suggested_stop_pct),
      mean_reversion_thesis: a.mean_reversion_thesis || '', recovery_catalyst: a.recovery_catalyst || '',
      thesis_invalidation: a.thesis_invalidation || '',
      key_risks: flagsToString_(a.key_risks), worst_case_scenario: a.worst_case_scenario || '',
      max_drawdown_risk_pct: toNum_(a.max_drawdown_risk_pct),
      verdict: a.verdict ? String(a.verdict).toUpperCase() : '',
      confidence: toNum_(a.confidence), data_quality_flag: a.data_quality_flag || '',
      source: 'CLAUDE_MANUAL (LLM estimate)', last_updated: fmtDateTime_(new Date())
    };
    upsertByKey_(TAB_DEEP, 'symbol', row);
    saved.push(row.symbol);
  });

  if (raw) { try { PropertiesService.getScriptProperties().setProperty('deep_raw_last', raw); } catch (e) {} }

  log_('saveDeepAnalysis: ' + saved.length + ' symbols -> ' + saved.join(', '));
  return { saved: saved.length, symbols: saved, timestamp: nowISO_() };
}

function flagsToString_(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean).join(' | ');
  return String(v);
}

// All deep-analysis rows + a bySymbol map.
function getDeepAnalysis() {
  const rows = readTabObjects_(TAB_DEEP).map(function (r) { delete r.__row; return r; });
  const bySymbol = {};
  let last = '';
  rows.forEach(function (r) {
    bySymbol[String(r.symbol).toUpperCase()] = r;
    if (r.last_updated && String(r.last_updated) > last) last = String(r.last_updated);
  });
  return { rows: rows, bySymbol: bySymbol, count: rows.length, lastUpdated: last };
}

// ── API HANDLER ──────────────────────────────────────────────────────────────

function doGet(e) {
  const action = e && e.parameter ? e.parameter.action : null;
  const data = (e && e.parameter && e.parameter.data) ? JSON.parse(e.parameter.data) : null;
  return handleAction_(action, data);
}

// POST entry point — used for large payloads (e.g. a pasted Claude analysis)
// that would overflow a GET query string. Body is the JSON `data`; the action
// stays in the query string. text/plain content-type keeps it a CORS-simple
// request (no preflight).
function doPost(e) {
  const action = e && e.parameter ? e.parameter.action : null;
  let data = null;
  try {
    if (e && e.postData && e.postData.contents) data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, error: 'Invalid JSON body: ' + err, action: action, timestamp: nowISO_() });
  }
  return handleAction_(action, data);
}

// Actions that are never gated (liveness check used before a key is entered).
const OPEN_ACTIONS = { ping: 1 };

function getApiToken_() {
  try { return (PropertiesService.getScriptProperties().getProperty('api_token') || '').trim(); }
  catch (e) { return ''; }
}

function handleAction_(action, data) {
  let result;
  try {
    // Whole-app gate: when api_token is configured, EVERY HTTP action (reads
    // included) requires the matching token, so a public URL is fully locked
    // until the key is entered. Editor TEST_* runs bypass this. A wrong/missing
    // token returns the literal 'unauthorized' so the frontend gate can detect it.
    const tok = getApiToken_();
    if (tok && !OPEN_ACTIONS[action]) {
      const provided = data && data.token;
      if (provided !== tok) {
        return jsonOut_({ success: false, action: action, timestamp: nowISO_(), error: 'unauthorized' });
      }
    }
    switch (action) {
      // Setup
      case 'setupStockIQ':           result = setupStockIQ(); break;
      case 'setupTimeTriggers':      result = setupTimeTriggers(); break;

      // Engine
      case 'runFundamentalScreener': result = runFundamentalScreener(data && data.symbols); break;
      case 'runOpportunityMonitor':  result = runOpportunityMonitor(); break;
      case 'runDailyUpdate':         result = runDailyUpdate(); break;
      case 'runEndOfDayAlerts':      result = runEndOfDayAlerts(); break;

      // Reads
      case 'getScreenerData':        result = getScreenerData(); break;
      case 'getOpportunityData':     result = getOpportunityData(); break;
      case 'getPortfolioSummary':    result = getPortfolioSummary(); break;
      case 'getPortfolioData':       result = getPortfolioData(); break;
      case 'getClosedSummary':       result = getClosedSummary(); break;
      case 'getAlerts':              result = getAlerts(); break;
      case 'getConfig':              result = getConfig(); break;
      case 'getMarketHealth':        result = fetchNifty200DMA(); break;
      case 'getDeepAnalysis':        result = getDeepAnalysis(); break;

      // Actions
      case 'addPosition':            result = addPosition(data); break;
      case 'bookProfit':             result = bookProfit(data); break;
      case 'updatePortfolioPrices':  result = updatePortfolioPrices(); break;
      case 'actionAlert':            result = actionAlert(data); break;
      case 'updateConfig':           result = updateConfig(data); break;
      case 'saveDeepAnalysis':       result = saveDeepAnalysis(data); break;

      // Diagnostics
      case 'ping':                   result = { pong: true, time: nowISO_() }; break;
      case 'selfTest':               result = selfTest(data && data.symbol); break;

      default:                       result = { error: 'Unknown action: ' + action };
    }
    return jsonOut_({ success: !(result && result.error), data: result, timestamp: nowISO_() });
  } catch (err) {
    log_('handleAction_ error (' + action + '): ' + err);
    return jsonOut_({ success: false, error: String(err), action: action, timestamp: nowISO_() });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── SELF-TEST (run from editor to validate the data + calc layers on 1 stock) ───

function selfTest(symbol) {
  symbol = symbol || 'TCS';
  const cfg = getConfig();
  const raw = fetchFromScreener(symbol);
  const px = fetchNSEPrice(symbol);
  const pe = fetchHistoricalPE(symbol);
  const health = fetchNifty200DMA();
  const screened = screenOneStock_(getStockMeta_(symbol) || { symbol: symbol, name: symbol, sector: '', isBanking: false }, cfg);
  const val = calculateValuationStatus(pe ? pe.currentPE : null, pe ? pe.avg5yr : null, cfg);
  const tg = px ? calculateTargets(px.lastPrice, cfg) : { valid: false };
  const report = {
    symbol: symbol,
    rawScreener: raw ? { salesYrs: (raw.sales || []).length, profitYrs: (raw.netProfit || []).length,
      currentPE: raw.currentPE, debtToEquity: raw.debtToEquity, promoterHolding: raw.promoterHolding } : null,
    price: px ? { lastPrice: px.lastPrice, stale: !!px._stale } : null,
    pe: pe,
    marketHealth: health,
    screened: screened,
    valuation: val,
    targets: tg
  };
  log_('selfTest ' + symbol + ': ' + JSON.stringify(report));
  return report;
}

// Convenience wrappers to run from the Apps Script editor dropdown.
function TEST_setup()        { return setupStockIQ(); }
function TEST_screenTCS()    { return runFundamentalScreener(['TCS']); }
function TEST_screen5()      { return runFundamentalScreener(['TCS','INFY','HDFCBANK','ITC','RELIANCE']); }
function TEST_opportunities(){ return runOpportunityMonitor(); }
function TEST_selfTestTCS()  { return selfTest('TCS'); }

// ── GOOGLEFINANCE DATA LAYER ─────────────────────────────────────────────────
//  screener.in / NSE are unreachable from Apps Script (Cloudflare blocks the
//  datacenter IPs -> "Address unavailable"). GOOGLEFINANCE is native to the
//  Sheet, so we round-trip formulas through a hidden scratch tab and read the
//  computed values back. This is the price/PE/52wk/200-DMA engine.

function gfPrepScratch_() {
  const ss = ss_();
  let sh = ss.getSheetByName(TAB_GF);
  if (!sh) { sh = ss.insertSheet(TAB_GF); try { sh.hideSheet(); } catch (e) {} }
  return sh;
}

// Live-ish quote via GOOGLEFINANCE. `symbol` may be a bare NSE code (TCS) or a
// full ticker with a colon (INDEXNSE:NIFTY_50). Returns numeric fields or null
// per field on #N/A. Serialized with a script lock to protect the scratch cells.
function gfQuote_(symbol) {
  const ticker = (String(symbol).indexOf(':') >= 0) ? String(symbol) : ('NSE:' + symbol);
  const attrs = ['price', 'pe', 'eps', 'high52', 'low52', 'changepct'];
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { /* proceed best-effort */ }
  try {
    const sh = gfPrepScratch_();
    sh.getRange('A1').setValue(ticker);
    const formulaRow = attrs.map(function (a) {
      return '=IFERROR(GOOGLEFINANCE($A$1,"' + a + '"),"NA")';
    });
    sh.getRange(1, 2, 1, attrs.length).setFormulas([formulaRow]);
    SpreadsheetApp.flush();
    const vals = sh.getRange(1, 2, 1, attrs.length).getValues()[0];
    const out = { symbol: symbol };
    for (let i = 0; i < attrs.length; i++) {
      out[attrs[i]] = (vals[i] === 'NA' || vals[i] === '') ? null : toNum_(vals[i]);
    }
    return out;
  } catch (e) {
    log_('gfQuote_ ' + symbol + ' error: ' + e);
    return null;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Historical daily closes via GOOGLEFINANCE -> current level + N-day moving avg.
// `ticker` is a full GOOGLEFINANCE ticker (e.g. INDEXNSE:NIFTY_50 or NSE:TCS).
function gfHistoricalAvgClose_(ticker, calendarDays, lastN) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) {}
  try {
    const sh = gfPrepScratch_();
    sh.getRange(2, 1, 600, 3).clearContent();           // clear the spill zone
    sh.getRange('A2').setFormula(
      '=IFERROR(GOOGLEFINANCE("' + ticker + '","close",TODAY()-' + calendarDays + ',TODAY(),"DAILY"),"NA")');
    SpreadsheetApp.flush();
    const data = sh.getRange(2, 1, 600, 2).getValues(); // [date, close]; header row "Date/Close" is text
    const closes = [];
    for (let i = 0; i < data.length; i++) {
      const c = toNum_(data[i][1]);
      if (c !== null) closes.push(c);
    }
    if (!closes.length) return { current: null, dma: null, samples: 0 };
    const current = closes[closes.length - 1];
    const window = closes.slice(Math.max(0, closes.length - (lastN || 200)));
    return { current: round2_(current), dma: round2_(mean_(window)), samples: closes.length };
  } catch (e) {
    log_('gfHistoricalAvgClose_ ' + ticker + ' error: ' + e);
    return { current: null, dma: null, samples: 0 };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Rolling PE history per symbol (PropertiesService). GOOGLEFINANCE gives only
// the *current* PE, so a self-built daily series becomes the "average PE"
// signal over time. Needs >=20 samples (~1 month) before it returns an average.
function updatePERollingSeries_(symbol, pe) {
  const key = 'peseries_' + symbol;
  let arr = [];
  try { const raw = PropertiesService.getScriptProperties().getProperty(key); if (raw) arr = JSON.parse(raw); }
  catch (e) { arr = []; }
  const today = fmtDate_(new Date());
  if (pe !== null && pe > 0 && (!arr.length || arr[arr.length - 1].d !== today)) {
    arr.push({ d: today, v: pe });
    if (arr.length > 800) arr = arr.slice(arr.length - 800);
    try { PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(arr)); } catch (e) {}
  }
  const vals = arr.map(function (x) { return x.v; });
  const avg = vals.length >= 20 ? round2_(mean_(vals)) : null;
  const sd  = vals.length >= 20 ? round2_(stdDev_(vals)) : null;
  let percentile = null;
  if (avg !== null && pe !== null && vals.length) {
    const below = vals.filter(function (v) { return v <= pe; }).length;
    percentile = round2_((below / vals.length) * 100);
  }
  return { avg: avg, stdDev: sd, percentile: percentile, samples: vals.length };
}

// GF valuation fallback when no PE-average exists yet: distance below the
// 52-week high (the "X% off peak = accumulate" signal). discountPct is the
// drawdown (negative = below high).
function calculateValuationStatusGF_(price, high52, cfg) {
  cfg = cfg || getConfig();
  if (price === null || high52 === null || high52 <= 0) {
    return { status: 'DATA_UNAVAILABLE', discountPct: null, ratio: null, basis: '52w_drawdown' };
  }
  const dd = round2_(((price - high52) / high52) * 100);
  let status;
  if (dd <= cfg.value_dd_strong_buy)   status = 'STRONG_BUY';
  else if (dd <= cfg.value_dd_buy)     status = 'BUY';
  else if (dd <= cfg.value_dd_watch)   status = 'WATCH';
  else if (dd <= -3)                   status = 'FAIR_VALUE';
  else                                 status = 'EXPENSIVE';
  return { status: status, discountPct: dd, ratio: null, basis: '52w_drawdown' };
}

// Holistic 0-100 conviction — fair across stock TYPES, not just beaten-down
// names. Blends Quality + Value (measured the way each type is actually judged)
// + Risk:reward + the Claude verdict. o = opportunity row, deep = Claude analysis.
//   VALUE   (max 45): financials lean on the (P/B-aware) Claude read since banks
//                     trade on P/B not PE/drawdown; others use PE-vs-avg / drawdown.
//   QUALITY (max 35): growth + ROE + balance sheet from Claude (baseline if not analysed).
//   R:R     (max 10): reward asymmetry to target.
//   VERDICT (±):      STRONG +10 / MODERATE 0 / WEAK -20, minus red flags.
function calculateConviction_(o, deep) {
  const fin = ['Banking', 'NBFC', 'Insurance'].indexOf(o.sector) >= 0;
  const scale = function (x, lo, hi, max) { return Math.max(0, Math.min(max, ((x - lo) / (hi - lo)) * max)); };
  const conf = deep ? (toNum_(deep.confidence) || 0) : null;

  // ── VALUE (max 45) — prefer Claude's sector-appropriate discount % (PE/PB/EV,
  //    all normalised to "% below own 5yr norm"); else legacy fallbacks. ──
  let value;
  const vdisc = deep ? toNum_(deep.valuation_discount_pct) : null;
  const pe = toNum_(o.current_pe);
  const peAvg = toNum_(o.avg_pe_5yr);
  const dd = -(toNum_(o.pe_discount_pct) || 0);            // positive % below fair value / 52w high
  if (vdisc !== null) {
    value = scale(vdisc, 0, 40, 45);                       // type-fair: same number across sectors
  } else if (fin) {
    value = (conf !== null) ? scale(conf, 40, 90, 45) : scale(dd, 0, 50, 45);
  } else if (peAvg && peAvg > 0 && pe && pe > 0) {
    value = scale((1 - pe / peAvg) * 100, 0, 40, 45);
  } else {
    value = scale(dd, 0, 50, 45);
  }

  // ── QUALITY (max 35) — Claude's health_score if present; else derive. ──
  let quality = 18;                                         // neutral baseline (passed screening)
  const health = deep ? toNum_(deep.health_score) : null;
  if (health !== null) {
    quality = scale(health, 0, 100, 35);
  } else if (deep) {
    const roe = toNum_(deep.roe_5yr_avg);
    const pcagr = toNum_(deep.profit_cagr_3yr);
    const de = toNum_(deep.debt_to_equity);
    quality =
      (roe === null ? 4 : roe >= 20 ? 14 : roe >= 15 ? 10 : roe >= 12 ? 6 : 2) +
      (pcagr === null ? 3 : pcagr >= 15 ? 11 : pcagr >= 10 ? 8 : pcagr >= 5 ? 4 : 0) +
      (fin ? 7 : (de === null ? 4 : de === 0 ? 10 : de <= 0.5 ? 7 : de <= 1 ? 4 : 0));
  }

  // ── RISK:REWARD (max 10) ──
  const rr = toNum_(o.risk_reward_ratio);
  const rrPts = rr ? Math.max(0, Math.min(10, ((rr - 1) / 2) * 10)) : 0;

  let score = value + quality + rrPts;

  // ── VERDICT + cyclical bonus ──
  if (deep) {
    const v = String(deep.verdict).toUpperCase();
    if (v === 'STRONG') score += 10;
    else if (v === 'WEAK') score -= 20;
    if (String(deep.correction_reason).toLowerCase() === 'cyclical') score += 3;   // recoverable dip
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// GF-mode fundamental row for one stock. Nifty 100 are pre-vetted large caps,
// so a profitable, priced name PASSes; the real selection happens at the
// opportunity stage (valuation + risk:reward + confidence>=60). Confidence here
// is a GOOGLEFINANCE proxy: profitability + sane PE + drawdown from 52w high.
function screenOneStockGF_(meta, cfg) {
  const base = {
    symbol: meta.symbol, company_name: meta.name, sector: meta.sector, is_banking: meta.isBanking,
    revenue_cagr_5yr: null, profit_cagr_5yr: null, roe_avg_5yr: null, debt_to_equity: null,
    cf_quality: null, promoter_holding: null, promoter_pledge: null, roce: null,
    sales_growth_3yr: null, profit_growth_3yr: null, screening_status: 'INSUFFICIENT_DATA',
    fail_reasons: '', confidence_score: 0, last_updated: fmtDateTime_(new Date())
  };
  const q = gfQuote_(meta.symbol);
  if (!q || q.price === null) { base.fail_reasons = 'GOOGLEFINANCE returned no price'; return base; }

  const dd = (q.high52 !== null && q.high52 > 0) ? round2_(((q.price - q.high52) / q.high52) * 100) : null;
  let score = 0;
  if (q.eps !== null && q.eps > 0) score += 30;                                  // profitable
  if (q.pe !== null && q.pe > 0) score += q.pe <= 25 ? 25 : q.pe <= 40 ? 15 : q.pe <= 60 ? 5 : 0;
  if (dd !== null) score += dd <= -25 ? 25 : dd <= -15 ? 15 : dd <= -8 ? 8 : 0;  // cheaper = better
  if (q.high52 !== null && q.low52 !== null) score += 10;                        // range data present
  base.confidence_score = Math.min(100, score);

  const profitablePriced = (q.eps !== null && q.eps > 0 && q.pe !== null && q.pe > 0);
  base.screening_status = profitablePriced ? 'PASS' : 'FAIL';
  base.fail_reasons = profitablePriced
    ? ('GF mode · PE ' + q.pe + ' · EPS ' + q.eps + (dd !== null ? ' · ' + dd + '% off 52w high' : ''))
    : ('GF mode: not profitable / no PE (EPS ' + q.eps + ', PE ' + q.pe + ')');
  return base;
}

// Manual test from the editor: dump GF data + valuation for one symbol.
function TEST_gfTCS() {
  const cfg = getConfig();
  const q = gfQuote_('TCS');
  const pe = fetchHistoricalPE('TCS');
  const px = fetchNSEPrice('TCS');
  const health = fetchNifty200DMA();
  const report = { quote: q, price: px, pe: pe, marketHealth: health,
    valuationGF: q ? calculateValuationStatusGF_(q.price, q.high52, cfg) : null };
  log_('TEST_gfTCS: ' + JSON.stringify(report));
  return report;
}

// Set (or clear) the API token that gates sensitive write actions. Run once
// from the editor, e.g. TEST_setApiToken('pick-a-long-random-string'), then
// enter the SAME token in the app via the 🔑 button. Pass '' to remove the gate.
function TEST_setApiToken(token) {
  const props = PropertiesService.getScriptProperties();
  if (token) { props.setProperty('api_token', String(token).trim()); log_('api_token set'); return { set: true }; }
  props.deleteProperty('api_token'); log_('api_token cleared'); return { set: false };
}

// Wipe all deep-analysis rows (header kept) for a clean slate. Safe — the data
// is re-derivable by re-pasting the Claude analysis. Run from the editor.
function TEST_clearDeep() {
  const sh = ss_().getSheetByName(TAB_DEEP);
  if (!sh) return { cleared: 0 };
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  const n = Math.max(0, last - 1);
  log_('TEST_clearDeep: cleared ' + n + ' rows');
  return { cleared: n };
}
