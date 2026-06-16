// Single-market, multi-wallet trading cycle. Trades a wallet ONLY when it is
// armed (safe switch on). Real txs only when armed AND not dry-run; armed +
// dry-run = paper fills. Disarmed wallets are never touched.
import { getAddress, type Address } from "viem";
import type { RuntimeConfig } from "./config.ts";
import type { BotState, MarketSnapshot, Outcome, Position, StrategyConfig } from "./types.ts";
import { passesEntry } from "./rules.ts";
import * as chain from "./chain.ts";
import * as notify from "./notify.ts";
import { inCooldown, totalExposure, walletSlot } from "./state.ts";
import type { ManagedWallet } from "./wallets.ts";

const HOUR_MS = 3600_000;

function hoursUntil(iso: string | null, now: number): number {
  if (!iso) return Infinity;
  return (new Date(iso).getTime() - now) / HOUR_MS;
}

function decideExit(
  p: Position,
  price: number,
  cfg: StrategyConfig,
  endDate: string | null,
  now: number,
): { exit: boolean; reason: string } {
  const pnlPct = ((price - p.entryPrice) / p.entryPrice) * 100;
  if (cfg.exit.takeProfitPct > 0 && pnlPct >= cfg.exit.takeProfitPct)
    return { exit: true, reason: `take-profit (+${pnlPct.toFixed(1)}%)` };
  if (cfg.exit.stopLossPct > 0 && pnlPct <= -cfg.exit.stopLossPct)
    return { exit: true, reason: `stop-loss (${pnlPct.toFixed(1)}%)` };
  const heldH = (now - new Date(p.openedAt).getTime()) / HOUR_MS;
  if (cfg.exit.maxHoldHours > 0 && heldH >= cfg.exit.maxHoldHours)
    return { exit: true, reason: `max-hold (${heldH.toFixed(1)}h)` };
  if (hoursUntil(endDate, now) <= cfg.exit.exitBeforeEndHours)
    return { exit: true, reason: `market ending soon` };
  return { exit: false, reason: `hold (pnl ${pnlPct.toFixed(1)}%)` };
}

export interface CycleSummary {
  market: string;
  status: string;
  entries: string[];
  exits: string[];
  errors: string[];
  openPositions: number;
  exposureUsdt: number;
  realizedPnlUsdt: number;
  armedWallets: number;
}

export async function runCycle(
  rc: RuntimeConfig,
  cfg: StrategyConfig,
  wallets: ManagedWallet[],
  state: BotState,
  snapshot: MarketSnapshot,
): Promise<CycleSummary> {
  const now = Date.now();
  const market = getAddress(rc.targetMarket) as Address;
  const priceByToken = new Map(snapshot.outcomes.map((o) => [o.tokenId, o.price]));
  const summary: CycleSummary = {
    market: rc.targetMarket,
    status: snapshot.status,
    entries: [],
    exits: [],
    errors: [],
    openPositions: 0,
    exposureUsdt: 0,
    realizedPnlUsdt: 0,
    armedWallets: 0,
  };

  if (snapshot.isFinalised) {
    await notify.warn(`Market ${rc.targetMarket} is finalised — no trading. Claim winnings manually.`);
  }

  // Candidate outcomes sorted by 1h momentum (best first) for entry priority.
  const candidates: Outcome[] = [...snapshot.outcomes].sort(
    (a, b) => (b.metrics.priceChange1h ?? 0) - (a.metrics.priceChange1h ?? 0),
  );

  for (const w of wallets) {
    const ws = walletSlot(state, w.id);

    // Skip wallets managed by an active campaign leg or volume-strategy window —
    // those engines own the wallet, so the rules engine must never double-trade it.
    const campaignLeg = state.campaign?.[w.id];
    const volumeLeg = state.volume?.[w.id];
    if ((campaignLeg && campaignLeg.phase !== "done") || (volumeLeg && volumeLeg.phase !== "done")) {
      summary.openPositions += ws.positions.length;
      summary.exposureUsdt += totalExposure(ws);
      summary.realizedPnlUsdt += ws.realizedPnlUsdt;
      continue;
    }

    if (ws.armed) summary.armedWallets++;
    const tag = `[${rc.dryRun ? "DRY" : "LIVE"}|${w.label}]`;

    // Disarmed wallets are never traded — safe switch off.
    if (!ws.armed) {
      summary.openPositions += ws.positions.length;
      summary.exposureUsdt += totalExposure(ws);
      summary.realizedPnlUsdt += ws.realizedPnlUsdt;
      continue;
    }

    // ---- EXITS ----
    if (!snapshot.isFinalised) {
      for (const p of [...ws.positions]) {
        try {
          const price = priceByToken.get(p.tokenId) ?? (await chain.simulateSell(market, p.tokenId, BigInt(p.otAmountWei))).priceBefore;
          const d = decideExit(p, price, cfg, snapshot.endDate, now);
          if (!d.exit) continue;
          const otWei = BigInt(p.otAmountWei);
          const sim = await chain.simulateSell(market, p.tokenId, otWei);
          let txHash: string | undefined;
          if (!rc.dryRun) {
            txHash = (await chain.executeSell(w.signer, market, p.tokenId, otWei, cfg.execution.slippagePct, sim)).hash;
          }
          const pnl = sim.collateralUsdt - p.usdtCost;
          const pnlPct = p.usdtCost > 0 ? (pnl / p.usdtCost) * 100 : 0;
          ws.realizedPnlUsdt += pnl;
          ws.closed.push({
            tokenId: p.tokenId,
            name: p.name,
            entryPrice: p.entryPrice,
            exitPrice: price,
            usdtCost: p.usdtCost,
            usdtReturned: sim.collateralUsdt,
            pnlUsdt: pnl,
            pnlPct,
            reason: d.reason,
            openedAt: p.openedAt,
            closedAt: new Date(now).toISOString(),
            fill: rc.dryRun ? "paper" : "live",
          });
          ws.positions = ws.positions.filter((x) => x.tokenId !== p.tokenId);
          ws.cooldowns[String(p.tokenId)] = new Date(now).toISOString();
          const line = `${tag} SELL ${p.name} — ${d.reason} | back ${sim.collateralUsdt.toFixed(3)} USDT, pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} (${pnlPct.toFixed(1)}%)${txHash ? ` | ${txHash}` : ""}`;
          console.log("  " + line);
          summary.exits.push(line);
        } catch (e) {
          const msg = `${w.label} exit ${p.name}: ${(e as Error).message}`;
          summary.errors.push(msg);
          await notify.error(msg);
        }
      }
    }

    // ---- ENTRIES ----
    if (!snapshot.isFinalised) {
      // Per-wallet balance gate for live trading.
      let usdtAvailable = Infinity;
      if (!rc.dryRun) {
        const bal = await chain.getBalances(getAddress(w.address) as Address);
        if (bal.bnb < cfg.execution.minBnbReserve) {
          await notify.warn(`${w.label}: BNB ${bal.bnb} below reserve ${cfg.execution.minBnbReserve} — skipping buys`);
          continue;
        }
        usdtAvailable = bal.usdt;
      }

      for (const c of candidates) {
        if (ws.positions.length >= cfg.sizing.maxConcurrentPositions) break;
        if (ws.positions.some((p) => p.tokenId === c.tokenId)) continue;
        if (inCooldown(ws, c.tokenId, cfg.sizing.reentryCooldownHours, now)) continue;
        if (hoursUntil(snapshot.endDate, now) <= cfg.exit.exitBeforeEndHours) continue;

        const verdict = passesEntry(c, cfg.entry);
        if (!verdict.ok) continue;

        const size = cfg.sizing.usdtPerTrade;
        if (totalExposure(ws) + size > cfg.sizing.maxTotalExposureUsdt) continue;
        if (!rc.dryRun && size > usdtAvailable) continue;

        try {
          const sim = await chain.simulateBuy(market, c.tokenId, size);
          let txHash: string | undefined;
          if (!rc.dryRun) {
            txHash = (await chain.executeBuy(w.signer, market, c.tokenId, size, cfg.execution.slippagePct, sim)).hash;
            usdtAvailable -= size;
          }
          ws.positions.push({
            tokenId: c.tokenId,
            name: c.name,
            entryPrice: sim.priceBefore,
            otAmountWei: sim.otToUserWei.toString(),
            usdtCost: sim.costUsdt + sim.feeUsdt,
            openedAt: new Date(now).toISOString(),
            fill: rc.dryRun ? "paper" : "live",
            txHash,
          });
          const line = `${tag} BUY ${c.name} — ${size} USDT @ ${sim.priceBefore.toFixed(4)}/OT | ${verdict.reason}${txHash ? ` | ${txHash}` : ""}`;
          console.log("  " + line);
          summary.entries.push(line);
        } catch (e) {
          const msg = `${w.label} entry ${c.name}: ${(e as Error).message}`;
          summary.errors.push(msg);
          await notify.error(msg);
        }
      }
    }

    summary.openPositions += ws.positions.length;
    summary.exposureUsdt += totalExposure(ws);
    summary.realizedPnlUsdt += ws.realizedPnlUsdt;
  }

  state.lastRun = new Date(now).toISOString();
  return summary;
}
