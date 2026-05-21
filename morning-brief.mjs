/**
 * 브리핑 — 매일 자동 텔레그램 발송 (9시 / 18시 KST)
 */

import "dotenv/config";
import crypto from "crypto";
import { mkdirSync, writeFileSync as wfs, readFileSync, existsSync } from "fs";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ─── Binance fetch helpers ────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1h", limit = 500) {
  const urls = [
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];
  for (const url of urls) {
    try {
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
  throw new Error(`${symbol} ${interval} 캔들 수신 실패`);
}

async function fetchFutures(path, params = {}) {
  const base = "https://fapi.binance.com";
  const q    = new URLSearchParams(params).toString();
  const urls = [
    `${base}${path}${q ? "?" + q : ""}`,
    `https://api.binance.us/fapi/v1${path}${q ? "?" + q : ""}`,
  ];
  for (const url of urls) {
    try {
      const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      if (data && !data.code) return data;
    } catch {}
  }
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

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const s = candles.filter(c => c.time >= midnight.getTime());
  if (!s.length) return null;
  const tpv = s.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = s.reduce((sum, c) => sum + c.volume, 0);
  return vol ? tpv / vol : null;
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function volAvg20(candles) {
  const recent = candles.slice(-21, -1);
  return recent.reduce((s, c) => s + c.volume, 0) / recent.length;
}

function findSwingLevels(candles, lookback = 100) {
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

    const btcPrice = parseFloat(btc24.lastPrice);
    const ethPrice = parseFloat(eth24.lastPrice);

    return {
      fngValue:   parseInt(fng.data[0].value),
      fngLabel:   fng.data[0].value_classification,
      dominance:  global.data.market_cap_percentage.btc.toFixed(1),
      ethBtc:     (ethPrice / btcPrice).toFixed(5),
      btcChange:  parseFloat(btc24.priceChangePercent),
      ethChange:  parseFloat(eth24.priceChangePercent),
      totalMcap:  (global.data.total_market_cap.usd / 1e12).toFixed(2),
    };
  } catch { return null; }
}

async function fetchFundingRate(symbol) {
  try {
    const data = await fetchFutures("/fapi/v1/fundingRate", { symbol, limit: 1 });
    if (!data || !data[0]) return null;
    return parseFloat(data[0].fundingRate) * 100; // %로 변환
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
    const change = prevOI ? ((curOI - prevOI) / prevOI * 100) : null;
    return { oi: curOI, change24h: change };
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
    const q    = new URLSearchParams(params).toString();
    const full = q ? `${path}?${q}` : path;
    const ts   = Date.now().toString();
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

  return [...btcPos, ...ethPos]
    .filter(p => parseFloat(p.total) > 0)
    .map(p => {
      const entry   = parseFloat(p.openPriceAvg);
      const mark    = parseFloat(p.markPrice);
      const liq     = parseFloat(p.liquidationPrice);
      const lev     = parseInt(p.leverage);
      const isShort = p.holdSide === "short";
      const pnlPct  = (isShort ? -1 : 1) * ((mark - entry) / entry * 100) * lev;
      const liqDist = isShort
        ? ((liq - mark) / mark * 100)    // 숏: 청산가 위에 있음
        : ((mark - liq) / mark * 100);   // 롱: 청산가 아래에 있음
      return {
        symbol: p.symbol, side: p.holdSide, entry, mark,
        total: parseFloat(p.total), coin: p.marginCoin,
        leverage: lev, pnl: parseFloat(p.unrealizedPL),
        pnlPct, liqPrice: liq, liqDist,
      };
    });
}

// ─── Symbol analysis ──────────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  const [candles1h, candles4h, candlesW, funding, oi] = await Promise.all([
    fetchCandles(symbol, "1h", 500),
    fetchCandles(symbol, "4h", 200),
    fetchCandles(symbol, "1w", 300),
    fetchFundingRate(symbol),
    fetchOpenInterest(symbol),
  ]);

  // 1H indicators
  const closes1h = candles1h.map(c => c.close);
  const price    = closes1h[closes1h.length - 1];
  const ema9     = calcEMA(closes1h, 9);
  const ema21    = calcEMA(closes1h, 21);
  const vwap     = calcVWAP(candles1h);
  const rsi3     = calcRSI(closes1h, 3);
  const atr      = calcATR(candles1h);
  const dist     = vwap ? Math.abs((price - vwap) / vwap * 100) : 999;

  // Volume vs 20-bar avg
  const curVol   = candles1h[candles1h.length - 1].volume;
  const avgVol   = volAvg20(candles1h);
  const volRatio = curVol / avgVol;

  // 4H trend
  const closes4h = candles4h.map(c => c.close);
  const ema9_4h  = calcEMA(closes4h, 9);
  const ema21_4h = calcEMA(closes4h, 21);
  const h4Bull   = ema9_4h > ema21_4h;
  const h4Bear   = ema9_4h < ema21_4h;

  // Weekly EMA50 slope
  const closesW     = candlesW.map(c => c.close);
  const weeklyEma50 = calcEMA(closesW, 50);
  const prevWEma50  = calcEMA(closesW.slice(0, -1), 50);
  const wSlopeUp    = weeklyEma50 > prevWEma50;

  // 1H bias
  const bullish = vwap && price > vwap && price > ema9 && price > ema21;
  const bearish = vwap && price < vwap && price < ema9 && price < ema21;
  const bias    = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";

  // Signal
  let signal, decision;
  if (!bullish && !bearish) {
    signal = "NO SIGNAL"; decision = "NO TRADE";
  } else if (bullish && rsi3 < 30 && dist < 1.5) {
    signal = "🟢 LONG READY"; decision = "TRADE";
  } else if (bearish && rsi3 > 70 && dist < 1.5) {
    signal = "🔴 SHORT READY"; decision = "TRADE";
  } else if (bullish) {
    signal = `WAITING — RSI ${rsi3.toFixed(1)} (30 이하 필요)`; decision = "NO TRADE";
  } else {
    signal = `WAITING — RSI ${rsi3.toFixed(1)} (70 이상 필요)`; decision = "NO TRADE";
  }

  // Key levels (multiple)
  const { swingHighs, swingLows } = findSwingLevels(candles1h, 200);
  const minDist     = atr * 0.5;
  const resistances = swingHighs.filter(h => h > price + minDist).sort((a,b)=>a-b).slice(0, 3);
  const supports    = swingLows.filter(l => l < price - minDist).sort((a,b)=>b-a).slice(0, 3);

  const levelsAbove = resistances.map(l => ({ price: l, touches: levelTouches(l, candles1h, atr) }));
  const levelsBelow = supports.map(l => ({ price: l, touches: levelTouches(l, candles1h, atr) }));

  // Watch
  let watch;
  if (bullish) {
    if (rsi3 > 60)       watch = `RSI 과열 — RSI 30↓ 되돌림 + EMA9 $${fmt(ema9)} 위 반등 시 롱`;
    else if (rsi3 <= 40) watch = `롱 타점 임박 — EMA9 $${fmt(ema9)} 위 유지 + 반등 캔들 확인 시`;
    else                 watch = `EMA9 $${fmt(ema9)} 지지 확인 중`;
  } else if (bearish) {
    if (rsi3 < 40)       watch = `RSI 과매도 — RSI 70↑ 반등 + EMA9 $${fmt(ema9)} 아래 이탈 시 숏`;
    else if (rsi3 >= 60) watch = `숏 타점 임박 — EMA9 $${fmt(ema9)} 아래 유지 + 하락 캔들 확인 시`;
    else                 watch = `EMA9 $${fmt(ema9)} 저항 확인 중`;
  } else {
    watch = `VWAP $${fmt(vwap)} 위 돌파 시 롱, 아래 이탈 시 숏`;
  }

  return {
    symbol, price, ema9, ema21, vwap, rsi3, atr, dist, bias, signal, decision,
    h4Bull, h4Bear, wSlopeUp, weeklyEma50,
    ema9_4h, ema21_4h,
    levelsAbove, levelsBelow,
    funding, oi,
    curVol, avgVol, volRatio,
    watch,
  };
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  return parseFloat(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sessionSummary(symbols) {
  const biases  = symbols.map(s => s.bias);
  const allBull = biases.every(b => b === "BULLISH");
  const allBear = biases.every(b => b === "BEARISH");
  const signals = symbols.filter(s => s.decision === "TRADE").map(s => s.symbol);
  const diverge = biases[0] !== biases[1];

  if (allBull && signals.length) return `🟢 강세 — ${signals.join("/")} 진입 신호`;
  if (allBull)                   return `🟢 강세 — RSI 되돌림 대기 중`;
  if (allBear && signals.length) return `🔴 약세 — ${signals.join("/")} 숏 신호`;
  if (allBear)                   return `🔴 약세 — RSI 되돌림 대기 중`;
  if (diverge)                   return `⚠️ 혼조 — BTC/ETH 방향 불일치, 관망`;
  return `⚪️ 중립 — 방향 불명확, 횡보 대기`;
}

function saveSession(data) {
  try {
    const dir  = `${process.env.HOME}/.tradingview-mcp/sessions`;
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(dir, { recursive: true });
    wfs(`${dir}/${date}.json`, JSON.stringify(data, null, 2));
  } catch {}
}

function getYesterdaySession() {
  try {
    const dir       = `${process.env.HOME}/.tradingview-mcp/sessions`;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const path      = `${dir}/${yesterday}.json`;
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

// ─── Format ───────────────────────────────────────────────────────────────────

function formatBrief(symbols, market, positions, yesterday) {
  const now   = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full", timeStyle: "short" });
  const lines = [];

  lines.push(`🤖 브리핑  |  ${now}`);
  lines.push(sessionSummary(symbols));
  lines.push(``);

  // ── 시장 개요 ──
  if (market) {
    const fngEmoji = market.fngValue >= 60 ? "😄" : market.fngValue >= 40 ? "😐" : "😨";
    let fngDelta = "";
    if (yesterday?.market?.fngValue != null) {
      const d = market.fngValue - yesterday.market.fngValue;
      fngDelta = d !== 0 ? ` (${d > 0 ? "+" : ""}${d})` : "";
    }
    const btcSign = market.btcChange >= 0 ? "+" : "";
    const ethSign = market.ethChange >= 0 ? "+" : "";
    lines.push(`📊 시장`);
    lines.push(`공포탐욕: ${fngEmoji} ${market.fngValue}${fngDelta}  |  총 시총: $${market.totalMcap}T`);
    lines.push(`BTC 도미넌스: ${market.dominance}%  |  ETH/BTC: ${market.ethBtc}`);
    lines.push(`BTC ${btcSign}${market.btcChange.toFixed(2)}%  |  ETH ${ethSign}${market.ethChange.toFixed(2)}%`);
    lines.push(``);
  }

  // ── 심볼별 분석 ──
  for (const s of symbols) {
    const biasEmoji = s.bias === "BULLISH" ? "🟢" : s.bias === "BEARISH" ? "🔴" : "⚪️";
    const yest      = yesterday?.symbols?.find(y => y.symbol === s.symbol);
    const biasDelta = yest && yest.bias !== s.bias ? ` (어제: ${yest.bias})` : "";

    lines.push(`──────────────────`);
    lines.push(`${biasEmoji} ${s.symbol}  |  ${s.bias}${biasDelta}`);
    lines.push(`가격: $${fmt(s.price)}  |  ATR: $${fmt(s.atr)}`);
    lines.push(`VWAP $${fmt(s.vwap)} ${s.price > s.vwap ? "↑" : "↓"}  EMA9 $${fmt(s.ema9)} ${s.price > s.ema9 ? "↑" : "↓"}  EMA21 $${fmt(s.ema21)} ${s.price > s.ema21 ? "↑" : "↓"}`);
    lines.push(`RSI(3): ${s.rsi3.toFixed(1)}  |  거래량: 평균 대비 ${s.volRatio >= 1 ? "+" : ""}${((s.volRatio - 1) * 100).toFixed(0)}%`);
    lines.push(``);

    // 추세 필터
    const h4Trend = s.h4Bull ? "🟢 BULL" : s.h4Bear ? "🔴 BEAR" : "⚪️ 중립";
    const wSlope  = s.wSlopeUp ? "↑ 상승" : "↓ 하락";
    lines.push(`4H 추세: ${h4Trend}  |  주봉 EMA50: $${fmt(s.weeklyEma50, 0)} ${wSlope}`);

    // 펀딩비
    if (s.funding != null) {
      const fSign   = s.funding >= 0 ? "+" : "";
      const fStatus = s.funding > 0.05 ? " — 롱 과다 (숏 유리)" : s.funding < -0.05 ? " — 숏 과다 (롱 유리)" : " — 균형";
      lines.push(`펀딩비: ${fSign}${s.funding.toFixed(4)}%${fStatus}`);
    }

    // OI
    if (s.oi?.change24h != null) {
      const oiSign = s.oi.change24h >= 0 ? "+" : "";
      lines.push(`미결제약정: ${oiSign}${s.oi.change24h.toFixed(2)}% (24h)`);
    }

    lines.push(``);

    // 저항 레벨
    if (s.levelsAbove.length) {
      lines.push(`저항`);
      for (const l of s.levelsAbove.slice(0, 2)) {
        const pct = ((l.price - s.price) / s.price * 100).toFixed(1);
        lines.push(`  $${fmt(l.price)}  ${levelStrengthEmoji(l.touches)} (${l.touches}회)  +${pct}%`);
      }
    }

    // 지지 레벨
    if (s.levelsBelow.length) {
      lines.push(`지지`);
      for (const l of s.levelsBelow.slice(0, 2)) {
        const pct = ((s.price - l.price) / s.price * 100).toFixed(1);
        lines.push(`  $${fmt(l.price)}  ${levelStrengthEmoji(l.touches)} (${l.touches}회)  -${pct}%`);
      }
    }

    lines.push(``);
    lines.push(`Signal: ${s.signal}`);
    lines.push(`Watch:  ${s.watch}`);
    lines.push(``);
  }

  // ── 포지션 ──
  lines.push(`──────────────────`);
  if (positions.length > 0) {
    lines.push(`📂 포지션`);
    for (const p of positions) {
      const sideEmoji = p.side === "long" ? "🟢 롱" : "🔴 숏";
      const pnlSign   = p.pnlPct >= 0 ? "+" : "";
      const liqWarn   = p.liqDist < 5 ? " ⚠️" : "";
      lines.push(`${p.symbol} ${sideEmoji} ${p.leverage}x`);
      lines.push(`  진입 $${fmt(p.entry)} → 현재 $${fmt(p.mark)}`);
      lines.push(`  손익: ${pnlSign}${p.pnlPct.toFixed(2)}%  |  청산까지 ${p.liqDist.toFixed(1)}%${liqWarn}`);
    }
  } else {
    lines.push(`📂 포지션 없음`);
  }

  return lines.join("\n");
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) { console.log("텔레그램 설정 없음"); return; }
  // 4096자 초과 시 분할 발송
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  saveSession({ date: new Date().toISOString().slice(0, 10), symbols, market });

  const text = formatBrief(symbols, market, positions, yesterday);
  console.log(text);
  await sendTelegram(text);
}

main().catch(console.error);
