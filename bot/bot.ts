#!/usr/bin/env bun
// CLI companion to the dashboard server (bot/server.ts).
//   bun bot/bot.ts run      one trade cycle on the target market, then exit
//   bun bot/bot.ts status   market snapshot + each wallet's armed state/balances
//   bun bot/bot.ts scan      show outcomes + which pass entry rules (no trades)
//   bun bot/bot.ts arm <walletId> [on|off]   flip a wallet's safe switch
//
// The dashboard (bot/server.ts) is the primary way to run continuously.
// DRY_RUN defaults to true. Set DRY_RUN=false for real on-chain trades.
import { getAddress, type Address } from "viem";
import { loadRuntime, loadStrategy } from "./config.ts";
import { initRead, getBalances } from "./chain.ts";
import { initNotify } from "./notify.ts";
import { buildWallets } from "./wallets.ts";
import { buildMarketSnapshot } from "./market.ts";
import { passesEntry } from "./rules.ts";
import { oneCycle } from "./orchestrator.ts";
import { loadState, saveState, walletSlot } from "./state.ts";

function setup() {
  const rc = loadRuntime();
  const cfg = loadStrategy(rc.configPath);
  initRead({ rpc: rc.rpc, integratorAddress: rc.integratorAddress, integratorFeeBps: rc.integratorFeeBps });
  initNotify({ slackWebhook: rc.slackWebhook, dryRun: rc.dryRun });
  const wallets = buildWallets(rc.wallets);
  return { rc, cfg, wallets };
}

async function cmdRun(): Promise<void> {
  const { rc, cfg, wallets } = setup();
  const state = loadState(rc.statePath);
  console.log(`\n=== cycle | ${rc.dryRun ? "DRY-RUN" : "*** LIVE ***"} | market ${rc.targetMarket} ===`);
  const { summary } = await oneCycle(rc, cfg, wallets, state);
  console.log(
    `\n  status=${summary.status} armed=${summary.armedWallets}/${wallets.length} ` +
      `entries=${summary.entries.length} exits=${summary.exits.length} errors=${summary.errors.length}\n` +
      `  open=${summary.openPositions} exposure=${summary.exposureUsdt.toFixed(2)} USDT realizedPnL=${summary.realizedPnlUsdt.toFixed(3)}`,
  );
}

async function cmdScan(): Promise<void> {
  const { rc, cfg } = setup();
  const snap = await buildMarketSnapshot(rc.restBase, rc.targetMarket);
  console.log(`\n${snap.question} (${snap.status}) — ${snap.numOutcomes} outcomes, cap ${snap.totalMarketCap.toFixed(0)} USDT\n`);
  const sorted = [...snap.outcomes].sort((a, b) => (b.metrics.priceChange1h ?? 0) - (a.metrics.priceChange1h ?? 0));
  let matched = 0;
  for (const o of sorted) {
    const v = passesEntry(o, cfg.entry);
    if (v.ok) matched++;
    console.log(
      `${v.ok ? "✅" : "  "} ${o.name.padEnd(16).slice(0, 16)} price=${o.price.toFixed(4)} cap=${o.marketCap.toFixed(0).padStart(7)} | ${v.reason}`,
    );
  }
  console.log(`\n${matched} outcome(s) pass entry rules. Calibrate strategy.config.json against the values above.`);
}

async function cmdStatus(): Promise<void> {
  const { rc, cfg, wallets } = setup();
  const snap = await buildMarketSnapshot(rc.restBase, rc.targetMarket);
  const state = loadState(rc.statePath);
  console.log(`\n=== 42 bot | ${rc.dryRun ? "DRY-RUN" : "LIVE"} ===`);
  console.log(`Market: ${snap.question}`);
  console.log(`  ${rc.targetMarket} | ${snap.status} | cap ${snap.totalMarketCap.toFixed(0)} USDT | vol ${snap.volume.toFixed(0)} | ${snap.traders} traders`);
  console.log(`\nStrategy: TP +${cfg.exit.takeProfitPct}% / SL -${cfg.exit.stopLossPct}% | ${cfg.sizing.usdtPerTrade} USDT/trade, cap ${cfg.sizing.maxTotalExposureUsdt}/wallet`);
  console.log(`Entry rules: ${JSON.stringify(cfg.entry.rules)} (${cfg.entry.combine})`);
  console.log(`\nWallets (${wallets.length}):`);
  for (const w of wallets) {
    const ws = walletSlot(state, w.id);
    let bal = { bnb: 0, usdt: 0 };
    try { bal = await getBalances(getAddress(w.address) as Address); } catch { /* rpc */ }
    console.log(
      `  ${ws.armed ? "🟢 ARMED" : "⚪ SAFE "} ${w.label.padEnd(12)} ${w.address.slice(0, 10)}… ` +
        `BNB ${bal.bnb.toFixed(4)} USDT ${bal.usdt.toFixed(2)} | ${ws.positions.length} pos, rPnL ${ws.realizedPnlUsdt.toFixed(3)}`,
    );
  }
}

async function cmdArm(argv: string[]): Promise<void> {
  const { rc, wallets } = setup();
  const id = argv[3];
  const onoff = (argv[4] ?? "on").toLowerCase();
  const w = wallets.find((x) => x.id === id || x.label === id);
  if (!w) {
    console.error(`unknown wallet "${id}". Known: ${wallets.map((x) => x.id).join(", ") || "(none)"}`);
    process.exit(1);
  }
  const state = loadState(rc.statePath);
  const ws = walletSlot(state, w.id);
  ws.armed = onoff === "on" || onoff === "true" || onoff === "arm";
  saveState(rc.statePath, state);
  console.log(`${w.label} (${w.id}) is now ${ws.armed ? "🟢 ARMED" : "⚪ SAFE"}.`);
}

const cmd = process.argv[2] ?? "status";
const DISPATCH: Record<string, () => Promise<void>> = {
  run: cmdRun,
  scan: cmdScan,
  status: cmdStatus,
  arm: () => cmdArm(process.argv),
};
const fn = DISPATCH[cmd];
if (!fn) {
  console.log("Usage: bun bot/bot.ts <run|status|scan|arm>");
  process.exit(1);
}
fn().catch((e: unknown) => {
  console.error("FATAL:", (e as Error).message ?? String(e));
  process.exit(1);
});
