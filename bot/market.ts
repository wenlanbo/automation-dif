// Builds a full snapshot of the target market by merging on-chain Lens data
// (authoritative price/supply/marketcap) with REST metadata (names, volume,
// statsChanges used by the strategy rules).
import { getAddress, type Address } from "viem";
import * as chain from "./chain.ts";
import { fetchMarketMeta, fetchOutcomeStats } from "./rest.ts";
import type { MarketSnapshot, Outcome } from "./types.ts";

export async function buildMarketSnapshot(
  restBase: string,
  marketRaw: string,
): Promise<MarketSnapshot> {
  const market = getAddress(marketRaw) as Address;

  const [snap, meta, stats] = await Promise.all([
    chain.snapshotMarket(market),
    fetchMarketMeta(restBase, market).catch(() => null),
    fetchOutcomeStats(restBase, market).catch(() => new Map()),
  ]);

  const outcomes: Outcome[] = snap.ots.map((ot) => {
    const s = stats.get(ot.tokenId);
    return {
      tokenId: ot.tokenId,
      name: s?.name ?? `Token ${ot.tokenId}`,
      price: ot.price,
      supply: ot.supply,
      marketCap: ot.price * ot.supply,
      payoutPerOt: ot.payoutPerOt,
      volume: s?.volume ?? 0,
      traders: s?.traders ?? 0,
      // metrics namespace for rules; on-chain price overrides REST price.
      metrics: { ...(s?.metrics ?? {}), price: ot.price },
    };
  });

  return {
    address: market,
    question: meta?.question ?? "Unknown market",
    status: meta?.status ?? (snap.isFinalised ? "finalised" : "live"),
    isFinalised: snap.isFinalised,
    endDate: meta?.endDate ?? null,
    totalMarketCap: snap.totalMarketCap,
    volume: meta?.volume ?? 0,
    traders: meta?.traders ?? 0,
    numOutcomes: snap.numOutcomes,
    outcomes,
    fetchedAt: new Date().toISOString(),
  };
}
