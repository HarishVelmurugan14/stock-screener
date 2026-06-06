// StockIQ — config, constants, shared state

// ── Web App endpoint ───────────────────────────────────────────────────────
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyRxkp7pXgTD1R8e1B-Ot7aTVpbfmGzzORu4KTyKKUUUZ6wfPQJQ8R7bs33Jc_WzZ5J/exec';

// ── Lookup tables ───────────────────────────────────────────────────────────
const ALERT_ICON = {
  STOP_LOSS_HIT: '🚨',
  TARGET_2_HIT: '🎯',
  TARGET_1_HIT: '🎯',
  ROTATION_OPPORTUNITY: '🔄',
  THESIS_BROKEN: '⚠️',
  NEW_OPPORTUNITY: '✨',
  PROFIT_BOOKED: '✅',
};

const ALERT_PRI = {
  STOP_LOSS_HIT: 1,
  TARGET_2_HIT: 2,
  TARGET_1_HIT: 3,
  ROTATION_OPPORTUNITY: 4,
  THESIS_BROKEN: 5,
  NEW_OPPORTUNITY: 6,
  PROFIT_BOOKED: 7,
};

const VERDICT_PILL = { STRONG: 'green', MODERATE: 'blue', WEAK: 'amber', AVOID: 'red' };

// ── Mutable shared state ────────────────────────────────────────────────────
let _config = {};            // server config snapshot (paper mode, etc.)
let _screenerRows = [];       // cached screener rows for client-side filtering
let _oppSymbols = [];         // current opportunity symbols, for the analysis prompt
let _scrLoaded = false;       // has the screener section been loaded yet
let _opps = [];               // last opportunities (with scores/prices) — for the buy plan
let _health = null;           // last market-health snapshot
let _summary = null;          // last portfolio summary (capital remaining, etc.)
