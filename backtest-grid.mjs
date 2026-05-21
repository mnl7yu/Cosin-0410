/**
 * backtest-grid.mjs — 조건 조합 전체 비교
 *
 * 테스트 항목:
 *   브레이크아웃 봉 수  : 없음 / 2 / 3 / 5 / 10 / 20
 *   ADX 임계값          : 없음 / 15 / 20 / 25 / 30
 *   거래량 배수         : 없음 / 1.2 / 1.5 / 2.0
 *
 * Usage:
 *   node backtest-grid.mjs
 *   node backtest-grid.mjs --symbol=BTCUSDT --bars=1000
 *   node backtest-grid.mjs --bk-tf=30m        ← 브레이크아웃 기준을 30분봉으로
 *   node backtest-grid.mjs --top=10           ← 수익 상위 N개만 출력
 */

const args   = process.argv.slice(2);
const getArg = (k, d) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split("=")[1] : d; };
const SYMBOL = getArg("symbol", "BTCUSDT");
const BARS   = parseInt(getArg("bars",  "700"));
const TOP    = parseInt(getArg("top",   "0"));    // 0 = 전체 출력
const BK_TF  = getArg("bk-tf", "1h");            // 브레이크아웃 기준 타임프레임

// ─── 테스트 격자 정의 ─────────────────────────────────────────────────────────

const BREAKOUT_PERIODS = [null, 2, 3, 5, 10, 20]; // null = 조건 없음
const ADX_THRESHOLDS   = [null, 15, 20, 25, 30];  // null = 조건 없음
const VOL_MULTIPLIERS  = [null, 1.2, 1.5, 2.0];   // null = 조건 없음

// ─── Binance ──────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const map = { "1H": "1h", "30m": "30m", "4H": "4h", "1W": "1w" };
  const url  = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval]}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol} ${interval}: ${res.status}`);
  return (await res.json()).map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicator series ────────────────────────────────────────────────────────

function emaFull(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); out[i] = ema; }
  return out;
}

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
  for (let i = period + 1; i < n; i++) { sum = (out[i - 1] * (period - 1) + trs[i]); out[i] = sum / period; }
  return out;
}

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
    const r = new Array(period + 1).fill(null); r[period] = s;
    for (let i = period + 1; i < arr.length; i++) { s = s - s / period + arr[i]; r.push(s); }
    return r;
  };
  const atrS = wilder(trs), pS = wilder(pDMs), mS = wilder(mDMs);
  const dx = atrS.map((a, i) => {
    if (a == null || a === 0) return null;
    const pdi = 100 * pS[i] / a, mdi = 100 * mS[i] / a, sum = pdi + mdi;
    return sum > 0 ? 100 * Math.abs(pdi - mdi) / sum : 0;
  });
  const out = new Array(n).fill(null);
  const start = period * 2;
  if (start >= dx.length) return out;
  let adx = dx.slice(period, start).filter(v => v != null).reduce((a, b) => a + b, 0) / period;
  out[start - 1] = adx;
  for (let i = start; i < dx.length; i++) { if (dx[i] != null) adx = (adx * (period - 1) + dx[i]) / period; out[i] = adx; }
  return out;
}

function volSmaFull(candles, period = 20) {
  const vols = candles.map(c => c.volume);
  return vols.map((_, i) => {
    if (i < period - 1) return null;
    return vols.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function breakoutFull(candles, period) {
  return candles.map((_, i) => {
    if (i < period) return { hh: null, ll: null };
    const slice = candles.slice(i - period, i);
    return { hh: Math.max(...slice.map(c => c.high)), ll: Math.min(...slice.map(c => c.low)) };
  });
}

function lowerTfIdx(time, higherCandles) {
  let lo = 0, hi = higherCandles.length - 2, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (higherCandles[mid].time <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// ─── Single backtest run ──────────────────────────────────────────────────────

function runBacktest({ c1h, c4h, cW, c30m, ema50w, ema50_4h, adx4h, atr1h, vol1hSma, bkouts, bkouts30m }, cfg) {
  const { breakoutPeriod, adxThreshold, volMultiplier } = cfg;
  // BK_TF에 따라 1H 또는 30m 브레이크아웃 시리즈 선택
  const bkoutSeries = (BK_TF === "30m" && bkouts30m) ? bkouts30m : bkouts;
  const bkout = breakoutPeriod != null ? bkoutSeries[breakoutPeriod] : null;

  let pos = null, trades = [], equity = 1000;
  const RISK = 0.01;
  const SL_M = { bull: 3.0, bear: 2.0 };
  const TR_M = { bull: 6.0, bear: 4.0 };
  const warmup = 100;

  for (let i = warmup; i < c1h.length - 1; i++) {
    const bar   = c1h[i];
    const price = bar.close;
    const high  = bar.high;
    const i4h   = lowerTfIdx(bar.time, c4h);
    const iW    = lowerTfIdx(bar.time, cW);
    if (i4h < 0 || iW < 0) continue;

    const wEma50  = ema50w[iW];
    const h4Ema50 = ema50_4h[i4h];
    const h4Adx   = adx4h[i4h];
    const atr     = atr1h[i];
    const vSma    = vol1hSma[i];
    if (!wEma50 || !h4Ema50 || !atr) continue;
    if (adxThreshold != null && !h4Adx) continue;

    // ── Exit ──────────────────────────────────────────────
    if (pos) {
      const isLong = pos.side === "long";
      if (isLong) pos.trail = Math.max(pos.trail, high - atr * pos.trailMult);
      else        pos.trail = Math.min(pos.trail, bar.low + atr * pos.trailMult);

      const slHit    = isLong ? price <= pos.sl    : price >= pos.sl;
      const trailHit = isLong ? price <= pos.trail : price >= pos.trail;
      const flip     = isLong ? price < h4Ema50    : price > h4Ema50;

      let exitPrice = null, exitReason = null;
      if      (slHit)    { exitPrice = pos.sl;    exitReason = "SL"; }
      else if (trailHit) { exitPrice = pos.trail; exitReason = "TRAIL"; }
      else if (flip)     { exitPrice = price;     exitReason = "FLIP"; }

      if (exitReason) {
        const pnlPct = (isLong ? 1 : -1) * (exitPrice - pos.entry) / pos.entry;
        const pnlUsd = equity * RISK * (pnlPct / (Math.abs(pos.sl - pos.entry) / pos.entry));
        equity += pnlUsd;
        trades.push({ pnlUsd, reason: exitReason });
        pos = null;
      }
    }

    if (pos) continue;

    // ── Entry ─────────────────────────────────────────────
    const weeklyBull = price > wEma50;
    const weeklyBear = price < wEma50;
    const h4Bull     = price > h4Ema50;
    const h4Bear     = price < h4Ema50;

    let direction = null;
    if (weeklyBull && h4Bull) direction = "long";
    else if (weeklyBear && h4Bear) direction = "short";
    if (!direction) continue;

    const isLong = direction === "long";

    // ADX 필터
    if (adxThreshold != null && (h4Adx == null || h4Adx <= adxThreshold)) continue;

    // 브레이크아웃 필터
    if (bkout != null) {
      let hh, ll;
      if (BK_TF === "30m" && c30m) {
        // 30m 브레이크아웃: 현재 1H 봉의 시작 시각 이전 마지막 30m 봉 인덱스
        const i30 = lowerTfIdx(bar.time, c30m);
        if (i30 < 0) continue;
        const bk = bkout[i30];
        if (!bk || !bk.hh || !bk.ll) continue;
        hh = bk.hh; ll = bk.ll;
      } else {
        const bk = bkout[i];
        if (!bk || !bk.hh || !bk.ll) continue;
        hh = bk.hh; ll = bk.ll;
      }
      if (isLong ? price <= hh : price >= ll) continue;
    }

    // 거래량 필터
    if (volMultiplier != null) {
      if (!vSma || bar.volume < vSma * volMultiplier) continue;
    }

    const isBull   = weeklyBull && isLong;
    const slMult   = isBull ? SL_M.bull : SL_M.bear;
    const trailMult= isBull ? TR_M.bull : TR_M.bear;
    const sl       = isLong ? price - atr * slMult : price + atr * slMult;
    const trail    = isLong ? price - atr * trailMult : price + atr * trailMult;
    pos = { side: direction, entry: price, sl, trail, trailMult, atr, openBar: i };
  }

  // 미청산 강제 청산
  if (pos) {
    const lastPrice = c1h.at(-1).close;
    const isLong = pos.side === "long";
    const pnlPct = (isLong ? 1 : -1) * (lastPrice - pos.entry) / pos.entry;
    const pnlUsd = equity * RISK * (pnlPct / (Math.abs(pos.sl - pos.entry) / pos.entry));
    equity += pnlUsd;
    trades.push({ pnlUsd, reason: "END" });
  }

  const wins  = trades.filter(t => t.pnlUsd > 0);
  const total = trades.length;
  const pnl   = equity - 1000;
  const wr    = total > 0 ? wins.length / total * 100 : 0;
  const avgW  = wins.length ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
  const losers= trades.filter(t => t.pnlUsd <= 0);
  const avgL  = losers.length ? Math.abs(losers.reduce((s, t) => s + t.pnlUsd, 0) / losers.length) : 0;
  const rr    = avgL > 0 ? avgW / avgL : null;
  const expectancy = total > 0 ? trades.reduce((s, t) => s + t.pnlUsd, 0) / total : 0;

  return { total, wins: wins.length, losses: losers.length, wr, pnl, equity, rr, expectancy, cfg };
}

// ─── Fetch & precompute ───────────────────────────────────────────────────────

async function loadData(symbol) {
  process.stdout.write(`  ${symbol} 데이터 수집 중...`);

  const fetches = [
    fetchCandles(symbol, "1H", BARS),
    fetchCandles(symbol, "4H", Math.ceil(BARS / 4) + 100),
    fetchCandles(symbol, "1W", 300),
  ];
  // 30m 봉: 1H 봉의 2배 수 + 버퍼
  if (BK_TF === "30m") fetches.push(fetchCandles(symbol, "30m", BARS * 2 + 200));

  const [c1h, c4h, cW, c30m] = await Promise.all(fetches);

  process.stdout.write(" 지표 계산 중...");
  const ema50w   = emaFull(cW.map(c => c.close), 50);
  const ema50_4h = emaFull(c4h.map(c => c.close), 50);
  const adx4h    = adxFull(c4h, 14);
  const atr1h    = atrFull(c1h, 14);
  const vol1hSma = volSmaFull(c1h, 20);

  // 1H 브레이크아웃 시리즈
  const bkouts = {};
  for (const p of BREAKOUT_PERIODS) {
    if (p != null) bkouts[p] = breakoutFull(c1h, p);
  }

  // 30m 브레이크아웃 시리즈 (--bk-tf=30m 일 때만)
  let bkouts30m = null;
  if (BK_TF === "30m" && c30m) {
    bkouts30m = {};
    for (const p of BREAKOUT_PERIODS) {
      if (p != null) bkouts30m[p] = breakoutFull(c30m, p);
    }
  }

  console.log(" 완료.");
  return { c1h, c4h, cW, c30m: c30m ?? null, ema50w, ema50_4h, adx4h, atr1h, vol1hSma, bkouts, bkouts30m };
}

// ─── Grid runner ─────────────────────────────────────────────────────────────

function runGrid(data) {
  const results = [];
  for (const breakoutPeriod of BREAKOUT_PERIODS) {
    for (const adxThreshold of ADX_THRESHOLDS) {
      for (const volMultiplier of VOL_MULTIPLIERS) {
        const cfg = { breakoutPeriod, adxThreshold, volMultiplier };
        const r   = runBacktest(data, cfg);
        results.push(r);
      }
    }
  }
  return results;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function cfgLabel(cfg) {
  const bk  = cfg.breakoutPeriod != null ? `BK${cfg.breakoutPeriod}봉`  : "BK없음";
  const adx = cfg.adxThreshold   != null ? `ADX>${cfg.adxThreshold}`    : "ADX없음";
  const vol = cfg.volMultiplier   != null ? `VOL×${cfg.volMultiplier}` : "VOL없음";
  return `${bk} | ${adx} | ${vol}`;
}

function bar(val, max, width = 20) {
  const filled = max > 0 ? Math.round((val / max) * width) : 0;
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

function sign(n) { return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`; }

// ─── Report ───────────────────────────────────────────────────────────────────

function printResults(results, symbol) {
  // 정렬: 수익 > 승률 > 거래수
  const sorted = [...results].sort((a, b) =>
    b.pnl !== a.pnl ? b.pnl - a.pnl : b.wr - a.wr
  );

  const display = TOP > 0 ? sorted.slice(0, TOP) : sorted;
  const maxPnl  = Math.max(...results.map(r => Math.abs(r.pnl)));
  const maxTrades = Math.max(...results.map(r => r.total));

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  ${symbol}  —  전체 조합 ${results.length}개  |  ${BARS}봉 (~${(BARS/24).toFixed(0)}일)`);
  if (TOP > 0) console.log(`  상위 ${TOP}개만 표시`);
  console.log(`${"═".repeat(80)}`);
  console.log(`  ${"순위".padEnd(4)}  ${"조건 조합".padEnd(30)}  ${"거래".padStart(4)}  ${"승률".padStart(6)}  ${"손익비".padStart(6)}  ${"기대값".padStart(7)}  ${"PnL".padStart(9)}`);
  console.log(`  ${"─".repeat(76)}`);

  display.forEach((r, idx) => {
    const rank  = String(idx + 1).padStart(2);
    const label = cfgLabel(r.cfg).padEnd(30);
    const total = String(r.total).padStart(4);
    const wr    = `${r.wr.toFixed(0)}%`.padStart(6);
    const rr    = r.rr != null ? `${r.rr.toFixed(2)}`.padStart(6) : `  N/A`.padStart(6);
    const exp   = `${r.expectancy >= 0 ? "+" : ""}$${r.expectancy.toFixed(2)}`.padStart(7);
    const pnl   = `${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}`.padStart(9);
    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "  ";
    console.log(`  ${medal}${rank}  ${label}  ${total}  ${wr}  ${rr}  ${exp}  ${pnl}`);
  });

  // ── 섹션별 Best ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(80)}`);
  console.log("  섹션별 Best");
  console.log(`${"─".repeat(80)}`);

  // 브레이크아웃 봉 수별
  console.log("\n  [브레이크아웃 봉 수별 평균 PnL]");
  for (const bp of BREAKOUT_PERIODS) {
    const group = results.filter(r => r.cfg.breakoutPeriod === bp);
    const avg   = group.reduce((s, r) => s + r.pnl, 0) / group.length;
    const best  = group.sort((a, b) => b.pnl - a.pnl)[0];
    const label = bp != null ? `${bp}봉 브레이크아웃` : "브레이크아웃 없음";
    const b     = bar(avg + maxPnl, maxPnl * 2);
    console.log(`  ${label.padEnd(18)}  avg ${(avg >= 0 ? "+" : "")+"$"+Math.abs(avg).toFixed(2)}  ${b}  best: ${sign(best.pnl)}`);
  }

  // ADX 임계값별
  console.log("\n  [ADX 임계값별 평균 PnL]");
  for (const at of ADX_THRESHOLDS) {
    const group = results.filter(r => r.cfg.adxThreshold === at);
    const avg   = group.reduce((s, r) => s + r.pnl, 0) / group.length;
    const best  = group.sort((a, b) => b.pnl - a.pnl)[0];
    const label = at != null ? `ADX > ${at}` : "ADX 조건 없음";
    const b     = bar(avg + maxPnl, maxPnl * 2);
    console.log(`  ${label.padEnd(18)}  avg ${(avg >= 0 ? "+" : "")+"$"+Math.abs(avg).toFixed(2)}  ${b}  best: ${sign(best.pnl)}`);
  }

  // 거래량 배수별
  console.log("\n  [거래량 배수별 평균 PnL]");
  for (const vm of VOL_MULTIPLIERS) {
    const group = results.filter(r => r.cfg.volMultiplier === vm);
    const avg   = group.reduce((s, r) => s + r.pnl, 0) / group.length;
    const best  = group.sort((a, b) => b.pnl - a.pnl)[0];
    const label = vm != null ? `VOL × ${vm}` : "거래량 조건 없음";
    const b     = bar(avg + maxPnl, maxPnl * 2);
    console.log(`  ${label.padEnd(18)}  avg ${(avg >= 0 ? "+" : "")+"$"+Math.abs(avg).toFixed(2)}  ${b}  best: ${sign(best.pnl)}`);
  }

  // ── 거래 수 분포 ──────────────────────────────────────────────────────────
  console.log(`\n  [거래 수 분포]`);
  const buckets = { "0건": 0, "1-3건": 0, "4-10건": 0, "11+건": 0 };
  results.forEach(r => {
    if (r.total === 0)       buckets["0건"]++;
    else if (r.total <= 3)   buckets["1-3건"]++;
    else if (r.total <= 10)  buckets["4-10건"]++;
    else                     buckets["11+건"]++;
  });
  Object.entries(buckets).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(8)}  ${"█".repeat(v)} (${v}개 조합)`);
  });

  // ── 최종 추천 ──────────────────────────────────────────────────────────────
  const best3 = sorted.slice(0, 3);
  console.log(`\n${"─".repeat(80)}`);
  console.log("  추천 조합 Top 3");
  console.log(`${"─".repeat(80)}`);
  best3.forEach((r, i) => {
    const medals = ["🥇", "🥈", "🥉"];
    console.log(`\n  ${medals[i]} ${cfgLabel(r.cfg)}`);
    console.log(`     거래: ${r.total}건 | 승률: ${r.wr.toFixed(0)}% | 손익비: ${r.rr != null ? r.rr.toFixed(2) : "N/A"} | PnL: ${sign(r.pnl)}`);
  });
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const totalCombinations = BREAKOUT_PERIODS.length * ADX_THRESHOLDS.length * VOL_MULTIPLIERS.length;
console.log("═".repeat(80));
console.log("  조건 조합 백테스트 그리드");
console.log(`  심볼 : ${SYMBOL}  |  기간 : 1H ${BARS}봉 (~${(BARS/24).toFixed(0)}일)`);
console.log(`  BK TF: ${BK_TF === "30m" ? "30분봉 브레이크아웃" : "1시간봉 브레이크아웃 (기본)"}`);
console.log(`  조합 : 브레이크아웃 ${BREAKOUT_PERIODS.length}가지 × ADX ${ADX_THRESHOLDS.length}가지 × 거래량 ${VOL_MULTIPLIERS.length}가지 = ${totalCombinations}가지`);
console.log("═".repeat(80));

(async () => {
  try {
    const data    = await loadData(SYMBOL);
    const results = runGrid(data);
    printResults(results, SYMBOL);
  } catch (err) {
    console.error(`\n❌ 오류: ${err.message}`);
    process.exit(1);
  }
})();
