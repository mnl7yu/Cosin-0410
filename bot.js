/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  leverage: parseFloat(process.env.LEVERAGE || "1"),
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const TZ = "Asia/Seoul";
function localDate(d = new Date()) { return d.toLocaleDateString("sv", { timeZone: TZ }); }
function localTime(d = new Date()) { return d.toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false }); }
function localISO(d = new Date()) { return `${localDate(d)}T${localTime(d)}`; }

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = localDate();
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (OKX public API — free, no auth) ───────────────────────────

function toOkxSymbol(symbol) {
  // BTCUSDT → BTC-USDT, ETHUSDT → ETH-USDT
  return symbol.replace(/^([A-Z]+)(USDT)$/, "$1-USDT");
}

async function fetchCandles(symbol, interval, limit = 100) {
  // OKX bar format: 1m 3m 5m 15m 30m 1H 4H 1D 1W
  const barMap = {
    "1m": "1m", "3m": "3m", "5m": "5m",
    "15m": "15m", "30m": "30m",
    "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W",
  };
  const bar = barMap[interval] || "1H";
  const instId = toOkxSymbol(symbol);

  // OKX max 300 per request; fetch in pages if limit > 300
  const candles = [];
  let after = "";
  let remaining = limit;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 300);
    const params = new URLSearchParams({ instId, bar, limit: batchSize });
    if (after) params.set("after", after);
    const url = `https://www.okx.com/api/v5/market/candles?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OKX API error: ${res.status}`);
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX error: ${json.msg}`);
    const batch = json.data;
    if (!batch || batch.length === 0) break;
    candles.push(...batch);
    remaining -= batch.length;
    if (batch.length < batchSize) break;
    after = batch[batch.length - 1][0]; // oldest timestamp for next page
  }

  // OKX returns newest-first — reverse to oldest-first (same as Binance)
  candles.reverse();

  return candles.map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ADX(14) — Wilder's smoothing
function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const wilder = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const r = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; r.push(s); }
    return r;
  };
  const atrS = wilder(trs), pS = wilder(pDMs), mS = wilder(mDMs);
  const dxArr = atrS.map((a, i) => {
    const pdi = a > 0 ? 100 * pS[i] / a : 0;
    const mdi = a > 0 ? 100 * mS[i] / a : 0;
    const sum = pdi + mdi;
    return sum > 0 ? 100 * Math.abs(pdi - mdi) / sum : 0;
  });
  // ADX: (prev*(period-1) + DX) / period — 0~100 범위 유지
  // ATR/DM은 + arr[i] (Wilder sum), ADX는 + DX/period (Wilder mean)
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) { adx = (adx * (period - 1) + dxArr[i]) / period; }
  return adx;
}

// N봉 최고가/최저가 (마지막 봉 제외 — 돌파 확인용)
function calcBreakoutLevels(candles, period = 2) {
  const slice = candles.slice(-period - 1, -1); // 마지막 봉 제외
  return {
    hh: Math.max(...slice.map(c => c.high)),
    ll: Math.min(...slice.map(c => c.low)),
  };
}

// ─── Notifications ──────────────────────────────────────────────────────────

async function sendNotification(title, message, subtitle = "") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const text = subtitle
    ? `${title}\n${subtitle}\n\n${message}`
    : `${title}\n\n${message}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch {
    // Network error — skip silently
  }
}

// ─── Strategy Check (Trend Following) ────────────────────────────────────────
//
// 조건 (롱):
//   1. 주봉 EMA(50) 위 + 기울기 상승 (횡보장 필터)
//   2. 4H EMA(50) 위 + 4H ADX(14) > adxThreshold (BTC=25, ETH=20)
//   3. 30분봉 2봉 최고가 돌파 (브레이크아웃)
// 숏은 위의 반대 (주봉 EMA 아래 + 기울기 하락일 때만)
//
// ── backtest-v2 결과 (1H × 2000봉 ≈ 83일, 2024-05 기준) ────────────────────
//
//   BTCUSDT: Baseline PnL +30.5%  PF 9.58  (baseline 우세)
//   ETHUSDT: Baseline PnL +11.5%  PF 2.74  (baseline 우세)
//
//   피처 검증 결과:
//     ❌ dynamic-atr  : BTC ±0%,   ETH -1.8%   → 효과 없음
//     ❌ funding-rate : 두 심볼 모두 필터 임계값 미달 → 효과 없음
//     ❌ rsi-div      : BTC -20.9%, ETH -5.5%   → 조기 청산 증가로 성능 저하
//     ❌ tp1 (신규)   : BTC -25.0%, ETH -7.2%   → 대형 추세 손절로 성능 저하
//                       (기존 TP1은 유지 — 이전 세션 결과 보존용)
//     ❌ pyramid      : BTC -20.7%, ETH -7.8%   → tp1과 함께 성능 저하
//
//   결론: 현재 베이스라인 로직이 모든 피처보다 우수.
//         강한 추세 시장에서 큰 trail multiplier(×6)가 더 유리함.

function runStrategyCheck({ price, high,
  weeklyEma50, prevWeeklyEma50, h4Ema50, h4Adx,
  hh2, ll2, adxThreshold }) {

  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Strategy Check (트렌드 추종) ─────────────────────────\n");

  const weeklyBull = price > weeklyEma50;
  const weeklyBear = price < weeklyEma50;
  const wSlopeUp   = weeklyEma50 > prevWeeklyEma50;
  const wSlopeDown = weeklyEma50 < prevWeeklyEma50;
  const h4Bull     = price > h4Ema50;
  const h4Bear     = price < h4Ema50;
  const adxStrong  = h4Adx !== null && h4Adx > adxThreshold;

  // 방향 결정 (주봉 EMA 위치 + 기울기 모두 일치해야 방향 확정)
  let direction = null;
  if (weeklyBull && wSlopeUp && h4Bull) direction = "long";
  else if (weeklyBear && wSlopeDown && h4Bear) direction = "short";

  const slopeArrow = wSlopeUp ? "↑ 상승" : "↓ 하락";
  console.log(`  주봉 EMA(50): $${weeklyEma50.toFixed(2)} (기울기: ${slopeArrow}) → ${weeklyBull ? "위 (롱 바이어스)" : "아래 (숏 바이어스)"}`);
  console.log(`  4H   EMA(50): $${h4Ema50.toFixed(2)} → ${h4Bull ? "위" : "아래"}`);
  console.log(`  4H   ADX(14): ${h4Adx !== null ? h4Adx.toFixed(1) : "N/A"} → ${adxStrong ? `강한 추세 ✅ (>${adxThreshold})` : `약한 추세 🚫 (>${adxThreshold} 필요)`}`);
  console.log(`  방향: ${direction === "long" ? "🟢 LONG" : direction === "short" ? "🔴 SHORT" : "⚪ NEUTRAL"}\n`);

  if (!direction) {
    results.push({ label: "주봉+4H 방향 일치", required: "동일 방향", actual: "불일치 (중립)", pass: false });
    return { results, allPass: false, direction: null };
  }

  const isLong = direction === "long";

  // 1. 주봉 방향 + 기울기 필터 (횡보장 제외)
  check(
    `주봉 EMA(50) ${isLong ? "위 + 상승 기울기" : "아래 + 하락 기울기"} — 횡보 필터`,
    isLong ? "위 & ↑ 상승" : "아래 & ↓ 하락",
    `$${weeklyEma50.toFixed(2)} (${wSlopeUp ? "↑" : "↓"} ${weeklyEma50.toFixed(2)} vs ${prevWeeklyEma50.toFixed(2)})`,
    isLong ? (weeklyBull && wSlopeUp) : (weeklyBear && wSlopeDown),
  );

  // 2. 4H 추세 강도
  check(
    `4H ADX(14) > ${adxThreshold} — 추세 강도 확인`,
    `> ${adxThreshold}`,
    h4Adx !== null ? h4Adx.toFixed(1) : "N/A",
    adxStrong,
  );

  // 3. 30분봉 2봉 브레이크아웃
  const breakoutHit = isLong ? (price > hh2) : (price < ll2);
  check(
    `30분봉 2봉 ${isLong ? "최고가" : "최저가"} 돌파 (브레이크아웃)`,
    isLong ? `> $${hh2.toFixed(2)}` : `< $${ll2.toFixed(2)}`,
    `$${price.toFixed(2)}`,
    breakoutHit,
  );

  const allPass = results.every((r) => r.pass);
  return { results, allPass, direction };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Position Tracking ───────────────────────────────────────────────────────

const POSITIONS_FILE = "positions.json";

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// ─── Exit Management ─────────────────────────────────────────────────────────
//
// 청산 우선순위:
//   1. SL (initialSl): 가격이 SL에 도달 → 즉시 청산 (항상 1순위)
//   2. SIGNAL FADE: 진입 후 첫 3번 체크 동안 브레이크아웃 레벨 역방향 이탈
//   3. TRAIL: 트레일링 스탑 도달
//   4. TREND FLIP: 4H EMA(50) 반대편 이탈
//
// TP1 분할 익절 없음 — backtest-v2 결과 강한 추세장에서 수익 25% 감소 확인 → 제거
//
// SL vs Trail 관계:
//   [초기 구간] Trail이 SL 너머에 있음 → SL이 먼저 걸림 (손실 방어)
//   [수익 구간] Trail이 SL 안쪽으로 진입 → Trail이 먼저 걸림 (수익 보호)
//
//   LONG:  SL = 진입 - ATR×slM (아래)  Trail = 진입 - ATR×trM → 상승하며 위로 이동
//   SHORT: SL = 진입 + ATR×slM (위)    Trail = 진입 + ATR×trM → 하락하며 아래로 이동

async function checkExits(currentPrice, currentHigh, currentLow, h4Bull, h4Bear, positions) {
  if (positions.length === 0) return positions;

  console.log("\n── Exit Check ───────────────────────────────────────────\n");

  const updated = [];

  for (const pos of positions) {
    const isShort = pos.side === "short";
    const pnlPct  = (isShort ? -1 : 1) * ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const fmt     = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    console.log(`  ${pos.symbol} ${isShort ? "🔴 SHORT" : "🟢 LONG"} @ $${fmt(pos.entryPrice)}`);
    console.log(`  현재가: $${fmt(currentPrice)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);

    // 트레일 스탑 갱신
    // LONG:  고점(currentHigh) 기준 — 올라갈수록 trail이 위로 이동
    // SHORT: 저점(currentLow)  기준 — 내려갈수록 trail이 아래로 이동
    const atr       = pos.atr ?? Math.abs(pos.entryPrice - pos.initialSl) / 2.0;
    const trailMult = pos.trailMult ?? 4.0;
    let trailStop   = pos.trailStop ?? pos.initialSl;

    if (isShort) {
      trailStop = Math.min(trailStop, currentLow + atr * trailMult);
    } else {
      trailStop = Math.max(trailStop, currentHigh - atr * trailMult);
    }

    // 체크 카운터 증가 (신호 소멸 판단용)
    const checkCount = (pos.entryCheckCount ?? 0) + 1;

    // ── 1순위: SL ─────────────────────────────────────────
    const slHit = isShort ? currentHigh >= pos.initialSl : currentLow <= pos.initialSl;
    if (slHit) {
      const exitPrice   = pos.initialSl;
      const qty         = pos.quantity;
      const realizedPnl = (isShort ? -1 : 1) * (exitPrice - pos.entryPrice) * qty * CONFIG.leverage;
      console.log(`  🔴 청산 발동 — SL: 초기 손절`);
      console.log(`  청산가: $${fmt(exitPrice)} | PnL: $${realizedPnl.toFixed(2)}`);
      writeExitCsv(pos, exitPrice, "SL: 초기 손절", qty);
      if (CONFIG.paperTrading) {
        console.log(`  📋 PAPER: ${qty.toFixed(6)} ${pos.symbol} 청산 @ $${fmt(exitPrice)}`);
      } else {
        try { await placeBitGetSellOrder(pos.symbol, qty, exitPrice); }
        catch (err) { console.log(`  ❌ 청산 실패: ${err.message}`); updated.push({ ...pos, trailStop, entryCheckCount: checkCount }); continue; }
      }
      await sendNotification(`${isShort ? "🔴" : "🟢"} ${pos.symbol} 청산 신호`,
        [`사유: SL: 초기 손절`, `진입: $${fmt(pos.entryPrice)} → 청산가: $${fmt(exitPrice)}`,
         `PnL: $${realizedPnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`, ``, `🔴 지금 BitGet에서 직접 청산하세요!`].join("\n"));
      continue;
    }

    // ── SL vs Trail 구간 표시 ──────────────────────────────
    const trailFirst = isShort
      ? trailStop < pos.initialSl
      : trailStop > pos.initialSl;

    const slDist    = Math.abs(currentPrice - pos.initialSl);
    const trailDist = Math.abs(currentPrice - trailStop);
    const slPct     = (slDist / currentPrice * 100).toFixed(2);
    const trailPct  = (trailDist / currentPrice * 100).toFixed(2);

    if (trailFirst) {
      console.log(`  📊 구간: [수익 보호] Trail($${fmt(trailStop)}) 먼저 걸림 — Trail까지 ${trailPct}%`);
    } else {
      console.log(`  📊 구간: [손실 방어] SL($${fmt(pos.initialSl)}) 먼저 걸림 — SL까지 ${slPct}%`);
    }

    // ── 3순위: 신호 소멸 — 진입 후 첫 3번 체크 동안만 ─────
    // 브레이크아웃 후 가격이 돌파 레벨 반대로 복귀 = 가짜 브레이크아웃
    const earlyPhase = checkCount <= 3 && pos.breakoutLevel != null;
    const signalFade = earlyPhase && (
      isShort ? currentPrice > pos.breakoutLevel : currentPrice < pos.breakoutLevel
    );

    // ── 4순위: Trail / 5순위: Trend Flip ──────────────────
    // close 기준 감지 — 백테스트 정합성 유지, 일봉 내 wick에 의한 가짜 청산 방지
    const trailHit  = isShort ? currentPrice >= trailStop : currentPrice <= trailStop;
    const trendFlip = isShort ? h4Bull : h4Bear;

    let exitReason = null;
    if      (signalFade) exitReason = "SIGNAL FADE: 브레이크아웃 되돌림";
    else if (trailHit)   exitReason = "TRAIL: 트레일링 스탑";
    else if (trendFlip)  exitReason = "TREND FLIP: 4H 추세 반전";

    if (exitReason) {
      const exitPrice   = trailHit ? trailStop : currentPrice;
      const qty         = pos.quantity;
      const realizedPnl = (isShort ? -1 : 1) * (exitPrice - pos.entryPrice) * qty * CONFIG.leverage;

      console.log(`  🔴 청산 발동 — ${exitReason}`);
      console.log(`  청산가: $${fmt(exitPrice)} | PnL: ${realizedPnl >= 0 ? "+" : ""}$${Math.abs(realizedPnl).toFixed(2)}`);

      writeExitCsv(pos, exitPrice, exitReason, qty);

      if (CONFIG.paperTrading) {
        console.log(`  📋 PAPER: ${qty.toFixed(6)} ${pos.symbol} 청산 @ $${fmt(exitPrice)}`);
      } else {
        try {
          await placeBitGetSellOrder(pos.symbol, qty, exitPrice);
        } catch (err) {
          console.log(`  ❌ 청산 실패: ${err.message}`);
          updated.push({ ...pos, trailStop, entryCheckCount: checkCount });
          continue;
        }
      }

      await sendNotification(
        `${isShort ? "🔴" : "🟢"} ${pos.symbol} 청산 신호`,
        [
          `사유: ${exitReason}`,
          `진입: $${fmt(pos.entryPrice)} → 청산가: $${fmt(exitPrice)}`,
          `PnL: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          ``,
          `🔴 지금 BitGet에서 직접 청산하세요!`,
        ].join("\n"),
      );
      continue;
    }

    // 홀딩 — trail 갱신 저장
    console.log(`  ⏳ 홀딩 중 — 초기SL: $${fmt(pos.initialSl)} | Trail: $${fmt(trailStop)} | PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
    updated.push({ ...pos, trailStop, entryCheckCount: checkCount });
  }

  return updated;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetSellOrder(symbol, quantity, price) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/trade/placeOrder";

  const body = JSON.stringify({
    symbol,
    side: "sell",
    orderType: "market",
    quantity: quantity.toFixed(6),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet 매도 실패: ${data.msg}`);
  }

  console.log(`  ✅ 매도 주문 완료 — ${data.data.orderId}`);
  return data.data;
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
  "Realized PnL",
].join(",");

function writeExitCsv(pos, exitPrice, exitType, qty) {
  const now = new Date();
  const date = localDate(now);
  const time = localTime(now);
  const isShort = pos.side === "short";
  const realizedPnl = (isShort ? -1 : 1) * (exitPrice - pos.entryPrice) * qty * CONFIG.leverage;
  const exitValue = exitPrice * qty;           // 실제 거래 금액 (수수료 계산용)
  const totalUSD = (pos.tradeSize + realizedPnl).toFixed(2);  // 내 투자금 + 손익
  const fee = (exitValue * 0.001).toFixed(4);
  const exitSide = isShort ? "SHORT EXIT" : "LONG EXIT";
  const row = [
    date, time, "BitGet", pos.symbol, exitSide,
    qty.toFixed(6), exitPrice.toFixed(2), totalUSD,
    fee, (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2),
    pos.orderId, CONFIG.paperTrading ? "PAPER" : "LIVE",
    `"${exitType}"`, realizedPnl.toFixed(4),
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = localDate(now);
  const time = localTime(now);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.direction === "short" ? "SHORT" : "LONG";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = logEntry.notes || "All conditions met";
  } else {
    side = logEntry.direction === "short" ? "SHORT" : "LONG";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Per-Symbol Logic ────────────────────────────────────────────────────────

async function runForSymbol(symbol, log) {
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  ${symbol}`);
  console.log(`${"─".repeat(57)}`);

  console.log("\n── 시장 데이터 수집 (Binance) ──────────────────────────\n");

  // 심볼별 ADX 임계값 (백테스트 최적값: BTC=25, ETH=20)
  const adxThreshold = symbol === "BTCUSDT" ? 25 : 20;

  // 네 타임프레임 동시 수집
  const [candles1h, candles4h, candlesW, candles30m] = await Promise.all([
    fetchCandles(symbol, "1H", 200),   // 1H: 진입 신호 / ATR
    fetchCandles(symbol, "4H", 200),   // 4H: 추세 방향 + ADX
    fetchCandles(symbol, "1W", 100),   // 주봉: 바이어스 필터
    fetchCandles(symbol, "30m", 10),   // 30분봉: 2봉 브레이크아웃
  ]);

  const price  = candles1h.at(-1).close;
  const high1h = candles1h.at(-1).high;
  const low1h  = candles1h.at(-1).low;

  // 지표 계산
  const weeklyCloses    = candlesW.map(c => c.close);
  const weeklyEma50     = calcEMA(weeklyCloses, 50);
  const prevWeeklyEma50 = calcEMA(weeklyCloses.slice(0, -1), 50);  // 기울기 계산용 (전봉)
  const h4Ema50         = calcEMA(candles4h.map(c => c.close), 50);
  const h4Adx       = calcADX(candles4h, 14);
  const atr1h       = calcATR(candles1h, 14);
  const { hh: hh2_30m, ll: ll2_30m } = calcBreakoutLevels(candles30m, 2);

  const h4Bull = price > h4Ema50;
  const h4Bear = price < h4Ema50;

  console.log(`  현재가 (1H):      $${price.toFixed(2)}`);
  const slopeArrow = weeklyEma50 > prevWeeklyEma50 ? "↑" : "↓";
  console.log(`  주봉 EMA(50):    $${weeklyEma50.toFixed(2)} (기울기: ${slopeArrow})`);
  console.log(`  4H EMA(50):     $${h4Ema50.toFixed(2)}`);
  console.log(`  4H ADX(14):     ${h4Adx !== null ? h4Adx.toFixed(1) : "N/A"} (임계값 >${adxThreshold})`);
  console.log(`  1H ATR(14):     $${atr1h.toFixed(2)}`);
  console.log(`  30m 2봉 최고가:  $${hh2_30m.toFixed(2)}`);
  console.log(`  30m 2봉 최저가:  $${ll2_30m.toFixed(2)}`);

  // 포지션 청산 체크 (먼저 실행)
  const positions    = loadPositions().filter(p => p.symbol === symbol);
  const allOther     = loadPositions().filter(p => p.symbol !== symbol);
  const updPositions = await checkExits(price, high1h, low1h, h4Bull, h4Bear, positions);
  savePositions([...allOther, ...updPositions]);

  // 전략 체크
  const { results, allPass, direction } = runStrategyCheck({
    price, high: high1h,
    weeklyEma50, prevWeeklyEma50, h4Ema50, h4Adx,
    hh2: hh2_30m, ll2: ll2_30m,
    adxThreshold,
  });

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  const fmt = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: localISO(),
    symbol,
    price,
    indicators: { weeklyEma50, prevWeeklyEma50, h4Ema50, h4Adx, atr1h, hh2_30m, ll2_30m, adxThreshold },
    conditions: results,
    allPass,
    direction,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = results.filter(r => !r.pass).map(r => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach(f => console.log(`   - ${f}`));
  } else {
    const isLong    = direction === "long";
    const dirLabel  = isLong ? "🟢 LONG" : "🔴 SHORT";
    const weeklyBull = price > weeklyEma50;
    // 주봉 강세장 롱: Trail×6.0 / SL×3.0 → 파라볼릭 무브 대응
    // 나머지 (하락장 숏 등): Trail×4.0 / SL×2.0
    const slMult    = isLong && weeklyBull ? 3.0 : 2.0;
    const trailMult = isLong && weeklyBull ? 6.0 : 4.0;
    const initialSl = isLong
      ? price - atr1h * slMult
      : price + atr1h * slMult;
    const trailStop = isLong
      ? price - atr1h * trailMult
      : price + atr1h * trailMult;
    const slPct = Math.abs((initialSl - price) / price * 100).toFixed(2);

    console.log(`✅ ALL CONDITIONS MET — ${dirLabel} 진입`);

    const entryMsg = [
      `${dirLabel} 진입 신호 — ${symbol}`,
      ``,
      `진입가:     $${fmt(price)}`,
      `4H ADX:    ${h4Adx !== null ? h4Adx.toFixed(1) : "N/A"} (추세 강도)`,
      `주봉 바이어스: ${price > weeklyEma50 ? "상승 ▲" : "하락 ▼"}`,
      `30m BK:    ${isLong ? `$${fmt(hh2_30m)} 돌파 (2봉 30분봉)` : `$${fmt(ll2_30m)} 하향 돌파 (2봉 30분봉)`}`,
      ``,
      `🛑 초기 손절: $${fmt(initialSl)} (-${slPct}%, ATR×${slMult.toFixed(1)})`,
      `🔄 트레일링: ATR×${trailMult.toFixed(1)} 기준 갱신`,
      ``,
      `모드: ${CONFIG.paperTrading ? "페이퍼" : "실거래"}`,
    ].join("\n");

    console.log(`\n  ${dirLabel} ALERT: ${symbol} @ $${fmt(price)}`);
    console.log(`  초기 손절: $${fmt(initialSl)} | ATR: $${atr1h.toFixed(2)}`);
    await sendNotification(`${dirLabel} ${symbol} 진입 신호!`, entryMsg);

    // 포지션 열기
    let fresh = loadPositions();
    const existing     = fresh.filter(p => p.symbol === symbol);
    const oppositeSide = existing.filter(p => p.side !== direction);
    const sameSide     = existing.filter(p => p.side === direction);

    // 반대 방향 → 청산
    if (oppositeSide.length > 0) {
      for (const pos of oppositeSide) {
        const pnl = (pos.side === "long" ? 1 : -1) * (price - pos.entryPrice) * pos.quantity;
        writeExitCsv(pos, price, `반대 시그널 → ${direction.toUpperCase()}`, pos.quantity);
        console.log(`  🔄 반대 포지션 청산: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
      }
      fresh = fresh.filter(p => !oppositeSide.includes(p));
    }

    if (sameSide.length > 0) {
      console.log(`\n⏭ ${symbol} ${direction.toUpperCase()} 이미 오픈 — 중복 스킵`);
      logEntry.notes = "skipped: same direction position already open";
    } else {
      const qty = tradeSize / price;
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER: ${qty.toFixed(6)} ${symbol} @ $${fmt(price)}`);
        console.log(`   초기SL: $${fmt(initialSl)} | 트레일 시작: $${fmt(trailStop)}`);
      } else {
        try {
          const order = await placeBitGetOrder(symbol, isLong ? "buy" : "sell", tradeSize, price);
          logEntry.orderId = order.orderId;
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
          logEntry.orderPlaced = false;
        }
      }

      if (logEntry.orderPlaced) {
        fresh.push({
          symbol,
          side: direction,
          entryPrice: price,
          quantity: qty,
          tradeSize,
          leverage: CONFIG.leverage,
          initialSl,
          trailStop,
          trailMult,
          atr: atr1h,
          timestamp: localISO(),
          orderId: logEntry.orderId,
          breakoutLevel: isLong ? hh2_30m : ll2_30m,
          entryCheckCount: 0,
        });
        savePositions(fresh);
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  writeTradeCsv(logEntry);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${localISO()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy and watchlist
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = rules.watchlist || [CONFIG.symbol];
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Run for each symbol in sequence
  for (const symbol of watchlist) {
    await runForSymbol(symbol, log, rules);
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
