# Trading Bot — Claude Instructions

Claude reads this file automatically when working in this project.
Everything below is the decision tree. Apply it every time you analyze the market.

---

## Watchlist

- BTCUSDT
- ETHUSDT

Timeframe: 1H (default) — adjust only if user asks

---

## Strategy: VWAP + RSI(3) + EMA(8/21) Scalping

Four indicators, one job each:

| Indicator | Role |
|---|---|
| EMA(8) | Short-term momentum |
| EMA(21) | Medium-term trend filter (noise reduction) |
| VWAP | Session bias — resets midnight UTC |
| RSI(3) | Entry timing — fast, sensitive |

---

## Decision Tree

### Step 1 — Determine Bias

**BULLISH** (all three must be true):
- Price > VWAP
- Price > EMA(8)
- Price > EMA(21)

**BEARISH** (all three must be true):
- Price < VWAP
- Price < EMA(8)
- Price < EMA(21)

**NEUTRAL** → No trade. Stop here.

---

### Step 2 — Check Entry Trigger

**LONG entry** (bullish bias confirmed):
- RSI(3) < 30 → pullback in uptrend, snap-back likely ✅

**SHORT entry** (bearish bias confirmed):
- RSI(3) > 70 → spike in downtrend, reversal likely ✅

If trigger not met → No trade. State the actual RSI value and what's needed.

---

### Step 3 — Check Safety Filter

- Price must be within 1.5% of VWAP
- If overextended → No trade, even if all other conditions pass

---

### Step 4 — Risk / Position Size

- Max risk per trade: 1% of portfolio
- Hard cap: MAX_TRADE_SIZE_USD from .env
- Max trades per day: MAX_TRADES_PER_DAY from .env

---

### Step 5 — Exit Rules

| Condition | Action |
|---|---|
| Price hits +3% from entry | Sell 50%, move stop to breakeven |
| Price hits breakeven stop (after 50% sold) | Sell remaining 50% |
| Price hits -1.5% from entry | Sell 100% (hard stop) |

---

## Morning Brief Protocol

When asked for a morning brief, run this sequence for **each symbol in the watchlist**:

1. Get current price, EMA(8), EMA(21), VWAP, RSI(3)
2. Determine bias (bullish / bearish / neutral)
3. Check entry trigger
4. Check safety filter
5. State open positions and P&L if any
6. Print session summary

**Output format:**

```
── BTCUSDT ──────────────────────────────
Price:   $XX,XXX
VWAP:    $XX,XXX  (bias: ABOVE / BELOW)
EMA(8):  $XX,XXX  (bias: ABOVE / BELOW)
EMA(21): $XX,XXX  (bias: ABOVE / BELOW)
RSI(3):  XX.X

Bias:    BULLISH / BEARISH / NEUTRAL
Signal:  LONG READY / SHORT READY / WAITING (RSI at XX, need < 30)
Filter:  PASS / BLOCKED (X.X% from VWAP, max 1.5%)

Decision: TRADE / NO TRADE
Reason:   [one line]
```

---

## TradingView MCP Tool Mapping

When TradingView MCP is connected (cdp_connected: true), use these tools:

| Task | Tools to call |
|---|---|
| Morning brief | `quote_get` → `data_get_study_values` → apply decision tree |
| Full analysis | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `capture_screenshot` |
| Switch chart | `chart_set_symbol` → `chart_set_timeframe` |
| Draw a level | `draw_shape` (horizontal_line) |
| Write Pine Script | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| Replay practice | `replay_start` → `replay_step` → `replay_trade` |
| Set alert | create alert at key price levels |

If TradingView MCP is NOT connected, fall back to Binance API via `node bot.js`.

---

## Fallback (no MCP)

```bash
node bot.js          # run full check for all watchlist symbols
node bot.js --tax-summary   # show trade stats
```

Data source: Binance public API (no auth needed, cloud-safe).

---

## Paper vs Live

- PAPER_TRADING=true in .env → log decisions, never place real orders
- PAPER_TRADING=false → live orders via BitGet API

Always confirm mode before executing any trade.

---

## Key Files

| File | Purpose |
|---|---|
| `rules.json` | Strategy rules (source of truth for indicators/entries/exits) |
| `.env` | Credentials and limits (never commit) |
| `safety-check-log.json` | Every decision with full indicator values |
| `trades.csv` | Tax-ready trade log |
| `positions.json` | Open positions (BTC + ETH tracked separately) |
