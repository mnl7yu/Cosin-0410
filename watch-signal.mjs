/**
 * watch-signal.mjs — 진입 신호 감시 + 자동 진입
 * 5분마다 체크, 브레이크아웃 조건 충족 시 bot.js 자동 실행
 */

import { execSync, spawnSync } from "child_process";

const INTERVAL_MS = 5 * 60 * 1000; // 5분

function toOkxSymbol(symbol) {
  return symbol.replace(/^([A-Z]+)(USDT)$/, "$1-USDT");
}

async function fetchCandles(symbol, interval, limit) {
  // OKX bar format: 30m, 4H, 1W, 1H (case-sensitive uppercase for H/W/D)
  const barMap = { "30m": "30m", "4H": "4H", "1W": "1W", "1H": "1H" };
  const bar = barMap[interval] || interval;
  const instId = toOkxSymbol(symbol);
  const params = new URLSearchParams({ instId, bar, limit: String(limit) });
  const res = await fetch(`https://www.okx.com/api/v5/market/candles?${params}`);
  if (!res.ok) throw new Error(`${symbol}/${interval}: ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX error: ${json.msg}`);
  // OKX returns newest-first → reverse to oldest-first
  return (json.data ?? []).reverse().map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function ema(closes, period) {
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function adx(candles, period = 14) {
  const n = candles.length;
  const trs = [0], pDMs = [0], mDMs = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const wilder = arr => {
    let s = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    for (let i = period + 1; i < arr.length; i++) s = s - s / period + arr[i];
    return s;
  };
  const aS = wilder(trs), pS = wilder(pDMs), mS = wilder(mDMs);
  const pdi = 100 * pS / aS, mdi = 100 * mS / aS;
  const sm = pdi + mdi;
  const lastDx = sm > 0 ? 100 * Math.abs(pdi - mdi) / sm : 0;
  // simplified: return last ADX approximation
  return lastDx;
}

async function check() {
  const now = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const results = [];

  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const adxThres = symbol === "BTCUSDT" ? 25 : 20;
    try {
      const [c1h, c4h, cW, c30m] = await Promise.all([
        fetchCandles(symbol, "1H", 100),
        fetchCandles(symbol, "4H", 200),
        fetchCandles(symbol, "1W", 100),
        fetchCandles(symbol, "30m", 10),
      ]);

      const price    = c1h.at(-1).close;
      const wEma50   = ema(cW.map(c => c.close), 50);
      const wEmaPrev = ema(cW.slice(0, -1).map(c => c.close), 50);
      const h4Ema50  = ema(c4h.map(c => c.close), 50);
      const h4Adx    = adx(c4h.slice(-30), 14);

      const ll2 = Math.min(...c30m.slice(-3, -1).map(c => c.low));
      const hh2 = Math.max(...c30m.slice(-3, -1).map(c => c.high));

      const wDown  = price < wEma50 && wEma50 < wEmaPrev;
      const wUp    = price > wEma50 && wEma50 > wEmaPrev;
      const h4Bear = price < h4Ema50;
      const h4Bull = price > h4Ema50;
      const adxOk  = h4Adx > adxThres;

      const shortBias = wDown && h4Bear && adxOk;
      const longBias  = wUp  && h4Bull && adxOk;

      const shortBreak = price < ll2;
      const longBreak  = price > hh2;

      if (shortBias && shortBreak) {
        results.push(`🚨 [${now}] ${symbol} SHORT 진입 신호!\n   현재가: $${price.toFixed(2)}  돌파기준: $${ll2.toFixed(2)}  ADX: ${h4Adx.toFixed(1)}`);
      } else if (longBias && longBreak) {
        results.push(`🚨 [${now}] ${symbol} LONG 진입 신호!\n   현재가: $${price.toFixed(2)}  돌파기준: $${hh2.toFixed(2)}  ADX: ${h4Adx.toFixed(1)}`);
      } else {
        // 진입 임박 여부 표시
        const gap = shortBias ? ((price - ll2) / price * 100).toFixed(2)
                  : longBias  ? ((hh2 - price) / price * 100).toFixed(2)
                  : null;
        const dir = shortBias ? "SHORT 대기" : longBias ? "LONG 대기" : "NEUTRAL";
        const gapStr = gap ? `  브레이크아웃까지 ${gap}%` : "";
        console.log(`[${now}] ${symbol} ${dir}${gapStr}`);
      }
    } catch (e) {
      console.log(`[${now}] ${symbol} 오류: ${e.message}`);
    }
  }

  if (results.length > 0) {
    console.log("\n" + "█".repeat(50));
    results.forEach(r => console.log(r));
    console.log("█".repeat(50) + "\n");

    // ── 자동 진입 ──────────────────────────────────────────
    console.log(`[${now}] 🤖 bot.js 자동 실행 중...`);
    try {
      const ret = spawnSync("node", ["bot.js"], {
        cwd: new URL(".", import.meta.url).pathname,
        encoding: "utf-8",
        timeout: 60000,
      });
      if (ret.stdout) console.log(ret.stdout);
      if (ret.stderr) console.error(ret.stderr);
      console.log(`[${now}] ✅ bot.js 실행 완료`);
    } catch (e) {
      console.log(`[${now}] ❌ bot.js 실행 실패: ${e.message}`);
    }
  }
}

console.log(`신호 감시 시작 — 5분 간격 체크 + 자동 진입`);
console.log(`중지: Ctrl+C\n`);

await check();
setInterval(check, INTERVAL_MS);
