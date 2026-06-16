// One full cycle: snapshot the market, trade armed wallets, send reviews, persist.
// Shared by the CLI (one-shot) and the dashboard server (loop).
import type { RuntimeConfig } from "./config.ts";
import type { BotState, MarketSnapshot, StrategyConfig } from "./types.ts";
import { buildMarketSnapshot } from "./market.ts";
import { runCycle, type CycleSummary } from "./engine.ts";
import { runCampaign } from "./campaign.ts";
import { runVolumeStrategy } from "./volume-engine.ts";
import { maybeMarketReview, maybePortfolioReview } from "./reviews.ts";
import { saveState } from "./state.ts";
import type { ManagedWallet } from "./wallets.ts";

export interface CycleResult {
  snapshot: MarketSnapshot;
  summary: CycleSummary;
}

export async function oneCycle(
  rc: RuntimeConfig,
  cfg: StrategyConfig,
  wallets: ManagedWallet[],
  state: BotState,
): Promise<CycleResult> {
  const snapshot = await buildMarketSnapshot(rc.restBase, rc.targetMarket);
  const summary = await runCycle(rc, cfg, wallets, state, snapshot);
  // Distribute-out campaign (buy-all then ladder-sell). Independent of the
  // rules engine / safe switch; controlled by campaign.json.
  await runCampaign(rc, wallets, state, snapshot);
  // Volume-generation strategy (continuous PI-controlled market-making).
  // Independent of the rules engine / safe switch; controlled by volume.config.json.
  await runVolumeStrategy(rc, wallets, state, snapshot);
  // Slack reviews: market-volume update (~30m) + per-wallet portfolio review (~1h).
  await maybeMarketReview(rc, state, snapshot);
  await maybePortfolioReview(rc, state, snapshot, wallets);
  saveState(rc.statePath, state);
  return { snapshot, summary };
}
