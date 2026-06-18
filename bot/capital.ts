#!/usr/bin/env bun
// Total capital across all configured markets: USDT cash + on-chain position value.
// Multi-market aware (sums every market in volume.config markets[], else TARGET_MARKET).
import { formatUnits, getAddress, type Address } from "viem";
import { loadRuntime } from "./config.ts";
import { initRead, getBalances, getUserState } from "./chain.ts";
import { buildWallets } from "./wallets.ts";
import { buildMarketSnapshot } from "./market.ts";
import { loadVolumeConfig } from "./volume-config.ts";

const rc = loadRuntime();
initRead({ rpc: rc.rpc, integratorAddress: rc.integratorAddress, integratorFeeBps: rc.integratorFeeBps });
const wallets = buildWallets(rc.wallets);
const cfg = loadVolumeConfig();
const marketAddrs = (cfg.markets?.length ? cfg.markets.map((m) => m.address) : [rc.targetMarket]).map((a) => getAddress(a) as Address);
const priceByMarket = new Map<string, Map<number, number>>();
for (const m of marketAddrs) {
  const snap = await buildMarketSnapshot(rc.restBase, m).catch(() => null);
  if (snap) priceByMarket.set(m.toLowerCase(), new Map(snap.outcomes.map((o) => [o.tokenId, o.price])));
}
const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
let tCash = 0, tPos = 0;
for (const w of wallets) {
  const addr = getAddress(w.address) as Address;
  const bal = await getBalances(addr);
  let pos = 0;
  for (const m of marketAddrs) {
    const pm = priceByMarket.get(m.toLowerCase());
    if (!pm) continue;
    const us = await getUserState(m, addr).catch(() => null);
    if (us) for (const h of us.holdings) pos += parseFloat(formatUnits(h.otHolding, 18)) * (pm.get(h.tokenId) ?? 0);
  }
  tCash += bal.usdt; tPos += pos;
  console.log(`  ${w.label.padEnd(10)} USDT ${n(bal.usdt).padStart(9)} | positions ${n(pos).padStart(9)} | total ${n(bal.usdt + pos).padStart(9)}`);
}
console.log(`\nTOTAL CAPITAL: $${n(tCash + tPos)}  (cash ${n(tCash)} + positions ${n(tPos)})`);
