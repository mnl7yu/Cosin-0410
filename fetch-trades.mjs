/**
 * BitGet 거래 내역 조회 — 수동 + 봇 실행 내역 모두 포함
 * 사용: node fetch-trades.mjs
 */

import "dotenv/config";
import crypto from "crypto";

const CONFIG = {
  apiKey: process.env.BITGET_API_KEY,
  secretKey: process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
  baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
};

function sign(timestamp, method, path, body = "") {
  return crypto
    .createHmac("sha256", CONFIG.secretKey)
    .update(`${timestamp}${method}${path}${body}`)
    .digest("base64");
}

async function bitgetGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;
  const timestamp = Date.now().toString();
  const sig = sign(timestamp, "GET", fullPath);

  const res = await fetch(`${CONFIG.baseUrl}${fullPath}`, {
    headers: {
      "ACCESS-KEY": CONFIG.apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.passphrase,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BitGet 거래 내역 조회");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── 1. 스팟 체결 내역 (filled orders) ──────────────────────────────────
  console.log("── Spot 체결 내역 ───────────────────────────────────────\n");

  const symbols = ["BTCUSDT", "ETHUSDT"];

  for (const symbol of symbols) {
    const data = await bitgetGet("/api/v2/spot/trade/fills", {
      symbol,
      limit: "20",
    });

    if (data.code !== "00000") {
      console.log(`  ${symbol}: 오류 — ${data.msg}`);
      continue;
    }

    const fills = data.data ?? [];
    if (fills.length === 0) {
      console.log(`  ${symbol}: 체결 내역 없음`);
      continue;
    }

    console.log(`  ${symbol} (최근 ${fills.length}건):`);
    console.log(`  ${"─".repeat(60)}`);
    fills.forEach(f => {
      const date = new Date(parseInt(f.cTime)).toISOString().replace("T", " ").slice(0, 19);
      const side = f.side === "buy" ? "매수" : "매도";
      const size = parseFloat(f.size).toFixed(6);
      const price = parseFloat(f.priceAvg).toLocaleString();
      const total = parseFloat(f.amount).toFixed(2);
      const fee = parseFloat(f.feeDetail?.totalFee ?? 0).toFixed(4);
      console.log(`  ${date} UTC  ${side.padEnd(4)}  ${size} @ $${price}  = $${total} USDT  수수료: ${fee}`);
    });
    console.log();
  }

  // ── 2. 스팟 주문 내역 (order history) ──────────────────────────────────
  console.log("── Spot 주문 내역 (최근 30일) ───────────────────────────\n");

  for (const symbol of symbols) {
    const data = await bitgetGet("/api/v2/spot/trade/history-orders", {
      symbol,
      limit: "20",
    });

    if (data.code !== "00000") {
      console.log(`  ${symbol}: 오류 — ${data.msg}`);
      continue;
    }

    const orders = data.data ?? [];
    if (orders.length === 0) {
      console.log(`  ${symbol}: 주문 내역 없음`);
      continue;
    }

    console.log(`  ${symbol} (최근 ${orders.length}건):`);
    console.log(`  ${"─".repeat(70)}`);
    orders.forEach(o => {
      const date = new Date(parseInt(o.cTime)).toISOString().replace("T", " ").slice(0, 19);
      const side = o.side === "buy" ? "매수" : "매도";
      const status = o.status;
      const size = parseFloat(o.size ?? 0).toFixed(6);
      const avgPrice = parseFloat(o.priceAvg ?? o.price ?? 0).toLocaleString();
      const total = parseFloat(o.fillTotalAmount ?? 0).toFixed(2);
      console.log(`  ${date} UTC  ${side.padEnd(4)}  ${size} @ $${avgPrice}  합계 $${total}  [${status}]`);
    });
    console.log();
  }

  // ── 3. 잔고 현황 ────────────────────────────────────────────────────────
  console.log("── 현재 잔고 ───────────────────────────────────────────\n");
  const assets = await bitgetGet("/api/v2/spot/account/assets");

  if (assets.code === "00000") {
    const nonZero = (assets.data ?? []).filter(a => parseFloat(a.available) > 0 || parseFloat(a.frozen) > 0);
    if (nonZero.length === 0) {
      console.log("  잔고 없음");
    } else {
      nonZero.forEach(a => {
        const avail = parseFloat(a.available).toFixed(6);
        const frozen = parseFloat(a.frozen).toFixed(6);
        console.log(`  ${a.coin.padEnd(6)} 사용가능: ${avail}  묶음: ${frozen}`);
      });
    }
  } else {
    console.log(`  잔고 조회 오류: ${assets.msg}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
}

main().catch(console.error);
