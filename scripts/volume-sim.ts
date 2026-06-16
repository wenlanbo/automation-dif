#!/usr/bin/env bun
// Offline backtester for the volume strategy port. Runs the SAME decision logic
// the live engine uses (bot/volume-strategy.ts) through a discrete-event loop
// with a constant-price fill model (no slippage/fees) — directly comparable to
// the quant's strategy.py run_simulation. Use it to sanity-check that the port
// hits the target volume multiple and holds the target cash ratio.
//
//   bun scripts/volume-sim.ts [wallets] [balance] [multiple]
import { DEFAULT_VOLUME_CONFIG, loadVolumeConfig, type VolumeConfig } from "../bot/volume-config.ts";
import {
  computeRates,
  decideBuy,
  decideSell,
  forceLiquidation,
  freshProgress,
  portfolioValue,
  windowIntervals,
  effectiveIntervals,
  type Intent,
  type Portfolio,
} from "../bot/volume-strategy.ts";
import type { VolumeProgress } from "../bot/types.ts";

// Default prices from strategy.py (constant — this is the comparison baseline).
const PRICES: Record<string, number> = {
  France: 0.22, Spain: 0.18, England: 0.15, Portugal: 0.12,
  Argentina: 0.11, Brazil: 0.1, Germany: 0.06, Netherlands: 0.06,
};

function makePortfolio(cfg: VolumeConfig): { pf: Portfolio; price: Map<number, number> } {
  const tokenIds: number[] = [];
  const weights: number[] = [];
  const prices = new Map<number, number>();
  cfg.outcomes.forEach((o, i) => {
    tokenIds.push(i);
    weights.push(o.weight);
    prices.set(i, PRICES[o.name] ?? 0.1);
  });
  return {
    pf: { cash: 0, holdings: new Map(tokenIds.map((t) => [t, 0])), prices, tokenIds, weights },
    price: prices,
  };
}

function applyFill(pf: Portfolio, prog: VolumeProgress, it: Intent): void {
  const price = pf.prices.get(it.tokenId)!;
  if (it.type === "BUY") {
    const buy = Math.min(it.usdt, pf.cash);
    if (buy <= 0) return;
    pf.cash -= buy;
    pf.holdings.set(it.tokenId, (pf.holdings.get(it.tokenId) ?? 0) + buy / price);
    prog.cumulativeBuyVolume += buy;
  } else {
    const holdingUsd = (pf.holdings.get(it.tokenId) ?? 0) * price;
    const sell = Math.min(it.usdt, holdingUsd);
    if (sell <= 0) return;
    pf.cash += sell;
    pf.holdings.set(it.tokenId, (pf.holdings.get(it.tokenId) ?? 0) - sell / price);
    prog.cumulativeSellVolume += sell;
  }
  prog.trades += 1;
}

function runOne(cfg: VolumeConfig, balance: number): { volume: number; cashRatio: number; trades: number; liquidated: boolean } {
  const { pf } = makePortfolio(cfg);
  pf.cash = balance;
  const prog = freshProgress(cfg, balance, 0, false);
  prog.targetMultiple = cfg.targetVolumeMultiple; // test the requested multiple, not the random one
  const r = computeRates(cfg, balance, prog.targetMultiple);
  const iv = effectiveIntervals(cfg, prog.targetMultiple); // override or target-scaled
  const tick = parseInt(process.env.TICK_SEC ?? "60", 10); // mimic BOT_INTERVAL clamp
  const rand = (a: [number, number]) => Math.max(tick, a[0] + Math.random() * (a[1] - a[0]));

  let nextBuy = rand(iv);
  let nextSell = rand(iv);
  let t = 0;
  while (t < r.durationSec) {
    const isBuy = nextBuy < nextSell;
    const eventTime = isBuy ? nextBuy : nextSell;
    if (eventTime >= r.durationSec) break;
    t = eventTime;
    if (isBuy) {
      const dt = rand(iv);
      for (const it of decideBuy(prog, cfg, pf, t, dt)) applyFill(pf, prog, it);
      nextBuy = t < r.tStopBuy ? t + dt : Infinity;
    } else {
      const dt = prog.cascadeSellsRemaining > 0 ? rand([60, 300]) : rand(iv);
      for (const it of decideSell(prog, cfg, pf, t, dt)) applyFill(pf, prog, it);
      nextSell = t + dt;
    }
  }
  if (cfg.forceLiquidationAtEnd) for (const it of forceLiquidation(pf)) applyFill(pf, prog, it);

  const pv = portfolioValue(pf);
  const liquidated = [...pf.holdings.values()].every((v) => Math.abs(v) < 1e-9);
  return {
    volume: prog.cumulativeBuyVolume + prog.cumulativeSellVolume,
    cashRatio: pv > 0 ? pf.cash / pv : 1,
    trades: prog.trades,
    liquidated,
  };
}

// Base on the REAL config file so the backtest reflects what will deploy;
// fall back to defaults if it can't be loaded. Args override N/balance/multiple.
let base: VolumeConfig;
try { base = loadVolumeConfig(); } catch { base = DEFAULT_VOLUME_CONFIG; }
const N = parseInt(process.argv[2] ?? "10", 10);
const BAL = parseFloat(process.argv[3] ?? "5000");
const MULT = parseFloat(process.argv[4] ?? String(base.targetVolumeMultiple));
const cfg: VolumeConfig = { ...base, targetVolumeMultiple: MULT };

const runs = Array.from({ length: N }, () => runOne(cfg, BAL));
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const vols = runs.map((r) => r.volume);
const target = BAL * MULT;

console.log(`\n=== Volume strategy port — ${N} wallets x $${BAL} | target ${MULT}x | continuous ===`);
console.log(` Avg volume/wallet : $${avg(vols).toFixed(0)}  (target $${target.toFixed(0)}, ${((avg(vols) / target) * 100).toFixed(1)}%)`);
console.log(` Avg multiple      : ${(avg(vols) / BAL).toFixed(2)}x`);
console.log(` Fleet total volume: $${vols.reduce((a, b) => a + b, 0).toFixed(0)} on $${(N * BAL).toLocaleString()} capital`);
console.log(` Avg end cash ratio: ${(avg(runs.map((r) => r.cashRatio)) * 100).toFixed(1)}%  (target ${(cfg.targetCashRatio * 100).toFixed(0)}%)`);
console.log(` Avg trades/wallet : ${avg(runs.map((r) => r.trades)).toFixed(0)}`);
console.log(` Per-wallet volume : ${vols.map((v) => "$" + (v / 1000).toFixed(1) + "k").join(", ")}`);

if (cfg.forceLiquidationAtEnd)
  console.log(` Liquidation rate  : ${((runs.filter((r) => r.liquidated).length / N) * 100).toFixed(0)}%`);
