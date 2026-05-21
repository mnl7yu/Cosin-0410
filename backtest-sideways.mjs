/**
 * backtest-sideways.mjs — 횡보장 필터 비교 백테스트
 *
 * 테스트할 필터:
 *   A. 없음 (기존 전략 — 비교 기준)
 *   B. 주봉 ADX > 18
 *   C. 주봉 ADX > 20
 *   D. 주봉 EMA(50) 기울기 (롱: 상승 / 숏: 하락)
 *   E. 주봉 ADX > 18 + EMA 기울기 (복합)
 *   F. 주봉 ADX > 20 + EMA 기울기 (복합)
 *
 * 핵심 전략 설정:
 *   BTC: 30분봉 2봉 BK | 4H ADX > 25
 *   ETH: 30분봉 2봉 BK | 4H ADX > 20
 */

const args   = process.argv.slice(2);
const getArg = (k, d) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split("=")[1] : d; };
const SYMBOLS = getArg("symbol", "BTCUSDT,ETHUSDT").split(",");

// ─── 시장 국면 ────────────────────────────────────────────────────────────────

const PERIODS = [
  { name: "🐂 Bull Run 1",      label: "상승장", start: "2020-10-01", end: "2021-04-30" },
  { name: "🔻 ATH 조정",        label: "조정",   start: "2021-05-01", end: "2021-07-31" },
  { name: "🐂 Bull Run 2",      label: "상승장", start: "2021-08-01", end: "2021-11-30" },
  { name: "🐻 Bear Market",     label: "하락장", start: "2022-01-01", end: "2022-12-31" },
  { name: "🦀 Sideways 2023",   label: "횡보",   start: "2023-01-01", end: "2023-09-30" },
  { name: "🐂 Bull Run 3",      label: "상승장", start: "2023-10-01", end: "2024-03-31" },
  { name: "🔻 Post-ATH 조정",   label: "조정",   start: "2024-04-01", end: "2024-09-30" },
  { name: "🐂 Bull Run 4",      label: "상승장", start: "2024-10-01", end: "2025-01-31" },
  { name: "📉 최근 조정 2025",   label: "하락장", start: "2025-02-01", end: "2025-05-16" },
];

// ─── 횡보장 필터 정의 ────────────────────────────────────────────────────────

const FILTERS = [
  { id: "A", name: "없음 (기준)",           wAdx: null,  slope: false },
  { id: "B", name: "주봉 ADX > 18",         wAdx: 18,    slope: false },
  { id: "C", name: "주봉 ADX > 20",         wAdx: 20,    slope: false },
  { id: "D", name: "EMA 기울기",            wAdx: null,  slope: true  },
  { id: "E", name: "ADX>18 + EMA 기울기",   wAdx: 18,    slope: true  },
  { id: "F", name: "ADX>20 + EMA 기울기",   wAdx: 20,    slope: true  },
];

const toMs = s => new Date(s + "T00:00:00Z").getTime();
const TF   = { "1H":"1h", "30m":"30m", "4H":"4h", "1W":"1w" };

// ─── Binance fetch ────────────────────────────────────────────────────────────

async function fetchRange(symbol, interval, startMs, endMs) {
  const all = []; let from = startMs;
  while (from < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TF[interval]}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} ${interval} ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all.push(...data.map(k => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })));
    if (data.length < 1000) break;
    from = data[data.length-1][0] + 1;
    await new Promise(r => setTimeout(r, 120));
  }
  return all;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaFull(closes, p) {
  const k=2/(p+1), out=new Array(closes.length).fill(null);
  let e=closes.slice(0,p).reduce((a,b)=>a+b,0)/p; out[p-1]=e;
  for(let i=p;i<closes.length;i++){e=closes[i]*k+e*(1-k);out[i]=e;}
  return out;
}

function atrFull(c, p=14) {
  const n=c.length, trs=[0];
  for(let i=1;i<n;i++){const a=c[i],b=c[i-1];trs.push(Math.max(a.high-a.low,Math.abs(a.high-b.close),Math.abs(a.low-b.close)));}
  const out=new Array(n).fill(null);
  let s=trs.slice(1,p+1).reduce((a,b)=>a+b,0); out[p]=s/p;
  for(let i=p+1;i<n;i++){s=(out[i-1]*(p-1)+trs[i]);out[i]=s/p;}
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
  const w=arr=>{let s=arr.slice(1,p+1).reduce((a,b)=>a+b,0);const r=new Array(p+1).fill(null);r[p]=s;for(let i=p+1;i<arr.length;i++){s=s-s/p+arr[i];r.push(s);}return r;};
  const aS=w(trs),pS=w(pDMs),mS=w(mDMs);
  const dx=aS.map((a,i)=>{if(!a||a===0)return null;const pd=100*pS[i]/a,md=100*mS[i]/a,sm=pd+md;return sm>0?100*Math.abs(pd-md)/sm:0;});
  const out=new Array(n).fill(null); const st=p*2; if(st>=dx.length)return out;
  let adx=dx.slice(p,st).filter(v=>v!=null).reduce((a,b)=>a+b,0)/p; out[st-1]=adx;
  for(let i=st;i<dx.length;i++){if(dx[i]!=null)adx=(adx*(p-1)+dx[i])/p;out[i]=adx;}
  return out;
}

function breakoutFull(c, p) {
  return c.map((_,i)=>{if(i<p)return{hh:null,ll:null};const sl=c.slice(i-p,i);return{hh:Math.max(...sl.map(x=>x.high)),ll:Math.min(...sl.map(x=>x.low))};});
}

function lowerTfIdx(time, higher) {
  let lo=0,hi=higher.length-2,best=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(higher[m].time<=time){best=m;lo=m+1;}else hi=m-1;}
  return best;
}

// ─── Simulator ────────────────────────────────────────────────────────────────

function simulate(data, cfg, filter) {
  const { c1h, c4h, cW, c30m, ema50w, ema50_4h, adx4h, adxW, atr1h, bk30m, periodStartMs, periodEndMs } = data;
  const { adxThreshold } = cfg;
  const { wAdx, slope } = filter;

  let pos=null, trades=[], equity=1000;
  const RISK=0.01, SL_M={bull:3,bear:2}, TR_M={bull:6,bear:4};

  for(let i=100; i<c1h.length-1; i++){
    const bar=c1h[i], price=bar.close, high=bar.high;
    const inPeriod = bar.time>=periodStartMs && bar.time<=periodEndMs;

    const i4h=lowerTfIdx(bar.time,c4h), iW=lowerTfIdx(bar.time,cW);
    if(i4h<0||iW<0) continue;
    const wEma50=ema50w[iW], h4Ema50=ema50_4h[i4h], h4Adx=adx4h[i4h], atr=atr1h[i];
    if(!wEma50||!h4Ema50||!atr) continue;

    // ── Exit ───────────────────────────────────────────
    if(pos){
      const isLong=pos.side==="long";
      if(isLong) pos.trail=Math.max(pos.trail,high-atr*pos.trailMult);
      else       pos.trail=Math.min(pos.trail,bar.low+atr*pos.trailMult);
      const slHit=isLong?price<=pos.sl:price>=pos.sl;
      const trHit=isLong?price<=pos.trail:price>=pos.trail;
      const flip=isLong?(price<h4Ema50):(price>h4Ema50);
      let ep=null,er=null;
      if(slHit){ep=pos.sl;er="SL";}
      else if(trHit){ep=pos.trail;er="TRAIL";}
      else if(flip){ep=price;er="FLIP";}
      if(er){
        const pct=(isLong?1:-1)*(ep-pos.entry)/pos.entry;
        const usd=equity*RISK*(pct/(Math.abs(pos.sl-pos.entry)/pos.entry));
        equity+=usd;
        trades.push({pnlUsd:usd,reason:er});
        pos=null;
      }
    }

    if(!inPeriod||pos) continue;

    // ── 횡보장 필터 ────────────────────────────────────
    const wBull=price>wEma50, wBear=price<wEma50;
    const h4Bull=price>h4Ema50, h4Bear=price<h4Ema50;
    let dir=null;
    if(wBull&&h4Bull) dir="long";
    else if(wBear&&h4Bear) dir="short";
    if(!dir) continue;

    // A. 4H ADX 기본 필터
    if(h4Adx==null||h4Adx<=adxThreshold) continue;

    // B/C. 주봉 ADX 필터
    if(wAdx!=null){
      const wAdxVal=adxW[iW];
      if(wAdxVal==null||wAdxVal<=wAdx) continue;
    }

    // D. 주봉 EMA 기울기 필터
    if(slope){
      const prevW=ema50w[iW-1];
      if(prevW==null) continue;
      const isLong=dir==="long";
      // 롱: 주봉 EMA 상승 중, 숏: 주봉 EMA 하락 중
      if(isLong && wEma50<=prevW) continue;
      if(!isLong && wEma50>=prevW) continue;
    }

    // ── 30분봉 2봉 브레이크아웃 ───────────────────────
    const i30=lowerTfIdx(bar.time,c30m);
    if(i30<0) continue;
    const bk=bk30m[i30];
    if(!bk||!bk.hh||!bk.ll) continue;
    const isLong=dir==="long";
    if(isLong?price<=bk.hh:price>=bk.ll) continue;

    const isBull=wBull&&isLong;
    const slM=isBull?SL_M.bull:SL_M.bear, trM=isBull?TR_M.bull:TR_M.bear;
    const sl=isLong?price-atr*slM:price+atr*slM;
    const trail=isLong?price-atr*trM:price+atr*trM;
    pos={side:dir,entry:price,sl,trail,trailMult:trM,atr,ob:i};
  }

  if(pos){
    const lp=c1h.at(-1).close, isLong=pos.side==="long";
    const pct=(isLong?1:-1)*(lp-pos.entry)/pos.entry;
    const usd=equity*RISK*(pct/(Math.abs(pos.sl-pos.entry)/pos.entry));
    equity+=usd;
    trades.push({pnlUsd:usd,reason:"END"});
  }

  const wins=trades.filter(t=>t.pnlUsd>0), total=trades.length;
  const avgW=wins.length?wins.reduce((s,t)=>s+t.pnlUsd,0)/wins.length:0;
  const loss=trades.filter(t=>t.pnlUsd<=0);
  const avgL=loss.length?Math.abs(loss.reduce((s,t)=>s+t.pnlUsd,0)/loss.length):0;
  const rr=avgL>0?avgW/avgL:null;
  return {
    total, wins:wins.length, losses:loss.length,
    wr:total>0?wins.length/total*100:0,
    pnl:equity-1000, rr,
    expectancy:total>0?trades.reduce((s,t)=>s+t.pnlUsd,0)/total:0,
  };
}

// ─── Data Loader ─────────────────────────────────────────────────────────────

async function loadData(symbol, period) {
  const startMs = toMs(period.start);
  const endMs   = toMs(period.end) + 86400000;
  const W120    = 120*86400000, W500 = 500*86400000, W2 = 2*86400000;

  const [c1h, c4h, cW, c30m] = await Promise.all([
    fetchRange(symbol, "1H",  startMs-W120, endMs),
    fetchRange(symbol, "4H",  startMs-W120, endMs),
    fetchRange(symbol, "1W",  startMs-W500, endMs),
    fetchRange(symbol, "30m", startMs-W2,   endMs),
  ]);

  return {
    c1h, c4h, cW, c30m,
    ema50w:   emaFull(cW.map(c=>c.close),  50),
    ema50_4h: emaFull(c4h.map(c=>c.close), 50),
    adx4h:    adxFull(c4h, 14),
    adxW:     adxFull(cW,  14),   // 주봉 ADX
    atr1h:    atrFull(c1h, 14),
    bk30m:    breakoutFull(c30m, 2),
    periodStartMs: startMs, periodEndMs: endMs,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function s(n){ return (n>=0?"+$":"-$")+Math.abs(n).toFixed(2); }

function printFilterComparison(symbol, allData) {
  // allData: { period, results: { filterId -> result } }[]
  const LINE = "─".repeat(100);

  // ── 구간별 필터 비교 ──────────────────────────────
  console.log(`\n${"═".repeat(100)}`);
  console.log(`  ${symbol}  필터별 구간 비교`);
  console.log("═".repeat(100));

  // 헤더
  const hdr = "  구간".padEnd(24) + FILTERS.map(f=>(` [${f.id}] ${f.name}`).padEnd(22)).join("");
  console.log(hdr);
  console.log(LINE);

  for(const {period, results} of allData){
    const cols = FILTERS.map(f=>{
      const r=results[f.id];
      if(!r) return " ".repeat(22);
      const icon=r.pnl>=0?"✅":"❌";
      return ` ${icon} ${s(r.pnl).padStart(9)} (${String(r.total).padStart(3)}건 ${r.wr.toFixed(0).padStart(2)}%)`.padEnd(22);
    }).join("");
    console.log(`  ${period.name.padEnd(22)}${cols}`);
  }

  // ── 필터별 전체 합산 ──────────────────────────────
  console.log(LINE);
  console.log("  [전체 합산]".padEnd(24) + FILTERS.map(f=>{
    const totPnl=allData.reduce((s,{results})=>s+(results[f.id]?.pnl??0),0);
    const totTr =allData.reduce((s,{results})=>s+(results[f.id]?.total??0),0);
    const allW  =allData.reduce((s,{results})=>s+(results[f.id]?.wins??0),0);
    const wr    =totTr>0?allW/totTr*100:0;
    const icon  =totPnl>=0?"✅":"❌";
    return (` ${icon} ${s(totPnl).padStart(9)} (${String(totTr).padStart(3)}건 ${wr.toFixed(0).padStart(2)}%)`).padEnd(22);
  }).join(""));

  // ── 국면별 합산 ───────────────────────────────────
  console.log(`\n${"─".repeat(100)}`);
  console.log("  [국면별 필터 효과]");
  console.log(`${"─".repeat(100)}`);
  const labels = [...new Set(PERIODS.map(p=>p.label))];
  for(const label of labels){
    const periodGroup=allData.filter(({period})=>period.label===label);
    if(!periodGroup.length) continue;
    process.stdout.write(`  ${"  "+label}`.padEnd(10));
    for(const f of FILTERS){
      const pnl=periodGroup.reduce((s,{results})=>s+(results[f.id]?.pnl??0),0);
      const tr =periodGroup.reduce((s,{results})=>s+(results[f.id]?.total??0),0);
      process.stdout.write(` [${f.id}] ${s(pnl).padStart(9)} (${String(tr).padStart(3)}건)  `);
    }
    console.log();
  }

  // ── 최종 추천 ─────────────────────────────────────
  const ranked = FILTERS.map(f=>{
    const totPnl=allData.reduce((s,{results})=>s+(results[f.id]?.pnl??0),0);
    const totTr =allData.reduce((s,{results})=>s+(results[f.id]?.total??0),0);
    const allW  =allData.reduce((s,{results})=>s+(results[f.id]?.wins??0),0);
    // 횡보 구간 PnL (가장 중요)
    const sidewaysPnl=allData.filter(({period})=>period.label==="횡보").reduce((s,{results})=>s+(results[f.id]?.pnl??0),0);
    return { f, totPnl, totTr, wr:totTr>0?allW/totTr*100:0, sidewaysPnl };
  }).sort((a,b)=>b.totPnl-a.totPnl);

  console.log(`\n${"─".repeat(100)}`);
  console.log("  최종 필터 랭킹 (누적 PnL 기준)");
  console.log(`${"─".repeat(100)}`);
  const medals=["🥇","🥈","🥉","4️⃣ ","5️⃣ ","6️⃣ "];
  ranked.forEach(({f,totPnl,totTr,wr,sidewaysPnl},i)=>{
    const spnl = sidewaysPnl>=0?`+$${sidewaysPnl.toFixed(2)}`:`-$${Math.abs(sidewaysPnl).toFixed(2)}`;
    console.log(`  ${medals[i]}  [${f.id}] ${f.name.padEnd(22)}  누적 ${s(totPnl).padStart(10)}  거래 ${totTr}건  승률 ${wr.toFixed(0)}%  횡보 PnL: ${spnl}`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const CFG = { BTCUSDT:{adxThreshold:25}, ETHUSDT:{adxThreshold:20} };

console.log("═".repeat(100));
console.log("  횡보장 필터 비교 백테스트");
console.log("  기본 전략: 30분봉 2봉 BK | 4H ADX BTC>25 / ETH>20 | 거래량 필터 없음");
console.log(`  테스트 필터: ${FILTERS.map(f=>`[${f.id}] ${f.name}`).join(" | ")}`);
console.log("═".repeat(100));

for(const symbol of SYMBOLS){
  const cfg = CFG[symbol] ?? {adxThreshold:25};
  console.log(`\n  ${symbol} 데이터 수집 중 (9개 구간 × ${FILTERS.length}개 필터)...`);

  const allData = [];
  for(const period of PERIODS){
    process.stdout.write(`  · ${period.name.padEnd(22)} `);
    try {
      const data = await loadData(symbol, period);
      process.stdout.write("시뮬...");
      const results = {};
      for(const f of FILTERS) results[f.id] = simulate(data, cfg, f);
      process.stdout.write(" 완료\n");
      allData.push({period, results});
    } catch(err){
      process.stdout.write(` ❌ ${err.message}\n`);
    }
  }

  printFilterComparison(symbol, allData);
}

console.log("\n" + "═".repeat(100));
