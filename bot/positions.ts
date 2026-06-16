#!/usr/bin/env bun
// Live per-wallet snapshot: USDT balance + REAL on-chain position value
// (holdings × current price), summed and broken down. Unlike `bot/bot.ts status`
// (which reads the rules-engine position list), this reads getUserState directly,
// so it reflects volume/campaign holdings. Read-only.
//   bun bot/positions.ts
import { formatUnits, getAddress, type Address } from "viem";
import { loadRuntime } from "./config.ts";
import { initRead, getBalances, getUserState } from "./chain.ts";
import { buildWallets } from "./wallets.ts";
import { buildMarketSnapshot } from "./market.ts";

const rc = loadRuntime();
initRead({ rpc: rc.rpc, integratorAddress: rc.integratorAddress, integratorFeeBps: rc.integratorFeeBps });
const wallets = buildWallets(rc.wallets);
const snap = await buildMarketSnapshot(rc.restBase, rc.targetMarket);
const priceByToken = new Map(snap.outcomes.map((o) => [o.tokenId, o.price]));
const nameByToken = new Map(snap.outcomes.map((o) => [o.tokenId, o.name]));
const mkt = getAddress(rc.targetMarket) as Address;
const n = (x: number, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

let tUsdt = 0;
let tPos = 0;
console.log(`\n=== Live balances + position value | ${snap.question} ===\n`);
for (const w of wallets) {
  const addr = getAddress(w.address) as Address;
  const [bal, us] = await Promise.all([getBalances(addr), getUserState(mkt, addr)]);
  let posVal = 0;
  const holds = us.holdings
    .map((h) => ({
      name: nameByToken.get(h.tokenId) ?? `#${h.tokenId}`,
      ot: parseFloat(formatUnits(h.otHolding, 18)),
      price: priceByToken.get(h.tokenId) ?? 0,
    }))
    .filter((h) => h.ot > 1e-9)
    .sort((a, b) => b.ot * b.price - a.ot * a.price);
  for (const h of holds) posVal += h.ot * h.price;
  tUsdt += bal.usdt;
  tPos += posVal;
  console.log(
    `${w.label.padEnd(10)} ${w.address.slice(0, 8)}…  USDT ${n(bal.usdt).padStart(9)}  | positions ${n(posVal).padStart(9)}  | total ${n(bal.usdt + posVal).padStart(9)}  (BNB ${n(bal.bnb, 4)})`,
  );
  for (const h of holds)
    console.log(`            └ ${h.name.padEnd(12)} ${n(h.ot, 1).padStart(12)} OT @ ${n(h.price, 4)} = ${n(h.ot * h.price).padStart(8)} USDT`);
}
console.log(`\nTOTAL      USDT ${n(tUsdt)}  | positions ${n(tPos)}  | portfolio ${n(tUsdt + tPos)} USDT\n`);
