/**
 * 특이사항 알림 모니터
 * - 거래량 폭등: 현재봉 > 20봉 평균 × 2
 * - 가격 급변: 직전 1H 대비 ±1.5% 이상
 * - 중복 방지: 같은 캔들에서 한 번만 발송 (캔들 오픈 시간 기준)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const SYMBOLS        = ["BTCUSDT", "ETHUSDT"];
const STATE_FILE     = "/tmp/alert-state.json";

const VOL_MULT       = 2.0;   // 거래량 폭등 기준 (평균 대비 배수)
const PRICE_THRESH   = 1.5;   // 가격 급변 기준 (%)

// ─── Binance ──────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, limit = 25) {
  const urls = [
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`,
  ];
  for (const url of urls) {
    try {
      const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      if (Array.isArray(data)) {
        return data.map(k => ({
          openTime: k[0],
          open: parseFloat(k[1]), high: parseFloat(k[2]),
          low:  parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));
      }
    } catch {}
  }
  return null;
}

// ─── 중복 방지 상태 ───────────────────────────────────────────────────────────

function loadState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}; }
  catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

function alreadySent(state, key) {
  return !!state[key];
}

function markSent(state, key) {
  // 24시간 이상 된 항목 청소
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(state)) {
    if (state[k] < cutoff) delete state[k];
  }
  state[key] = Date.now();
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text }),
  });
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  return parseFloat(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

async function checkSymbol(symbol, state) {
  const candles = await fetchCandles(symbol, 25);
  if (!candles || candles.length < 3) return;

  const cur  = candles[candles.length - 1];  // 현재 (미완성) 봉
  const prev = candles[candles.length - 2];  // 직전 완성봉
  const past = candles.slice(-21, -1);        // 20봉 평균용

  const avgVol   = past.reduce((s, c) => s + c.volume, 0) / past.length;
  const priceChg = ((cur.close - prev.close) / prev.close) * 100;
  const volMult  = cur.volume / avgVol;

  const alerts = [];

  // 거래량 폭등
  const volKey = `vol-${symbol}-${cur.openTime}`;
  if (volMult >= VOL_MULT && !alreadySent(state, volKey)) {
    alerts.push(`📊 거래량 폭등\n${symbol}: 현재 ${volMult.toFixed(1)}x 평균 (평균 대비 +${((volMult-1)*100).toFixed(0)}%)\n거래량: ${fmt(cur.volume, 0)} | 평균: ${fmt(avgVol, 0)}`);
    markSent(state, volKey);
  }

  // 가격 급변
  const priceKey = `price-${symbol}-${cur.openTime}-${priceChg > 0 ? "up" : "dn"}`;
  if (Math.abs(priceChg) >= PRICE_THRESH && !alreadySent(state, priceKey)) {
    const emoji = priceChg > 0 ? "🟢📈" : "🔴📉";
    alerts.push(`${emoji} 가격 급변\n${symbol}: ${priceChg > 0 ? "+" : ""}${priceChg.toFixed(2)}% (1H)\n직전봉 $${fmt(prev.close)} → 현재 $${fmt(cur.close)}`);
    markSent(state, priceKey);
  }

  return alerts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const state   = loadState();
  const results = await Promise.all(SYMBOLS.map(s => checkSymbol(s, state)));

  const allAlerts = results.flat().filter(Boolean);

  if (allAlerts.length > 0) {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", timeStyle: "short" });
    const msg = `⚡ 특이사항 감지  |  ${now}\n\n` + allAlerts.join("\n\n");
    console.log(msg);
    await sendTelegram(msg);
  } else {
    console.log("특이사항 없음");
  }

  saveState(state);
}

main().catch(console.error);
