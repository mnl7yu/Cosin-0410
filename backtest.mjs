/**
 * backtest.mjs — 브레이크아웃 봉 수 비교 백테스터
 *
 * Usage:
 *   node backtest.mjs                  → period=3 (BTCUSDT + ETHUSDT)
 *   node backtest.mjs --period=20      → 20봉
 *   node backtest.mjs --compare        → 3봉 vs 20봉 동시 비교
 *   node backtest.mjs --symbol=BTCUSDT --bars=1000
 */

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (key, def) => {
  const found = args.find(a => a.startsWith(`--${key}=`));
  return found ? found.split("=")[1] : def;
};
const hasFlag = (f) => args.includes(`--${f}`);

const COMPARE     = hasFlag("compare");
const NO_BREAKOUT = hasFlag("no-breakout");  // 브레이크아웃 조건 제거
const PERIODS = COMPARE ? [3, 20] : [parseInt(getArg("period", "3"))];
const SYMBOLS = getArg("symbol", "BTCUSDT,ETHUSDT").split(",");
const BARS    = parseInt(getArg("bars", "700"));   // 1H 봉 수 (~29일)

// ─── Binance ─────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const map = { "1H": "1h", "4H": "4h", "1W": "1w" };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval]}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol} ${interval}: ${res.status}`);
  return (await res.json()).map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators (rolling series) ─────────────────────────────────────────────

/** Returns full EMA series aligned to closes.length */
function emaFull(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Returns full ATR series */
function atrFull(candles, period = 14) {
  const n = candles.length;
  const trs = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const out = new Array(n).fill(null);
  let sum = trs.slice(1, period + 1).reduce((a, b) => a + b, 0);
  out[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    sum = (out[i - 1] * (period - 1) + trs[i]);
    out[i] = sum / period;
  }
  return out;
}

/** Returns full ADX series (Wilder's smoothing) */
function adxFull(candles, period = 14) {
  const n = candles.length;
  const trs = [0], pDMs = [0], mDMs = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const wilder = (arr) => {
    let s = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    const r = new Array(period + 1).fill(null);
    r[period] = s;
    for (let i = period + 1; i < arr.length; i++) { s = s - s / period + arr[i]; r.push(s); }
    return r;
  };
  const atrS = wilder(trs), pS = wilder(pDMs), mS = wilder(mDMs);
  const dx = atrS.map((a, i) => {
    if (a == null || a === 0) return null;
    const pdi = 100 * pS[i] / a, mdi = 100 * mS[i] / a;
    const sum = pdi + mdi;
    return sum > 0 ? 100 * Math.abs(pdi - mdi) / sum : 0;
  });
  const out = new Array(n).fill(null);
  const start = period * 2;
  if (start >= dx.length) return out;
  let adx = dx.slice(period, start).filter(v => v != null).reduce((a, b) => a + b, 0) / period;
  out[start - 1] = adx;
  for (let i = start; i < dx.length; i++) {
    if (dx[i] != null) adx = (adx * (period - 1) + dx[i]) / period;
    out[i] = adx;
  }
  return out;
}

/** Volume SMA series */
function volSmaFull(candles, period = 20) {
  const vols = candles.map(c => c.volume);
  return vols.map((_, i) => {
    if (i < period - 1) return null;
    return vols.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

/** N-봉 breakout high/low (마지막 봉 제외) */
function breakoutFull(candles, period) {
  return candles.map((_, i) => {
    if (i < period) return { hh: null, ll: null };
    const slice = candles.slice(i - period, i); // 현재봉 미포함
    return {
      hh: Math.max(...slice.map(c => c.high)),
      ll: Math.min(...slice.map(c => c.low)),
    };
  });
}

// ─── Time alignment helper ───────────────────────────────────────────────────
// 1H 봉의 타임스탬프에 가장 가까운 상위TF 인덱스를 찾음

function buildTimeIndex(candles) {
  // map: openTime → index
  const m = new Map();
  candles.forEach((c, i) => m.set(c.time, i));
  return m;
}

/** 1H bar의 time에 해당하는 4H/주봉 인덱스 (직전 확정봉) */
function lowerTfIdx(time, higherCandles) {
  // 직전 확정봉 = time보다 openTime이 작거나 같은 마지막 봉
  let lo = 0, hi = higherCandles.length - 2; // -2: 현재 봉은 미완성
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (higherCandles[mid].time <= time) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// ─── Core Backtest ───────────────────────────────────────────────────────────

async function backtest(symbol, breakoutPeriod, skipBreakout = false) {
  // 데이터 수집
  const [c1h, c4h, cW] = await Promise.all([
    fetchCandles(symbol, "1H", BARS),
    fetchCandles(symbol, "4H", Math.ceil(BARS / 4) + 100),
    fetchCandles(symbol, "1W", 300),
  ]);

  // 지표 시리즈 계산
  const ema50w   = emaFull(cW.map(c => c.close), 50);
  const ema50_4h = emaFull(c4h.map(c => c.close), 50);
  const adx4h    = adxFull(c4h, 14);
  const atr1h    = atrFull(c1h, 14);
  const vol1hSma = volSmaFull(c1h, 20);
  const bkout    = breakoutFull(c1h, breakoutPeriod);

  // 시뮬레이션 상태
  let pos      = null;   // { side, entry, sl, trail, trailMult, atr, openBar }
  let trades   = [];
  let equity   = 1000;   // $1000 시작
  const RISK   = 0.01;   // 1%
  const SL_M   = { bull: 3.0, bear: 2.0 };
  const TR_M   = { bull: 6.0, bear: 4.0 };

  const warmup = Math.max(50 * 2, 14 * 2 + 1, 50);  // 충분한 워밍업

  for (let i = warmup; i < c1h.length - 1; i++) {
    const bar  = c1h[i];
    const price = bar.close;
    const high  = bar.high;

    // 4H / 주봉 직전 확정봉
    const i4h = lowerTfIdx(bar.time, c4h);
    const iW  = lowerTfIdx(bar.time, cW);
    if (i4h < 0 || iW < 0) continue;

    const wEma50  = ema50w[iW];
    const h4Ema50 = ema50_4h[i4h];
    const h4Adx   = adx4h[i4h];
    const atr     = atr1h[i];
    const vSma    = vol1hSma[i];
    const { hh, ll } = bkout[i];

    if (!wEma50 || !h4Ema50 || !h4Adx || !atr || !vSma) continue;
    if (!skipBreakout && (!hh || !ll)) continue;

    // ── Exit check ─────────────────────────────────────────
    if (pos) {
      const isLong = pos.side === "long";
      // 트레일 갱신
      if (isLong)  pos.trail = Math.max(pos.trail, high  - atr * pos.trailMult);
      else         pos.trail = Math.min(pos.trail, bar.low + atr * pos.trailMult);

      const slHit    = isLong ? price <= pos.sl    : price >= pos.sl;
      const trailHit = isLong ? price <= pos.trail : price >= pos.trail;
      const trendFlip = isLong ? (price < h4Ema50) : (price > h4Ema50);

      let exitPrice = null, exitReason = null;
      if      (slHit)     { exitPrice = pos.sl;    exitReason = "SL"; }
      else if (trailHit)  { exitPrice = pos.trail; exitReason = "TRAIL"; }
      else if (trendFlip) { exitPrice = price;     exitReason = "FLIP"; }

      if (exitReason) {
        const pnlPct = (isLong ? 1 : -1) * (exitPrice - pos.entry) / pos.entry;
        const pnlUsd = equity * RISK * (pnlPct / (Math.abs(pos.sl - pos.entry) / pos.entry));
        equity += pnlUsd;
        trades.push({
          side: pos.side, entry: pos.entry, exit: exitPrice,
          reason: exitReason, pnlPct, pnlUsd,
          bars: i - pos.openBar,
          openTime: new Date(c1h[pos.openBar].time).toISOString().slice(0, 10),
        });
        pos = null;
      }
    }

    // ── Entry check ────────────────────────────────────────
    if (pos) continue;  // 이미 포지션 있으면 스킵

    const weeklyBull = price > wEma50;
    const weeklyBear = price < wEma50;
    const h4Bull     = price > h4Ema50;
    const h4Bear     = price < h4Ema50;
    const adxStrong  = h4Adx > 25;

    let direction = null;
    if (weeklyBull && h4Bull) direction = "long";
    else if (weeklyBear && h4Bear) direction = "short";
    if (!direction) continue;

    const isLong = direction === "long";

    // 브레이크아웃 (skipBreakout이면 조건 무시)
    if (!skipBreakout) {
      const bkHit = isLong ? (price > hh) : (price < ll);
      if (!bkHit) continue;
    }

    // ADX
    if (!adxStrong) continue;

    // 거래량
    const volOk = bar.volume >= vSma * 1.5;
    if (!volOk) continue;

    // 진입 실행
    const isBull   = weeklyBull && isLong;
    const slMult   = isBull ? SL_M.bull : SL_M.bear;
    const trailMult= isBull ? TR_M.bull : TR_M.bear;
    const sl       = isLong ? price - atr * slMult : price + atr * slMult;
    const trail    = isLong ? price - atr * trailMult : price + atr * trailMult;

    pos = { side: direction, entry: price, sl, trail, trailMult, atr, openBar: i };
  }

  // 미청산 포지션 강제 청산 (마지막 봉)
  if (pos) {
    const lastPrice = c1h.at(-1).close;
    const isLong = pos.side === "long";
    const pnlPct = (isLong ? 1 : -1) * (lastPrice - pos.entry) / pos.entry;
    const pnlUsd = equity * RISK * (pnlPct / (Math.abs(pos.sl - pos.entry) / pos.entry));
    equity += pnlUsd;
    trades.push({
      side: pos.side, entry: pos.entry, exit: lastPrice,
      reason: "END", pnlPct, pnlUsd,
      bars: c1h.length - 1 - pos.openBar,
      openTime: new Date(c1h[pos.openBar].time).toISOString().slice(0, 10),
    });
  }

  return { symbol, breakoutPeriod, trades, finalEquity: equity, skipBreakout };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function report(result) {
  const { symbol, breakoutPeriod, trades, finalEquity, skipBreakout } = result;
  const wins   = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const total  = trades.length;
  const winRate = total > 0 ? (wins.length / total * 100).toFixed(1) : "0.0";
  const pnl    = finalEquity - 1000;
  const pnlPct = (pnl / 1000 * 100).toFixed(2);

  const avgWin  = wins.length  ? wins.reduce((s, t) => s + t.pnlUsd, 0)   / wins.length  : 0;
  const avgLoss = losses.length? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length: 0;
  const rr      = avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "∞";

  const byReason = {};
  trades.forEach(t => { byReason[t.reason] = (byReason[t.reason] || 0) + 1; });

  const label = skipBreakout ? "브레이크아웃 없음" : `브레이크아웃 ${breakoutPeriod}봉`;
  console.log(`\n${"─".repeat(55)}`);
  console.log(`  ${symbol}  —  ${label}`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  총 거래    : ${total}건`);
  console.log(`  승률       : ${winRate}%  (${wins.length}승 ${losses.length}패)`);
  console.log(`  손익비     : 1 : ${rr}`);
  console.log(`  평균 수익  : +$${avgWin.toFixed(2)}`);
  console.log(`  평균 손실  : $${avgLoss.toFixed(2)}`);
  console.log(`  최종 자본  : $${finalEquity.toFixed(2)}  (${pnl >= 0 ? "+" : ""}${pnlPct}%)`);
  if (Object.keys(byReason).length) {
    const reasons = Object.entries(byReason).map(([k,v]) => `${k}:${v}`).join("  ");
    console.log(`  청산 사유  : ${reasons}`);
  }

  // 거래 내역 (상위 5개)
  if (trades.length > 0) {
    console.log(`\n  최근 거래 (최대 5개):`);
    trades.slice(-5).forEach(t => {
      const sign = t.pnlUsd >= 0 ? "+" : "";
      const icon = t.pnlUsd >= 0 ? "✅" : "🚫";
      console.log(`  ${icon} ${t.openTime}  ${t.side.toUpperCase().padEnd(5)}  진입$${t.entry.toFixed(0)} → 청산$${t.exit.toFixed(0)}  ${sign}$${t.pnlUsd.toFixed(2)} [${t.reason} ${t.bars}봉]`);
    });
  }
}

// ─── Compare Report ───────────────────────────────────────────────────────────

function compareReport(a, b, labelA, labelB) {
  const pnlA = a.finalEquity - 1000;
  const pnlB = b.finalEquity - 1000;
  const wrA  = a.trades.length ? (a.trades.filter(t=>t.pnlUsd>0).length / a.trades.length * 100).toFixed(1) : "0.0";
  const wrB  = b.trades.length ? (b.trades.filter(t=>t.pnlUsd>0).length / b.trades.length * 100).toFixed(1) : "0.0";

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  ${a.symbol}  비교: ${labelA} vs ${labelB}`);
  console.log(`${"═".repeat(55)}`);
  console.log(`  항목        ${labelA.padEnd(12)}  ${labelB}`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  거래 수     ${String(a.trades.length).padStart(5)}건        ${String(b.trades.length).padStart(5)}건`);
  console.log(`  승률        ${wrA.padStart(5)}%        ${wrB.padStart(5)}%`);
  console.log(`  최종 PnL    ${(pnlA>=0?"+":"")+"$"+pnlA.toFixed(2)}     ${(pnlB>=0?"+":"")+"$"+pnlB.toFixed(2)}`);
  console.log(`  최종 자본   $${a.finalEquity.toFixed(2)}     $${b.finalEquity.toFixed(2)}`);
  const winner = pnlA >= pnlB ? `🏆 ${labelA} 우세` : `🏆 ${labelB} 우세`;
  console.log(`\n  ${winner}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const modeLabel = NO_BREAKOUT ? "브레이크아웃 없음 vs 3봉" : (COMPARE ? "3봉 vs 20봉 비교" : `${PERIODS[0]}봉`);
console.log("═".repeat(55));
console.log("  백테스트 시작");
console.log(`  심볼  : ${SYMBOLS.join(", ")}`);
console.log(`  기간  : 1H 봉 ${BARS}개 (~${(BARS/24).toFixed(0)}일)`);
console.log(`  모드  : ${modeLabel}`);
console.log("═".repeat(55));

(async () => {
  for (const symbol of SYMBOLS) {
    try {
      if (NO_BREAKOUT) {
        // 브레이크아웃 없음 vs 3봉 비교
        console.log(`\n  ${symbol} 데이터 수집 중...`);
        const [rNone, r3] = await Promise.all([
          backtest(symbol, 3, true),   // 브레이크아웃 조건 제거
          backtest(symbol, 3, false),  // 3봉 브레이크아웃
        ]);
        report(rNone);
        report(r3);
        compareReport(rNone, r3, "조건없음", "3봉");
      } else if (COMPARE) {
        console.log(`\n  ${symbol} 데이터 수집 중...`);
        const [r3, r20] = await Promise.all([
          backtest(symbol, 3),
          backtest(symbol, 20),
        ]);
        report(r3);
        report(r20);
        compareReport(r3, r20, "3봉", "20봉");
      } else {
        for (const p of PERIODS) {
          console.log(`\n  ${symbol} (${p}봉) 데이터 수집 중...`);
          const r = await backtest(symbol, p);
          report(r);
        }
      }
    } catch (err) {
      console.error(`  ❌ ${symbol} 오류: ${err.message}`);
    }
  }
  console.log("\n" + "═".repeat(55));
})();
