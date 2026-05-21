/**
 * backtest-exits.mjs — 익절 전략 비교 백테스트
 *
 * 6가지 청산 전략을 9개 시장 국면 × BTC/ETH로 비교
 *
 * 청산 전략:
 *   A. 트레일 Only (기준)
 *   B. R1 50% 익절 + 나머지 트레일 (R1 도달 시 trail을 BEP로 이동)
 *   C. R2 전량 익절 (도달 못하면 트레일)
 *   D. R1 50% + R2 나머지 (둘 다 못하면 트레일)
 *   E. RSI(3) 과열 전량 익절 (롱>85, 숏<15)
 *   F. R1 50% + RSI 나머지
 *
 * 진입: 주봉 EMA(50) 기울기 필터 포함 (backtest-sideways [D] 최적안)
 * R1 = 진입가 ± ATR×3 | R2 = 진입가 ± ATR×6
 */

const args   = process.argv.slice(2);
const getArg = (k, d) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split("=")[1] : d; };
const SYMBOLS = getArg("symbol", "BTCUSDT,ETHUSDT").split(",");

// ─── 시장 국면 ────────────────────────────────────────────────────────────────

const PERIODS = [
  { name: "🐂 Bull Run 1",    label: "상승장", start: "2020-10-01", end: "2021-04-30" },
  { name: "🔻 ATH 조정",      label: "조정",   start: "2021-05-01", end: "2021-07-31" },
  { name: "🐂 Bull Run 2",    label: "상승장", start: "2021-08-01", end: "2021-11-30" },
  { name: "🐻 Bear Market",   label: "하락장", start: "2022-01-01", end: "2022-12-31" },
  { name: "🦀 Sideways 2023", label: "횡보",   start: "2023-01-01", end: "2023-09-30" },
  { name: "🐂 Bull Run 3",    label: "상승장", start: "2023-10-01", end: "2024-03-31" },
  { name: "🔻 Post-ATH 조정", label: "조정",   start: "2024-04-01", end: "2024-09-30" },
  { name: "🐂 Bull Run 4",    label: "상승장", start: "2024-10-01", end: "2025-01-31" },
  { name: "📉 조정 2025",      label: "하락장", start: "2025-02-01", end: "2025-05-16" },
];

// ─── 청산 전략 정의 ───────────────────────────────────────────────────────────

const EXIT_STRATEGIES = [
  { id: "A", name: "트레일 Only",           r1: false, r2: false, rsiEx: false },
  { id: "B", name: "R1 50% + 트레일",       r1: true,  r2: false, rsiEx: false },
  { id: "C", name: "R2 전량",               r1: false, r2: true,  rsiEx: false },
  { id: "D", name: "R1 50% + R2 나머지",    r1: true,  r2: true,  rsiEx: false },
  { id: "E", name: "RSI 과열 전량",         r1: false, r2: false, rsiEx: true  },
  { id: "F", name: "R1 50% + RSI 나머지",   r1: true,  r2: false, rsiEx: true  },
];

const toMs  = s => new Date(s + "T00:00:00Z").getTime();
const TF    = { "1H": "1h", "30m": "30m", "4H": "4h", "1W": "1w" };

// ─── Binance fetch ─────────────────────────────────────────────────────────────

async function fetchRange(symbol, interval, startMs, endMs) {
  const all = []; let from = startMs;
  while (from < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TF[interval]}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} ${interval} ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all.push(...data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })));
    if (data.length < 1000) break;
    from = data[data.length-1][0] + 1;
    await new Promise(r => setTimeout(r, 120));
  }
  return all;
}

// ─── Indicators (full series) ──────────────────────────────────────────────────

function emaFull(closes, p) {
  const k = 2/(p+1), out = new Array(closes.length).fill(null);
  let e = closes.slice(0,p).reduce((a,b)=>a+b,0)/p; out[p-1]=e;
  for (let i=p; i<closes.length; i++) { e=closes[i]*k+e*(1-k); out[i]=e; }
  return out;
}

function atrFull(c, p=14) {
  const n=c.length, trs=[0];
  for (let i=1;i<n;i++){const a=c[i],b=c[i-1];trs.push(Math.max(a.high-a.low,Math.abs(a.high-b.close),Math.abs(a.low-b.close)));}
  const out=new Array(n).fill(null);
  let s=trs.slice(1,p+1).reduce((a,b)=>a+b,0); out[p]=s/p;
  for (let i=p+1;i<n;i++){s=(out[i-1]*(p-1)+trs[i]); out[i]=s/p;}
  return out;
}

function adxFull(c, p=14) {
  const n=c.length, trs=[0], pDMs=[0], mDMs=[0];
  for(let i=1;i<n;i++){
    const a=c[i],b=c[i-1];
    trs.push(Math.max(a.high-a.low,Math.abs(a.high-b.close),Math.abs(a.low-b.close)));
    const up=a.high-b.high, dn=b.low-a.low;
    pDMs.push(up>dn&&up>0?up:0); mDMs.push(dn>up&&dn>0?dn:0);
  }
  const wilder=arr=>{
    let s=arr.slice(1,p+1).reduce((a,b)=>a+b,0);
    const r=new Array(p+1).fill(null); r[p]=s;
    for(let i=p+1;i<arr.length;i++){s=s-s/p+arr[i];r.push(s);} return r;
  };
  const aS=wilder(trs),pS=wilder(pDMs),mS=wilder(mDMs);
  const dx=aS.map((a,i)=>{if(!a)return null;const pd=100*pS[i]/a,md=100*mS[i]/a,sm=pd+md;return sm>0?100*Math.abs(pd-md)/sm:0;});
  const out=new Array(n).fill(null); const st=p*2; if(st>=dx.length)return out;
  let adx=dx.slice(p,st).filter(v=>v!=null).reduce((a,b)=>a+b,0)/p; out[st-1]=adx;
  for(let i=st;i<dx.length;i++){if(dx[i]!=null)adx=(adx*(p-1)+dx[i])/p; out[i]=adx;}
  return out;
}

function rsiFull(closes, p=3) {
  const out = new Array(closes.length).fill(null);
  for (let i=p; i<closes.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=closes[j]-closes[j-1]; if(d>0)g+=d; else l-=d; }
    const ag=g/p, al=l/p;
    out[i] = al===0 ? 100 : 100 - 100/(1+ag/al);
  }
  return out;
}

function breakoutFull(c, p) {
  return c.map((_,i)=>{
    if(i<p) return {hh:null,ll:null};
    const sl=c.slice(i-p,i);
    return {hh:Math.max(...sl.map(c=>c.high)),ll:Math.min(...sl.map(c=>c.low))};
  });
}

function lowerTfIdx(time, arr) {
  let lo=0, hi=arr.length-2, best=-1;
  while(lo<=hi){const m=(lo+hi)>>1; if(arr[m].time<=time){best=m;lo=m+1;}else hi=m-1;}
  return best;
}

// ─── Backtest Engine ───────────────────────────────────────────────────────────

function simulate(data, { adxThreshold, periodStartMs, periodEndMs }, exitStrategy) {
  const { c1h, c4h, cW, c30m, ema50w, ema50_4h, adx4h, atr1h, bk30m, rsi1h } = data;

  let pos=null, trades=[], equity=1000;
  const RISK=0.01, SL_M={bull:3,bear:2}, TR_M={bull:6,bear:4};
  const warmup=100;

  for (let i=warmup; i<c1h.length-1; i++) {
    const bar=c1h[i], price=bar.close, high=bar.high, low=bar.low;
    const inPeriod = bar.time>=periodStartMs && bar.time<=periodEndMs;

    const i4h=lowerTfIdx(bar.time,c4h), iW=lowerTfIdx(bar.time,cW);
    if(i4h<0||iW<0) continue;

    const wEma50=ema50w[iW], h4Ema50=ema50_4h[i4h], h4Adx=adx4h[i4h], atr=atr1h[i];
    const rsi=rsi1h[i];
    if(!wEma50||!h4Ema50||!atr) continue;

    // 주봉 EMA 기울기 (filter D)
    const prevWEma = iW>0 ? ema50w[iW-1] : null;
    const wSlopeUp   = prevWEma!==null && wEma50>prevWEma;
    const wSlopeDown = prevWEma!==null && wEma50<prevWEma;

    // ── Exit ─────────────────────────────────────────────
    if (pos) {
      const isLong=pos.side==="long";

      // 트레일 갱신
      if (isLong) pos.trail=Math.max(pos.trail, high-atr*pos.trailMult);
      else         pos.trail=Math.min(pos.trail, low +atr*pos.trailMult);

      // 주요 레벨
      const r1Price = isLong ? pos.entry+pos.atr*3 : pos.entry-pos.atr*3;
      const r2Price = isLong ? pos.entry+pos.atr*6 : pos.entry-pos.atr*6;
      const r1Hit   = isLong ? price>=r1Price : price<=r1Price;
      const r2Hit   = isLong ? price>=r2Price : price<=r2Price;
      const rsiExit = exitStrategy.rsiEx && rsi!==null &&
                      ((isLong&&rsi>85)||(!isLong&&rsi<15));

      // R1 50% 부분 익절 (첫 번째 도달 시)
      if (exitStrategy.r1 && !pos.r1Done && r1Hit) {
        const slDist = Math.abs(pos.sl-pos.entry);
        const gain   = isLong ? r1Price-pos.entry : pos.entry-r1Price;
        pos.halfPnl  = equity*RISK*0.5*(gain/slDist); // 나중에 합산
        pos.r1Done   = true;
        // BEP로 트레일 이동 (남은 50% 손실 방지)
        if (isLong) pos.trail=Math.max(pos.trail, pos.entry);
        else         pos.trail=Math.min(pos.trail, pos.entry);
      }

      // 전량 청산 조건 확인
      const slHit    = isLong ? price<=pos.sl    : price>=pos.sl;
      const trailHit = isLong ? price<=pos.trail  : price>=pos.trail;
      const flip     = isLong ? price<h4Ema50    : price>h4Ema50;

      let exitP=null, exitReason=null;
      if      (slHit)                               { exitP=pos.sl;    exitReason="SL"; }
      else if (trailHit)                            { exitP=pos.trail;  exitReason="TRAIL"; }
      else if (flip)                                { exitP=price;      exitReason="FLIP"; }
      else if (exitStrategy.r2 && r2Hit)            { exitP=r2Price;    exitReason="R2"; }
      else if (rsiExit)                             { exitP=price;      exitReason="RSI"; }

      if (exitP!==null) {
        const remaining = pos.r1Done ? 0.5 : 1.0;
        const slDist    = Math.abs(pos.sl-pos.entry);
        const gain      = isLong ? exitP-pos.entry : pos.entry-exitP;
        const usd       = equity*RISK*remaining*(gain/slDist);
        const totalUsd  = usd + (pos.halfPnl??0);
        equity += totalUsd;

        const wins_so_far=trades.filter(t=>t.pnlUsd>0).length;
        trades.push({
          pnlUsd: totalUsd, reason: exitReason+(pos.r1Done?"+R1":""),
          entry: pos.entry, exit: exitP, side: pos.side,
          r1Done: pos.r1Done??false,
          openTime:  new Date(c1h[pos.ob].time).toISOString().slice(0,10),
          closeTime: new Date(bar.time).toISOString().slice(0,10),
        });
        pos=null;
      }
    }

    // ── Entry (구간 내에서만) ──────────────────────────────
    if (!inPeriod||pos) continue;

    const wBull=price>wEma50, wBear=price<wEma50;
    const h4Bull=price>h4Ema50, h4Bear=price<h4Ema50;

    let dir=null;
    if (wBull&&wSlopeUp&&h4Bull) dir="long";
    else if (wBear&&wSlopeDown&&h4Bear) dir="short";
    if (!dir||!h4Adx||h4Adx<=adxThreshold) continue;

    const i30=lowerTfIdx(bar.time,c30m);
    if (i30<0) continue;
    const bk=bk30m[i30];
    if (!bk||!bk.hh||!bk.ll) continue;
    const isLong=dir==="long";
    if (isLong?price<=bk.hh:price>=bk.ll) continue;

    const isBull=wBull&&isLong;
    const slM=isBull?SL_M.bull:SL_M.bear, trM=isBull?TR_M.bull:TR_M.bear;
    const sl=isLong?price-atr*slM:price+atr*slM;
    const trail=isLong?price-atr*trM:price+atr*trM;
    pos={side:dir, entry:price, sl, trail, trailMult:trM, atr, ob:i, r1Done:false, halfPnl:0};
  }

  // 구간 종료 강제 청산
  if (pos) {
    const lp=c1h.at(-1).close, isLong=pos.side==="long";
    const remaining=pos.r1Done?0.5:1.0;
    const slDist=Math.abs(pos.sl-pos.entry);
    const gain=isLong?lp-pos.entry:pos.entry-lp;
    const usd=equity*RISK*remaining*(gain/slDist);
    const totalUsd=usd+(pos.halfPnl??0);
    equity+=totalUsd;
    trades.push({pnlUsd:totalUsd, reason:"END"+(pos.r1Done?"+R1":""),
                 entry:pos.entry, exit:lp, side:pos.side, r1Done:pos.r1Done??false,
                 openTime: new Date(c1h[pos.ob].time).toISOString().slice(0,10),
                 closeTime: new Date(c1h.at(-1).time).toISOString().slice(0,10)});
  }

  const wins=trades.filter(t=>t.pnlUsd>0);
  const loss=trades.filter(t=>t.pnlUsd<=0);
  const total=trades.length;
  const avgW=wins.length?wins.reduce((s,t)=>s+t.pnlUsd,0)/wins.length:0;
  const avgL=loss.length?Math.abs(loss.reduce((s,t)=>s+t.pnlUsd,0)/loss.length):0;
  const rr=avgL>0?avgW/avgL:null;
  const pnl=equity-1000;
  const wr=total>0?wins.length/total*100:0;
  return {total, wins:wins.length, losses:loss.length, wr, pnl, rr, trades};
}

// ─── Data Loader ──────────────────────────────────────────────────────────────

const WARMUP = {"1H":120,"4H":120,"1W":500,"30m":2};

async function loadData(symbol, period) {
  const startMs=toMs(period.start), endMs=toMs(period.end)+86400000;
  const [c1h,c4h,cW,c30m]=await Promise.all([
    fetchRange(symbol,"1H",  startMs-WARMUP["1H"] *86400000, endMs),
    fetchRange(symbol,"4H",  startMs-WARMUP["4H"] *86400000, endMs),
    fetchRange(symbol,"1W",  startMs-WARMUP["1W"] *86400000, endMs),
    fetchRange(symbol,"30m", startMs-WARMUP["30m"]*86400000, endMs),
  ]);
  const ema50w   = emaFull(cW.map(c=>c.close), 50);
  const ema50_4h = emaFull(c4h.map(c=>c.close), 50);
  const adx4h    = adxFull(c4h, 14);
  const atr1h    = atrFull(c1h, 14);
  const bk30m    = breakoutFull(c30m, 2);
  const rsi1h    = rsiFull(c1h.map(c=>c.close), 3);
  return {c1h,c4h,cW,c30m,ema50w,ema50_4h,adx4h,atr1h,bk30m,rsi1h,
          periodStartMs:startMs, periodEndMs:endMs};
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function sign(n) { return (n>=0?"+$":"-$")+Math.abs(n).toFixed(2); }

const CFG = { BTCUSDT:{adxThreshold:25}, ETHUSDT:{adxThreshold:20} };

console.log("═".repeat(110));
console.log("  익절 전략 비교 백테스트");
console.log("  진입: 주봉 EMA(50) 기울기 + 4H ADX | BTC>25 / ETH>20 | 30분봉 2봉 BK");
console.log("  R1 = 진입±ATR×3   R2 = 진입±ATR×6   RSI 과열: 롱>85 / 숏<15");
console.log("═".repeat(110));

for (const symbol of SYMBOLS) {
  const cfg = CFG[symbol]??{adxThreshold:25};

  console.log(`\n${"─".repeat(110)}`);
  console.log(`  ${symbol}  (ADX>${cfg.adxThreshold})`);
  console.log(`${"─".repeat(110)}`);

  // 헤더
  const hdr = "  구간".padEnd(26) + EXIT_STRATEGIES.map(s=>`[${s.id}] ${s.name}`.padEnd(22)).join("");
  console.log(hdr);
  console.log("─".repeat(110));

  const totals = EXIT_STRATEGIES.map(()=>({pnl:0, trades:0, wins:0}));

  for (const period of PERIODS) {
    process.stdout.write(`  ${period.name.padEnd(22)} 수집중... `);
    try {
      const data = await loadData(symbol, period);
      process.stdout.write("시뮬... ");

      const row = [period.name.padEnd(22)];
      EXIT_STRATEGIES.forEach((strat, si) => {
        const r = simulate(data, {...cfg, periodStartMs:data.periodStartMs, periodEndMs:data.periodEndMs}, strat);
        const mark = r.pnl>=0?"✅":"❌";
        row.push(`${mark} ${sign(r.pnl).padStart(8)} (${String(r.total).padStart(3)}건 ${r.wr.toFixed(0).padStart(2)}%)`);
        totals[si].pnl    += r.pnl;
        totals[si].trades += r.total;
        totals[si].wins   += r.wins;
      });
      process.stdout.write("완료\n");
      console.log("  " + row.join("  "));
    } catch(err) {
      process.stdout.write(`❌ ${err.message}\n`);
    }
  }

  // 합산
  console.log("─".repeat(110));
  const sumRow = ["[전체 합산]".padEnd(22)];
  totals.forEach(t => {
    const wr = t.trades>0?(t.wins/t.trades*100):0;
    const mark = t.pnl>=0?"✅":"❌";
    sumRow.push(`${mark} ${sign(t.pnl).padStart(8)} (${String(t.trades).padStart(3)}건 ${wr.toFixed(0).padStart(2)}%)`);
  });
  console.log("  " + sumRow.join("  "));

  // 랭킹
  console.log(`\n  ── ${symbol} 최종 랭킹 (누적 PnL 기준) ─────────────────────`);
  const ranked = EXIT_STRATEGIES.map((s,i)=>({...s, ...totals[i]}))
    .sort((a,b)=>b.pnl-a.pnl);
  const medals = ["🥇","🥈","🥉","4️⃣ ","5️⃣ ","6️⃣ "];
  ranked.forEach((s,i)=>{
    const wr=s.trades>0?(s.wins/s.trades*100):0;
    console.log(`  ${medals[i]} [${s.id}] ${s.name.padEnd(20)} 누적 ${sign(s.pnl).padStart(9)}  거래 ${s.trades}건  승률 ${wr.toFixed(0)}%`);
  });
}

console.log("\n" + "═".repeat(110));
