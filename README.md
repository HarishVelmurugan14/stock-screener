# StockIQ — Stock Intelligence System

A screener + opportunity monitor + portfolio tracker for the Indian large-cap
(Nifty 100) market. Pure **Google Apps Script** backend + **single-file HTML**
frontend. No Python, Node, or frameworks.

```
stock-screener/
├── backend/Code.gs        → Google Apps Script (deploy as Web App)
└── docs/                  → dashboard (served by GitHub Pages, main /docs)
    ├── index.html         → markup
    ├── css/styles.css     → styles
    └── js/{config,api,app}.js  → config, API layer, app logic
```

- **Backend** reads/writes a Google Sheet and pulls market data via
  **`GOOGLEFINANCE`** (price, PE, EPS, 52-week range, and the Nifty 200-DMA from
  historical closes). Direct scraping of screener.in / NSE is *not* used — those
  hosts block Apps Script's datacenter IPs (`Address unavailable`).
- **Frontend** calls the Web App over `fetch()` and renders 5 sections:
  Market Health · Alerts · Opportunities (max 5) · Portfolio · Screener.

> Informational tool, not investment advice. It is conservative by design:
> hard capital cap, max 5 ideas, paper-trade mode on by default, and it shows
> "Data unavailable" rather than guessing.

---

## Sheet & tabs

Sheet ID: `1R4yXbxb6YgXh-rDqnnw3iWOZe2ABcYMD96iN5hvDi5A`

- **Read-only (VaultZero, never restructured):** `indian_equity_stocks_assets`,
  `indian_equity_stocks_transactions`, `categories`, `subcategories`.
- **Created by `setupStockIQ()`:** `SCREENER_CONFIG`, `SCREENER_FUNDAMENTALS`,
  `SCREENER_OPPORTUNITIES`, `SCREENER_PORTFOLIO`, `SCREENER_ALERTS`.

Every threshold lives in `SCREENER_CONFIG` — change values there, no code edits.

---

## Deployment

### 1. Create a new Apps Script project (separate from VaultZero)
1. Go to <https://script.google.com> → **New project**.
2. Name it `StockIQ`.
3. **Project Settings (gear icon) → set the time zone to `Asia/Kolkata`** so the
   triggers fire at IST. This matters — daily/weekly jobs use IST hours.

### 2. Paste the backend
1. Delete the default `Code.gs` contents.
2. Paste the entire `backend/Code.gs`.
3. Save. The `SHEET_ID` constant is already set; change it only if you fork the sheet.

### 3. First-time setup
1. In the editor function dropdown choose **`TEST_setup`** (or `setupStockIQ`) → **Run**.
2. Authorize when prompted (it needs Sheets + external fetch + triggers).
3. Confirm the 5 `SCREENER_*` tabs now exist in the Sheet and `SCREENER_CONFIG`
   is populated. Triggers are installed in the same step.

### 4. Deploy as a Web App
1. **Deploy → New deployment → type: Web app.**
2. Execute as **Me**; Who has access **Anyone** (the frontend calls it anonymously).
3. Deploy → copy the **Web app URL** (ends in `/exec`).
4. Re-deploy (**Manage deployments → Edit → New version**) whenever you change `Code.gs`.

### 5. Wire up the frontend
1. Open `docs/index.html`.
2. Set the URL near the top of the `<script>` block:
   ```js
   const WEB_APP_URL = "https://script.google.com/macros/s/XXXXXXXX/exec";
   ```
3. Open it in a browser, or publish via GitHub Pages (below).

### 5b. Host on GitHub Pages (use it as an app)
1. Push the repo to GitHub (the `docs/` folder holds the app).
2. Repo **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`** → Save.
3. After ~1 min the site is live at `https://<user>.github.io/stock-screener/`.
4. On a phone: open that URL → browser menu → **Add to Home Screen** → it
   launches full-screen like an app (icon + title come from the PWA meta tags).

> **Security — important.** GitHub Pages is public, and `index.html` contains the
> Apps Script URL. Sensitive writes (`addPosition`, `bookProfit`, `updateConfig`,
> setup) are therefore **token-gated**:
> 1. In the editor run once: `TEST_setApiToken('a-long-random-string')`.
> 2. In the app, click **🔑** and enter the same string (stored only in your
>    browser's localStorage — never in the public HTML).
> Reads stay open so the dashboard loads for you without friction. Without a
> token set, all sensitive writes are blocked over HTTP by default.

### 6. First full screener run
- Either click **Run Full Screener** in the Screener section (≈10–15 min, keep tab open),
- or run **`TEST_screen5`** in the editor first (5 stocks) to validate, then
  **`runFundamentalScreener`** for all 100.
- After that, **`TEST_opportunities`** (or the daily trigger) fills the
  Opportunities tab.

---

## Automation (installed by setup)

| Trigger | When (IST) | Function |
|---|---|---|
| Weekly | Sun 08:00 | `runFundamentalScreener` — full 100-stock fundamental screen |
| Daily  | 08:30 | `runDailyUpdate` — opportunities + portfolio prices + alerts (weekday-gated) |
| Daily  | 21:00 | `runEndOfDayAlerts` — target / stop-loss / thesis alerts (weekday-gated) |

Weekend runs no-op via `isTradingDay_()`.

---

## Testing helpers (run from the editor)

| Function | Purpose |
|---|---|
| `TEST_setup` | Create tabs (incl. hidden `_GF_SCRATCH`), seed config, install triggers |
| `TEST_gfTCS` | **GOOGLEFINANCE check** — price/PE/52wk + 200-DMA + valuation for TCS (check the Logs) |
| `TEST_screenTCS` / `TEST_screen5` | Screen 1 / 5 stocks (GF mode) |
| `TEST_opportunities` | Build the opportunities list now |
| `selfTest('INFY')` | Legacy end-to-end dump for any symbol |

Use **View → Logs** (or Executions) to inspect each step.

---

## Safety model

- **Mode:** `paper_trade_mode` controls real-money mirroring. When `FALSE` (the
  current default), `addPosition` / `bookProfit` write to `SCREENER_PORTFOLIO`
  **and** mirror into the live VaultZero ledger. Set it to `TRUE` in
  `SCREENER_CONFIG` to simulate without touching VaultZero.
- **VaultZero is relational** — the mirror respects it:
  - `indian_equity_stocks_assets`: `id | subcategory_id | company_name | ticker | strategy | is_active | current_price | created_at`
  - `indian_equity_stocks_transactions`: `id | asset_id | txn_type | txn_date | quantity | price_per_share | amount | notes | created_at`
  - A buy resolves the asset by `ticker` (creating it with the next `id`,
    `subcategory_id` = `vaultzero_subcategory_id` config [22], `strategy` =
    `vaultzero_strategy` [Long Term], `is_active` TRUE) and then appends a
    transaction with a fresh auto-increment `id` and `asset_id` foreign key.
    `txn_type` is title-case `Buy`/`Sell` to match existing rows.
  - Selling appends a `Sell` transaction; it does not flip `is_active` or delete
    the asset (a holding may have other lots).
- **Hard capital cap:** `addPosition` blocks anything that would exceed
  `phase_capital_limit` (default ₹25,000).
- **Graceful degradation:** source down → last cached value (flagged stale);
  never a fabricated number.
- **Caching:** prices 1h, in `PropertiesService`. GOOGLEFINANCE round-trips go
  through a hidden `_GF_SCRATCH` tab, serialized with a script lock.

## Data model: GF mode vs API mode

`data_mode` (config) selects the fundamentals source:

- **`GF` (default):** GOOGLEFINANCE only, $0. Nifty 100 are treated as a
  pre-vetted large-cap universe; a profitable, priced name `PASS`es. Real
  selection happens at the opportunity stage: **valuation + risk:reward +
  confidence ≥ 60**. Valuation uses **distance below the 52-week high** on day
  one (the "X% off peak = accumulate" signal), and automatically upgrades to
  **PE-vs-its-own-rolling-average** once ~20 daily PE samples accumulate
  (~1 month). What GF mode does *not* have: revenue/profit CAGR, ROE, debt/
  equity, cash-flow quality, promoter holding/pledge — those columns stay blank.
- **`API` (future):** set `data_mode = 'API'` and wire an external fundamentals
  provider (e.g. FMP/EODHD) into `screenOneStock_`'s non-GF branch to restore
  the hard fundamental filters. Prices still come from GOOGLEFINANCE.

## Fundamental analysis (human-in-the-loop, via Claude)

Instead of a paid API, deep fundamentals are filled by pasting a Claude analysis
— $0, and it leverages the Claude subscription you already have.

1. The dashboard shows the top valuation candidates and a **Copy Analysis
   Prompt** button (pre-filled with those symbols).
2. Paste the prompt into Claude.ai → it returns a strict JSON block.
3. Paste that JSON into the dashboard box → **Save**.
4. `saveDeepAnalysis` (POST) stores one row per symbol in
   `SCREENER_DEEP_ANALYSIS`. `getOpportunityData` then joins it in, computes a
   **combined score** (valuation 60% + fundamental 40%, minus 3/red-flag),
   **drops any `AVOID`** verdict, and re-ranks. Cards show a 🔬 (analyzed) or
   ⚠️ (not yet) marker and a >90-day staleness nudge.

> These figures are **LLM estimates**, labelled "AI est." in the UI and tagged
> `source = CLAUDE_MANUAL (LLM estimate)` in the sheet. Verify on
> screener.in / Tickertape before committing real money.

### Known data limitations (honest notes)
- **Nifty 200-DMA** uses GOOGLEFINANCE historical closes — a true 200-DMA, today.
- **Average PE** is self-built from a daily rolling series (GOOGLEFINANCE has no
  historical PE), so the PE-discount signal sharpens over the first month; until
  then valuation runs on 52-week drawdown.
- **(legacy)** the older screener.in path below is retained only for `API`-mode
  reference and `selfTest`; it does not run in `GF` mode.
- **Historical PE (legacy path)** used screener's *median PE* as the proxy.
  When it isn't published, valuation shows `DATA_UNAVAILABLE` and the stock is
  skipped from opportunities rather than guessed.
- **Nifty 200-DMA (legacy path)** was built from a rolling daily series the script records on
  each run; until ~200 trading days accumulate, market health shows
  "DATA BUILDING" and does not hard-block ideas.
- Scraping depends on screener.in / NSE markup; parsers are tolerant and fail
  to `INSUFFICIENT_DATA` instead of crashing if layouts change.
