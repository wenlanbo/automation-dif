// Pure decision logic for the volume-generation strategy — a faithful TypeScript
// port of the quant's WorldCupTradingStrategy (strategy.py). It produces trade
// "intents" (BUY/SELL of a USDT amount on a tokenId); the engine converts those
// to on-chain orders (or paper fills) and feeds back the realized amounts.
//
// Holdings/cash/prices are passed in as a Portfolio each call (sourced from chain
// when live, from the paper ledger in dry-run). The only mutated state is the
// controller/cascade fields on VolumeProgress — exactly the fields strategy.py
// keeps on `self`. Cumulative volume is updated by the engine from real fills.
import type { VolumeConfig } from "./volume-config.ts";
import type { VolumeProgress } from "./types.ts";

export interface Portfolio {
  cash: number; // USDT
  holdings: Map<number, number>; // tokenId -> OT (contracts)
  prices: Map<number, number>; // tokenId -> price (USDT/OT)
  tokenIds: number[]; // tradable outcomes (resolved against the market)
  weights: number[]; // selection weights aligned to tokenIds
}

export type SellReason = "swap" | "cascade" | "large" | "normal" | "decay" | "force";

export type Intent =
  | { type: "BUY"; tokenId: number; usdt: number }
  | { type: "SELL"; tokenId: number; usdt: number; reason: SellReason };

// ---- RNG helpers (Math.random is fine here — production uses real entropy) ----

function uniform(range: [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}
function randint(lo: number, hi: number): number {
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}
function gauss(mu: number, sigma: number): number {
  // Box-Muller.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function lognorm(mu: number, sigma: number): number {
  return Math.exp(gauss(mu, sigma));
}
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(x, hi));
}

// ---- derived rates (mirror the strategy.py constructor) ----

export interface Rates {
  targetVolume: number;
  durationSec: number;
  tStopBuy: number;
  buyRate: number;
  sellRate: number;
  largeBuyThreshold: number;
}

export function computeRates(cfg: VolumeConfig, initialBalance: number, multiple?: number): Rates {
  const durationSec = cfg.durationHours * 3600;
  const correction = cfg.continuousTrading
    ? 1.0 + 0.15 * Math.max(0, 0.9 - cfg.targetCashRatio)
    : 1.0;
  const targetVolume = initialBalance * (multiple ?? cfg.targetVolumeMultiple) * correction;
  const targetBuy = targetVolume / 2;
  const targetSell = targetVolume / 2;
  const tStopBuy = cfg.continuousTrading ? durationSec : durationSec * cfg.liquidationRatio;
  return {
    targetVolume,
    durationSec,
    tStopBuy,
    buyRate: targetBuy / tStopBuy,
    sellRate: targetSell / durationSec,
    largeBuyThreshold: 0.08 * initialBalance,
  };
}

/**
 * Per-window trade interval [lo, hi] in seconds, scaled so realized volume
 * tracks the target multiple: higher target → more frequent trades. Calibrated
 * via the offline backtester (scripts/volume-sim.ts) for the ~8–15× range over
 * a 24h window. The matching loop cadence (BOT_INTERVAL) must be ≤ lo, or the
 * tick rate clamps the high-target end.
 */
export function windowIntervals(multiple: number): [number, number] {
  const avg = clamp(3200 - 174 * multiple, 480, 4000);
  return [Math.max(60, Math.round(0.13 * avg)), Math.round(1.87 * avg)];
}

/** Cadence for a window: explicit override if set, else target-scaled. */
export function effectiveIntervals(cfg: VolumeConfig, multiple: number): [number, number] {
  return cfg.intervalOverrideSec ?? windowIntervals(multiple);
}

export function portfolioValue(pf: Portfolio): number {
  let assets = 0;
  for (const t of pf.tokenIds) assets += (pf.holdings.get(t) ?? 0) * (pf.prices.get(t) ?? 0);
  return pf.cash + assets;
}

function selectRandomToken(pf: Portfolio): number {
  const total = pf.weights.reduce((a, b) => a + b, 0);
  let x = Math.random() * total;
  for (let i = 0; i < pf.tokenIds.length; i++) {
    x -= pf.weights[i] ?? 0;
    if (x <= 0) return pf.tokenIds[i]!;
  }
  return pf.tokenIds[pf.tokenIds.length - 1]!;
}

// ---- BUY decision (port of execute_buy) ----

export function decideBuy(
  prog: VolumeProgress,
  cfg: VolumeConfig,
  pf: Portfolio,
  timeElapsed: number,
  nextDt: number,
): Intent[] {
  const r = computeRates(cfg, prog.initialBalance, prog.targetMultiple);
  if (timeElapsed >= r.tStopBuy) return [];

  // 1. PI controller for target buy volume.
  const refBuyVol = timeElapsed * r.buyRate;
  const error = refBuyVol - prog.cumulativeBuyVolume;
  const expected = nextDt * r.buyRate;
  let targetBuySize = expected + 0.35 * error;
  if (targetBuySize <= 0) targetBuySize = pf.cash * uniform(cfg.buyPctRange);

  const logStd = cfg.sizeVolatility;
  const mult = Math.min(lognorm(-0.5 * logStd * logStd, logStd), 6.0);
  let buySize = targetBuySize * mult;

  // 2. PI controller for cash balance.
  const pv = portfolioValue(pf);
  const cashRatio = pv > 0 ? pf.cash / pv : 1.0;
  const cashError = cashRatio - cfg.targetCashRatio;
  prog.cashErrorIntegral = clamp(prog.cashErrorIntegral + cashError * (nextDt / 3600), -2, 2);
  const cashControl = 6.0 * cashError + 2.5 * prog.cashErrorIntegral;
  buySize *= clamp(1.0 + cashControl, 0.01, 4.0);
  if (cashRatio < cfg.targetCashRatio) buySize *= cashRatio / cfg.targetCashRatio;

  // 3. Pick a country, optionally fund the buy by swapping out of another asset.
  const tokenId = selectRandomToken(pf);
  const intents: Intent[] = [];
  let localCash = pf.cash;

  if (localCash < cfg.minOrderUsdt + 15.0) {
    const active = pf.tokenIds.filter((t) => (pf.holdings.get(t) ?? 0) > 0);
    if (active.length) {
      const sellTok = active.reduce((best, t) =>
        (pf.holdings.get(t)! * pf.prices.get(t)!) >
        (pf.holdings.get(best)! * pf.prices.get(best)!)
          ? t
          : best,
      );
      const holdingVal = pf.holdings.get(sellTok)! * pf.prices.get(sellTok)!;
      let swapVal = Math.max(buySize, 16.0 - localCash);
      swapVal = clamp(swapVal, cfg.minOrderUsdt, holdingVal);
      if (swapVal >= cfg.minOrderUsdt) {
        intents.push({ type: "SELL", tokenId: sellTok, usdt: swapVal, reason: "swap" });
        localCash += swapVal; // estimated proceeds; engine re-caps the buy on real cash
      }
    }
  }

  // Continuous mode: never spend more than 60% of cash on one buy.
  if (cfg.continuousTrading) buySize = Math.max(Math.min(buySize, 0.6 * localCash), cfg.minOrderUsdt);

  const availableCash = Math.max(0, localCash - 15.0);
  let buyCash = Math.min(buySize, availableCash);

  // Non-continuous: force-spend remaining cash near the end of Phase 1.
  if (!cfg.continuousTrading) {
    const timePct = timeElapsed / r.tStopBuy;
    if (timePct > 0.9 && prog.cumulativeBuyVolume < prog.initialBalance) buyCash = localCash;
  }

  if (buyCash < cfg.minOrderUsdt) {
    if (localCash >= cfg.minOrderUsdt + 15.0) buyCash = cfg.minOrderUsdt;
    else return intents; // can't buy — return any swap that already happened
  }

  intents.push({ type: "BUY", tokenId, usdt: buyCash });

  // Large-buy reaction: schedule a cascade or a single large sell.
  if (cfg.continuousTrading && buyCash >= r.largeBuyThreshold) {
    prog.cascadeSellTokenId = tokenId;
    if (Math.random() < 0.5) {
      prog.nextSellIsLarge = true;
      prog.lastLargeBuyAmount = buyCash;
    } else {
      const numSells = randint(3, 6);
      prog.cascadeSellsRemaining = numSells;
      prog.cascadeSellAmount = (buyCash * uniform([0.6, 0.9])) / numSells;
    }
  }

  return intents;
}

// ---- SELL decision (port of execute_sell, both modes) ----

export function decideSell(
  prog: VolumeProgress,
  cfg: VolumeConfig,
  pf: Portfolio,
  timeElapsed: number,
  nextDt: number,
): Intent[] {
  return cfg.continuousTrading
    ? sellContinuous(prog, cfg, pf, timeElapsed, nextDt)
    : sellPhased(prog, cfg, pf, timeElapsed, nextDt);
}

function sellContinuous(
  prog: VolumeProgress,
  cfg: VolumeConfig,
  pf: Portfolio,
  timeElapsed: number,
  nextDt: number,
): Intent[] {
  const pv = portfolioValue(pf);
  const cashRatio = pv > 0 ? pf.cash / pv : 1.0;

  // 1. Cascade-sell sequence in progress.
  if (prog.cascadeSellsRemaining > 0) {
    const tok = prog.cascadeSellTokenId ?? -1;
    const price = pf.prices.get(tok) ?? 0;
    const holdingUsd = (pf.holdings.get(tok) ?? 0) * price;
    let sellCash = Math.min(prog.cascadeSellAmount, holdingUsd, 0.85 * holdingUsd);
    sellCash = Math.min(Math.max(cfg.minOrderUsdt, sellCash), holdingUsd);
    prog.cascadeSellsRemaining -= 1;
    if (tok >= 0 && sellCash >= cfg.minOrderUsdt)
      return [{ type: "SELL", tokenId: tok, usdt: sellCash, reason: "cascade" }];
    prog.cascadeSellsRemaining = 0; // couldn't fill — end cascade, fall through
  } else if (prog.nextSellIsLarge) {
    // 2. Single large sell reacting to a recent large buy.
    prog.nextSellIsLarge = false;
    const tok = prog.cascadeSellTokenId ?? -1;
    const price = pf.prices.get(tok) ?? 0;
    const holdingUsd = (pf.holdings.get(tok) ?? 0) * price;
    let sellCash = prog.lastLargeBuyAmount * uniform([0.7, 1.1]);
    sellCash = Math.min(sellCash, 0.85 * holdingUsd, 0.6 * (pv - pf.cash));
    sellCash = Math.min(Math.max(cfg.minOrderUsdt, sellCash), holdingUsd);
    if (tok >= 0 && sellCash >= cfg.minOrderUsdt)
      return [{ type: "SELL", tokenId: tok, usdt: sellCash, reason: "large" }];
    // fall through to normal
  }

  // 3. Normal continuous sell (also the fallback).
  const active = pf.tokenIds.filter((t) => (pf.holdings.get(t) ?? 0) > 0);
  if (!active.length) return [];

  const r = computeRates(cfg, prog.initialBalance, prog.targetMultiple);
  const volError = timeElapsed * r.sellRate - prog.cumulativeSellVolume;
  let targetSellSize = nextDt * r.sellRate + 0.35 * volError;
  if (targetSellSize <= 0) targetSellSize = (pv - pf.cash) * uniform(cfg.sellPctRange);

  const logStd = cfg.sizeVolatility;
  const mult = Math.min(lognorm(-0.5 * logStd * logStd, logStd), 6.0);
  let sellCash = targetSellSize * mult;

  const cashError = cashRatio - cfg.targetCashRatio;
  prog.cashErrorIntegral = clamp(prog.cashErrorIntegral + cashError * (nextDt / 3600), -2, 2);
  const cashControl = 6.0 * cashError + 2.5 * prog.cashErrorIntegral;
  let sellScale = clamp(1.0 - cashControl, 0.01, 4.0);
  if (cashRatio < cfg.targetCashRatio)
    sellScale = Math.min(sellScale * (cfg.targetCashRatio / Math.max(0.001, cashRatio)), 4.0);
  sellCash *= sellScale;

  sellCash = Math.max(Math.min(sellCash, 0.6 * (pv - pf.cash)), cfg.minOrderUsdt);

  // Distribute the sell across held countries (keep 15% of any fully-hit holding).
  const out: Intent[] = [];
  let remaining = sellCash;
  for (const tok of shuffle([...active])) {
    if (remaining < cfg.minOrderUsdt) break;
    const price = pf.prices.get(tok)!;
    const holdingUsd = pf.holdings.get(tok)! * price;
    const sellValue = holdingUsd <= remaining ? 0.85 * holdingUsd : remaining;
    if (sellValue <= 0) continue;
    out.push({ type: "SELL", tokenId: tok, usdt: sellValue, reason: "normal" });
    remaining -= sellValue;
  }
  return out;
}

function sellPhased(
  prog: VolumeProgress,
  cfg: VolumeConfig,
  pf: Portfolio,
  timeElapsed: number,
  nextDt: number,
): Intent[] {
  const r = computeRates(cfg, prog.initialBalance, prog.targetMultiple);
  const out: Intent[] = [];

  if (timeElapsed >= r.tStopBuy) {
    // Phase 2: smooth linear-decay liquidation toward 0 by duration.
    if (!prog.liqStartHoldings) {
      prog.liqStartHoldings = {};
      for (const t of pf.tokenIds) prog.liqStartHoldings[String(t)] = pf.holdings.get(t) ?? 0;
    }
    const tRem = r.durationSec - timeElapsed;
    const liqDuration = r.durationSec - r.durationSec * cfg.liquidationRatio;
    for (const tok of pf.tokenIds) {
      const currentQty = pf.holdings.get(tok) ?? 0;
      if (currentQty <= 0) continue;
      const price = pf.prices.get(tok)!;
      const initialQty = prog.liqStartHoldings[String(tok)] ?? 0;
      const tNext = timeElapsed + nextDt;
      let qtyToSell: number;
      if (tNext >= r.durationSec || tRem <= 300) {
        qtyToSell = currentQty;
      } else {
        const timeInLiqNext = tNext - r.durationSec * cfg.liquidationRatio;
        const targetQtyNext = Math.max(0, initialQty * (1 - timeInLiqNext / liqDuration));
        qtyToSell = Math.min(Math.max(0, currentQty - targetQtyNext) * uniform([0.85, 1.15]), currentQty);
      }
      if (qtyToSell <= 0) continue;
      // Avoid leaving dust below the min order — sweep the whole holding instead.
      if (qtyToSell * price < cfg.minOrderUsdt || (currentQty - qtyToSell) * price < cfg.minOrderUsdt)
        qtyToSell = currentQty;
      out.push({ type: "SELL", tokenId: tok, usdt: qtyToSell * price, reason: "decay" });
    }
    return out;
  }

  // Phase 1: sell one random holding, sized by the cash-ratio error.
  const active = pf.tokenIds.filter((t) => (pf.holdings.get(t) ?? 0) > 0);
  if (!active.length) return [];
  const pv = portfolioValue(pf);
  const cashRatio = pv > 0 ? pf.cash / pv : 1.0;
  const cashError = cashRatio - cfg.targetCashRatio;
  const pctRange: [number, number] =
    cashError < 0 ? [0.5, 0.8] : cashError > 0.2 ? [0.1, 0.3] : cfg.sellPctRange;
  const tok = active[Math.floor(Math.random() * active.length)]!;
  const price = pf.prices.get(tok)!;
  const qty = pf.holdings.get(tok)!;
  let qtyToSell = qty * uniform(pctRange);
  if (qtyToSell * price < cfg.minOrderUsdt) qtyToSell = qty;
  if (qtyToSell <= 0) return [];
  out.push({ type: "SELL", tokenId: tok, usdt: qtyToSell * price, reason: "decay" });
  return out;
}

/** Build a fresh per-wallet progress object at the start of a trading window. */
export function freshProgress(
  cfg: VolumeConfig,
  initialBalance: number,
  now: number,
  dryRun: boolean,
): VolumeProgress {
  const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
  // Every window uses the configured target multiple; cadence is scaled to it.
  const targetMultiple = cfg.targetVolumeMultiple;
  const iv = effectiveIntervals(cfg, targetMultiple);
  return {
    phase: "trading",
    initialBalance,
    targetMultiple,
    startedAt: new Date(now).toISOString(),
    nextBuyAt: new Date(now + rand(iv) * 1000).toISOString(),
    nextSellAt: new Date(now + rand(iv) * 1000).toISOString(),
    cumulativeBuyVolume: 0,
    cumulativeSellVolume: 0,
    cashErrorIntegral: 0,
    cascadeSellsRemaining: 0,
    cascadeSellAmount: 0,
    cascadeSellTokenId: null,
    nextSellIsLarge: false,
    lastLargeBuyAmount: 0,
    trades: 0,
    windowsDone: 0,
    ...(dryRun ? { paper: { cash: initialBalance, holdings: {} } } : {}),
  };
}

/** Force-sell every remaining holding (end-of-window sweep). */
export function forceLiquidation(pf: Portfolio): Intent[] {
  const out: Intent[] = [];
  for (const tok of pf.tokenIds) {
    const qty = pf.holdings.get(tok) ?? 0;
    if (qty > 0) out.push({ type: "SELL", tokenId: tok, usdt: qty * pf.prices.get(tok)!, reason: "force" });
  }
  return out;
}
