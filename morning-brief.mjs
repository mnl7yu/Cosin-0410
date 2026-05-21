/**
 * 아침 브리핑 — 매일 자동 텔레그램 발송
 * 크론: 매일 오전 8시 KST (23:00 UTC)
 */

import "dotenv/config";
import crypto from "crypto";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ─── Binance ─────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, limit = 500) {
  // Binance US endpoint (GitHub Actions IP 차단 우회)
  const urls = [
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      if (Array.isArray(data)) {
        return data.map(k => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
        }));
      }
    } catch {}
  }
  throw new Error(`${symbol} 캔들 데이터 수신 실패 (Binance IP 차단)`);
}

function calcEMA(closes, period) {
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
  const vol = s.reduce((sum, c) => sum + c.volume, 0);
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

function findSwingLevels(candles, lookback = 50) {
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

// 키 레벨 강도 분석
function analyzeKeyLevel(level, candles, poc, vwap, atr) {
  const tolerance = atr * 0.15; // 레벨 근처로 인정하는 범위
  let touches = 0;
  let volumeAtLevel = 0;
  let recentTouch = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const nearLevel = (c.high >= level - tolerance && c.high <= level + tolerance) ||
                      (c.low  >= level - tolerance && c.low  <= level + tolerance);
    if (nearLevel) {
      touches++;
      volumeAtLevel += c.volume;
      if (i >= candles.length - 10) recentTouch = true;
    }
  }

  const isPOC   = Math.abs(level - poc)  < tolerance;
  const isVWAP  = Math.abs(level - vwap) < tolerance;

  // 강도 판단
  let strength, holdProb, breakProb, reasons = [];

  if (isPOC)        reasons.push("POC (최다 거래량 가격대)");
  if (isVWAP)       reasons.push("VWAP 근접");
  if (touches >= 3) reasons.push(`${touches}회 터치된 검증된 레벨`);
  else if (touches === 2) reasons.push("2회 터치 — 신뢰도 보통");
  else              reasons.push("최근 형성된 신규 레벨");
  if (recentTouch)  reasons.push("최근 10봉 내 반응 확인");
  if (volumeAtLevel > 0) reasons.push(`해당 구간 거래량 집중`);

  const score = (isPOC ? 3 : 0) + (isVWAP ? 2 : 0) + Math.min(touches, 3) + (recentTouch ? 1 : 0);

  if (score >= 6)      { strength = "🔴 매우 강함"; holdProb = "80~90%"; breakProb = "10~20%"; }
  else if (score >= 4) { strength = "🟠 강함";      holdProb = "65~80%"; breakProb = "20~35%"; }
  else if (score >= 2) { strength = "🟡 보통";       holdProb = "50~65%"; breakProb = "35~50%"; }
  else                 { strength = "⚪️ 약함";       holdProb = "40% 이하"; breakProb = "60% 이상"; }

  return { strength, holdProb, breakProb, touches, reasons };
}

// ─── Market (Fear & Greed + BTC dominance) ───────────────────────────────────

async function fetchMarket() {
  try {
    const [fngRes, globalRes, ticker24Res] = await Promise.all([
      fetch("https://api.alternative.me/fng/?limit=1"),
      fetch("https://api.coingecko.com/api/v3/global"),
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"),
    ]);
    const fng      = await fngRes.json();
    const global   = await globalRes.json();
    const ticker24 = await ticker24Res.json();

    return {
      fngValue:   parseInt(fng.data[0].value),
      fngLabel:   fng.data[0].value_classification,
      dominance:  global.data.market_cap_percentage.btc.toFixed(1),
      change24h:  parseFloat(ticker24.priceChangePercent),
    };
  } catch { return null; }
}

// ─── BitGet positions ─────────────────────────────────────────────────────────

async function fetchPositions() {
  const apiKey    = process.env.BITGET_API_KEY;
  const secretKey = process.env.BITGET_SECRET_KEY;
  const passphrase= process.env.BITGET_PASSPHRASE;
  const base      = process.env.BITGET_BASE_URL || "https://api.bitget.com";
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

  return [...btcPos, ...ethPos]
    .filter(p => parseFloat(p.total) > 0)
    .map(p => ({
      symbol:    p.symbol,
      side:      p.holdSide,
      entry:     parseFloat(p.openPriceAvg),
      mark:      parseFloat(p.markPrice),
      total:     parseFloat(p.total),
      coin:      p.marginCoin,
      leverage:  parseInt(p.leverage),
      pnl:       parseFloat(p.unrealizedPL),
      pnlPct:    ((parseFloat(p.markPrice) - parseFloat(p.openPriceAvg)) / parseFloat(p.openPriceAvg) * 100
                  * (p.holdSide === "short" ? -1 : 1) * parseInt(p.leverage)),
      liqPrice:  parseFloat(p.liquidationPrice),
    }));
}

// ─── Analysis per symbol ──────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  const candles = await fetchCandles(symbol);
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length - 1];
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  const vwap    = calcVWAP(candles);
  const rsi3    = calcRSI(closes, 3);
  const atr     = calcATR(candles);
  const dist    = vwap ? Math.abs((price - vwap) / vwap * 100) : 999;

  const bullish = vwap && price > vwap && price > ema9 && price > ema21;
  const bearish = vwap && price < vwap && price < ema9 && price < ema21;
  const bias    = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";

  // Signal
  let signal, decision;
  if (!bullish && !bearish) {
    signal = "NO SIGNAL"; decision = "NO TRADE";
  } else if (bullish && rsi3 < 30 && dist < 1.5) {
    signal = "LONG READY 🟢"; decision = "TRADE";
  } else if (bearish && rsi3 > 70 && dist < 1.5) {
    signal = "SHORT READY 🔴"; decision = "TRADE";
  } else if (bullish && rsi3 <= 40) {
    signal = `WAITING — RSI ${rsi3.toFixed(1)}, 30 이하 필요`; decision = "NO TRADE";
  } else if (bearish && rsi3 >= 60) {
    signal = `WAITING — RSI ${rsi3.toFixed(1)}, 70 이상 필요`; decision = "NO TRADE";
  } else {
    signal = `WAITING — RSI ${rsi3.toFixed(1)}`; decision = "NO TRADE";
  }

  // Volume profile POC
  function _vp(cds, bins = 60) {
    const hi = Math.max(...cds.map(c=>c.high)), lo = Math.min(...cds.map(c=>c.low));
    const bin = (hi - lo) / bins;
    const p = new Array(bins).fill(0);
    for (const c of cds) {
      const a = Math.floor((c.low-lo)/bin), b = Math.min(Math.floor((c.high-lo)/bin), bins-1);
      for (let i=a; i<=b; i++) p[i] += c.volume / Math.max(b-a+1,1);
    }
    const idx = p.indexOf(Math.max(...p));
    return lo + idx * bin + bin/2;
  }
  const poc = _vp(candles.slice(-100));

  // Key levels (nearest swing above + below)
  const { swingHighs, swingLows } = findSwingLevels(candles);
  const minDist = atr * 0.5;
  const nearestResistance = swingHighs.filter(h => h > price + minDist).sort((a,b)=>a-b)[0];
  const nearestSupport    = swingLows.filter(l => l < price - minDist).sort((a,b)=>b-a)[0];

  // KEY LEVEL = 진입 방향의 장애물 (숏: 위 저항이 막아줘야 유효 / 롱: 위 저항을 넘어야 함)
  // 즉 "이 레벨이 어떻게 행동하느냐"가 포지션 성패를 가름
  const keyLevel = bullish
    ? (nearestResistance ?? price * 1.03)   // 롱: 위 저항 돌파 여부
    : (nearestResistance ?? price * 1.015); // 숏: 위 저항이 막아주는지 여부 (SL 기준선)

  // KEY LEVEL 강도 분석
  const keyLevelAnalysis = analyzeKeyLevel(keyLevel, candles, poc, vwap, atr);

  // TP 구간 장애물 — TP 도달 가능성 판단
  // 숏이면 아래 지지가 얼마나 강한지, 롱이면 위 저항이 얼마나 강한지
  const tpObstacle = bearish ? nearestSupport : nearestResistance;
  const tpObstacleAnalysis = tpObstacle ? analyzeKeyLevel(tpObstacle, candles, poc, vwap, atr) : null;
  let tpWarning = null;
  if (tpObstacleAnalysis && tpObstacleAnalysis.touches >= 3) {
    const dir = bearish ? `지지($${fmt(nearestSupport)})` : `저항($${fmt(nearestResistance)})`;
    const prob = tpObstacleAnalysis.holdProb;
    tpWarning = `⚠️ TP 앞 ${dir} 강함 (${tpObstacleAnalysis.touches}회 터치, 유지 ${prob}) — 돌파 못하면 TP 미달 가능`;
  }

  // Watch condition with explicit LONG/SHORT direction
  let watch;
  if (bullish) {
    if (rsi3 > 60)       watch = `RSI(3) ${rsi3.toFixed(1)} 과열 — 🟢 롱 타점: RSI 30 이하 되돌림 후 EMA(9) $${fmt(ema9)} 위 반등 시`;
    else if (rsi3 <= 40) watch = `🟢 롱 진입 임박 — RSI(3) ${rsi3.toFixed(1)}, EMA(9) $${fmt(ema9)} 위 유지 + 반등 캔들 확인 시 진입`;
    else                 watch = `🟢 롱 대기 — EMA(9) $${fmt(ema9)} 지지 확인 중. 이탈 시 추세 약화로 관망 전환`;
  } else if (bearish) {
    if (rsi3 < 40)       watch = `RSI(3) ${rsi3.toFixed(1)} 과매도 — 🔴 숏 타점: RSI 70 이상 되돌림 후 EMA(9) $${fmt(ema9)} 아래 이탈 시`;
    else if (rsi3 >= 60) watch = `🔴 숏 진입 임박 — RSI(3) ${rsi3.toFixed(1)}, EMA(9) $${fmt(ema9)} 아래 유지 + 하락 캔들 확인 시 진입`;
    else                 watch = `🔴 숏 대기 — EMA(9) $${fmt(ema9)} 저항 확인 중. 돌파 시 추세 전환으로 관망 전환`;
  } else {
    watch = `⚪️ 방향 미결 — VWAP $${fmt(vwap)} 기준으로 위 돌파 시 🟢 롱, 아래 이탈 시 🔴 숏 고려`;
  }

  // Smart TP/SL
  let tp1 = null, tp2 = null, sl = null, rr = null;
  if (decision === "TRADE") {
    if (bullish) {
      const tpCands = swingHighs.filter(h => h > price + minDist).sort((a,b)=>a-b);
      tp1 = tpCands[0] ?? price * 1.03;
      tp2 = tpCands.find(c => c > tp1 + minDist) ?? price * 1.06;
      sl  = (swingLows.filter(l => l < price - minDist)[0]) ?? price - atr * 1.5;
    } else {
      const tpCands = swingLows.filter(l => l < price - minDist).sort((a,b)=>b-a);
      tp1 = tpCands[0] ?? price * 0.97;
      tp2 = tpCands.find(c => c < tp1 - minDist) ?? price * 0.94;
      sl  = (swingHighs.filter(h => h > price + minDist)[0]) ?? price + atr * 1.5;
    }
    const tp1Pct = Math.abs((tp1 - price) / price * 100);
    const slPct  = Math.abs((sl  - price) / price * 100);
    rr = slPct > 0 ? (tp1Pct / slPct).toFixed(2) : "-";
  }

  return { symbol, price, ema9, ema21, vwap, rsi3, atr, bias, signal, decision, dist,
           keyLevel, keyLevelAnalysis, nearestResistance, nearestSupport, tpWarning, watch, tp1, tp2, sl, rr };
}

// ─── Format ───────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  return parseFloat(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sessionSummary(symbols) {
  const biases = symbols.map(s => s.bias);
  const allBull = biases.every(b => b === "BULLISH");
  const allBear = biases.every(b => b === "BEARISH");
  const signals = symbols.filter(s => s.decision === "TRADE").map(s => s.symbol);
  const diverge = biases[0] !== biases[1];

  if (allBull && signals.length) return `🟢 강세 세션 — ${signals.join("/")} 진입 신호. 추세 추종 유리.`;
  if (allBull)                   return `🟢 강세 세션 — 방향은 위. RSI 되돌림 기다리는 중. 롱 준비.`;
  if (allBear && signals.length) return `🔴 약세 세션 — ${signals.join("/")} 숏 신호. 반등 매도 전략.`;
  if (allBear)                   return `🔴 약세 세션 — 방향은 아래. RSI 되돌림 기다리는 중. 숏 준비.`;
  if (diverge)                   return `⚠️ 혼조 세션 — BTC/ETH 방향 불일치. 관망 우선.`;
  return `⚪️ 중립 세션 — 방향 불명확. 횡보 구간, 매매 없이 대기.`;
}

import { mkdirSync, writeFileSync as wfs, readFileSync, existsSync } from "fs";
function saveSession(data) {
  try {
    const dir  = `${process.env.HOME}/.tradingview-mcp/sessions`;
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(dir, { recursive: true });
    wfs(`${dir}/${date}.json`, JSON.stringify(data, null, 2));
    console.log(`세션 저장됨 → ${dir}/${date}.json`);
  } catch (e) { console.log("세션 저장 실패:", e.message); }
}

function getYesterdaySession() {
  try {
    const dir  = `${process.env.HOME}/.tradingview-mcp/sessions`;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const path = `${dir}/${yesterday}.json`;
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function formatBrief(symbols, market, positions, yesterday) {
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full", timeStyle: "short" });
  const lines = [];

  lines.push(`🤖 아침 브리핑`);
  lines.push(`📅 ${now}`);
  lines.push(``);

  // Session summary (top line)
  lines.push(sessionSummary(symbols));
  lines.push(``);

  // Market overview
  if (market) {
    const fngEmoji = market.fngValue >= 60 ? "😄" : market.fngValue >= 40 ? "😐" : "😨";
    const chSign   = market.change24h >= 0 ? "+" : "";
    // Compare with yesterday's FnG if available
    let fngDelta = "";
    if (yesterday?.market?.fngValue) {
      const diff = market.fngValue - yesterday.market.fngValue;
      fngDelta = diff !== 0 ? ` (${diff > 0 ? "+" : ""}${diff} 어제 대비)` : " (어제와 동일)";
    }
    lines.push(`📊 시장 개요`);
    lines.push(`공포탐욕: ${fngEmoji} ${market.fngValue}${fngDelta} — ${market.fngLabel}`);
    lines.push(`BTC 도미넌스: ${market.dominance}%`);
    lines.push(`BTC 24h: ${chSign}${market.change24h.toFixed(2)}%`);
    lines.push(``);
  }

  // Per symbol
  for (const s of symbols) {
    const biasEmoji = s.bias === "BULLISH" ? "🟢" : s.bias === "BEARISH" ? "🔴" : "⚪️";
    // Yesterday's bias comparison
    const yest = yesterday?.symbols?.find(y => y.symbol === s.symbol);
    const biasDelta = yest && yest.bias !== s.bias ? ` (어제: ${yest.bias})` : "";

    lines.push(`──────────────────`);
    lines.push(`${biasEmoji} ${s.symbol}  |  BIAS: ${s.bias}${biasDelta}`);
    lines.push(`가격:     $${fmt(s.price)}`);
    lines.push(`VWAP:    $${fmt(s.vwap)}  (${s.price > s.vwap ? "↑ ABOVE" : "↓ BELOW"})`);
    lines.push(`EMA(9):  $${fmt(s.ema9)}  (${s.price > s.ema9 ? "↑ ABOVE" : "↓ BELOW"})`);
    lines.push(`EMA(21): $${fmt(s.ema21)}  (${s.price > s.ema21 ? "↑ ABOVE" : "↓ BELOW"})`);
    lines.push(`RSI(3):  ${s.rsi3.toFixed(1)}  |  ATR: ${fmt(s.atr)}`);
    lines.push(``);
    const kl = s.keyLevelAnalysis;
    const klLabel = s.bias === "BEARISH"
      ? `KEY LEVEL (위 저항 — 숏 유효하려면 이 레벨이 막아줘야 함)`
      : s.bias === "BULLISH"
      ? `KEY LEVEL (위 저항 — 롱 진행하려면 이 레벨 돌파 필요)`
      : `KEY LEVEL`;
    lines.push(`${klLabel}`);
    lines.push(`  $${fmt(s.keyLevel)}  ${kl.strength}`);
    lines.push(`  막을 확률: ${kl.holdProb}  |  뚫릴 확률: ${kl.breakProb}`);
    lines.push(`  근거: ${kl.reasons.join(" · ")}`);
    if (s.nearestSupport)    lines.push(`아래 지지:  $${fmt(s.nearestSupport)}`);
    if (s.tpWarning)         lines.push(s.tpWarning);
    lines.push(`WATCH:     ${s.watch}`);
    lines.push(``);
    lines.push(`Signal: ${s.signal}`);
    lines.push(`Filter: ${s.dist < 1.5 ? `✅ PASS (${s.dist.toFixed(2)}% from VWAP)` : `🚫 BLOCKED (${s.dist.toFixed(2)}%)`}`);
    lines.push(`결정:   ${s.decision}`);

    if (s.tp1) {
      const isLong = s.bias === "BULLISH";
      lines.push(``);
      lines.push(`🎯 차트 기반 타겟`);
      lines.push(`TP1: $${fmt(s.tp1)}  (${isLong ? "+" : "-"}${Math.abs((s.tp1-s.price)/s.price*100).toFixed(2)}%)`);
      lines.push(`TP2: $${fmt(s.tp2)}  (${isLong ? "+" : "-"}${Math.abs((s.tp2-s.price)/s.price*100).toFixed(2)}%)`);
      lines.push(`SL:  $${fmt(s.sl)}   (${isLong ? "-" : "+"}${Math.abs((s.sl-s.price)/s.price*100).toFixed(2)}%)`);
      lines.push(`R:R: ${s.rr}`);
    }
    lines.push(``);
  }

  // Positions
  if (positions.length > 0) {
    lines.push(`──────────────────`);
    lines.push(`📂 오픈 포지션`);
    for (const p of positions) {
      const pnlSign = p.pnlPct >= 0 ? "+" : "";
      const sideEmoji = p.side === "long" ? "🟢 롱" : "🔴 숏";
      lines.push(`${p.symbol} ${sideEmoji} ${p.leverage}x`);
      lines.push(`  진입 $${fmt(p.entry)} → 현재 $${fmt(p.mark)}`);
      lines.push(`  손익: ${pnlSign}${p.pnlPct.toFixed(2)}% | ${pnlSign}${p.pnl.toFixed(4)} ${p.coin}`);
      lines.push(`  청산가: $${fmt(p.liqPrice)}`);
    }
  } else {
    lines.push(`──────────────────`);
    lines.push(`📂 오픈 포지션 없음`);
  }

  return lines.join("\n");
}

// ─── Send Telegram ────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) { console.log("텔레그램 설정 없음"); return; }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text }),
  });
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

  // Save today's session
  saveSession({ date: new Date().toISOString().slice(0, 10), symbols, market });

  const text = formatBrief(symbols, market, positions, yesterday);
  console.log(text);
  await sendTelegram(text);
}

main().catch(console.error);
