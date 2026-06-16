// Slack reviews on two cadences (replaces the old single heartbeat):
//   • maybeMarketReview    — every marketReviewSec (~30m): total market volume +
//     the change since the last review, market cap, top outcomes, engine progress.
//   • maybePortfolioReview — every portfolioReviewSec (~1h): one message per
//     trading wallet with real on-chain holdings (or the paper ledger in dry-run),
//     valued at live price, plus cash, gas, and P&L.
import { formatUnits, getAddress, type Address } from "viem";
import type { RuntimeConfig } from "./config.ts";
import * as chain from "./chain.ts";
import * as notify from "./notify.ts";
import { campaignSummary } from "./campaign.ts";
import { volumeSummary } from "./volume-engine.ts";
import { buildMarketSnapshot } from "./market.ts";
import type { BotState, MarketSnapshot } from "./types.ts";
import type { ManagedWallet } from "./wallets.ts";

const n = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const sign = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${n(x, d)}`;

/** Snapshot for a given market, reusing the passed fallback or a per-call cache
 * (so multi-market reviews price each wallet against the market it trades). */
async function snapshotFor(
  rc: RuntimeConfig,
  market: string,
  fallback: MarketSnapshot,
  cache: Map<string, MarketSnapshot>,
): Promise<MarketSnapshot> {
  const key = market.toLowerCase();
  if (key === fallback.address.toLowerCase()) return fallback;
  let s = cache.get(key);
  if (!s) {
    s = await buildMarketSnapshot(rc.restBase, market);
    cache.set(key, s);
  }
  return s;
}

/** Market-volume update — replaces the old market-summary heartbeat. */
export async function maybeMarketReview(
  rc: RuntimeConfig,
  state: BotState,
  snapshot: MarketSnapshot,
): Promise<void> {
  const now = Date.now();
  const last = state.lastMarketReview ? new Date(state.lastMarketReview).getTime() : 0;
  if (now - last < rc.marketReviewSec * 1000) return;

  const prev = state.lastMarketVolume ?? snapshot.volume;
  const delta = snapshot.volume - prev;
  const pct = prev > 0 ? (delta / prev) * 100 : 0;
  const mins = Math.round(rc.marketReviewSec / 60);

  const byCap = [...snapshot.outcomes].sort((a, b) => b.marketCap - a.marketCap);
  const topLines = byCap
    .slice(0, 3)
    .map((o) => `   - ${o.name}: ${n(o.price, 4)} (cap ${n(o.marketCap, 0)})`);

  const engineLines = [...campaignSummary(state), ...volumeSummary(state)];
  const lines = [
    `📊 [${notify.tagStr()}] 42 market — volume update`,
    `• Market: ${snapshot.question} (${snapshot.status})`,
    `• Total volume: ${n(snapshot.volume, 0)} USDT  (Δ ${sign(delta, 0)} / ${sign(pct, 1)}% in ~${mins}m)`,
    `• Market cap: ${n(snapshot.totalMarketCap, 0)} USDT`,
    `• Top outcomes:`,
    ...topLines,
    ...(engineLines.length ? ["• Engines:", ...engineLines] : []),
  ];
  await notify.message(lines.join("\n"));
  state.lastMarketReview = new Date(now).toISOString();
  state.lastMarketVolume = snapshot.volume;
}

/** Hourly per-wallet portfolio review for every trading wallet. */
export async function maybePortfolioReview(
  rc: RuntimeConfig,
  state: BotState,
  snapshot: MarketSnapshot,
  wallets: ManagedWallet[],
): Promise<void> {
  const now = Date.now();
  const last = state.lastPortfolioReview ? new Date(state.lastPortfolioReview).getTime() : 0;
  if (now - last < rc.portfolioReviewSec * 1000) return;

  // A wallet is "trading" if it's armed, or owned by an active volume/campaign leg.
  const trading = wallets.filter((w) => {
    const armed = state.wallets?.[w.id]?.armed;
    const vol = state.volume?.[w.id];
    const camp = state.campaign?.[w.id];
    return armed || (vol && vol.phase !== "done") || (camp && camp.phase !== "done");
  });

  if (trading.length) {
    const cache = new Map<string, MarketSnapshot>();
    for (const w of trading) {
      try {
        // Price each wallet against the market it actually trades (multi-market).
        const mkt = state.volume?.[w.id]?.market ?? rc.targetMarket;
        const snap = await snapshotFor(rc, mkt, snapshot, cache);
        const priceByToken = new Map(snap.outcomes.map((o) => [o.tokenId, o.price]));
        const nameByToken = new Map(snap.outcomes.map((o) => [o.tokenId, o.name]));
        await notify.message(await buildReview(rc, state, w, getAddress(mkt) as Address, priceByToken, nameByToken));
      } catch (e) {
        await notify.error(`portfolio review ${w.label}: ${(e as Error).message}`);
      }
    }
  }
  state.lastPortfolioReview = new Date(now).toISOString();
}

/**
 * Build a one-shot portfolio summary (per-wallet USDT + on-chain position value
 * + grand total) as a single Slack message. Used by the dashboard's
 * "Send summary to Slack" button. Reads live chain (or paper ledger in dry-run).
 */
export async function buildPortfolioSummary(
  rc: RuntimeConfig,
  state: BotState,
  snapshot: MarketSnapshot,
  wallets: ManagedWallet[],
): Promise<string> {
  const cache = new Map<string, MarketSnapshot>();
  let tUsdt = 0;
  let tPos = 0;
  const lines: string[] = [];
  for (const w of wallets) {
    const addr = getAddress(w.address) as Address;
    const vol = state.volume?.[w.id];
    // Each wallet is valued against the market it trades (multi-market).
    const mkt = vol?.market ?? rc.targetMarket;
    const snap = await snapshotFor(rc, mkt, snapshot, cache);
    const priceByToken = new Map(snap.outcomes.map((o) => [o.tokenId, o.price]));
    let usdt: number;
    let posVal = 0;
    if (rc.dryRun && vol?.paper) {
      usdt = vol.paper.cash;
      for (const [t, wei] of Object.entries(vol.paper.holdings))
        posVal += parseFloat(formatUnits(BigInt(wei), 18)) * (priceByToken.get(Number(t)) ?? 0);
    } else {
      const [bal, us] = await Promise.all([chain.getBalances(addr), chain.getUserState(getAddress(mkt) as Address, addr)]);
      usdt = bal.usdt;
      for (const h of us.holdings)
        posVal += parseFloat(formatUnits(h.otHolding, 18)) * (priceByToken.get(h.tokenId) ?? 0);
    }
    tUsdt += usdt;
    tPos += posVal;
    lines.push(`• ${w.label}: USDT ${n(usdt)} | positions ${n(posVal)} | total ${n(usdt + posVal)}`);
  }
  return [
    `📋 [${notify.tagStr()}] Portfolio summary`,
    ...lines,
    `• TOTAL: USDT ${n(tUsdt)} | positions ${n(tPos)} | portfolio ${n(tUsdt + tPos)} USDT`,
  ].join("\n");
}

async function buildReview(
  rc: RuntimeConfig,
  state: BotState,
  w: ManagedWallet,
  market: Address,
  priceByToken: Map<number, number>,
  nameByToken: Map<number, string>,
): Promise<string> {
  const addr = getAddress(w.address) as Address;
  const vol = state.volume?.[w.id];
  const usePaper = rc.dryRun && !!vol?.paper;

  let bnb: number;
  let usdt: number;
  let holdings: Array<{ tokenId: number; ot: number }>;

  if (usePaper && vol?.paper) {
    const bal = await chain.getBalances(addr).catch(() => ({ bnb: 0, usdt: 0 }));
    bnb = bal.bnb;
    usdt = vol.paper.cash;
    holdings = Object.entries(vol.paper.holdings)
      .map(([t, wei]) => ({ tokenId: Number(t), ot: parseFloat(formatUnits(BigInt(wei), 18)) }))
      .filter((h) => h.ot > 1e-9);
  } else {
    const [bal, us] = await Promise.all([chain.getBalances(addr), chain.getUserState(market, addr)]);
    bnb = bal.bnb;
    usdt = bal.usdt;
    holdings = us.holdings
      .map((h) => ({ tokenId: h.tokenId, ot: parseFloat(formatUnits(h.otHolding, 18)) }))
      .filter((h) => h.ot > 1e-9);
  }

  let positionValue = 0;
  const holdLines = holdings
    .sort((a, b) => (priceByToken.get(b.tokenId) ?? 0) * b.ot - (priceByToken.get(a.tokenId) ?? 0) * a.ot)
    .map((h) => {
      const price = priceByToken.get(h.tokenId) ?? 0;
      const val = h.ot * price;
      positionValue += val;
      return `   - ${nameByToken.get(h.tokenId) ?? `Token ${h.tokenId}`}: ${n(h.ot)} OT @ ${n(price, 4)} = ${n(val)} USDT`;
    });

  const total = usdt + positionValue;
  const realized = state.wallets?.[w.id]?.realizedPnlUsdt ?? 0;
  const lines = [
    `💼 [${notify.tagStr()}] Portfolio — ${w.label}${usePaper ? " (paper)" : ""}`,
    `• BNB ${n(bnb, 5)} | USDT ${n(usdt)} | positions ${n(positionValue)} | total ${n(total)} USDT`,
    ...(holdLines.length ? ["• Holdings:", ...holdLines] : ["• Holdings: none"]),
  ];
  if (vol) {
    const v = vol.cumulativeBuyVolume + vol.cumulativeSellVolume;
    lines.push(
      `• Volume window: ${n(v, 0)} USDT over ${vol.trades} trades | P&L vs start ${sign(total - vol.initialBalance)} USDT (mark-to-market)`,
    );
  }
  if (realized !== 0) lines.push(`• Realized P&L ${sign(realized)} USDT`);
  return lines.join("\n");
}
