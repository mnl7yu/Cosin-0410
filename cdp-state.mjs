/**
 * tv chart_get_state — reads full chart state from TradingView via CDP
 * Output: symbol, timeframe, OHLCV, indicators, bid/ask
 */

const PAGE_ID = "EA2688E6E9E01C58989E814EE57EC4D6";
const WS_URL = `ws://localhost:9222/devtools/page/${PAGE_ID}`;
let msgId = 1;

async function cdpEval(ws, expression, pending) {
  const id = msgId++;
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function getChartState(ws, pending) {
  return await cdpEval(ws, `
    (() => {
      const state = { symbol: null, timeframe: null, ohlcv: {}, indicators: [], orderBook: {} };

      // ── Symbol + Timeframe from internal API ────────────────────────────
      try {
        const col = window._exposed_chartWidgetCollection;
        const widget = col.activeChartWidget?._value;
        const sym = widget?._symbolWV?._value;
        if (sym) {
          state.symbol = sym.ticker ?? sym.full_name ?? sym.name;
          state.exchange = sym.exchange;
          state.description = sym.description;
          state.type = sym.type;
        }
        const intervalWV = widget?._defInterval?._value;
        if (intervalWV) state.timeframe_raw = intervalWV;
      } catch(e) { state._symbolErr = e.message; }

      // Timeframe human label
      const tfMap = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
                      '60': '1H', '120': '2H', '240': '4H', 'D': '1D', 'W': '1W' };
      if (state.timeframe_raw) state.timeframe = tfMap[state.timeframe_raw] ?? state.timeframe_raw + 'm';

      // ── OHLCV from DOM ──────────────────────────────────────────────────
      try {
        const labelMap = { '시': 'open', '고': 'high', '저': 'low', '종': 'close', '볼륨': 'volume',
                           'O': 'open', 'H': 'high', 'L': 'low', 'C': 'close', 'Vol': 'volume' };
        document.querySelectorAll('.valueItem-l31H9iuA').forEach(el => {
          const text = el.textContent.trim();
          for (const [label, key] of Object.entries(labelMap)) {
            if (text.startsWith(label)) {
              const val = el.querySelector('.valueValue-l31H9iuA')?.textContent?.trim()
                       ?? text.replace(label, '').trim();
              if (val) state.ohlcv[key] = parseFloat(val.replace(/,/g, '')) || val;
            }
          }
        });

        // Change
        const changeEl = document.querySelector('.valueItem-l31H9iuA:not(.unimportant-l31H9iuA):not(.blockHidden-e6PF69Df)');
        const changeText = changeEl?.textContent?.trim();
        if (changeText && changeText.includes('%')) state.ohlcv.change = changeText;
      } catch(e) { state._ohlcvErr = e.message; }

      // ── Order book (bid/ask) ────────────────────────────────────────────
      try {
        const sell = document.querySelector('.sellButton-SXMXfs_Z .buttonText-SXMXfs_Z, [class*="sellButton"] [class*="buttonText"]');
        const buy  = document.querySelector('.buyButton-SXMXfs_Z .buttonText-SXMXfs_Z, [class*="buyButton"] [class*="buttonText"]');
        const spread = document.querySelector('.spread-SXMXfs_Z, [class*="spread"]');
        if (sell) state.orderBook.ask = parseFloat(sell.textContent.replace(/,/g, ''));
        if (buy)  state.orderBook.bid = parseFloat(buy.textContent.replace(/,/g, ''));
        if (spread) state.orderBook.spread = parseFloat(spread.textContent.replace(/,/g, ''));
      } catch(e) {}

      // ── Indicators from legend ──────────────────────────────────────────
      try {
        document.querySelectorAll('.item-l31H9iuA.study-l31H9iuA').forEach(el => {
          const fullText = el.textContent.trim();

          // Get indicator name (everything before the values)
          const titleEl = el.querySelector('[class*="titleWrapper"], [class*="inputTitle"]');
          // First title wrapper = indicator name
          const allTitles = Array.from(el.querySelectorAll('[class*="titleWrapper"]'));
          const name = allTitles[0]?.textContent?.trim();

          // Get all numeric values
          const valueEls = el.querySelectorAll('.valueItem-l31H9iuA');
          const values = Array.from(valueEls)
            .map(v => v.textContent.trim())
            .filter(v => v && v !== '∅' && !/^[A-Za-z가-힣]+$/.test(v));

          // Get the valuesWrapper text to extract clean numbers
          const valuesWrapper = el.querySelector('[class*="valuesWrapper"]');
          const rawValues = valuesWrapper?.textContent?.trim()?.split('∅').map(s => s.trim()).filter(Boolean) ?? [];

          if (name || rawValues.length > 0) {
            state.indicators.push({
              name: name ?? 'Unknown',
              values: rawValues.length > 0 ? rawValues : values,
              raw: fullText.slice(0, 100)
            });
          }
        });
      } catch(e) { state._indicatorsErr = e.message; }

      return state;
    })()
  `, pending);
}

async function main() {
  const ws = new WebSocket(WS_URL);
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  const result = await getChartState(ws, pending);
  const state = result?.result?.value;

  if (!state) { console.log("No data"); ws.close(); return; }

  // ── Pretty print ──────────────────────────────────────────────────────────
  console.log("\n══ TradingView Chart State ════════════════════════════════");
  console.log(`  Symbol:    ${state.symbol ?? 'unknown'}`);
  if (state.description) console.log(`  Name:      ${state.description}`);
  if (state.exchange)    console.log(`  Exchange:  ${state.exchange}`);
  console.log(`  Timeframe: ${state.timeframe ?? state.timeframe_raw ?? 'unknown'}`);

  console.log("\n── Price ────────────────────────────────────────────────");
  const o = state.ohlcv;
  if (o.open)   console.log(`  Open:   ${o.open}`);
  if (o.high)   console.log(`  High:   ${o.high}`);
  if (o.low)    console.log(`  Low:    ${o.low}`);
  if (o.close)  console.log(`  Close:  ${o.close}  ${o.change ?? ''}`);
  if (o.volume) console.log(`  Volume: ${o.volume}`);

  if (state.orderBook.bid || state.orderBook.ask) {
    console.log("\n── Order Book ───────────────────────────────────────────");
    if (state.orderBook.ask)    console.log(`  Ask (Sell): ${state.orderBook.ask}`);
    if (state.orderBook.spread) console.log(`  Spread:     ${state.orderBook.spread}`);
    if (state.orderBook.bid)    console.log(`  Bid (Buy):  ${state.orderBook.bid}`);
  }

  if (state.indicators.length > 0) {
    console.log("\n── Indicators ───────────────────────────────────────────");
    state.indicators.forEach(ind => {
      const vals = ind.values.join(' | ');
      console.log(`  ${ind.name}: ${vals}`);
    });
  } else {
    console.log("\n── Indicators ───────────────────────────────────────────");
    console.log("  (no indicator data extracted — check legend visibility)");
  }

  console.log("\n══════════════════════════════════════════════════════════\n");

  ws.close();
}

main().catch(console.error);
