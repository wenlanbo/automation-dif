// Loads + validates the volume-generation strategy config (volume.config.json).
// This is the TS counterpart of the quant's WorldCupTradingStrategy constructor
// parameters. Prices are NOT configured here — they come live from the market
// snapshot; only the outcome NAMES + probability weights are configured.
import { existsSync, readFileSync } from "node:fs";

export interface VolumeOutcome {
  /** Outcome name as it appears in the market (case-insensitive match). */
  name: string;
  /** Selection probability weight (normalized across resolvable outcomes). */
  weight: number;
}

/** One market this bot trades, with its own outcomes + weights. */
export interface VolumeMarket {
  /** Market contract address. */
  address: string;
  /** Display label (Slack/logs). */
  label?: string;
  /** Outcomes to trade in this market + selection weights. */
  outcomes: VolumeOutcome[];
}

export interface VolumeConfig {
  enabled: boolean;
  /** Total execution window X (hours). */
  durationHours: number;
  /** Target volume = initialBalance * targetVolumeMultiple. */
  targetVolumeMultiple: number;
  /** True: buy+sell smoothly the whole window. False: phase-split liquidation. */
  continuousTrading: boolean;
  /** Force-sell all inventory at the end of the window. */
  forceLiquidationAtEnd: boolean;
  /** Target cash ratio on the wallet (0.10 = 10% cash, 90% deployed). */
  targetCashRatio: number;
  /** Log-normal sigma for order-size variation (many small, some large). */
  sizeVolatility: number;
  /** Fraction of the window after which buying stops (non-continuous only). */
  liquidationRatio: number;
  /** Minimum trade size in USDT (orders below this are skipped). */
  minOrderUsdt: number;
  /** Slippage tolerance for on-chain execution (percent). */
  slippagePct: number;
  /** Retries for a reverted/failed trade (fresh quote each time) before pausing. */
  maxTradeRetries: number;
  /** Randomized buy interval [min, max] seconds. */
  buyIntervalSec: [number, number];
  /** Randomized sell interval [min, max] seconds. */
  sellIntervalSec: [number, number];
  /** Hard override for the per-window trade cadence [min,max] seconds. When set,
   * bypasses the target-scaled windowIntervals (used for max-throughput sprints). */
  intervalOverrideSec?: [number, number];
  /** Fallback buy size as a fraction of cash [min, max]. */
  buyPctRange: [number, number];
  /** Fallback sell size as a fraction of holdings [min, max]. */
  sellPctRange: [number, number];
  /** When a window completes, reset and start a fresh one (ongoing volume). */
  repeatWindow: boolean;
  /** Dry-run starting cash per wallet (paper ledger seed). */
  paperBalanceUsdt: number;
  /** Halt live buys for a wallet if BNB (gas) drops below this. */
  minBnbReserve: number;
  /** Outcomes to trade + weights (single-market mode / fallback). */
  outcomes: VolumeOutcome[];
  /** Multi-market mode: trade several markets at once. Each managed wallet is
   * assigned one market (round-robin). When set + non-empty, this supersedes the
   * single `outcomes`/TARGET_MARKET path. */
  markets?: VolumeMarket[];
  /** Wallet ids this strategy manages. Empty = all loaded wallets. */
  wallets: string[];
}

export const DEFAULT_VOLUME_CONFIG: VolumeConfig = {
  enabled: false,
  durationHours: 24,
  targetVolumeMultiple: 4.0,
  continuousTrading: true,
  forceLiquidationAtEnd: false,
  targetCashRatio: 0.1,
  sizeVolatility: 0.8,
  liquidationRatio: 0.8,
  minOrderUsdt: 1.0,
  slippagePct: 3,
  maxTradeRetries: 5,
  buyIntervalSec: [300, 7200],
  sellIntervalSec: [300, 7200],
  buyPctRange: [0.1, 0.3],
  sellPctRange: [0.2, 0.6],
  repeatWindow: false,
  paperBalanceUsdt: 1000,
  minBnbReserve: 0.005,
  outcomes: [
    { name: "France", weight: 0.2 },
    { name: "Spain", weight: 0.2 },
    { name: "England", weight: 0.15 },
    { name: "Portugal", weight: 0.14 },
    { name: "Argentina", weight: 0.11 },
    { name: "Brazil", weight: 0.1 },
    { name: "Germany", weight: 0.05 },
    { name: "Netherlands", weight: 0.05 },
  ],
  wallets: [],
};

export function loadVolumeConfig(): VolumeConfig {
  const path = process.env.VOLUME_CONFIG_PATH ?? "volume.config.json";
  if (!existsSync(path)) return DEFAULT_VOLUME_CONFIG;
  let parsed: Partial<VolumeConfig>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VolumeConfig>;
  } catch {
    return DEFAULT_VOLUME_CONFIG;
  }
  const cfg = { ...DEFAULT_VOLUME_CONFIG, ...parsed };
  validate(cfg);
  return cfg;
}

function validate(c: VolumeConfig): void {
  const errs: string[] = [];
  if (c.durationHours <= 0) errs.push("durationHours must be > 0");
  if (c.targetVolumeMultiple <= 0) errs.push("targetVolumeMultiple must be > 0");
  if (c.targetCashRatio < 0 || c.targetCashRatio >= 1)
    errs.push("targetCashRatio must be in [0, 1)");
  if (c.minOrderUsdt <= 0) errs.push("minOrderUsdt must be > 0");
  if (c.slippagePct < 0 || c.slippagePct >= 100) errs.push("slippagePct must be in [0, 100)");
  const multi = Array.isArray(c.markets) && c.markets.length > 0;
  if (multi) {
    c.markets!.forEach((m, i) => {
      if (!m.address) errs.push(`markets[${i}]: address required`);
      if (!Array.isArray(m.outcomes) || m.outcomes.length === 0)
        errs.push(`markets[${i}] (${m.label ?? m.address}): outcomes must be non-empty`);
      else if (m.outcomes.some((o) => !o.name || o.weight <= 0))
        errs.push(`markets[${i}] (${m.label ?? m.address}): each outcome needs a name and weight > 0`);
    });
  } else {
    if (!Array.isArray(c.outcomes) || c.outcomes.length === 0)
      errs.push("outcomes must be a non-empty array (or set markets[])");
    if (c.outcomes.some((o) => !o.name || o.weight <= 0))
      errs.push("each outcome needs a name and weight > 0");
  }
  if (errs.length) throw new Error("invalid volume.config.json:\n  - " + errs.join("\n  - "));
}
