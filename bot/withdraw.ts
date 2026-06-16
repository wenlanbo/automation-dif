// Fund-retrieval / liquidation routine. Two modes via opts.to:
//   • liquidate-only (no `to`): sell ALL positions back to USDT, keep cash in the wallets.
//   • full withdraw (`to` set): liquidate, then send USDT then BNB to `to`
//     (BNB last, since the USDT transfer needs gas).
// Runs inside the server process (which owns the signers) AFTER the strategy is
// paused, so it never races the trading loop for nonces. Progress → Slack + logs.
import { formatUnits, getAddress, type Address } from "viem";
import type { RuntimeConfig } from "./config.ts";
import * as chain from "./chain.ts";
import * as notify from "./notify.ts";
import type { ManagedWallet } from "./wallets.ts";

const TICK_WEI = 10n ** 16n; // 0.01 OT
const floorTick = (wei: bigint) => wei - (wei % TICK_WEI);
const f = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });

async function readHolding(market: Address, addr: Address, tokenId: number): Promise<bigint> {
  const us = await chain.getUserState(market, addr);
  return us.holdings.find((h) => h.tokenId === tokenId)?.otHolding ?? 0n;
}

/** Sell a full position to USDT, halving on revert (price impact) down to a floor.
 *  Returns USDT received (from the sims). */
async function liquidatePosition(
  rc: RuntimeConfig,
  w: ManagedWallet,
  market: Address,
  tokenId: number,
  slippagePct: number,
): Promise<number> {
  const addr = getAddress(w.address) as Address;
  let remaining = floorTick(await readHolding(market, addr, tokenId));
  let gotUsdt = 0;
  let rounds = 0;
  while (remaining > 0n && rounds < 14) {
    rounds++;
    let lot = remaining;
    let sold = false;
    for (let h = 0; h < 7 && lot >= TICK_WEI; h++) {
      try {
        const sim = await chain.simulateSell(market, tokenId, lot);
        if (!rc.dryRun) await chain.executeSell(w.signer, market, tokenId, lot, slippagePct, sim);
        gotUsdt += sim.collateralUsdt;
        sold = true;
        break;
      } catch {
        lot = floorTick(lot / 2n); // impact too high — try a smaller slice
      }
    }
    if (!sold) break;
    if (rc.dryRun) break; // holdings don't change on-chain in dry-run; one pass only
    remaining = floorTick(await readHolding(market, addr, tokenId));
  }
  return gotUsdt;
}

export interface DrainRow {
  label: string;
  positionsUsdt: number; // value of positions before liquidation
  usdtAfterSell: number; // USDT balance after selling (before any transfer)
  usdtSent: number; // USDT transferred out (full withdraw only)
  bnbSent: number; // BNB transferred out (full withdraw only)
  error?: string;
}
export interface DrainResult {
  mode: "liquidate" | "withdraw";
  to?: string;
  rows: DrainRow[];
}

export async function withdrawAll(
  rc: RuntimeConfig,
  wallets: ManagedWallet[],
  opts: { to?: Address; slippagePct?: number },
): Promise<DrainResult> {
  const market = getAddress(rc.targetMarket) as Address;
  const to = opts.to;
  const slippagePct = opts.slippagePct ?? 12;
  const result: DrainResult = { mode: to ? "withdraw" : "liquidate", ...(to ? { to } : {}), rows: [] };

  await notify.alertHere(
    to
      ? `💸 [${notify.tagStr()}] Withdraw started → ${to}\nLiquidating all positions, then sending USDT then BNB from ${wallets.length} wallet(s).`
      : `🧮 [${notify.tagStr()}] Liquidation started — selling ALL positions to USDT across ${wallets.length} wallet(s) (cash kept in wallets).`,
  );

  for (const w of wallets) {
    const addr = getAddress(w.address) as Address;
    const row: DrainRow = { label: w.label, positionsUsdt: 0, usdtAfterSell: 0, usdtSent: 0, bnbSent: 0 };
    try {
      // Value + list current positions (getUserState carries a price per token).
      const us = await chain.getUserState(market, addr);
      const held = us.holdings.filter((h) => floorTick(h.otHolding) > 0n);
      row.positionsUsdt = held.reduce((s, h) => s + parseFloat(formatUnits(h.otHolding, 18)) * h.price, 0);

      // 1. Sell every position to USDT.
      for (const h of held) await liquidatePosition(rc, w, market, h.tokenId, slippagePct);
      row.usdtAfterSell = parseFloat(formatUnits(await chain.usdtBalanceWei(addr), 18));

      // 2/3. Full withdraw only: send USDT then BNB.
      if (to && !rc.dryRun) {
        const usdtWei = await chain.usdtBalanceWei(addr);
        if (usdtWei > 0n) {
          await chain.transferUsdt(w.signer, to, usdtWei);
          row.usdtSent = parseFloat(formatUnits(usdtWei, 18));
        }
        const sent = await chain.sendAllBnb(w.signer, to);
        if (sent) row.bnbSent = parseFloat(formatUnits(sent.valueWei, 18));
      }

      const line = to
        ? `  ✅ ${w.label}: sold ${f(row.positionsUsdt)} positions → sent ${f(row.usdtSent)} USDT + ${f(row.bnbSent, 5)} BNB`
        : `  ✅ ${w.label}: sold ${f(row.positionsUsdt)} positions → USDT balance now ${f(row.usdtAfterSell)}`;
      console.log("  [withdraw]" + line);
      await notify.message(line);
    } catch (e) {
      row.error = (e as Error).message;
      await notify.error(`${result.mode} ${w.label}: ${row.error}`);
    }
    result.rows.push(row);
  }

  const totSold = result.rows.reduce((s, r) => s + r.positionsUsdt, 0);
  if (to) {
    const u = result.rows.reduce((s, r) => s + r.usdtSent, 0);
    const b = result.rows.reduce((s, r) => s + r.bnbSent, 0);
    await notify.alertHere(`✅ [${notify.tagStr()}] Withdraw complete → ${to}\nSold ${f(totSold)} in positions; sent ${f(u)} USDT + ${f(b, 5)} BNB.`);
  } else {
    const cash = result.rows.reduce((s, r) => s + r.usdtAfterSell, 0);
    await notify.alertHere(`✅ [${notify.tagStr()}] Liquidation complete — sold ${f(totSold)} of positions; wallets now hold ${f(cash)} USDT total.`);
  }
  return result;
}
