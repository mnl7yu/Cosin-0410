/**
 * backtest-periods.mjs — 시장 국면별 전략 백테스트
 *
 * 적용 전략 (백테스트 최적값):
 *   BTC: 30분봉 2봉 브레이크아웃 | ADX > 25 | 거래량 필터 없음
 *   ETH: 30분봉 2봉 브레이크아웃 | ADX > 20 | 거래량 필터 없음
 *
 * Usage:
 *   node backtest-periods.mjs
 *   node backtest-periods.mjs --symbol=BTCUSDT
 */

const args    = process.argv.slice(2);
const getArg  = (k, d) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split("=")[1] : d; };
const SYMBOLS = getArg("symbol", "BTCUSDT,ETHUSDT").split(",");

// ─── 시장 국면 정의 ───────────────────────────────────────────────────────────

const PERIODS = [
  { name: "🐂 Bull Run 1",       emoji: "🐂", label: "상승장",  start: "2020-10-01", end: "2021-04-30" },
  { name: "🔻 ATH 이후 조정",    emoji: "🔻", label: "조정",   start: "2021-05-01", end: "2021-07-31" },
  { name: "🐂 Bull Run 2",       emoji: "🐂", label: "상승장",  start: "2021-08-01", end: "2021-11-30" },
  { name: "🐻 Bear Market",      emoji: "🐻", label: "하락장",  start: "2022-01-01", end: "2022-12-31" },
  { name: "🦀 Sideways / 회복",  emoji: "🦀", label: "횡보",   start: "2023-01-01", end: "2023-09-30" },
  { name: "🐂 Bull Run 3",       emoji: "🐂", label: "상승장",  start: "2023-10-01", end: "2024-03-31" },
  { name: "🔻 Post-ATH 조정",    emoji: "🔻", label: "조정",   start: "2024-04-01", end: "2024-09-30" },
  { name: "🐂 Bull Run 4",       emoji: "🐂", label: "상승장",  start: "2024-10-01", end: "2025-01-31" },
  { name: "📉 최근 조정 (2025)", emoji: "📉", label: "하락장",  start: "2025-02-01", end: "2025-05-16" },
];

const toMs = (dateStr) => new Date(dateStr + "T00:00:00Z").getTime();

// ─── Binance 페이지네이션 fetch ───────────────────────────────────────────────

const TF_MAP = { "1H": "1h", "30m": "30m", "4H": "4h", "1W": "1w" };

async function fetchRange(symbol, interval, startMs, endMs) {
  const iv  = TF_MAP[interval] ?? interval;
  const all = [];
  let from  = startMs;

  while (from < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${iv}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${symbol} ${interval}: ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all.push(...data.map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    })));
    if (data.length < 1000) break;
    from = data[data.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 150)); // 바이낸스 rate limit
  }
  return all;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaFull(closes, p) {
  const k = 2 / (p + 1);
  const out = new Array(closes.length).fill(null);
  let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = e;
  for (let i = p; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function atrFull(candles, p = 14) {
  const n = candles.length, trs = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i], v = candles[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - v.close), Math.abs(c.low - v.close)));
  }
  const out = new Array(n).fill(null);
  let s = trs.slice(1, p+1).reduce((a,b)=>a+b,0);
  out[p] = s / p;
  for (let i = p+1; i < n; i++) { s = (out[i-1]*(p-1) + trs[i]); out[i] = s/p; }
  return out;
}

function adxFull(candles, p = 14) {
  const n = candles.length, trs=[0], pDMs=[0], mDMs=[0];
  for (let i = 1; i < n; i++) {
    const c = candles[i], v = candles[i-1];
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-v.close), Math.abs(c.low-v.close)));
    const up = c.high-v.high, dn = v.low-c.low;
    pDMs.push(up>dn && up>0 ? up : 0);
    mDMs.push(dn>up && dn>0 ? dn : 0);
  }
  const wilder = arr => {
    let s = arr.slice(1, p+1).reduce((a,b)=>a+b,0);
    const r = new Array(p+1).fill(null); r[p] = s;
    for (let i=p+1; i<arr.length; i++) { s=s-s/p+arr[i]; r.push(s); }
    return r;
  };
  const aS=wilder(trs), pS=wilder(pDMs), mS=wilder(mDMs);
  const dx=aS.map((a,i)=>{
    if(!a||a===0) return null;
    const pd=100*pS[i]/a, md=100*mS[i]/a, sm=pd+md;
    return sm>0 ? 100*Math.abs(pd-md)/sm : 0;
  });
  const out=new Array(n).fill(null);
  const st=p*2; if(st>=dx.length) return out;
  let adx=dx.slice(p,st).filter(v=>v!=null).reduce((a,b)=>a+b,0)/p;
  out[st-1]=adx;
  for(let i=st;i<dx.length;i++){if(dx[i]!=null)adx=(adx*(p-1)+dx[i])/p; out[i]=adx;}
  return out;
}

function breakoutFull(candles, p) {
  return candles.map((_,i) => {
    if (i < p) return { hh: null, ll: null };
    const sl = candles.slice(i-p, i);
    return { hh: Math.max(...sl.map(c=>c.high)), ll: Math.min(...sl.map(c=>c.low)) };
  });
}

function lowerTfIdx(time, higher) {
  let lo=0, hi=higher.length-2, best=-1;
  while(lo<=hi){const m=(lo+hi)>>1; if(higher[m].time<=time){best=m;lo=m+1;}else hi=m-1;}
  return best;
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

function simulate({ c1h, c4h, cW, c30m, ema50w, ema50_4h, adx4h, atr1h, bk30m },
                  { adxThreshold, periodStartMs, periodEndMs }) {

  let pos=null, trades=[], equity=1000;
  const RISK=0.01, SL_M={bull:3,bear:2}, TR_M={bull:6,bear:4};
  const warmup=100;

  for (let i=warmup; i<c1h.length-1; i++) {
    const bar=c1h[i], price=bar.close, high=bar.high;

    // 해당 구간 밖이면 스킵 (청산은 허용)
    const inPeriod = bar.time >= periodStartMs && bar.time <= periodEndMs;

    const i4h=lowerTfIdx(bar.time,c4h), iW=lowerTfIdx(bar.time,cW);
    if(i4h<0||iW<0) continue;
    const wEma50=ema50w[iW], h4Ema50=ema50_4h[i4h], h4Adx=adx4h[i4h], atr=atr1h[i];
    if(!wEma50||!h4Ema50||!atr) continue;

    // ── Exit ────────────────────────────────────────
    if (pos) {
      const isLong=pos.side==="long";
      if(isLong) pos.trail=Math.max(pos.trail, high-atr*pos.trailMult);
      else       pos.trail=Math.min(pos.trail, bar.low+atr*pos.trailMult);
      const slHit=isLong?price<=pos.sl:price>=pos.sl;
      const trHit=isLong?price<=pos.trail:price>=pos.trail;
      const flip =isLong?(price<h4Ema50):(price>h4Ema50);
      let exitP=null, exitR=null;
      if(slHit){exitP=pos.sl;exitR="SL";}
      else if(trHit){exitP=pos.trail;exitR="TRAIL";}
      else if(flip){exitP=price;exitR="FLIP";}
      if(exitR){
        const pct=(isLong?1:-1)*(exitP-pos.entry)/pos.entry;
        const usd=equity*RISK*(pct/(Math.abs(pos.sl-pos.entry)/pos.entry));
        equity+=usd;
        trades.push({pnlUsd:usd, reason:exitR, entry:pos.entry, exit:exitP, side:pos.side,
                     openTime:new Date(c1h[pos.ob].time).toISOString().slice(0,10),
                     closeTime:new Date(bar.time).toISOString().slice(0,10)});
        pos=null;
      }
    }

    // ── Entry (구간 내에서만) ────────────────────────
    if(!inPeriod || pos) continue;

    const wBull=price>wEma50, wBear=price<wEma50;
    const h4Bull=price>h4Ema50, h4Bear=price<h4Ema50;
    let dir=null;
    if(wBull&&h4Bull) dir="long";
    else if(wBear&&h4Bear) dir="short";
    if(!dir) continue;
    if(h4Adx==null||h4Adx<=adxThreshold) continue;

    // 30분봉 2봉 브레이크아웃
    const i30=lowerTfIdx(bar.time, c30m);
    if(i30<0) continue;
    const bk=bk30m[i30];
    if(!bk||!bk.hh||!bk.ll) continue;
    const isLong=dir==="long";
    if(isLong?price<=bk.hh:price>=bk.ll) continue;

    const isBull=wBull&&isLong;
    const slM=isBull?SL_M.bull:SL_M.bear, trM=isBull?TR_M.bull:TR_M.bear;
    const sl=isLong?price-atr*slM:price+atr*slM;
    const trail=isLong?price-atr*trM:price+atr*trM;
    pos={side:dir, entry:price, sl, trail, trailMult:trM, atr, ob:i};
  }

  // 미청산 강제 청산
  if(pos){
    const lp=c1h.at(-1).close, isLong=pos.side==="long";
    const pct=(isLong?1:-1)*(lp-pos.entry)/pos.entry;
    const usd=equity*RISK*(pct/(Math.abs(pos.sl-pos.entry)/pos.entry));
    equity+=usd;
    trades.push({pnlUsd:usd,reason:"END",entry:pos.entry,exit:lp,side:pos.side,
                 openTime:new Date(c1h[pos.ob].time).toISOString().slice(0,10),
                 closeTime:new Date(c1h.at(-1).time).toISOString().slice(0,10)});
  }

  const wins=trades.filter(t=>t.pnlUsd>0), total=trades.length;
  const avgW=wins.length?wins.reduce((s,t)=>s+t.pnlUsd,0)/wins.length:0;
  const loss=trades.filter(t=>t.pnlUsd<=0);
  const avgL=loss.length?Math.abs(loss.reduce((s,t)=>s+t.pnlUsd,0)/loss.length):0;
  const rr=avgL>0?avgW/avgL:null;
  const pnl=equity-1000;
  const wr=total>0?wins.length/total*100:0;
  const expectancy=total>0?trades.reduce((s,t)=>s+t.pnlUsd,0)/total:0;
  return {total, wins:wins.length, losses:loss.length, wr, pnl, equity, rr, expectancy, trades};
}

// ─── Data Loader (구간 + 워밍업 포함) ────────────────────────────────────────

const WARMUP_DAYS = { "1H":120, "4H":120, "1W":500, "30m":2 };

async function loadPeriodData(symbol, period) {
  const startMs = toMs(period.start);
  const endMs   = toMs(period.end) + 86400000; // 하루 더 (마지막 날 포함)

  const fetch1H  = fetchRange(symbol,"1H",  startMs - WARMUP_DAYS["1H"]*86400000,  endMs);
  const fetch4H  = fetchRange(symbol,"4H",  startMs - WARMUP_DAYS["4H"]*86400000,  endMs);
  const fetchW   = fetchRange(symbol,"1W",  startMs - WARMUP_DAYS["1W"]*86400000,  endMs);
  const fetch30m = fetchRange(symbol,"30m", startMs - WARMUP_DAYS["30m"]*86400000, endMs);

  const [c1h, c4h, cW, c30m] = await Promise.all([fetch1H, fetch4H, fetchW, fetch30m]);

  const ema50w   = emaFull(cW.map(c=>c.close), 50);
  const ema50_4h = emaFull(c4h.map(c=>c.close), 50);
  const adx4h    = adxFull(c4h, 14);
  const atr1h    = atrFull(c1h, 14);
  const bk30m    = breakoutFull(c30m, 2);

  return { c1h, c4h, cW, c30m, ema50w, ema50_4h, adx4h, atr1h, bk30m,
           periodStartMs: startMs, periodEndMs: endMs };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function sign(n) { return (n>=0?"+$":"-$") + Math.abs(n).toFixed(2); }
function pct(n)  { return (n>=0?"+":"") + n.toFixed(1) + "%"; }

function printPeriodResult(period, result) {
  const {total,wins,losses,wr,pnl,rr,expectancy,trades} = result;
  const pnlColor = pnl>=0 ? "✅" : "❌";
  console.log(`  ${pnlColor} ${period.name.padEnd(22)} | 거래:${String(total).padStart(3)}건 | 승률:${wr.toFixed(0).padStart(3)}% | 손익비:${rr!=null?rr.toFixed(2).padStart(5):"  N/A"} | 기대값:${expectancy>=0?"+":""}$${Math.abs(expectancy).toFixed(2).padStart(5)} | PnL: ${sign(pnl).padStart(9)}`);
}

function printSummaryTable(symbol, results) {
  const byLabel = {};
  results.forEach(({period, result}) => {
    const l = period.label;
    if (!byLabel[l]) byLabel[l] = [];
    byLabel[l].push(result);
  });

  console.log(`\n  [${symbol} 국면별 평균]`);
  for (const [label, rs] of Object.entries(byLabel)) {
    const avgPnl = rs.reduce((s,r)=>s+r.pnl,0)/rs.length;
    const avgWr  = rs.reduce((s,r)=>s+r.wr,0)/rs.length;
    const avgTr  = rs.reduce((s,r)=>s+r.total,0)/rs.length;
    const emoji  = avgPnl>=0?"✅":"❌";
    console.log(`  ${emoji} ${label.padEnd(6)}  평균 PnL ${sign(avgPnl).padStart(9)}  평균 승률 ${avgWr.toFixed(0)}%  평균 거래수 ${avgTr.toFixed(1)}건`);
  }

  const totalPnl = results.reduce((s,{result})=>s+result.pnl,0);
  const allTrades = results.flatMap(({result})=>result.trades);
  const wins = allTrades.filter(t=>t.pnlUsd>0).length;
  const wr   = allTrades.length ? wins/allTrades.length*100 : 0;
  console.log(`\n  ── 전체 누적 (${results.length}개 구간) ──────────────────`);
  console.log(`  총 거래: ${allTrades.length}건 | 전체 승률: ${wr.toFixed(1)}% | 누적 PnL: ${sign(totalPnl)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const CFG = { BTCUSDT: { adxThreshold:25 }, ETHUSDT: { adxThreshold:20 } };

console.log("═".repeat(90));
console.log("  시장 국면별 백테스트");
console.log("  전략: 30분봉 2봉 BK | ADX BTC>25 / ETH>20 | 거래량 필터 없음");
console.log("═".repeat(90));

for (const symbol of SYMBOLS) {
  const cfg = CFG[symbol] ?? { adxThreshold:25 };
  console.log(`\n${"─".repeat(90)}`);
  console.log(`  ${symbol}  —  ADX > ${cfg.adxThreshold}`);
  console.log(`${"─".repeat(90)}`);

  const allResults = [];

  for (const period of PERIODS) {
    process.stdout.write(`  ${period.name.padEnd(22)} 데이터 수집 중... `);
    try {
      const data = await loadPeriodData(symbol, period);
      process.stdout.write("시뮬레이션...");
      const result = simulate(data, { ...cfg, periodStartMs: data.periodStartMs, periodEndMs: data.periodEndMs });
      process.stdout.write(" 완료\n");
      allResults.push({ period, result });
      printPeriodResult(period, result);
    } catch(err) {
      process.stdout.write(` ❌ 오류: ${err.message}\n`);
    }
  }

  printSummaryTable(symbol, allResults);
}

console.log("\n" + "═".repeat(90));
