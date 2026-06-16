// Distribute-out campaign: each leg buys an outcome with ALL of a wallet's USDT,
// then sells a fixed chunk (~1/sellChunks of the entry) every sellEverySec until
// flat. Runs on the server's loop, persists progress, survives restarts, and
// posts a trade log to Slack for every fill. Respects DRY_RUN (paper when true).
import { existsSync, readFileSync } from "node:fs";
import { formatUnits, getAddress, type Address } from "viem";
import type { RuntimeConfig } from "./config.ts";
import * as chain from "./chain.ts";
import * as notify from "./notify.ts";
import type { BotState, CampaignProgress, MarketSnapshot } from "./types.ts";
import type { ManagedWallet } from "./wallets.ts";

const TICK_WEI = 10n ** 16n; // 0.01 OT

interface CampaignConfig {
  enabled: boolean;
  sellChunks: number;
  sellEverySec: number;
  slippagePct: number;
  minUsdt: number;
  legs: Array<{ walletId: string; outcome: string }>;
}

const DEFAULT: CampaignConfig = {
  enabled: false,
  sellChunks: 10,
  sellEverySec: 300,
  slippagePct: 3,
  minUsdt: 0.5,
  legs: [],
};

export function loadCampaign(): CampaignConfig {
  const path = process.env.CAMPAIGN_CONFIG_PATH ?? "campaign.json";
  if (!existsSync(path)) return DEFAULT;
  try {
    return { ...DEFAULT, ...(JSON.parse(readFileSync(path, "utf8")) as object) };
  } catch {
    return DEFAULT;
  }
}

const f = (n: number, d = 6) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const floorTick = (wei: bigint) => wei - (wei % TICK_WEI);

interface Bals {
  bnb: number;
  usdt: number;
  otWei: bigint;
  ot: number;
}

async function readBals(addr: Address, market: Address, tokenId: number): Promise<Bals> {
  const [b, us] = await Promise.all([
    chain.getBalances(addr),
    chain.getUserState(market, addr),
  ]);
  const h = us.holdings.find((x) => x.tokenId === tokenId);
  const otWei = h ? h.otHolding : 0n;
  return { bnb: b.bnb, usdt: b.usdt, otWei, ot: parseFloat(formatUnits(otWei, 18)) };
}

function tradeLog(
  emoji: string,
  label: string,
  action: string,
  name: string,
  a: Bals,
  b: Bals,
  tx?: string,
): string {
  return (
    `${emoji} [${notify.tagStr()}] ${label} ${action} ${name}\n` +
    `  USDT ${f(a.usdt, 4)} → ${f(b.usdt, 4)} (Δ ${f(b.usdt - a.usdt, 4)})\n` +
    `  ${name} OT ${f(a.ot)} → ${f(b.ot)} (Δ ${f(b.ot - a.ot)})\n` +
    `  gas Δ ${f(b.bnb - a.bnb)} BNB` +
    (tx ? `\n  tx ${tx}` : "")
  );
}

export async function runCampaign(
  rc: RuntimeConfig,
  wallets: ManagedWallet[],
  state: BotState,
  snapshot: MarketSnapshot,
): Promise<void> {
  const cfg = loadCampaign();
  if (!cfg.enabled || cfg.legs.length === 0) return;
  if (snapshot.isFinalised) return;
  state.campaign ??= {};
  const market = getAddress(rc.targetMarket) as Address;
  const now = Date.now();

  for (const leg of cfg.legs) {
    const w = wallets.find((x) => x.id === leg.walletId);
    if (!w) {
      await notify.warn(`campaign: wallet "${leg.walletId}" not loaded — skipping`);
      continue;
    }
    const oc = snapshot.outcomes.find(
      (o) => o.name.toLowerCase() === leg.outcome.toLowerCase(),
    );
    if (!oc) {
      await notify.warn(`campaign: outcome "${leg.outcome}" not found — skipping`);
      continue;
    }
    const addr = getAddress(w.address) as Address;
    let prog = state.campaign[leg.walletId];
    if (!prog) {
      prog = {
        outcome: oc.name,
        tokenId: oc.tokenId,
        phase: "pending_buy",
        initialOtWei: "0",
        chunkWei: "0",
        sellsRemaining: cfg.sellChunks,
        buyUsdt: 0,
        lastActionAt: null,
      };
      state.campaign[leg.walletId] = prog;
    }
    if (prog.phase === "done") continue;

    try {
      if (prog.phase === "pending_buy") {
        await doBuy(rc, cfg, w, addr, market, oc.tokenId, oc.name, prog);
      } else if (prog.phase === "selling") {
        const since = prog.lastActionAt ? now - new Date(prog.lastActionAt).getTime() : Infinity;
        if (since < cfg.sellEverySec * 1000) continue; // not time yet
        await doSell(rc, cfg, w, addr, market, oc.tokenId, oc.name, prog, now);
      }
    } catch (e) {
      await notify.error(`campaign ${w.label}/${oc.name}: ${(e as Error).message}`);
    }
  }
}

async function doBuy(
  rc: RuntimeConfig,
  cfg: CampaignConfig,
  w: ManagedWallet,
  addr: Address,
  market: Address,
  tokenId: number,
  name: string,
  prog: CampaignProgress,
): Promise<void> {
  const before = await readBals(addr, market, tokenId);
  if (before.usdt < cfg.minUsdt) {
    await notify.warn(`campaign ${w.label}: USDT ${f(before.usdt, 4)} < min ${cfg.minUsdt} — marking done`);
    prog.phase = "done";
    return;
  }
  // Buy with ~all USDT (floor to 6 dp so we never request above balance).
  const buyUsdt = Math.floor(before.usdt * 1e6) / 1e6;
  const sim = await chain.simulateBuy(market, tokenId, buyUsdt);

  let tx: string | undefined;
  let after: Bals;
  if (!rc.dryRun) {
    tx = (await chain.executeBuy(w.signer, market, tokenId, buyUsdt, cfg.slippagePct, sim)).hash;
    after = await readBals(addr, market, tokenId);
  } else {
    after = {
      bnb: before.bnb,
      usdt: before.usdt - (sim.costUsdt + sim.feeUsdt),
      otWei: before.otWei + sim.otToUserWei,
      ot: before.ot + parseFloat(formatUnits(sim.otToUserWei, 18)),
    };
  }

  const boughtWei = after.otWei - before.otWei;
  prog.initialOtWei = after.otWei.toString(); // ladder base = total holding
  prog.chunkWei = (floorTick(after.otWei / BigInt(cfg.sellChunks)) || TICK_WEI).toString();
  prog.sellsRemaining = cfg.sellChunks;
  prog.buyUsdt = buyUsdt;
  prog.phase = "selling";
  prog.lastActionAt = new Date().toISOString();
  prog.buyTx = tx;

  console.log(`  [campaign] ${w.label} BUY ${name} all USDT (${f(buyUsdt, 4)}) -> ${f(parseFloat(formatUnits(boughtWei, 18)))} OT${tx ? ` ${tx}` : ""}`);
  await notify.message(tradeLog("🟢", w.label, `BUY all USDT (${f(buyUsdt, 2)}) →`, name, before, after, tx));
}

async function doSell(
  rc: RuntimeConfig,
  cfg: CampaignConfig,
  w: ManagedWallet,
  addr: Address,
  market: Address,
  tokenId: number,
  name: string,
  prog: CampaignProgress,
  now: number,
): Promise<void> {
  const before = await readBals(addr, market, tokenId);
  const holding = before.otWei;
  if (floorTick(holding) <= 0n) {
    prog.phase = "done";
    await notify.info(`campaign ${w.label}/${name}: position cleared ✅`);
    return;
  }

  const chunk = BigInt(prog.chunkWei);
  // Last scheduled sell (or chunk >= holding) dumps the remainder.
  let sellWei = prog.sellsRemaining <= 1 || chunk >= holding ? holding : chunk;
  sellWei = floorTick(sellWei);
  if (sellWei <= 0n) sellWei = floorTick(holding);
  if (sellWei <= 0n) {
    prog.phase = "done";
    return;
  }

  const sim = await chain.simulateSell(market, tokenId, sellWei);
  let tx: string | undefined;
  let after: Bals;
  if (!rc.dryRun) {
    tx = (await chain.executeSell(w.signer, market, tokenId, sellWei, cfg.slippagePct, sim)).hash;
    after = await readBals(addr, market, tokenId);
  } else {
    after = {
      bnb: before.bnb,
      usdt: before.usdt + sim.collateralUsdt,
      otWei: before.otWei - sellWei,
      ot: before.ot - parseFloat(formatUnits(sellWei, 18)),
    };
  }

  prog.sellsRemaining = Math.max(0, prog.sellsRemaining - 1);
  prog.lastActionAt = new Date(now).toISOString();
  prog.lastSellTx = tx;
  const step = cfg.sellChunks - prog.sellsRemaining;
  if (prog.sellsRemaining <= 0 || floorTick(after.otWei) <= 0n) prog.phase = "done";

  console.log(`  [campaign] ${w.label} SELL ${name} step ${step}/${cfg.sellChunks} -> ${f(parseFloat(formatUnits(sellWei, 18)))} OT${tx ? ` ${tx}` : ""}`);
  await notify.message(
    tradeLog("🔴", w.label, `SELL step ${step}/${cfg.sellChunks} (${prog.phase === "done" ? "FINAL" : prog.sellsRemaining + " left"})`, name, before, after, tx),
  );
  if (prog.phase === "done") await notify.info(`campaign ${w.label}/${name}: fully sold out ✅`);
}

/** One-line-per-leg campaign progress for the heartbeat. */
export function campaignSummary(state: BotState): string[] {
  if (!state.campaign) return [];
  return Object.entries(state.campaign).map(
    ([id, p]) =>
      `• ${id} → ${p.outcome}: ${p.phase}` +
      (p.phase === "selling" ? ` (${p.sellsRemaining} sells left)` : ""),
  );
}
