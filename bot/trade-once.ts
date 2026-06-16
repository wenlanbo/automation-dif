#!/usr/bin/env bun
// Deliberate one-off REAL trade (independent of the autonomous loop / DRY_RUN).
//   bun bot/trade-once.ts <outcomeName> <buyUsdt> <holdSeconds> [slippagePct] [walletEnv]
// e.g. bun bot/trade-once.ts France 1 5 3
//
// Buys <buyUsdt> of the named outcome on TARGET_MARKET, waits <holdSeconds>,
// then sells the ENTIRE holding of that outcome. Logs balance deltas per trade.
// Always executes for real — this is an explicit manual tool, not the loop.
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { loadRuntime } from "./config.ts";
import * as chain from "./chain.ts";
import * as notify from "./notify.ts";
import { buildMarketSnapshot } from "./market.ts";

const TICK_WEI = 10n ** 16n; // 0.01 OT tick

function fmt(n: number, d = 6): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

async function main() {
  const rc = loadRuntime();
  const outcomeName = (process.argv[2] ?? "France").trim();
  const buyUsdt = parseFloat(process.argv[3] ?? "1");
  const holdSec = parseInt(process.argv[4] ?? "5", 10);
  const slippagePct = parseFloat(process.argv[5] ?? "3");
  const walletEnv = process.argv[6] ?? "WALLET_1_KEY";

  if (!(buyUsdt > 0)) throw new Error("buyUsdt must be > 0");
  const key = process.env[walletEnv];
  if (!key) throw new Error(`${walletEnv} not set in environment`);

  chain.initRead({
    rpc: rc.rpc,
    integratorAddress: rc.integratorAddress,
    integratorFeeBps: rc.integratorFeeBps,
  });
  notify.initNotify({ slackWebhook: rc.slackWebhook, dryRun: false });

  const signer = chain.makeSigner(key);
  const addr = getAddress(signer.address) as Address;
  const market = getAddress(rc.targetMarket) as Address;

  console.log(`\n=== REAL ONE-OFF TRADE ===`);
  console.log(`Wallet:  ${addr}`);
  console.log(`Market:  ${market}`);

  // Resolve the outcome's on-chain tokenId by name from the live snapshot.
  const snap = await buildMarketSnapshot(rc.restBase, market);
  const oc = snap.outcomes.find(
    (o) => o.name.toLowerCase() === outcomeName.toLowerCase(),
  );
  if (!oc) throw new Error(`outcome "${outcomeName}" not found in market`);
  const tokenId = oc.tokenId;
  console.log(`Outcome: ${oc.name} (tokenId ${tokenId}) @ ${fmt(oc.price)} USDT\n`);

  // --- balance helper: BNB, USDT, and this outcome's OT holding ---
  async function snapshotBals() {
    const [bal, us] = await Promise.all([
      chain.getBalances(addr),
      chain.getUserState(market, addr),
    ]);
    const h = us.holdings.find((x) => x.tokenId === tokenId);
    const otWei = h ? h.otHolding : 0n;
    return { bnb: bal.bnb, usdt: bal.usdt, otWei, ot: parseFloat(formatUnits(otWei, 18)) };
  }

  function logDelta(title: string, a: any, b: any, txHash?: string) {
    console.log(`\n----- ${title} -----`);
    console.log(`  BNB :  ${fmt(a.bnb)}  ->  ${fmt(b.bnb)}   (Δ ${fmt(b.bnb - a.bnb)})  [gas]`);
    console.log(`  USDT:  ${fmt(a.usdt, 4)}  ->  ${fmt(b.usdt, 4)}   (Δ ${fmt(b.usdt - a.usdt, 4)})`);
    console.log(`  ${oc!.name} OT:  ${fmt(a.ot)}  ->  ${fmt(b.ot)}   (Δ ${fmt(b.ot - a.ot)})`);
    if (txHash) console.log(`  tx: ${txHash}`);
  }

  // === BEFORE ===
  const b0 = await snapshotBals();
  console.log(`Starting balances → BNB ${fmt(b0.bnb)} | USDT ${fmt(b0.usdt, 4)} | ${oc.name} OT ${fmt(b0.ot)}`);
  if (b0.usdt < buyUsdt) throw new Error(`insufficient USDT: have ${fmt(b0.usdt, 4)}, need ${buyUsdt}`);
  if (b0.bnb < 0.0015) throw new Error(`insufficient BNB for gas: have ${fmt(b0.bnb)}`);

  // === BUY ===
  console.log(`\nBuying ${buyUsdt} USDT of ${oc.name} (slippage ${slippagePct}%)...`);
  const buySim = await chain.simulateBuy(market, tokenId, buyUsdt);
  console.log(`  sim: ~${fmt(parseFloat(formatUnits(buySim.otToUserWei, 18)))} OT, cost ${fmt(buySim.costUsdt, 4)} + fee ${fmt(buySim.feeUsdt, 4)} USDT`);
  const buyRes = await chain.executeBuy(signer, market, tokenId, buyUsdt, slippagePct, buySim);
  const b1 = await snapshotBals();
  logDelta(`TRADE 1: BUY ${buyUsdt} USDT ${oc.name}`, b0, b1, buyRes.hash);

  // === HOLD ===
  console.log(`\nHolding ${holdSec}s...`);
  await new Promise((r) => setTimeout(r, holdSec * 1000));

  // === SELL ALL ===
  const mid = await snapshotBals();
  let sellWei = mid.otWei - (mid.otWei % TICK_WEI); // floor to 0.01 OT tick
  if (sellWei <= 0n) throw new Error(`nothing to sell (holding ${fmt(mid.ot)} OT)`);
  console.log(`\nSelling ALL ${oc.name}: ${fmt(parseFloat(formatUnits(sellWei, 18)))} OT (slippage ${slippagePct}%)...`);
  const sellSim = await chain.simulateSell(market, tokenId, sellWei);
  console.log(`  sim: ~${fmt(sellSim.collateralUsdt, 4)} USDT back`);
  const sellRes = await chain.executeSell(signer, market, tokenId, sellWei, slippagePct, sellSim);
  const b2 = await snapshotBals();
  logDelta(`TRADE 2: SELL ${oc.name}`, mid, b2, sellRes.hash);

  // === SUMMARY ===
  const netUsdt = b2.usdt - b0.usdt;
  const netBnb = b2.bnb - b0.bnb;
  console.log(`\n===== NET (start → end) =====`);
  console.log(`  USDT:  ${fmt(b0.usdt, 4)} -> ${fmt(b2.usdt, 4)}   (Δ ${fmt(netUsdt, 4)})`);
  console.log(`  BNB :  ${fmt(b0.bnb)} -> ${fmt(b2.bnb)}   (Δ ${fmt(netBnb)} gas)`);
  console.log(`  ${oc.name} OT:  ${fmt(b0.ot)} -> ${fmt(b2.ot)}`);

  await notify.info(
    `Manual round-trip on ${oc.name}: buy ${buyUsdt} USDT → hold ${holdSec}s → sell all.\n` +
      `USDT Δ ${fmt(netUsdt, 4)} | gas Δ ${fmt(netBnb)} BNB\nbuy ${buyRes.hash}\nsell ${sellRes.hash}`,
  );
  console.log(`\nDone.`);
}

main().catch((e: unknown) => {
  console.error("\nTRADE ERROR:", (e as Error).message ?? String(e));
  process.exit(1);
});
