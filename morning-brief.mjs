/**
 * 브리핑 — 매일 자동 텔레그램 발송 (9시 / 18시 KST)
 * 진입 조건: 봇과 동일 기준
 *   1. 주봉 EMA(50) 방향 + 기울기
 *   2. 4H EMA(50) 방향 일치
 *   3. 4H ADX(14) > 25
 *   4. 30분봉 2봉 브레이크아웃
 */

import "dotenv/config";
import crypto from "crypto";
import { mkdirSync, writeFileSync as wfs, readFileSync, existsSync } from "fs";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ─── Binance fetch ────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1h", limit = 500) {
  const urls = [
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
        const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map(k => ({
            time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
            low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
          }));
        }
      } catch {}
    }
  }
  throw new Error(`${symbol} ${interval} 캔들 수신 실패`);
}

async function fetchFutures(path, params = {}) {
  const q   = new URLSearchParams(params).toString();
  const url = `https://fapi.binance.com${path}${q ? "?" + q : ""}`;
  try {
    const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    if (data && !data.code) return data;
  } catch {}
  return null;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const m = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * m + ema * (1 - m);
  return ema;
}

function calcRSI(closes, period = 3) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Wilder's smoothing ADX
function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 0;
  const trs = [], pdms = [], ndms = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr  = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const pdm = Math.max(c.high - p.high, 0);
    const ndm = Math.max(p.low - c.low, 0);
    trs.push(tr);
    pdms.push(pdm > ndm ? pdm : 0);
    ndms.push(ndm > pdm ? ndm : 0);
  }
  // Initial sums
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pdi = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let ndi = ndms.slice(0, period).reduce((a, b) => a + b, 0);
  let adx = 0;
  const dxs = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pdi = pdi - pdi / period + pdms[i];
    ndi = ndi - ndi / period + ndms[i];
    const pDI = atr > 0 ? (pdi / atr) * 100 : 0;
    const nDI = atr > 0 ? (ndi / atr) * 100 : 0;
    const dx  = (pDI + nDI) > 0 ? Math.abs(pDI - nDI) / (pDI + nDI) * 100 : 0;
    dxs.push(dx);
  }
  if (dxs.length < period) return dxs[dxs.length - 1] ?? 0;
  adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]) / period;
  return adx;
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const s = candles.filter(c => c.time >= midnight.getTime());
  if (!s.length) return null;
  const tpv = s.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = s.reduce((sum, c) => sum + c.volume, 0);
  return vol ? tpv / vol : null;
}

function volAvg20(candles) {
  const recent = candles.slice(-21, -1);
  return recent.reduce((s, c) => s + c.volume, 0) / recent.length;
}

function findSwingLevels(candles, lookback = 200) {
  const recent = candles.slice(-lookback);
  const highs = [], lows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    if (c.high > recent[i-1].high && c.high > recent[i-2].high &&
        c.high > recent[i+1].high && c.high > recent[i+2].high) highs.push(c.high);
    if (c.low < recent[i-1].low && c.low < recent[i-2].low &&
        c.low < recent[i+1].low && c.low < recent[i+2].low) lows.push(c.low);
  }
  return { swingHighs: highs.sort((a,b)=>a-b), swingLows: lows.sort((a,b)=>b-a) };
}

function levelTouches(level, candles, atr) {
  const tol = atr * 0.15;
  return candles.filter(c =>
    (c.high >= level - tol && c.high <= level + tol) ||
    (c.low  >= level - tol && c.low  <= level + tol)
  ).length;
}

function levelStrengthEmoji(touches) {
  if (touches >= 10) return "🔴";
  if (touches >= 5)  return "🟠";
  if (touches >= 2)  return "🟡";
  return "⚪️";
}

// ─── Market data ──────────────────────────────────────────────────────────────

async function fetchMarket() {
  try {
    const [fngRes, globalRes, btc24Res, eth24Res] = await Promise.all([
      fetch("https://api.alternative.me/fng/?limit=1"),
      fetch("https://api.coingecko.com/api/v3/global"),
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"),
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT"),
    ]);
    const fng    = await fngRes.json();
    const global = await globalRes.json();
    const btc24  = await btc24Res.json();
    const eth24  = await eth24Res.json();
    return {
      fngValue:  parseInt(fng.data[0].value),
      fngLabel:  fng.data[0].value_classification,
      dominance: global.data.market_cap_percentage.btc.toFixed(1),
      ethBtc:    (parseFloat(eth24.lastPrice) / parseFloat(btc24.lastPrice)).toFixed(5),
      btcChange: parseFloat(btc24.priceChangePercent),
      ethChange: parseFloat(eth24.priceChangePercent),
      totalMcap: (global.data.total_market_cap.usd / 1e12).toFixed(2),
    };
  } catch { return null; }
}

async function fetchFundingRate(symbol) {
  try {
    const data = await fetchFutures("/fapi/v1/fundingRate", { symbol, limit: 1 });
    if (!data || !data[0]) return null;
    return parseFloat(data[0].fundingRate) * 100;
  } catch { return null; }
}

async function fetchOpenInterest(symbol) {
  try {
    const [cur, hist] = await Promise.all([
      fetchFutures("/fapi/v1/openInterest", { symbol }),
      fetchFutures("/futures/data/openInterestHist", { symbol, period: "1h", limit: 25 }),
    ]);
    if (!cur) return null;
    const curOI  = parseFloat(cur.openInterest);
    const prevOI = hist && hist[0] ? parseFloat(hist[0].sumOpenInterest) : null;
    return { change24h: prevOI ? ((curOI - prevOI) / prevOI * 100) : null };
  } catch { return null; }
}

// ─── BitGet positions ─────────────────────────────────────────────────────────

async function fetchPositions() {
  const apiKey     = process.env.BITGET_API_KEY;
  const secretKey  = process.env.BITGET_SECRET_KEY;
  const passphrase = process.env.BITGET_PASSPHRASE;
  const base       = process.env.BITGET_BASE_URL || "https://api.bitget.com";
  if (!apiKey) return [];
  function sign(ts, method, path) {
    return crypto.createHmac("sha256", secretKey).update(ts + method + path).digest("base64");
  }
  async function get(path, params = {}) {
    const q = new URLSearchParams(params).toString();
    const full = q ? `${path}?${q}` : path;
    const ts = Date.now().toString();
    try {
      const res = await fetch(`${base}${full}`, {
        headers: { "ACCESS-KEY": apiKey, "ACCESS-SIGN": sign(ts,"GET",full),
                   "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": passphrase, "Content-Type":"application/json" }
      });
      const d = await res.json();
      return d.code === "00000" ? (d.data ?? []) : [];
    } catch { return []; }
  }
  const [btcPos, ethPos] = await Promise.all([
    get("/api/v2/mix/position/all-position", { productType: "COIN-FUTURES", marginCoin: "BTC" }),
    get("/api/v2/mix/position/all-position", { productType: "COIN-FUTURES", marginCoin: "ETH" }),
  ]);
  return [...btcPos, ...ethPos].filter(p => parseFloat(p.total) > 0).map(p => {
    const entry   = parseFloat(p.openPriceAvg);
    const mark    = parseFloat(p.markPrice);
    const liq     = parseFloat(p.liquidationPrice);
    const lev     = parseInt(p.leverage);
    const isShort = p.holdSide === "short";
    const pnlPct  = (isShort ? -1 : 1) * ((mark - entry) / entry * 100) * lev;
    const liqDist = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
    return { symbol: p.symbol, side: p.holdSide, entry, mark, coin: p.marginCoin,
             leverage: lev, pnl: parseFloat(p.unrealizedPL), pnlPct, liqPrice: liq, liqDist };
  });
}

// ─── Symbol analysis ──────────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  const [candles1h, candles4h, candles30m, candlesW, funding, oi] = await Promise.all([
    fetchCandles(symbol, "1h", 500),
    fetchCandles(symbol, "4h", 300),
    fetchCandles(symbol, "30m", 10),
    fetchCandles(symbol, "1w", 300),
    fetchFundingRate(symbol),
    fetchOpenInterest(symbol),
  ]);

  // 1H
  const closes1h = candles1h.map(c => c.close);
  const price    = closes1h[closes1h.length - 1];
  const atr      = calcATR(candles1h);
  const rsi3     = calcRSI(closes1h, 3);
  const vwap     = calcVWAP(candles1h);
  const curVol   = candles1h[candles1h.length - 1].volume;
  const avgVol   = volAvg20(candles1h);

  // 주봉 EMA50 + 기울기
  const closesW     = candlesW.map(c => c.close);
  const weeklyEma50 = calcEMA(closesW, 50);
  const prevWEma50  = calcEMA(closesW.slice(0, -1), 50);
  const wSlopeUp    = weeklyEma50 > prevWEma50;
  const wAbove      = price > weeklyEma50;  // 롱 바이어스
  const wBelow      = price < weeklyEma50;  // 숏 바이어스

  // 4H EMA50 + ADX
  const closes4h  = candles4h.map(c => c.close);
  const ema50_4h  = calcEMA(closes4h, 50);
  const h4Above   = price > ema50_4h;
  const h4Below   = price < ema50_4h;
  const adx4h     = calcADX(candles4h);

  // 방향 결정 (봇과 동일)
  let direction = null;
  if (wBelow && !wSlopeUp && h4Below) direction = "short";
  if (wAbove &&  wSlopeUp && h4Above) direction = "long";

  // 30분봉 브레이크아웃 레벨
  const bars30m      = candles30m.slice(-3, -1);  // 직전 2봉 (현재봉 제외)
  const breakoutHigh = Math.max(...bars30m.map(c => c.high));  // 롱: 돌파 필요
  const breakoutLow  = Math.min(...bars30m.map(c => c.low));   // 숏: 하향 돌파 필요
  const breakoutHit  = direction === "long"  ? price > breakoutHigh
                     : direction === "short" ? price < breakoutLow
                     : false;

  // 필터 체크 (봇과 동일)
  const checks = {
    wSlope:    direction === "long" ? (wAbove && wSlopeUp) : (wBelow && !wSlopeUp),
    h4Align:   direction === "long" ? h4Above : h4Below,
    adxStrong: adx4h > 25,
    breakout:  breakoutHit,
  };
  const allPass = direction !== null && Object.values(checks).every(Boolean);

  // 진입 신호
  let signal;
  if (!direction)         signal = "NO SIGNAL — 방향 불명확";
  else if (allPass)       signal = direction === "long" ? "🟢 LONG READY" : "🔴 SHORT READY";
  else                    signal = direction === "long" ? "대기 중 (롱)" : "대기 중 (숏)";

  // 지지/저항
  const { swingHighs, swingLows } = findSwingLevels(candles1h);
  const minDist    = atr * 0.5;
  const levelsAbove = swingHighs.filter(h => h > price + minDist).sort((a,b)=>a-b).slice(0, 2)
                       .map(l => ({ price: l, touches: levelTouches(l, candles1h, atr) }));
  const levelsBelow = swingLows.filter(l => l < price - minDist).sort((a,b)=>b-a).slice(0, 2)
                       .map(l => ({ price: l, touches: levelTouches(l, candles1h, atr) }));

  return {
    symbol, price, atr, rsi3, vwap, curVol, avgVol,
    weeklyEma50, prevWEma50, wSlopeUp, wAbove, wBelow,
    ema50_4h, h4Above, h4Below, adx4h,
    breakoutLow, breakoutHigh, breakoutHit,
    direction, checks, allPass, signal,
    levelsAbove, levelsBelow,
    funding, oi,
  };
}

// ─── Format ───────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  return parseFloat(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sessionSummary(symbols) {
  const ready   = symbols.filter(s => s.allPass);
  const shorts  = symbols.filter(s => s.direction === "short");
  const longs   = symbols.filter(s => s.direction === "long");
  const allBear = shorts.length === symbols.length;
  const allBull = longs.length  === symbols.length;

  if (ready.length)  return `${ready[0].direction === "short" ? "🔴" : "🟢"} ${ready.map(s=>s.symbol).join("/")} 진입 신호 — 조건 충족`;
  if (allBear)       return `🔴 약세 — 브레이크아웃 대기 중`;
  if (allBull)       return `🟢 강세 — 브레이크아웃 대기 중`;
  if (shorts.length) return `⚠️ 혼조 — 방향 불일치, 관망`;
  return `⚪️ 중립 — 방향 불명확`;
}

function saveSession(data) {
  try {
    const dir  = `${process.env.HOME}/.tradingview-mcp/sessions`;
    mkdirSync(dir, { recursive: true });
    wfs(`${dir}/${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2));
  } catch {}
}

function getYesterdaySession() {
  try {
    const dir  = `${process.env.HOME}/.tradingview-mcp/sessions`;
    const path = `${dir}/${new Date(Date.now()-86400000).toISOString().slice(0,10)}.json`;
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch { return null; }
}

function formatBrief(symbols, market, positions, yesterday) {
  const now   = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full", timeStyle: "short" });
  const lines = [];

  lines.push(`🤖 브리핑  |  ${now}`);
  lines.push(sessionSummary(symbols));
  lines.push(``);

  // 시장 개요
  if (market) {
    const fngEmoji = market.fngValue >= 60 ? "😄" : market.fngValue >= 40 ? "😐" : "😨";
    let fngDelta = "";
    if (yesterday?.market?.fngValue != null) {
      const d = market.fngValue - yesterday.market.fngValue;
      fngDelta = d !== 0 ? ` (${d > 0 ? "+" : ""}${d})` : "";
    }
    lines.push(`📊 시장`);
    lines.push(`공포탐욕: ${fngEmoji} ${market.fngValue}${fngDelta}  |  총 시총: $${market.totalMcap}T`);
    lines.push(`BTC 도미넌스: ${market.dominance}%  |  ETH/BTC: ${market.ethBtc}`);
    lines.push(`BTC ${market.btcChange >= 0 ? "+" : ""}${market.btcChange.toFixed(2)}%  |  ETH ${market.ethChange >= 0 ? "+" : ""}${market.ethChange.toFixed(2)}%`);
    lines.push(``);
  }

  // 심볼별
  for (const s of symbols) {
    const dirEmoji = s.direction === "long" ? "🟢" : s.direction === "short" ? "🔴" : "⚪️";
    const yest     = yesterday?.symbols?.find(y => y.symbol === s.symbol);
    const dirDelta = yest && yest.direction !== s.direction ? ` (어제: ${yest.direction ?? "중립"})` : "";

    lines.push(`──────────────────`);
    lines.push(`${dirEmoji} ${s.symbol}  |  ${s.direction ? s.direction.toUpperCase() : "NEUTRAL"}${dirDelta}`);
    lines.push(`가격: $${fmt(s.price)}  |  RSI(3): ${s.rsi3.toFixed(1)}  |  ATR: $${fmt(s.atr)}`);
    lines.push(`거래량: 평균 대비 ${s.curVol >= s.avgVol ? "+" : ""}${((s.curVol/s.avgVol - 1)*100).toFixed(0)}%`);
    lines.push(``);

    // 필터 체크 (봇과 동일 기준)
    const wDir   = s.direction === "short" ? "아래" : "위";
    const wSlope = s.wSlopeUp ? "↑ 상승" : "↓ 하락";
    lines.push(`필터 체크`);
    lines.push(`${s.checks.wSlope ? "✅" : "🚫"} 주봉 EMA50 $${fmt(s.weeklyEma50, 0)} ${wDir}  ${wSlope}`);
    lines.push(`${s.checks.h4Align ? "✅" : "🚫"} 4H EMA50 $${fmt(s.ema50_4h, 0)} ${wDir}`);
    lines.push(`${s.checks.adxStrong ? "✅" : "🚫"} 4H ADX ${s.adx4h.toFixed(1)} ${s.checks.adxStrong ? "(추세 강함)" : "(추세 약함 — 진입 불가)"}`);

    if (s.direction === "short") {
      lines.push(`${s.checks.breakout ? "✅" : "🚫"} 30m 브레이크아웃 — $${fmt(s.breakoutLow)} ${s.checks.breakout ? "하향 돌파 ✓" : `하향 돌파 필요 (현재 +$${fmt(s.price - s.breakoutLow)})`}`);
    } else if (s.direction === "long") {
      lines.push(`${s.checks.breakout ? "✅" : "🚫"} 30m 브레이크아웃 — $${fmt(s.breakoutHigh)} ${s.checks.breakout ? "상향 돌파 ✓" : `상향 돌파 필요 (현재 -$${fmt(s.breakoutHigh - s.price)})`}`);
    } else {
      lines.push(`⚪️ 30m 브레이크아웃 — 방향 미결`);
    }

    lines.push(``);
    lines.push(`Signal: ${s.signal}`);

    // 펀딩비 / OI
    const extras = [];
    if (s.funding != null) {
      const fStatus = s.funding > 0.05 ? "롱 과다" : s.funding < -0.05 ? "숏 과다" : "균형";
      extras.push(`펀딩비 ${s.funding >= 0 ? "+" : ""}${s.funding.toFixed(4)}% (${fStatus})`);
    }
    if (s.oi?.change24h != null) extras.push(`OI ${s.oi.change24h >= 0 ? "+" : ""}${s.oi.change24h.toFixed(1)}%`);
    if (extras.length) lines.push(extras.join("  |  "));

    lines.push(``);

    // 지지/저항
    if (s.levelsAbove.length) {
      lines.push(`저항  ${s.levelsAbove.map(l => `$${fmt(l.price)} ${levelStrengthEmoji(l.touches)}(${l.touches}) +${((l.price-s.price)/s.price*100).toFixed(1)}%`).join("  ")}`);
    }
    if (s.levelsBelow.length) {
      lines.push(`지지  ${s.levelsBelow.map(l => `$${fmt(l.price)} ${levelStrengthEmoji(l.touches)}(${l.touches}) -${((s.price-l.price)/s.price*100).toFixed(1)}%`).join("  ")}`);
    }
    lines.push(``);
  }

  // 포지션
  lines.push(`──────────────────`);
  if (positions.length > 0) {
    lines.push(`📂 포지션`);
    for (const p of positions) {
      const sideEmoji = p.side === "long" ? "🟢 롱" : "🔴 숏";
      const pnlSign   = p.pnlPct >= 0 ? "+" : "";
      const liqWarn   = p.liqDist < 5 ? " ⚠️위험" : p.liqDist < 10 ? " ⚠️주의" : "";
      lines.push(`${p.symbol} ${sideEmoji} ${p.leverage}x  |  진입 $${fmt(p.entry)} → $${fmt(p.mark)}`);
      lines.push(`  손익: ${pnlSign}${p.pnlPct.toFixed(1)}%  |  청산까지 ${p.liqDist.toFixed(1)}%${liqWarn}`);
    }
  } else {
    lines.push(`📂 포지션 없음`);
  }

  return lines.join("\n");
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) { console.log("텔레그램 설정 없음"); return; }
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: chunk }),
    });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [btc, eth, market, positions] = await Promise.all([
    analyzeSymbol("BTCUSDT"),
    analyzeSymbol("ETHUSDT"),
    fetchMarket(),
    fetchPositions(),
  ]);
  const symbols   = [btc, eth];
  const yesterday = getYesterdaySession();
  saveSession({ date: new Date().toISOString().slice(0,10), symbols, market });
  const text = formatBrief(symbols, market, positions, yesterday);
  console.log(text);
  await sendTelegram(text);
}

main().catch(async (err) => {
  console.error(err);
  // 실패해도 텔레그램으로 알림
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", timeStyle: "short" });
  await sendTelegram(`⚠️ 브리핑 실패  |  ${now}\n오류: ${err.message}\n\n잠시 후 수동으로 확인하세요.`).catch(() => {});
});
