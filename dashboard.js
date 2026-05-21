/**
 * Trading Bot Dashboard — Trend Following Strategy
 * Run: node dashboard.js
 * Open: http://localhost:3000
 *
 * Strategy: 4H ADX(14) + 30분봉 2봉 브레이크아웃 + 주봉 EMA(50) 방향 필터
 * ADX 임계값: BTC=25, ETH=20  |  주봉 강세장 롱: Trail×6 / SL×3  |  기타: Trail×4 / SL×2
 */

import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

const PORT = 3000;

// ─── Binance Market Data ─────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1h", limit = 200) {
  const map = { "1h": "1h", "30m": "30m", "4h": "4h", "1w": "1w", "1d": "1d" };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval] ?? interval}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
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

// ADX(14) — Wilder's smoothing (0~100 범위)
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
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) { adx = (adx * (period - 1) + dxArr[i]) / period; }
  return adx;
}

// RSI(3) — Wilder's smoothing
function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// N봉 최고가/최저가 (마지막 봉 제외)
function calcBreakoutLevels(candles, period = 2) {
  const slice = candles.slice(-period - 1, -1);
  return {
    hh: Math.max(...slice.map(c => c.high)),
    ll: Math.min(...slice.map(c => c.low)),
  };
}

// 스윙 고점/저점 기반 참고 타겟
// lookback 봉 안에서 스윙 고점(저점)을 찾아 가장 가까운 2개 반환
function calcSwingTargets(candles, price, direction, atr, lookback = 100) {
  const recent = candles.slice(-lookback - 3, -1); // 마지막 봉 제외
  const swingHighs = [], swingLows = [];

  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    if (c.high > recent[i-1].high && c.high > recent[i-2].high &&
        c.high > recent[i+1].high && c.high > recent[i+2].high) {
      swingHighs.push(c.high);
    }
    if (c.low < recent[i-1].low && c.low < recent[i-2].low &&
        c.low < recent[i+1].low && c.low < recent[i+2].low) {
      swingLows.push(c.low);
    }
  }

  const minDist = atr * 0.5;

  if (direction === "long") {
    // 위쪽 저항 스윙 고점 2개
    const targets = swingHighs
      .filter(h => h > price + minDist)
      .sort((a, b) => a - b);
    const r1 = targets[0] ?? price + atr * 3;
    const r2 = targets.find(t => t > r1 + minDist) ?? price + atr * 6;
    return { r1, r2 };
  } else {
    // 아래쪽 지지 스윙 저점 2개
    const targets = swingLows
      .filter(l => l < price - minDist)
      .sort((a, b) => b - a);
    const r1 = targets[0] ?? price - atr * 3;
    const r2 = targets.find(t => t < r1 - minDist) ?? price - atr * 6;
    return { r1, r2 };
  }
}

// ─── Symbol Analysis (새 전략) ────────────────────────────────────────────────

async function getSymbolData(symbol) {
  // 심볼별 ADX 임계값 (백테스트 최적값: BTC=25, ETH=20)
  const adxThreshold = symbol === "BTCUSDT" ? 25 : 20;

  const [candles1h, candles4h, candlesW, candles30m] = await Promise.all([
    fetchCandles(symbol, "1h", 200),
    fetchCandles(symbol, "4h", 200),
    fetchCandles(symbol, "1w", 100),
    fetchCandles(symbol, "30m", 10),   // 2봉 브레이크아웃용
  ]);

  const price  = candles1h.at(-1).close;
  const high1h = candles1h.at(-1).high;
  const vol1h  = candles1h.at(-1).volume;

  const closes1h        = candles1h.map(c => c.close);
  const rsi3            = calcRSI(closes1h, 3);

  const weeklyCloses    = candlesW.map(c => c.close);
  const weeklyEma50     = calcEMA(weeklyCloses, 50);
  const prevWeeklyEma50 = calcEMA(weeklyCloses.slice(0, -1), 50);  // 기울기용 (전봉)
  const h4Ema50         = calcEMA(candles4h.map(c => c.close), 50);
  const h4Adx       = calcADX(candles4h, 14);
  const atr1h       = calcATR(candles1h, 14);
  const { hh: hh2, ll: ll2 } = calcBreakoutLevels(candles30m, 2);  // 30분봉 2봉

  const weeklyBull = price > weeklyEma50;
  const weeklyBear = price < weeklyEma50;
  const wSlopeUp   = weeklyEma50 > prevWeeklyEma50;
  const wSlopeDown = weeklyEma50 < prevWeeklyEma50;
  const h4Bull     = price > h4Ema50;
  const h4Bear     = price < h4Ema50;
  const adxStrong  = h4Adx !== null && h4Adx > adxThreshold;
  const breakoutLong  = price > hh2;
  const breakoutShort = price < ll2;

  // 방향 결정 (주봉 EMA 위치 + 기울기 모두 일치)
  let direction = null;
  if (weeklyBull && wSlopeUp && h4Bull) direction = "long";
  else if (weeklyBear && wSlopeDown && h4Bear) direction = "short";

  const breakoutHit = direction === "long" ? breakoutLong : direction === "short" ? breakoutShort : false;
  const emaSlope    = direction === "long" ? wSlopeUp : direction === "short" ? wSlopeDown : false;
  const allPass = direction !== null && adxStrong && breakoutHit && emaSlope;

  // 신호 레벨
  let signal = "WAITING";
  if (allPass) signal = direction === "long" ? "LONG" : "SHORT";
  else if (direction !== null && adxStrong && emaSlope && !breakoutHit) signal = "WATCH";
  else if (direction !== null && !adxStrong) signal = "WEAK";

  // 진입 시 SL/Trail 계산 (주봉 강세장 롱: ×1.5)
  const isLong = direction === "long";
  const weeklyBullLong = isLong && weeklyBull;
  const slMult    = weeklyBullLong ? 3.0 : 2.0;
  const trailMult = weeklyBullLong ? 6.0 : 4.0;
  const projSl    = direction ? (isLong ? price - atr1h * slMult : price + atr1h * slMult) : null;
  const projTrail = direction ? (isLong ? price - atr1h * trailMult : price + atr1h * trailMult) : null;

  // 스윙 기반 참고 타겟 (실제 청산은 트레일링 — 이건 참고용)
  const swingTargets = direction ? calcSwingTargets(candles1h, price, direction, atr1h) : null;
  const ref1Pct = swingTargets ? ((swingTargets.r1 - price) / price * 100 * (isLong ? 1 : -1)) : null;
  const ref2Pct = swingTargets ? ((swingTargets.r2 - price) / price * 100 * (isLong ? 1 : -1)) : null;
  const slPct   = projSl ? Math.abs((projSl - price) / price * 100) : null;
  const rr1     = (ref1Pct && slPct) ? (ref1Pct / slPct) : null;
  const rr2     = (ref2Pct && slPct) ? (ref2Pct / slPct) : null;

  const checks = [
    { label: "주봉 EMA(50) 방향 필터",                  pass: weeklyBull || weeklyBear,
      detail: `${weeklyBull ? "위 (롱 바이어스)" : "아래 (숏 바이어스)"}  $${weeklyEma50.toFixed(0)}` },
    { label: `주봉 EMA(50) 기울기 — ${isLong ? "↑ 상승" : "↓ 하락"} 중이어야 함`,
      pass: isLong ? wSlopeUp : wSlopeDown,
      detail: `${weeklyEma50.toFixed(0)} ${wSlopeUp ? "↑" : "↓"} (전봉: ${prevWeeklyEma50.toFixed(0)})` },
    { label: "4H EMA(50) + 방향 일치",                  pass: direction !== null,
      detail: `${h4Bull ? "위" : "아래"}  $${h4Ema50.toFixed(0)}` },
    { label: `4H ADX(14) > ${adxThreshold} — 추세 강도`, pass: adxStrong,
      detail: h4Adx !== null ? h4Adx.toFixed(1) : "N/A" },
    { label: `30분봉 2봉 ${isLong ? "최고가" : "최저가"} 브레이크아웃`,
      pass: breakoutHit,
      detail: isLong ? `$${hh2.toFixed(0)} 돌파 필요` : `$${ll2.toFixed(0)} 하향 돌파 필요` },
  ];

  return {
    symbol, price, high1h, vol1h, rsi3,
    weeklyEma50, prevWeeklyEma50, h4Ema50, h4Adx, atr1h, hh2, ll2,
    adxThreshold,
    weeklyBull, weeklyBear, wSlopeUp, wSlopeDown, h4Bull, h4Bear,
    adxStrong, breakoutHit, breakoutLong, breakoutShort, emaSlope,
    direction, allPass, signal, checks,
    slMult, trailMult, projSl, projTrail,
    weeklyBullLong,
    swingTargets, ref1Pct, ref2Pct, slPct, rr1, rr2,
  };
}

// ─── Daily Market Briefing ───────────────────────────────────────────────────

async function fetchMarketBrief() {
  try {
    const [fngRes, globalRes, btcDailyRes] = await Promise.all([
      fetch("https://api.alternative.me/fng/?limit=1"),
      fetch("https://api.coingecko.com/api/v3/global"),
      fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30"),
    ]);

    const fng = await fngRes.json();
    const global = await globalRes.json();
    const btcDaily = await btcDailyRes.json();

    const fngValue = parseInt(fng.data[0].value);
    const fngLabel = fng.data[0].value_classification;
    const dominance = global.data.market_cap_percentage.btc.toFixed(1);

    const ticker = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT").then(r => r.json());
    const change24h = parseFloat(ticker.priceChangePercent);
    const volume24h = parseFloat(ticker.quoteVolume) / 1e9;

    const recentCandles = btcDaily.slice(-14);
    const high14 = Math.max(...recentCandles.map(c => parseFloat(c[2])));
    const low14  = Math.min(...recentCandles.map(c => parseFloat(c[3])));

    const closes = btcDaily.map(c => parseFloat(c[4]));
    const ema7  = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
    const ema14 = closes.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const weeklyTrend = ema7 > ema14 ? "상승" : "하락";

    return { fngValue, fngLabel, dominance, change24h, volume24h, high14, low14, weeklyTrend };
  } catch {
    return null;
  }
}

// ─── BitGet Balance ──────────────────────────────────────────────────────────

async function fetchBalance() {
  const apiKey = process.env.BITGET_API_KEY;
  const secretKey = process.env.BITGET_SECRET_KEY;
  const passphrase = process.env.BITGET_PASSPHRASE;
  const baseUrl = process.env.BITGET_BASE_URL || "https://api.bitget.com";
  if (!apiKey) return [];

  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/account/assets";
  const sig = crypto.createHmac("sha256", secretKey)
    .update(`${timestamp}GET${path}`)
    .digest("base64");

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY": apiKey, "ACCESS-SIGN": sig,
        "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    if (data.code !== "00000") return [];
    return (data.data ?? []).filter(a => parseFloat(a.available) > 0 || parseFloat(a.frozen) > 0);
  } catch { return []; }
}

// ─── Real BitGet Positions ───────────────────────────────────────────────────

async function fetchRealPositions() {
  const apiKey = process.env.BITGET_API_KEY;
  const secretKey = process.env.BITGET_SECRET_KEY;
  const passphrase = process.env.BITGET_PASSPHRASE;
  const baseUrl = process.env.BITGET_BASE_URL || "https://api.bitget.com";
  if (!apiKey) return [];

  function sign(ts, method, path) {
    return crypto.createHmac("sha256", secretKey).update(ts + method + path).digest("base64");
  }
  async function get(path, params = {}) {
    const q = new URLSearchParams(params).toString();
    const full = q ? `${path}?${q}` : path;
    const ts = Date.now().toString();
    try {
      const res = await fetch(`${baseUrl}${full}`, {
        headers: {
          "ACCESS-KEY": apiKey, "ACCESS-SIGN": sign(ts, "GET", full),
          "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": passphrase,
          "Content-Type": "application/json",
        },
      });
      const data = await res.json();
      return data.code === "00000" ? (data.data ?? []) : [];
    } catch { return []; }
  }

  const [btcPos, ethPos] = await Promise.all([
    get("/api/v2/mix/position/all-position", { productType: "COIN-FUTURES", marginCoin: "BTC" }),
    get("/api/v2/mix/position/all-position", { productType: "COIN-FUTURES", marginCoin: "ETH" }),
  ]);

  return [...btcPos, ...ethPos]
    .filter(p => parseFloat(p.total) > 0)
    .map(p => {
      const entry = parseFloat(p.openPriceAvg);
      const mark  = parseFloat(p.markPrice);
      const side  = p.holdSide;
      const pnl   = parseFloat(p.unrealizedPL);
      const total = parseFloat(p.total);
      const pnlPct = ((mark - entry) / entry) * 100 * (side === "short" ? -1 : 1) * parseInt(p.leverage);
      return { symbol: p.symbol, marginCoin: p.marginCoin, side, entry, mark, total, pnl, pnlPct,
               leverage: parseInt(p.leverage), liqPrice: parseFloat(p.liquidationPrice) };
    });
}

// ─── Local Data ──────────────────────────────────────────────────────────────

let currentLeverage = parseFloat(process.env.LEVERAGE || "1");

function loadTrades() {
  if (!existsSync("trades.csv")) return [];
  const lines = readFileSync("trades.csv", "utf8").trim().split("\n");
  return lines.slice(2).reverse().slice(0, 30).map((l) => {
    const cols = l.split(",");
    return { date: cols[0], time: cols[1], symbol: cols[3], side: cols[4],
             qty: cols[5], price: cols[6], total: cols[7], mode: cols[11],
             notes: (cols[12] || "").replace(/"/g, ""), realizedPnl: cols[13] ? parseFloat(cols[13]) : null };
  });
}

function loadAllTrades() {
  if (!existsSync("trades.csv")) return [];
  const lines = readFileSync("trades.csv", "utf8").trim().split("\n");
  return lines.slice(2).map((l) => {
    const cols = l.split(",");
    return { date: cols[0], time: cols[1], symbol: cols[3], side: cols[4],
             qty: parseFloat(cols[5]) || 0, price: parseFloat(cols[6]) || 0,
             total: parseFloat(cols[7]) || 0, mode: cols[11],
             notes: (cols[12] || "").replace(/"/g, ""), realizedPnl: cols[13] ? parseFloat(cols[13]) : null };
  });
}

function loadPositions() {
  if (!existsSync("positions.json")) return [];
  return JSON.parse(readFileSync("positions.json", "utf8"));
}

function computePaperStats(positions, symbols) {
  const allTrades = loadAllTrades();
  const lev = currentLeverage;

  const unrealizedBreakdown = positions.map(pos => {
    const sym = symbols.find(s => s.symbol === pos.symbol);
    const currentPrice = sym ? sym.price : pos.entryPrice;
    const isShort = pos.side === "short";
    const rawPnl = (isShort ? -1 : 1) * (currentPrice - pos.entryPrice) * pos.quantity;
    const leveragedPnl = rawPnl * lev;
    const pnlPct = (isShort ? -1 : 1) * ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * lev;
    return { symbol: pos.symbol, side: pos.side ?? "long", entryPrice: pos.entryPrice, currentPrice,
             qty: pos.quantity, rawPnl, leveragedPnl, pnlPct,
             initialSl: pos.initialSl, trailStop: pos.trailStop, trailMult: pos.trailMult ?? 4.0,
             leverage: pos.leverage || lev, timestamp: pos.timestamp };
  });
  const totalUnrealized = unrealizedBreakdown.reduce((s, p) => s + p.leveragedPnl, 0);

  const isExit  = t => t.side === "SELL" || t.side === "LONG EXIT" || t.side === "SHORT EXIT";
  const isEntry = t => t.side === "BUY"  || t.side === "LONG" || t.side === "SHORT";
  const sellTrades = allTrades.filter(t => isExit(t) && t.realizedPnl !== null);
  const totalRealized = sellTrades.reduce((s, t) => s + (t.realizedPnl * lev), 0);
  const wins   = sellTrades.filter(t => t.realizedPnl > 0).length;
  const losses = sellTrades.filter(t => t.realizedPnl <= 0).length;
  const total  = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : null;
  const entries = allTrades.filter(t => isEntry(t) && (t.mode === "PAPER" || t.mode === "LIVE"));

  return { unrealizedBreakdown, totalUnrealized, totalRealized,
           wins, losses, total, winRate, entryCount: entries.length,
           leverage: lev, netPnl: totalRealized + totalUnrealized };
}

// ─── 텔레그램 알림 ────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {}
}

// 알림 중복 방지 — 같은 알림은 30분에 한 번만
const alertSentAt = new Map();
function shouldNotify(key) {
  const last = alertSentAt.get(key) ?? 0;
  if (Date.now() - last > 30 * 60 * 1000) {
    alertSentAt.set(key, Date.now());
    return true;
  }
  return false;
}

// ─── 포지션 청산/익절 알림 계산 ──────────────────────────────────────────────

function computePositionAlerts(pos, sym) {
  const isLong = pos.side === "long";
  const price  = sym.price;
  const alerts = [];

  // ── 손절 / 청산 신호 ──────────────────────────────────────────
  if (isLong ? price <= pos.initialSl : price >= pos.initialSl) {
    alerts.push({ type: "SL",         severity: "critical", emoji: "🚨",
      msg: "초기 손절 도달 — 즉시 청산!", value: `$${pos.initialSl.toFixed(0)}` });
  }

  if (pos.trailStop) {
    const trailHit = isLong ? price <= pos.trailStop : price >= pos.trailStop;
    if (trailHit) {
      alerts.push({ type: "TRAIL",     severity: "critical", emoji: "🚨",
        msg: "트레일 스탑 도달 — 청산!", value: `$${pos.trailStop.toFixed(0)}` });
    } else {
      const distPct = (isLong ? price - pos.trailStop : pos.trailStop - price) / price * 100;
      if (distPct < 1.5) {
        alerts.push({ type: "TRAIL_NEAR", severity: "warning", emoji: "⚠️",
          msg: `Trail Stop까지 ${distPct.toFixed(2)}% — 주의`, value: `$${pos.trailStop.toFixed(0)}` });
      }
    }
  }

  if (isLong && sym.h4Bear) {
    alerts.push({ type: "TREND_FLIP", severity: "warning", emoji: "⚠️",
      msg: "4H EMA(50) 하향 이탈 — 추세 반전, 청산 고려", value: `$${sym.h4Ema50.toFixed(0)}` });
  } else if (!isLong && sym.h4Bull) {
    alerts.push({ type: "TREND_FLIP", severity: "warning", emoji: "⚠️",
      msg: "4H EMA(50) 상향 돌파 — 추세 반전, 청산 고려", value: `$${sym.h4Ema50.toFixed(0)}` });
  }

  if (isLong && !sym.wSlopeUp) {
    alerts.push({ type: "SLOPE_FLIP", severity: "warning", emoji: "⚠️",
      msg: "주봉 EMA 기울기 하락 전환 — 횡보/약세 진입 위험", value: `$${sym.weeklyEma50.toFixed(0)}` });
  } else if (!isLong && sym.wSlopeUp) {
    alerts.push({ type: "SLOPE_FLIP", severity: "warning", emoji: "⚠️",
      msg: "주봉 EMA 기울기 상승 전환 — 횡보/강세 전환 위험", value: `$${sym.weeklyEma50.toFixed(0)}` });
  }

  // ── 익절 신호 ──────────────────────────────────────────────────
  if (sym.swingTargets) {
    const r2Hit = isLong ? price >= sym.swingTargets.r2 : price <= sym.swingTargets.r2;
    const r1Hit = isLong ? price >= sym.swingTargets.r1 : price <= sym.swingTargets.r1;
    if (r2Hit) {
      alerts.push({ type: "R2", severity: "profit", emoji: "✅",
        msg: "2차 스윙 타겟 도달 — 전량 익절 고려", value: `$${sym.swingTargets.r2.toFixed(0)}` });
    } else if (r1Hit) {
      alerts.push({ type: "R1", severity: "profit", emoji: "✅",
        msg: "1차 스윙 타겟 도달 — 50% 익절 고려", value: `$${sym.swingTargets.r1.toFixed(0)}` });
    }
  }

  if (sym.rsi3 !== null) {
    if (isLong && sym.rsi3 > 85) {
      alerts.push({ type: "RSI_HOT", severity: "profit", emoji: "⚡",
        msg: `RSI(3) ${sym.rsi3.toFixed(0)} 과열 — 모멘텀 소진, 익절 검토`, value: `RSI ${sym.rsi3.toFixed(1)}` });
    } else if (!isLong && sym.rsi3 < 15) {
      alerts.push({ type: "RSI_HOT", severity: "profit", emoji: "⚡",
        msg: `RSI(3) ${sym.rsi3.toFixed(0)} 과매도 — 반등 가능, 익절 검토`, value: `RSI ${sym.rsi3.toFixed(1)}` });
    }
  }

  return alerts;
}

// ─── API Endpoint ─────────────────────────────────────────────────────────────

async function apiData() {
  const [btc, eth, balance, market, realPositions] = await Promise.all([
    getSymbolData("BTCUSDT"),
    getSymbolData("ETHUSDT"),
    fetchBalance(),
    fetchMarketBrief(),
    fetchRealPositions(),
  ]);

  const symbols        = [btc, eth];
  const paperPositions = loadPositions();
  const paperStats     = computePaperStats(paperPositions, symbols);

  // 포지션 알림 계산 + 텔레그램 발송
  const exitAlerts = paperPositions.map(pos => {
    const sym    = symbols.find(s => s.symbol === pos.symbol);
    if (!sym) return null;
    const alerts = computePositionAlerts(pos, sym);
    const isLong = pos.side === "long";
    const pnlPct = (isLong ? 1 : -1) * (sym.price - pos.entryPrice) / pos.entryPrice * 100;
    const trailDistPct = pos.trailStop
      ? (isLong ? sym.price - pos.trailStop : pos.trailStop - sym.price) / sym.price * 100
      : null;

    // 텔레그램 — critical/profit만 발송 (warning 중 TRAIL_NEAR 제외)
    for (const a of alerts) {
      if (a.type === "TRAIL_NEAR") continue;
      const key = `${pos.symbol}:${a.type}`;
      if (shouldNotify(key)) {
        sendTelegram(
          `${a.emoji} ${pos.symbol} ${pos.side.toUpperCase()}\n` +
          `${a.msg}\n` +
          `현재가: $${sym.price.toFixed(0)} | ${a.value}\n` +
          `PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
        );
      }
    }

    return { symbol: pos.symbol, side: pos.side,
             entryPrice: pos.entryPrice, price: sym.price,
             pnlPct, trailDistPct,
             initialSl: pos.initialSl, trailStop: pos.trailStop,
             alerts };
  }).filter(Boolean);

  return { updatedAt: new Date().toISOString(),
           paperTrading: process.env.PAPER_TRADING !== "false",
           symbols, balance, market, positions: realPositions,
           paperPositions, paperStats, trades: loadTrades(), exitAlerts };
}

// ─── HTML ────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }

  header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; font-weight: 600; }
  .mode-badge { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .mode-paper { background: #1f4068; color: #58a6ff; }
  .mode-live  { background: #3d1a1a; color: #f85149; }
  .updated { font-size: 12px; color: #8b949e; }

  main { padding: 24px; max-width: 1100px; margin: 0 auto; }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }

  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; }
  .card h2 { font-size: 13px; color: #8b949e; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }

  .symbol-name { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .price { font-size: 32px; font-weight: 700; margin-bottom: 16px; }

  .signal { display: inline-block; padding: 6px 16px; border-radius: 6px; font-size: 14px; font-weight: 700; margin-bottom: 16px; }
  .signal-LONG    { background: #1a4731; color: #3fb950; }
  .signal-SHORT   { background: #3d1a1a; color: #f85149; }
  .signal-WATCH   { background: #3d3000; color: #e3b341; }
  .signal-WEAK    { background: #21262d; color: #6e7681; }
  .signal-WAITING { background: #1c2128; color: #8b949e; }

  .indicators { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ind { background: #0d1117; border-radius: 6px; padding: 10px 12px; }
  .ind-label { font-size: 11px; color: #8b949e; margin-bottom: 2px; }
  .ind-value { font-size: 14px; font-weight: 600; }
  .ind-value.above { color: #3fb950; }
  .ind-value.below { color: #f85149; }
  .ind-value.warn  { color: #e3b341; }

  .dir-tag { font-size: 12px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; }
  .dir-long    { background: #1a4731; color: #3fb950; }
  .dir-short   { background: #3d1a1a; color: #f85149; }
  .dir-neutral { background: #1c2128; color: #8b949e; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; color: #8b949e; border-bottom: 1px solid #30363d; font-weight: 500; font-size: 12px; }
  td { padding: 10px 12px; border-bottom: 1px solid #21262d; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1c2128; }

  .tag { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .tag-BLOCKED { background: #21262d; color: #8b949e; }
  .tag-PAPER   { background: #1f4068; color: #58a6ff; }
  .tag-LIVE    { background: #1a4731; color: #3fb950; }

  .balance-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #21262d; }
  .balance-item:last-child { border-bottom: none; }
  .coin { font-weight: 600; font-size: 15px; }

  .pos-item { padding: 12px 0; border-bottom: 1px solid #21262d; }
  .pos-item:last-child { border-bottom: none; }
  .pos-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .pos-sym { font-weight: 600; }
  .pos-pnl { font-weight: 600; }
  .pos-details { font-size: 12px; color: #8b949e; }

  .empty { color: #8b949e; font-size: 13px; text-align: center; padding: 20px 0; }

  .refresh-btn { background: #21262d; border: 1px solid #30363d; color: #e6edf3; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .refresh-btn:hover { background: #30363d; }

  [data-tip] { position: relative; cursor: help; border-bottom: 1px dashed #444; }
  [data-tip]:hover::after { content: attr(data-tip); position: absolute; bottom: 125%; left: 50%; transform: translateX(-50%); background: #1c2128; border: 1px solid #444; color: #e6edf3; font-size: 11px; padding: 6px 10px; border-radius: 6px; white-space: nowrap; z-index: 10; pointer-events: none; }
  [data-tip]:hover::before { content: ''; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top-color: #444; z-index: 10; }

  .market-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .market-item { background: #0d1117; border-radius: 8px; padding: 14px 16px; }
  .market-item-label { font-size: 11px; color: #8b949e; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .market-item-value { font-size: 20px; font-weight: 700; }
  .market-item-sub { font-size: 12px; color: #8b949e; margin-top: 2px; }
  .market-trend { margin-top: 14px; padding: 12px 14px; background: #0d1117; border-radius: 8px; font-size: 13px; line-height: 1.6; color: #c9d1d9; }

  .strat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .strat-sym { border: 1px solid #30363d; border-radius: 8px; padding: 16px; }

  .check-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
  .check-row:last-child { border-bottom: none; }
  .check-label { color: #c9d1d9; }
  .check-detail { font-size: 11px; color: #8b949e; }
  .check-pass { color: #3fb950; font-size: 14px; }
  .check-fail { color: #f85149; font-size: 14px; }

  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .stat-item { background: #0d1117; border-radius: 8px; padding: 14px 16px; }
  .stat-label { font-size: 11px; color: #8b949e; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
  .stat-value { font-size: 22px; font-weight: 700; }
  .stat-sub { font-size: 11px; color: #8b949e; margin-top: 2px; }
  .pnl-pos { color: #3fb950; }
  .pnl-neg { color: #f85149; }
  .pnl-neu { color: #8b949e; }
  .lev-input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 6px; padding: 6px 10px; font-size: 14px; width: 70px; text-align: center; }
  .lev-btn { background: #238636; border: none; color: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; margin-left: 6px; }
  .lev-btn:hover { background: #2ea043; }
  .open-pos-item { padding: 12px 0; border-bottom: 1px solid #21262d; }
  .open-pos-item:last-child { border-bottom: none; }

  @media (max-width: 700px) {
    .grid-2, .grid-3, .strat-grid { grid-template-columns: 1fr; }
    .price { font-size: 24px; }
  }
</style>
</head>
<body>
<header>
  <h1>🤖 Trading Bot</h1>
  <div style="display:flex;gap:12px;align-items:center">
    <span class="updated" id="updated">로딩 중...</span>
    <button class="refresh-btn" onclick="load()">새로고침</button>
    <span class="mode-badge" id="mode-badge">-</span>
  </div>
</header>
<main>
  <div class="card" style="margin-bottom:16px">
    <h2>일일 시장 브리핑 (BTC 전체 장세)</h2>
    <div id="market"><div class="empty">로딩 중...</div></div>
  </div>
  <div class="card" style="margin-bottom:16px" id="exit-monitor-card">
    <h2>🔔 포지션 모니터 (청산 · 익절 신호)</h2>
    <div id="exit-monitor"><div class="empty">로딩 중...</div></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h2>전략 체크 (주봉 EMA50 · 4H ADX · 30분봉 2봉 브레이크아웃)</h2>
    <div id="strategy"><div class="empty">로딩 중...</div></div>
  </div>
  <div class="grid-2" id="symbols"></div>
  <div class="card" style="margin-bottom:16px">
    <h2>📋 페이퍼 성과</h2>
    <div id="paper-stats"><div class="empty">로딩 중...</div></div>
  </div>
  <div class="grid-3">
    <div class="card">
      <h2>잔고</h2>
      <div id="balance"><div class="empty">로딩 중...</div></div>
    </div>
    <div class="card">
      <h2>오픈 포지션 (실거래)</h2>
      <div id="positions"><div class="empty">로딩 중...</div></div>
    </div>
    <div class="card">
      <h2>오늘 요약</h2>
      <div id="summary"><div class="empty">로딩 중...</div></div>
    </div>
  </div>
  <div class="card">
    <h2>최근 거래 내역</h2>
    <div id="trades"><div class="empty">로딩 중...</div></div>
  </div>
</main>

<script>
function fmt(n, d=2) { return parseFloat(n).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d}); }

function renderExitMonitor(exitAlerts) {
  if (!exitAlerts || !exitAlerts.length)
    return '<div class="empty">오픈 포지션 없음 — 모니터링 대기 중</div>';

  return exitAlerts.map(p => {
    const isLong   = p.side === "long";
    const critical = p.alerts.filter(a => a.severity === "critical");
    const warnings = p.alerts.filter(a => a.severity === "warning");
    const profits  = p.alerts.filter(a => a.severity === "profit");
    const hasAlert = p.alerts.length > 0;

    const borderColor = critical.length ? "#f85149"
      : warnings.length ? "#e3b341"
      : profits.length  ? "#3fb950" : "#30363d";

    const alertRows = p.alerts.map(a => {
      const bg    = a.severity === "critical" ? "#3d1a1a" : a.severity === "warning" ? "#2d2a16" : "#0d2318";
      const color = a.severity === "critical" ? "#f85149" : a.severity === "warning" ? "#e3b341" : "#3fb950";
      return \`<div style="background:\${bg};border-radius:6px;padding:8px 12px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
        <span style="color:\${color};font-size:13px">\${a.emoji} \${a.msg}</span>
        <span style="color:#8b949e;font-size:12px;font-weight:600">\${a.value}</span>
      </div>\`;
    }).join('');

    const trailColor = (p.trailDistPct !== null && p.trailDistPct < 1.5) ? "#e3b341" : "#58a6ff";

    return \`<div style="border:1px solid \${borderColor};border-radius:8px;padding:14px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:700;font-size:15px">\${p.symbol} \${isLong ? "🟢 LONG" : "🔴 SHORT"}</span>
        <span style="color:\${p.pnlPct >= 0 ? "#3fb950" : "#f85149"};font-weight:700;font-size:16px">\${p.pnlPct >= 0 ? "+" : ""}\${fmt(p.pnlPct)}%</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;text-align:center">
        <div style="background:#1c2128;border-radius:6px;padding:8px">
          <div style="font-size:10px;color:#8b949e;margin-bottom:2px">진입가</div>
          <div style="font-size:13px;font-weight:600">$\${fmt(p.entryPrice)}</div>
        </div>
        <div style="background:#1c2128;border-radius:6px;padding:8px">
          <div style="font-size:10px;color:#8b949e;margin-bottom:2px">현재가</div>
          <div style="font-size:13px;font-weight:600">$\${fmt(p.price)}</div>
        </div>
        <div style="background:#1c2128;border-radius:6px;padding:8px">
          <div style="font-size:10px;color:#8b949e;margin-bottom:2px">Trail까지</div>
          <div style="font-size:13px;font-weight:600;color:\${trailColor}">\${p.trailDistPct !== null ? fmt(p.trailDistPct) + "%" : "—"}</div>
        </div>
      </div>
      \${hasAlert ? alertRows
        : '<div style="background:#0d2318;border-radius:6px;padding:10px 12px;color:#3fb950;font-size:13px">✅ 청산/익절 신호 없음 — 홀딩 유지</div>'}
    </div>\`;
  }).join('');
}

function renderSymbol(s) {
  const dirLabel = s.direction === 'long' ? '🟢 LONG 바이어스' : s.direction === 'short' ? '🔴 SHORT 바이어스' : '⚪ NEUTRAL';
  const dirClass = s.direction === 'long' ? 'dir-long' : s.direction === 'short' ? 'dir-short' : 'dir-neutral';
  const sigLabel = {LONG:'🟢 진입 신호!', SHORT:'🔴 진입 신호!', WATCH:'🟡 브레이크아웃 대기', WEAK:'⚠️ ADX 약함', WAITING:'⏸ 조건 미충족'}[s.signal] ?? '⏸ 대기';
  const sigClass = 'signal-' + s.signal;

  const adxColor = s.adxStrong ? 'above' : (s.h4Adx && s.h4Adx > s.adxThreshold - 5 ? 'warn' : 'below');

  return \`<div class="card">
    <div style="display:flex;align-items:center;margin-bottom:4px">
      <div class="symbol-name">\${s.symbol}</div>
      <span class="dir-tag \${dirClass}">\${dirLabel}</span>
    </div>
    <div class="price">$\${fmt(s.price)}</div>
    <div class="\${sigClass} signal">\${sigLabel}</div>
    <div class="indicators">
      <div class="ind">
        <div class="ind-label" data-tip="주봉 EMA(50) — 위면 롱 바이어스, 기울기는 횡보 필터">주봉 EMA(50)</div>
        <div class="ind-value \${s.price > s.weeklyEma50 ? 'above' : 'below'}">$\${fmt(s.weeklyEma50)} <span style="font-size:10px">\${s.wSlopeUp ? '↑' : '↓'}</span></div>
      </div>
      <div class="ind">
        <div class="ind-label" data-tip="4H EMA(50) — 중기 추세 방향">4H EMA(50)</div>
        <div class="ind-value \${s.price > s.h4Ema50 ? 'above' : 'below'}">$\${fmt(s.h4Ema50)}</div>
      </div>
      <div class="ind">
        <div class="ind-label" data-tip="4H ADX(14) — BTC:25 / ETH:20 이상이면 강한 추세">4H ADX(14)</div>
        <div class="ind-value \${adxColor}">\${s.h4Adx !== null ? fmt(s.h4Adx, 1) : 'N/A'} <span style="font-size:10px;color:#8b949e">(>\${s.adxThreshold})</span></div>
      </div>
      <div class="ind">
        <div class="ind-label" data-tip="30분봉 2봉 브레이크아웃 — 돌파 여부">BK 30m×2봉</div>
        <div class="ind-value \${s.breakoutHit ? 'above' : 'below'}">\${s.breakoutHit ? '✅ 돌파' : '⏸ 대기'}</div>
      </div>
    </div>
    <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
      <div class="ind">
        <div class="ind-label" data-tip="30분봉 2봉 최고가 — 롱 진입 기준">30m 2봉 최고가</div>
        <div class="ind-value \${s.breakoutLong ? 'above' : ''}">$\${fmt(s.hh2)}</div>
      </div>
      <div class="ind">
        <div class="ind-label" data-tip="30분봉 2봉 최저가 — 숏 진입 기준">30m 2봉 최저가</div>
        <div class="ind-value \${s.breakoutShort ? 'below' : ''}">$\${fmt(s.ll2)}</div>
      </div>
    </div>
  </div>\`;
}

function renderStrategy(symbols, paperPositions = []) {
  const items = symbols.map(s => {
    const pos = paperPositions.find(p => p.symbol === s.symbol) ?? null;
    const allColor  = s.allPass ? '#3fb950' : '#f85149';
    const allBg     = s.allPass ? '#1a4731' : '#21262d';
    const allLabel  = s.allPass
      ? (s.direction === 'long' ? '🟢 LONG 진입 조건 충족' : '🔴 SHORT 진입 조건 충족')
      : '⏸ 조건 미충족';

    const modeNote = s.weeklyBullLong
      ? '<span style="color:#e3b341;font-size:11px">★ 주봉 강세장 모드 — Trail×6 / SL×3</span>'
      : s.direction === 'short' ? '<span style="color:#8b949e;font-size:11px">하락장 숏 모드 — Trail×4 / SL×2</span>' : '';

    const checkRows = s.checks.map(c => \`
      <div class="check-row">
        <span class="check-label">\${c.label}</span>
        <span style="display:flex;align-items:center;gap:8px">
          <span class="check-detail">\${c.detail}</span>
          <span class="\${c.pass ? 'check-pass' : 'check-fail'}">\${c.pass ? '✅' : '🚫'}</span>
        </span>
      </div>\`).join('');

    const isLong = s.direction === 'long';
    const tgtColor = isLong ? '#3fb950' : '#f85149';
    const rrColor1 = s.rr1 >= 2 ? '#3fb950' : s.rr1 >= 1 ? '#e3b341' : '#f85149';
    const rrColor2 = s.rr2 >= 2 ? '#3fb950' : s.rr2 >= 1 ? '#e3b341' : '#f85149';

    const projBlock = s.direction && s.projSl ? \`
      <div style="margin-top:14px">
        <div style="font-size:11px;color:#8b949e;margin-bottom:8px;letter-spacing:0.3px">손익 레벨 (참고)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
          <div style="background:#3d1a1a;border-radius:6px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:3px">🛑 \${pos ? '실제 SL' : '진입 예상 SL (ATR×'+s.slMult+')'}</div>
            <div style="font-size:14px;font-weight:700;color:#f85149">$\${fmt(pos ? pos.initialSl : s.projSl)}</div>
            <div style="font-size:10px;color:#f85149;margin-top:2px">-\${pos ? Math.abs((pos.initialSl - pos.entryPrice)/pos.entryPrice*100).toFixed(2) : s.slPct?.toFixed(2)}%</div>
          </div>
          <div style="background:#1c2128;border-radius:6px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:3px">🔄 \${pos ? '현재 Trail ↑갱신중' : '진입 예상 Trail (ATR×'+s.trailMult+')'}</div>
            <div style="font-size:14px;font-weight:700;color:#58a6ff">$\${fmt(pos ? pos.trailStop : s.projTrail)}</div>
            <div style="font-size:10px;color:#58a6ff;margin-top:2px">\${pos ? '매 시간 자동 갱신' : '트레일링 시작점'}</div>
          </div>
        </div>
        \${s.swingTargets ? \`
        <div style="font-size:11px;color:#8b949e;margin:10px 0 6px">📊 스윙 레벨 참고 타겟 (실제 청산은 트레일링)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div style="background:#0d2318;border-radius:6px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:3px">1차 저항/지지</div>
            <div style="font-size:14px;font-weight:700;color:\${tgtColor}">$\${fmt(s.swingTargets.r1)}</div>
            <div style="font-size:10px;margin-top:2px">
              <span style="color:\${tgtColor}">+\${s.ref1Pct?.toFixed(2)}%</span>
              <span style="color:#8b949e;margin-left:4px">R:R <span style="color:\${rrColor1};font-weight:700">\${s.rr1?.toFixed(2)}</span></span>
            </div>
          </div>
          <div style="background:#0d2318;border-radius:6px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:3px">2차 저항/지지</div>
            <div style="font-size:14px;font-weight:700;color:\${tgtColor}">$\${fmt(s.swingTargets.r2)}</div>
            <div style="font-size:10px;margin-top:2px">
              <span style="color:\${tgtColor}">+\${s.ref2Pct?.toFixed(2)}%</span>
              <span style="color:#8b949e;margin-left:4px">R:R <span style="color:\${rrColor2};font-weight:700">\${s.rr2?.toFixed(2)}</span></span>
            </div>
          </div>
        </div>\` : ''}
      </div>\` : '';

    return \`<div class="strat-sym">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-weight:700;font-size:16px">\${s.symbol}</span>
        <span style="font-size:13px;color:#8b949e">$\${fmt(s.price)}</span>
      </div>
      <div style="background:\${allBg};border-radius:8px;padding:10px 14px;margin-bottom:12px">
        <div style="font-size:15px;font-weight:700;color:\${allColor};\${s.allPass ? '' : 'opacity:.7'}">\${allLabel}</div>
        \${modeNote ? '<div style="margin-top:4px">' + modeNote + '</div>' : ''}
      </div>
      \${checkRows}
      \${projBlock}
    </div>\`;
  });
  return \`<div class="strat-grid">\${items.join('')}</div>\`;
}

function renderBalance(items) {
  if (!items.length) return '<div class="empty">잔고 없음</div>';
  return items.map(a => \`<div class="balance-item">
    <span class="coin">\${a.coin}</span>
    <span style="font-size:13px;color:#8b949e">가용 <span style="color:#e6edf3;font-weight:600">\${parseFloat(a.available).toFixed(6)}</span></span>
  </div>\`).join('');
}

function renderPositions(positions) {
  if (!positions.length) return '<div class="empty">오픈 포지션 없음</div>';
  return positions.map(p => {
    const isLong = p.side === 'long';
    const sideColor = isLong ? '#3fb950' : '#f85149';
    const pnlColor  = p.pnl >= 0 ? '#3fb950' : '#f85149';
    return \`<div class="pos-item">
      <div class="pos-header">
        <span class="pos-sym">\${p.symbol} <span style="color:\${sideColor};font-size:12px">\${isLong ? '🟢 LONG' : '🔴 SHORT'}</span> <span style="color:#8b949e;font-size:11px">\${p.leverage}x</span></span>
        <span class="pos-pnl" style="color:\${pnlColor}">\${p.pnlPct >= 0 ? '+' : ''}\${fmt(p.pnlPct)}%</span>
      </div>
      <div class="pos-details">진입 $\${fmt(p.entry)} | 현재 $\${fmt(p.mark)} | 청산가 $\${fmt(p.liqPrice)}</div>
    </div>\`;
  }).join('');
}

function renderTrades(trades) {
  if (!trades.length) return '<div class="empty">거래 내역 없음</div>';
  return \`<table><thead><tr><th>날짜</th><th>시간</th><th>심볼</th><th>방향</th><th>가격</th><th>합계</th><th>모드</th><th>비고</th></tr></thead><tbody>\`
    + trades.map(t => {
      const sideColor = (t.side === 'LONG' || t.side === 'LONG EXIT') ? '#3fb950'
                      : (t.side === 'SHORT' || t.side === 'SHORT EXIT') ? '#f85149'
                      : '#8b949e';
      const dirTag = (t.side === 'LONG')        ? \`<span style="color:#3fb950;font-weight:700">🟢 LONG</span>\`
                  : (t.side === 'LONG EXIT')   ? \`<span style="color:#3fb950;font-weight:700">🟢 LONG EXIT</span>\`
                  : (t.side === 'SHORT')        ? \`<span style="color:#f85149;font-weight:700">🔴 SHORT</span>\`
                  : (t.side === 'SHORT EXIT')  ? \`<span style="color:#f85149;font-weight:700">🔴 SHORT EXIT</span>\`
                  : (t.side === 'BUY')          ? \`<span style="color:#8b949e;font-weight:600">진입</span>\`
                  : (t.side === 'SELL')         ? \`<span style="color:#8b949e;font-weight:600">청산</span>\`
                  : '';
      const pnlTag = t.realizedPnl != null
        ? \` <span style="color:\${t.realizedPnl>=0?'#3fb950':'#f85149'};font-weight:600">(\${t.realizedPnl>=0?'+':''}\${t.realizedPnl.toFixed(2)})</span>\`
        : '';
      const notesStr = t.notes ? \` <span style="color:#8b949e">\${t.notes}</span>\` : '';
      return \`<tr>
        <td>\${t.date}</td><td>\${t.time}</td><td>\${t.symbol}</td>
        <td style="color:\${sideColor}">\${t.side||'-'}</td>
        <td>\${t.price ? '$'+fmt(t.price) : '-'}</td><td>\${t.total ? '$'+fmt(t.total) : '-'}</td>
        <td><span class="tag tag-\${t.mode}">\${t.mode}</span></td>
        <td style="font-size:12px">\${dirTag}\${notesStr}\${pnlTag}</td>
      </tr>\`;
    }).join('') + '</tbody></table>';
}

function renderMarket(m) {
  if (!m) return '<div class="empty">시장 데이터 로딩 실패</div>';
  const fngColor    = m.fngValue >= 60 ? '#3fb950' : m.fngValue >= 40 ? '#e3b341' : '#f85149';
  const changeColor = m.change24h >= 0 ? '#3fb950' : '#f85149';
  const changeSign  = m.change24h >= 0 ? '+' : '';
  const isBullish = m.fngValue >= 50 && m.change24h > 0 && m.weeklyTrend === '상승';
  const isBearish = m.fngValue < 40  && m.change24h < 0 && m.weeklyTrend === '하락';
  const sentimentLabel = isBullish ? '🟢 전반적으로 강세' : isBearish ? '🔴 전반적으로 약세' : '🟡 혼조세 — 방향 주시 필요';
  const sentimentDesc  = isBullish
    ? \`공포탐욕 \${m.fngValue}(탐욕), BTC 주간 상승추세, 24h \${changeSign}\${m.change24h.toFixed(2)}% — 매수 심리 우위\`
    : isBearish
    ? \`공포탐욕 \${m.fngValue}(공포), BTC 주간 하락추세, 24h \${changeSign}\${m.change24h.toFixed(2)}% — 매도 심리 우위\`
    : \`공포탐욕 \${m.fngValue}, 주간 \${m.weeklyTrend}추세, 24h \${changeSign}\${m.change24h.toFixed(2)}% — 섣부른 진입 자제\`;
  return \`
  <div class="market-grid">
    <div class="market-item">
      <div class="market-item-label" data-tip="0=극도의 공포 / 100=극도의 탐욕">공포&탐욕 지수</div>
      <div class="market-item-value" style="color:\${fngColor}">\${m.fngValue}</div>
      <div class="market-item-sub">\${m.fngLabel}</div>
    </div>
    <div class="market-item">
      <div class="market-item-label" data-tip="전체 암호화폐 시총 중 BTC 비중">BTC 도미넌스</div>
      <div class="market-item-value">\${m.dominance}%</div>
      <div class="market-item-sub">시장 점유율</div>
    </div>
    <div class="market-item">
      <div class="market-item-label" data-tip="최근 24시간 BTC 가격 변동률">24h 변동률</div>
      <div class="market-item-value" style="color:\${changeColor}">\${changeSign}\${m.change24h.toFixed(2)}%</div>
      <div class="market-item-sub">거래량 \${m.volume24h.toFixed(1)}B USD</div>
    </div>
    <div class="market-item">
      <div class="market-item-label" data-tip="최근 14일 최고가/최저가">14일 레인지</div>
      <div class="market-item-value" style="font-size:14px">$\${(m.high14/1000).toFixed(1)}K</div>
      <div class="market-item-sub">↓ $\${(m.low14/1000).toFixed(1)}K &nbsp;|&nbsp; 주간: \${m.weeklyTrend}추세</div>
    </div>
  </div>
  <div class="market-trend">\${sentimentLabel}<br><span style="color:#8b949e;font-size:12px">\${sentimentDesc}</span></div>\`;
}

function renderPaperStats(ps) {
  if (!ps) return '<div class="empty">데이터 없음</div>';
  const sign   = v => v >= 0 ? '+' : '';
  const cls    = v => v > 0 ? 'pnl-pos' : v < 0 ? 'pnl-neg' : 'pnl-neu';
  const fmtPnl = v => \`\${sign(v)}$\${Math.abs(v).toFixed(2)}\`;
  const wrColor = ps.winRate === null ? '#8b949e' : parseFloat(ps.winRate) >= 50 ? '#3fb950' : parseFloat(ps.winRate) >= 35 ? '#e3b341' : '#f85149';

  const openRows = ps.unrealizedBreakdown.length === 0
    ? '<div class="empty" style="padding:10px 0">오픈 포지션 없음</div>'
    : ps.unrealizedBreakdown.map(p => {
        const isShort = p.side === 'short';
        const pnlCls = cls(p.leveragedPnl);
        const pctSign = p.pnlPct >= 0 ? '+' : '';
        const since = p.timestamp ? new Date(p.timestamp).toLocaleDateString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
        const slStr    = p.initialSl  ? \`$\${fmt(p.initialSl)}\`  : '-';
        const trailStr = p.trailStop  ? \`$\${fmt(p.trailStop)}\`  : '-';
        return \`<div class="open-pos-item">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-weight:700">\${p.symbol} <span style="color:\${isShort ? '#f85149' : '#3fb950'};font-size:11px">\${isShort ? '🔴 SHORT' : '🟢 LONG'}</span></span>
            <span style="font-weight:700" class="\${pnlCls}">\${fmtPnl(p.leveragedPnl)} (\${pctSign}\${p.pnlPct.toFixed(2)}%)</span>
          </div>
          <div style="font-size:12px;color:#8b949e">
            진입 $\${fmt(p.entryPrice)} → 현재 $\${fmt(p.currentPrice)} | 수량 \${p.qty.toFixed(5)}
          </div>
          <div style="font-size:11px;color:#6e7681;margin-top:3px">
            🛑 SL \${slStr} &nbsp; 🔄 Trail \${trailStr} (×\${p.trailMult}) &nbsp;|&nbsp; \${since} 진입
          </div>
        </div>\`;
      }).join('');

  return \`
  <div class="stat-grid">
    <div class="stat-item">
      <div class="stat-label">실현 PnL</div>
      <div class="stat-value \${cls(ps.totalRealized)}">\${fmtPnl(ps.totalRealized)}</div>
      <div class="stat-sub">종료 거래 \${ps.total}건</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">미실현 PnL</div>
      <div class="stat-value \${cls(ps.totalUnrealized)}">\${fmtPnl(ps.totalUnrealized)}</div>
      <div class="stat-sub">오픈 포지션 \${ps.unrealizedBreakdown.length}개</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">승률 / 거래수</div>
      <div class="stat-value" style="color:\${wrColor}">\${ps.winRate !== null ? ps.winRate + '%' : '-'}</div>
      <div class="stat-sub">\${ps.wins}승 \${ps.losses}패 · 진입 \${ps.entryCount}회</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">레버리지 조정</div>
      <div style="display:flex;align-items:center;margin-top:6px">
        <input class="lev-input" id="lev-input" type="number" min="1" max="125" step="1" value="\${ps.leverage}">
        <button class="lev-btn" onclick="setLeverage()">적용</button>
      </div>
      <div class="stat-sub" style="margin-top:6px">현재 \${ps.leverage}x &nbsp;|&nbsp; 순 PnL <span class="\${cls(ps.netPnl)}">\${fmtPnl(ps.netPnl)}</span></div>
    </div>
  </div>
  <div style="font-size:12px;color:#8b949e;margin-bottom:8px">📂 오픈 포지션 (페이퍼)</div>
  \${openRows}\`;
}

async function setLeverage() {
  const val = document.getElementById('lev-input').value;
  await fetch('/api/leverage', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({leverage: parseFloat(val)}) });
  load();
}

function renderSummary(trades, positions) {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = trades.filter(t => t.date === today);
  const blocked  = todayTrades.filter(t => t.mode === 'BLOCKED').length;
  const executed = todayTrades.filter(t => t.mode === 'PAPER' || t.mode === 'LIVE').length;
  return \`<div class="balance-item"><span>오늘 체크 횟수</span><span style="font-weight:600">\${todayTrades.length}회</span></div>
    <div class="balance-item"><span>신호 발생</span><span style="font-weight:600;color:#3fb950">\${executed}회</span></div>
    <div class="balance-item"><span>차단됨</span><span style="font-weight:600;color:#8b949e">\${blocked}회</span></div>
    <div class="balance-item"><span>오픈 포지션</span><span style="font-weight:600">\${positions.length}개</span></div>\`;
}

async function load() {
  try {
    const data = await fetch('/api').then(r => r.json());
    document.getElementById('updated').textContent = '업데이트: ' + new Date(data.updatedAt).toLocaleTimeString('ko-KR');
    document.getElementById('mode-badge').textContent = data.paperTrading ? '📋 페이퍼' : '🔴 실거래';
    document.getElementById('mode-badge').className = 'mode-badge ' + (data.paperTrading ? 'mode-paper' : 'mode-live');
    document.getElementById('exit-monitor').innerHTML = renderExitMonitor(data.exitAlerts);
    document.getElementById('market').innerHTML    = renderMarket(data.market);
    document.getElementById('strategy').innerHTML  = renderStrategy(data.symbols, data.paperPositions);
    document.getElementById('symbols').innerHTML   = data.symbols.map(renderSymbol).join('');
    document.getElementById('paper-stats').innerHTML = renderPaperStats(data.paperStats);
    document.getElementById('balance').innerHTML   = renderBalance(data.balance);
    document.getElementById('positions').innerHTML = renderPositions(data.positions);
    document.getElementById('summary').innerHTML   = renderSummary(data.trades, data.positions);
    document.getElementById('trades').innerHTML    = renderTrades(data.trades);
  } catch(e) { console.error(e); }
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`;

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.url === "/api" && req.method === "GET") {
    try {
      const data = await apiData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.url === "/api/leverage" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { leverage } = JSON.parse(body);
        const lev = parseFloat(leverage);
        if (!isNaN(lev) && lev >= 1 && lev <= 125) {
          currentLeverage = lev;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ leverage: currentLeverage }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "1~125 사이로 입력하세요" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid body" }));
      }
    });
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  }
});

import { execSync } from "child_process";

server.listen(PORT, () => {
  console.log(`\n🚀 대시보드 실행 중 → http://localhost:${PORT}\n`);
  console.log(`   Ctrl+C 로 종료\n`);
  try { execSync(`open http://localhost:${PORT}`); } catch {}
  startExitMonitor();
});

// ─── 서버 사이드 청산 모니터 (브라우저 없어도 5분마다 체크) ─────────────────

function startExitMonitor() {
  const INTERVAL_MS = 5 * 60 * 1000; // 5분

  async function check() {
    try {
      const positions = loadPositions();
      if (!positions.length) return;

      const symbols = ["BTCUSDT", "ETHUSDT"];
      const symData = await Promise.all(symbols.map(s => getSymbolData(s).catch(() => null)));
      const symMap  = Object.fromEntries(symbols.map((s, i) => [s, symData[i]]).filter(([,v]) => v));

      for (const pos of positions) {
        const sym = symMap[pos.symbol];
        if (!sym) continue;

        const alerts = computePositionAlerts(pos, sym);
        const isLong = pos.side === "long";
        const pnlPct = (isLong ? 1 : -1) * (sym.price - pos.entryPrice) / pos.entryPrice * 100;

        for (const a of alerts) {
          if (a.type === "TRAIL_NEAR") continue; // 근접 경고는 스킵
          const key = `monitor:${pos.symbol}:${a.type}`;
          if (shouldNotify(key)) {
            const isCritical = a.severity === "critical";
            const msg = [
              `${a.emoji} ${pos.symbol} ${pos.side.toUpperCase()} — ${a.msg}`,
              ``,
              `진입: $${pos.entryPrice.toFixed(0)} | 현재: $${sym.price.toFixed(0)}`,
              `PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
              ``,
              isCritical
                ? `🔴 지금 BitGet에서 직접 청산하세요!`
                : a.severity === "profit"
                ? `💰 익절 타이밍 — BitGet에서 일부/전량 청산 고려`
                : `⚠️ 포지션 점검하세요`,
            ].join("\n");
            await sendTelegram(msg);
            console.log(`[모니터] 텔레그램 발송: ${pos.symbol} ${a.type}`);
          }
        }
      }
    } catch (err) {
      // 체크 실패 시 조용히 넘어감
    }
  }

  // 서버 시작 30초 후 첫 체크, 이후 5분마다
  setTimeout(() => {
    check();
    setInterval(check, INTERVAL_MS);
  }, 30000);

  console.log(`   📡 청산 모니터: 5분마다 포지션 체크 + 텔레그램 자동 발송\n`);
}
