// Drives the volume-generation strategy on the server's loop. Per managed wallet
// it keeps a randomized buy/sell schedule, builds a Portfolio (from chain when
// live, from a paper ledger in dry-run), asks volume-strategy for trade intents,
// and executes them via the chain layer. Progress persists across restarts and
// every fill is logged to Slack. Mirrors campaign.ts in spirit.
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import type { RuntimeConfig } from "./config.ts";
import * as chain from "./chain.ts";
import * as notify from "./notify.ts";
import { saveState } from "./state.ts";
import type { BotState, MarketSnapshot, VolumeProgress } from "./types.ts";
import type { ManagedWallet } from "./wallets.ts";
import { loadVolumeConfig, type VolumeConfig, type VolumeOutcome, type VolumeMarket } from "./volume-config.ts";
import { buildMarketSnapshot } from "./market.ts";
import {
  computeRates,
  decideBuy,
  decideSell,
  forceLiquidation,
  freshProgress,
  effectiveIntervals,
  type Intent,
  type Portfolio,
} from "./volume-strategy.ts";

const TICK_WEI = 10n ** 16n; // 0.01 OT minimum tick
const floorTick = (wei: bigint) => wei - (wei % TICK_WEI);

// Retry transient RPC reads/simulations so a flaky public endpoint doesn't trip
// the pause-on-error guard. NOT used for writes (a reverted tx must pause, not retry).
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}
const f = (n: number, d = 4) => n.toLocaleString("en-US", { maximumFractionDigits: d });

/** Tradable outcomes resolved from config names against the live snapshot. */
interface Resolved {
  tokenIds: number[];
  weights: number[];
  names: Map<number, string>;
  prices: Map<number, number>;
}

function resolveOutcomes(outcomes: VolumeOutcome[], snap: MarketSnapshot): Resolved {
  const tokenIds: number[] = [];
  const weights: number[] = [];
  const names = new Map<number, string>();
  const prices = new Map<number, number>();
  for (const want of outcomes) {
    const oc = snap.outcomes.find((o) => o.name.toLowerCase() === want.name.toLowerCase());
    if (!oc) continue;
    tokenIds.push(oc.tokenId);
    weights.push(want.weight);
    names.set(oc.tokenId, oc.name);
    prices.set(oc.tokenId, oc.price);
  }
  return { tokenIds, weights, names, prices };
}

/** Mutable per-wallet trading context for one tick. */
interface Ctx {
  rc: RuntimeConfig;
  cfg: VolumeConfig;
  w: ManagedWallet;
  addr: Address;
  market: Address;
  prog: VolumeProgress;
  res: Resolved;
  /** Live OT holdings in wei (kept in sync as intents execute this tick). */
  weiByToken: Map<number, bigint>;
  pf: Portfolio;
  bnb: number;
}

function buildPortfolio(ctx: Ctx): void {
  const { cfg, prog, res } = ctx;
  const holdings = new Map<number, number>();
  for (const t of res.tokenIds) {
    const wei = ctx.weiByToken.get(t) ?? 0n;
    holdings.set(t, parseFloat(formatUnits(wei, 18)));
  }
  ctx.pf = {
    cash: ctx.rc.dryRun ? prog.paper!.cash : ctx.pf.cash,
    holdings,
    prices: res.prices,
    tokenIds: res.tokenIds,
    weights: res.weights,
  };
}

async function loadWei(ctx: Ctx): Promise<void> {
  if (ctx.rc.dryRun) {
    for (const t of ctx.res.tokenIds)
      ctx.weiByToken.set(t, BigInt(ctx.prog.paper!.holdings[String(t)] ?? "0"));
  } else {
    const us = await retry(() => chain.getUserState(ctx.market, ctx.addr));
    for (const t of ctx.res.tokenIds) {
      const h = us.holdings.find((x) => x.tokenId === t);
      ctx.weiByToken.set(t, h ? h.otHolding : 0n);
    }
  }
}

async function execBuy(ctx: Ctx, tokenId: number, usdt: number): Promise<void> {
  const { cfg, prog, rc } = ctx;
  let buy = Math.min(usdt, ctx.pf.cash);
  if (buy < cfg.minOrderUsdt) return;
  if (!rc.dryRun && ctx.bnb < cfg.minBnbReserve) {
    await notify.warn(`volume ${ctx.w.label}: BNB ${f(ctx.bnb, 5)} < reserve — skipping buy`);
    return;
  }
  buy = Math.floor(buy * 1e6) / 1e6; // never request above balance
  // Retry a reverted/failed buy up to maxTradeRetries with a FRESH quote each
  // time (a revert is usually slippage; re-simulating recomputes the min-out).
  // Only after all attempts fail does the error propagate and pause the strategy.
  const tries = cfg.maxTradeRetries ?? 5;
  let sim!: Awaited<ReturnType<typeof chain.simulateBuy>>;
  let lastErr: unknown = null;
  for (let a = 1; a <= tries; a++) {
    try {
      sim = await chain.simulateBuy(ctx.market, tokenId, buy);
      if (!rc.dryRun) await chain.executeBuy(ctx.w.signer, ctx.market, tokenId, buy, cfg.slippagePct, sim);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (a < tries) await new Promise((r) => setTimeout(r, 700 * a));
    }
  }
  if (lastErr) throw new Error(`buy ${tokenId} failed after ${tries} tries: ${(lastErr as Error).message}`);
  const cost = sim.costUsdt + sim.feeUsdt;

  // Reconcile in-memory portfolio from the realized fill.
  ctx.pf.cash -= cost;
  ctx.weiByToken.set(tokenId, (ctx.weiByToken.get(tokenId) ?? 0n) + sim.otToUserWei);
  prog.cumulativeBuyVolume += sim.costUsdt;
  prog.trades += 1;
  if (rc.dryRun) {
    prog.paper!.cash = ctx.pf.cash;
    prog.paper!.holdings[String(tokenId)] = (ctx.weiByToken.get(tokenId) ?? 0n).toString();
  }
  buildPortfolio(ctx);

  const name = ctx.res.names.get(tokenId) ?? `Token ${tokenId}`;
  const line = `🟢 [${notify.tagStr()}] ${ctx.w.label} BUY ${name} ${f(buy, 2)} USDT @ ${f(sim.priceBefore, 4)} → ${f(parseFloat(formatUnits(sim.otToUserWei, 18)))} OT`;
  console.log("  [volume] " + line);
  await notify.message(line);
}

async function execSell(ctx: Ctx, tokenId: number, usdt: number, reason: string): Promise<void> {
  const { cfg, prog, rc } = ctx;
  const price = ctx.res.prices.get(tokenId) ?? 0;
  if (price <= 0) return;
  const holdingWei = ctx.weiByToken.get(tokenId) ?? 0n;
  const holdingUsd = parseFloat(formatUnits(holdingWei, 18)) * price;
  if (holdingUsd <= 0) return;

  // Convert the USDT-denominated intent to OT wei; sweep fully if it covers the lot.
  let otWei: bigint;
  if (usdt >= holdingUsd * 0.999) {
    otWei = floorTick(holdingWei);
  } else {
    otWei = floorTick(parseUnits((usdt / price).toFixed(18), 18));
    if (otWei > holdingWei) otWei = floorTick(holdingWei);
  }
  if (otWei <= 0n) return;

  // Retry a reverted/failed sell up to maxTradeRetries with a fresh quote each time.
  const tries = cfg.maxTradeRetries ?? 5;
  let sim!: Awaited<ReturnType<typeof chain.simulateSell>>;
  let lastErr: unknown = null;
  for (let a = 1; a <= tries; a++) {
    try {
      sim = await chain.simulateSell(ctx.market, tokenId, otWei);
      if (!rc.dryRun) await chain.executeSell(ctx.w.signer, ctx.market, tokenId, otWei, cfg.slippagePct, sim);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (a < tries) await new Promise((r) => setTimeout(r, 700 * a));
    }
  }
  if (lastErr) throw new Error(`sell ${tokenId} failed after ${tries} tries: ${(lastErr as Error).message}`);

  ctx.pf.cash += sim.collateralUsdt;
  ctx.weiByToken.set(tokenId, holdingWei - otWei);
  prog.cumulativeSellVolume += sim.collateralUsdt;
  prog.trades += 1;
  if (rc.dryRun) {
    prog.paper!.cash = ctx.pf.cash;
    prog.paper!.holdings[String(tokenId)] = (holdingWei - otWei).toString();
  }
  buildPortfolio(ctx);

  const name = ctx.res.names.get(tokenId) ?? `Token ${tokenId}`;
  const line = `🔴 [${notify.tagStr()}] ${ctx.w.label} SELL ${name} (${reason}) ${f(parseFloat(formatUnits(otWei, 18)))} OT → ${f(sim.collateralUsdt, 2)} USDT @ ${f(sim.priceBefore, 4)}`;
  console.log("  [volume] " + line);
  await notify.message(line);
}

// A trade that still fails after maxTradeRetries throws here; the per-wallet
// handler then pauses the whole strategy (so only persistent failures pause).
async function execIntents(ctx: Ctx, intents: Intent[]): Promise<void> {
  for (const it of intents) {
    if (it.type === "BUY") await execBuy(ctx, it.tokenId, it.usdt);
    else await execSell(ctx, it.tokenId, it.usdt, it.reason);
  }
}

/**
 * Project gas runway from the empirical BNB burn rate and alert (@here) ~6h
 * before a wallet would drop to its minBnbReserve and stop being able to trade.
 * Re-baselines roughly hourly so the rate stays current; debounced to 6h.
 */
async function maybeGasAlert(
  rc: RuntimeConfig,
  state: BotState,
  id: string,
  label: string,
  bnb: number,
  minReserve: number,
): Promise<void> {
  state.gasWatch ??= {};
  const now = Date.now();
  const prev = state.gasWatch[id];
  if (!prev) {
    state.gasWatch[id] = { bnb, at: new Date(now).toISOString() };
    return;
  }
  const hours = (now - new Date(prev.at).getTime()) / 3_600_000;
  if (hours < 1) return; // wait for enough spacing to estimate a stable rate
  const ratePerHour = (prev.bnb - bnb) / hours; // BNB/h consumed
  if (ratePerHour > 0) {
    const hoursLeft = (bnb - minReserve) / ratePerHour;
    const lastAlert = prev.alertedAt ? new Date(prev.alertedAt).getTime() : 0;
    if (hoursLeft <= 6 && now - lastAlert > 6 * 3_600_000) {
      await notify.alertHere(
        `⛽ ${label}: low gas — BNB ${bnb.toFixed(5)}, burning ~${ratePerHour.toFixed(5)}/h → ~${hoursLeft.toFixed(1)}h until it hits the ${minReserve} reserve and stops trading. Top up BNB.`,
      );
      state.gasWatch[id] = { bnb, at: new Date(now).toISOString(), alertedAt: new Date(now).toISOString() };
      return;
    }
  }
  // Re-baseline (keep any prior alert timestamp for debouncing).
  state.gasWatch[id] = prev.alertedAt
    ? { bnb, at: new Date(now).toISOString(), alertedAt: prev.alertedAt }
    : { bnb, at: new Date(now).toISOString() };
}

/** Pause the volume strategy on error and alert the channel (@here). */
async function pauseOnError(rc: RuntimeConfig, state: BotState, reason: string): Promise<void> {
  state.paused = { reason, at: new Date().toISOString() };
  saveState(rc.statePath, state);
  await notify.alertHere(
    `⛔ Volume automation PAUSED — ${reason}\nNo further trades will run until you click "Resume automation" on the dashboard.`,
  );
}

export async function runVolumeStrategy(
  rc: RuntimeConfig,
  wallets: ManagedWallet[],
  state: BotState,
  snapshot: MarketSnapshot,
): Promise<void> {
  const cfg = loadVolumeConfig();
  if (!cfg.enabled) return;
  if (state.paused) return; // halted on a prior error — wait for dashboard resume
  state.volume ??= {};
  const now = Date.now();
  const ids = cfg.wallets.length ? cfg.wallets : wallets.map((w) => w.id);

  // Markets to trade: multi-market list if set, else single (targetMarket + outcomes).
  const marketDefs: VolumeMarket[] =
    cfg.markets && cfg.markets.length ? cfg.markets : [{ address: rc.targetMarket, outcomes: cfg.outcomes }];

  // Build a snapshot per distinct market (reuse the passed target snapshot if it matches).
  const snaps = new Map<string, MarketSnapshot>();
  snaps.set(snapshot.address.toLowerCase(), snapshot);
  for (const md of marketDefs) {
    const key = md.address.toLowerCase();
    if (snaps.has(key)) continue;
    try {
      snaps.set(key, await buildMarketSnapshot(rc.restBase, md.address));
    } catch (e) {
      await notify.warn(`volume: snapshot failed for ${md.label ?? md.address}: ${(e as Error).message}`);
    }
  }

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const w = wallets.find((x) => x.id === id);
    if (!w) {
      await notify.warn(`volume: wallet "${id}" not loaded — skipping`);
      continue;
    }
    // Yield to an active distribute-out campaign — one engine owns a wallet at a time.
    const camp = state.campaign?.[id];
    if (camp && camp.phase !== "done") continue;

    // Assign this wallet a market (round-robin over the configured markets).
    const md = marketDefs[i % marketDefs.length]!;
    const snap = snaps.get(md.address.toLowerCase());
    if (!snap || snap.isFinalised) {
      if (!snap) await notify.warn(`volume ${w.label}: no snapshot for ${md.label ?? md.address} — skipping`);
      continue;
    }
    const res = resolveOutcomes(md.outcomes, snap);
    if (res.tokenIds.length === 0) {
      await notify.warn(`volume ${w.label}: no configured outcomes matched ${md.label ?? md.address} — skipping`);
      continue;
    }
    const market = getAddress(md.address) as Address;
    const addr = getAddress(w.address) as Address;

    try {
    // Start a new window on first run, or when the previous one finished and
    // repeatWindow is on (this is what makes the strategy run 24/7). Starting
    // capital = current PORTFOLIO VALUE (cash + held OT), so continuous mode
    // recycles its full deployed capital across back-to-back windows; the
    // dry-run paper ledger carries forward across windows too.
    let prog = state.volume[id];
    const marketChanged = !!prog?.market && prog.market.toLowerCase() !== market.toLowerCase();
    if (!prog || (prog.phase === "done" && cfg.repeatWindow) || marketChanged) {
      const carryPaper = rc.dryRun && !marketChanged ? prog?.paper : undefined;
      let portfolioVal: number;
      if (!rc.dryRun) {
        const [bal, us] = await Promise.all([
          retry(() => chain.getBalances(addr)),
          retry(() => chain.getUserState(market, addr)),
        ]);
        let held = 0;
        for (const t of res.tokenIds) {
          const h = us.holdings.find((x) => x.tokenId === t);
          if (h) held += parseFloat(formatUnits(h.otHolding, 18)) * (res.prices.get(t) ?? 0);
        }
        portfolioVal = bal.usdt + held;
        if (portfolioVal < cfg.minOrderUsdt) {
          await notify.warn(`volume ${w.label}: portfolio ${f(portfolioVal, 2)} USDT too low to start — skipping`);
          continue;
        }
        if (bal.bnb < cfg.minBnbReserve)
          await notify.warn(`volume ${w.label}: BNB ${f(bal.bnb, 5)} below reserve — buys will be skipped`);
      } else if (carryPaper) {
        let held = 0;
        for (const t of res.tokenIds)
          held += parseFloat(formatUnits(BigInt(carryPaper.holdings[String(t)] ?? "0"), 18)) * (res.prices.get(t) ?? 0);
        portfolioVal = carryPaper.cash + held;
      } else {
        portfolioVal = cfg.paperBalanceUsdt;
      }
      const windowNum = (prog?.windowsDone ?? 0) + 1;
      prog = freshProgress(cfg, portfolioVal, now, rc.dryRun);
      prog.market = market;
      prog.windowsDone = windowNum - 1;
      if (rc.dryRun && carryPaper) prog.paper = carryPaper; // preserve paper holdings + cash
      state.volume[id] = prog;
      await notify.info(
        `volume ${w.label} → ${md.label ?? md.address.slice(0, 10)}: window ${windowNum} started — capital ${f(portfolioVal, 2)} USDT, target ${prog.targetMultiple ?? cfg.targetVolumeMultiple}x over ${cfg.durationHours}h`,
      );
    }
    if (prog.phase === "done") continue;

    const elapsed = (now - new Date(prog.startedAt).getTime()) / 1000;
    const r = computeRates(cfg, prog.initialBalance, prog.targetMultiple);

    // Live balances (cash + gas) for this tick.
    const ctx: Ctx = {
      rc, cfg, w, addr, market, prog, res,
      weiByToken: new Map(),
      pf: { cash: 0, holdings: new Map(), prices: res.prices, tokenIds: res.tokenIds, weights: res.weights },
      bnb: Infinity,
    };
    if (!rc.dryRun) {
      const bal = await retry(() => chain.getBalances(addr));
      ctx.pf.cash = bal.usdt;
      ctx.bnb = bal.bnb;
      await maybeGasAlert(rc, state, w.id, w.label, bal.bnb, cfg.minBnbReserve);
    } else {
      ctx.pf.cash = prog.paper!.cash;
    }
    await loadWei(ctx);
    buildPortfolio(ctx);

      // End-of-window: optionally force-liquidate, then close (or repeat).
      if (elapsed >= r.durationSec) {
        if (cfg.forceLiquidationAtEnd) await execIntents(ctx, forceLiquidation(ctx.pf));
        prog.phase = "done";
        prog.windowsDone += 1;
        await notify.info(
          `volume ${w.label}: window complete — ${prog.trades} trades, volume buy ${f(prog.cumulativeBuyVolume, 0)} / sell ${f(prog.cumulativeSellVolume, 0)} USDT`,
        );
        saveState(rc.statePath, state);
        continue;
      }

      const rand = (a: [number, number]) => a[0] + Math.random() * (a[1] - a[0]);
      // Trade cadence scaled to this window's target multiple (higher → faster).
      const iv = effectiveIntervals(cfg, prog.targetMultiple ?? cfg.targetVolumeMultiple);

      // BUY event.
      if (now >= new Date(prog.nextBuyAt).getTime()) {
        if (elapsed < r.tStopBuy) {
          const dt = rand(iv);
          await execIntents(ctx, decideBuy(prog, cfg, ctx.pf, elapsed, dt));
          prog.nextBuyAt = new Date(now + dt * 1000).toISOString();
        } else {
          prog.nextBuyAt = new Date(now + r.durationSec * 1000).toISOString(); // buying done
        }
      }

      // SELL event.
      if (now >= new Date(prog.nextSellAt).getTime()) {
        const dt = prog.cascadeSellsRemaining > 0 ? rand([60, 300]) : rand(iv);
        await execIntents(ctx, decideSell(prog, cfg, ctx.pf, elapsed, dt));
        prog.nextSellAt = new Date(now + dt * 1000).toISOString();
      }

      saveState(rc.statePath, state);
    } catch (e) {
      // Any error pauses the whole strategy until resumed from the dashboard.
      await pauseOnError(rc, state, `${w.label}: ${(e as Error).message}`);
      return;
    }
  }

  // Completion: once every managed wallet that started a window has finished
  // (and none are still trading), fire a one-time @here "test complete" alert.
  if (!cfg.repeatWindow && !state.volumeDoneAlerted) {
    const legs = ids.map((id) => state.volume?.[id]).filter(Boolean) as VolumeProgress[];
    const anyDone = legs.some((p) => p.phase === "done");
    const allDone = legs.length > 0 && legs.every((p) => p.phase === "done");
    if (anyDone && allDone) {
      state.volumeDoneAlerted = true;
      const totalVol = legs.reduce((s, p) => s + p.cumulativeBuyVolume + p.cumulativeSellVolume, 0);
      const totalTrades = legs.reduce((s, p) => s + p.trades, 0);
      const perWallet = ids
        .filter((id) => state.volume?.[id])
        .map((id) => {
          const p = state.volume![id]!;
          return `   • ${id}: ${f(p.cumulativeBuyVolume + p.cumulativeSellVolume, 0)} USDT, ${p.trades} trades`;
        });
      await notify.alertHere(
        `✅ Volume test complete — all ${legs.length} wallet(s) finished their ${cfg.durationHours}h window.\n` +
          `• Total volume: ${f(totalVol, 0)} USDT over ${totalTrades} trades\n` +
          perWallet.join("\n"),
      );
      saveState(rc.statePath, state);
    }
  }
}

/** One-line-per-wallet volume progress for the heartbeat. */
export function volumeSummary(state: BotState): string[] {
  if (!state.volume) return [];
  return Object.entries(state.volume).map(([id, p]) => {
    const vol = p.cumulativeBuyVolume + p.cumulativeSellVolume;
    const mkt = p.market ? ` @${p.market.slice(0, 8)}…` : "";
    return `• ${id}${mkt} → ${p.phase}: vol ${f(vol, 0)} USDT, ${p.trades} trades`;
  });
}
