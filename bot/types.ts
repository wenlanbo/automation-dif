// Shared types for the single-market, multi-wallet 42.space trading bot.

export type CompareOp = ">" | ">=" | "<" | "<=" | "==" | "abs>" | "abs<";

/** A single entry/exit condition evaluated against an outcome's metrics. */
export interface Rule {
  metric: string;
  op: CompareOp;
  value: number;
}

export interface EntryConfig {
  rules: Rule[];
  combine: "all" | "any";
  minPriceUsdt: number;
  maxPriceUsdt: number;
}

export interface ExitConfig {
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldHours: number;
  exitBeforeEndHours: number;
}

export interface SizingConfig {
  /** USDT per entry, per wallet. */
  usdtPerTrade: number;
  /** Max concurrent positions per wallet. */
  maxConcurrentPositions: number;
  /** Max total USDT a single wallet may deploy into this market. */
  maxTotalExposureUsdt: number;
  reentryCooldownHours: number;
}

export interface ExecutionConfig {
  slippagePct: number;
  /** Halt live buys for a wallet if its BNB (gas) drops below this. */
  minBnbReserve: number;
}

export interface StrategyConfig {
  entry: EntryConfig;
  exit: ExitConfig;
  sizing: SizingConfig;
  execution: ExecutionConfig;
}

/** One outcome of the target market, enriched for display + rule matching. */
export interface Outcome {
  tokenId: number;
  name: string;
  price: number; // USDT/OT (on-chain marginal)
  supply: number; // OT in circulation
  marketCap: number; // USDT
  payoutPerOt: number;
  volume: number; // REST: outcome volume
  traders: number;
  metrics: Record<string, number>; // priceChange1h, volumeChange24h, buyRatio, ...
}

/** Full snapshot of the single market the bot trades. */
export interface MarketSnapshot {
  address: string;
  question: string;
  status: string; // live / ended / resolved / finalised
  isFinalised: boolean;
  endDate: string | null;
  totalMarketCap: number;
  volume: number;
  traders: number;
  numOutcomes: number;
  outcomes: Outcome[];
  fetchedAt: string;
}

/** An open position held by a wallet. */
export interface Position {
  tokenId: number;
  name: string;
  entryPrice: number;
  otAmountWei: string;
  usdtCost: number;
  openedAt: string;
  fill: "live" | "paper";
  txHash?: string;
}

export interface ClosedTrade {
  tokenId: number;
  name: string;
  entryPrice: number;
  exitPrice: number;
  usdtCost: number;
  usdtReturned: number;
  pnlUsdt: number;
  pnlPct: number;
  reason: string;
  openedAt: string;
  closedAt: string;
  fill: "live" | "paper";
}

/** Per-wallet persisted state. */
export interface WalletState {
  /** Safe switch. Default false = no trading. */
  armed: boolean;
  positions: Position[];
  closed: ClosedTrade[];
  /** tokenId -> ISO timestamp of last exit (re-entry cooldown). */
  cooldowns: Record<string, string>;
  realizedPnlUsdt: number;
}

/** Progress of one campaign leg (buy-all then ladder-sell), keyed by walletId. */
export interface CampaignProgress {
  outcome: string;
  tokenId: number;
  phase: "pending_buy" | "selling" | "done";
  /** OT bought (wei string) at entry — the ladder base. */
  initialOtWei: string;
  /** Per-tick sell size (wei string), ~initial/sellChunks, tick-aligned. */
  chunkWei: string;
  sellsRemaining: number;
  buyUsdt: number;
  /** ISO of the last buy/sell action (gates the 5-min cadence). */
  lastActionAt: string | null;
  buyTx?: string;
  lastSellTx?: string;
}

/**
 * Per-wallet progress for the volume-generation strategy (port of the quant's
 * WorldCupTradingStrategy). Holdings/cash come from chain when live; in dry-run
 * they live in `paper`. Only the controller state + schedule are persisted.
 */
export interface VolumeProgress {
  phase: "trading" | "done";
  /** Wallet capital at window start — drives volume rates + thresholds. */
  initialBalance: number;
  /** This window's target volume multiple. Set per window (randomized for
   * repeat windows); falls back to config when absent (legacy windows). */
  targetMultiple?: number;
  startedAt: string;
  /** ISO of next scheduled buy/sell event (gates the randomized cadence). */
  nextBuyAt: string;
  nextSellAt: string;
  cumulativeBuyVolume: number;
  cumulativeSellVolume: number;
  /** PI cash-controller integrated error (hours), windup-limited. */
  cashErrorIntegral: number;
  /** Cascade-sell sequence triggered after a large buy. */
  cascadeSellsRemaining: number;
  cascadeSellAmount: number;
  cascadeSellTokenId: number | null;
  nextSellIsLarge: boolean;
  lastLargeBuyAmount: number;
  trades: number;
  windowsDone: number;
  /** Non-continuous mode: per-token OT held when the liquidation phase began. */
  liqStartHoldings?: Record<string, number>;
  /** Dry-run only: simulated cash (USDT) + holdings (tokenId -> OT wei string). */
  paper?: { cash: number; holdings: Record<string, string> };
}

export interface BotState {
  /** Keyed by wallet id (label-derived or address). */
  wallets: Record<string, WalletState>;
  /** Distribute-out campaign progress, keyed by walletId. */
  campaign?: Record<string, CampaignProgress>;
  /** Volume-generation strategy progress, keyed by walletId. */
  volume?: Record<string, VolumeProgress>;
  lastRun: string | null;
  /** ISO of the last 30-min market-volume review (+ the volume seen then). */
  lastMarketReview?: string;
  lastMarketVolume?: number;
  /** ISO of the last hourly per-wallet portfolio review. */
  lastPortfolioReview?: string;
  /** When set, the volume strategy is paused (set on error) until resumed from
   * the dashboard. Trading halts; reviews keep running. */
  paused?: { reason: string; at: string };
  /** Guards the one-time "volume test complete" @here Slack alert. */
  volumeDoneAlerted?: boolean;
  /** Per-wallet gas-runway tracking for the 6h-ahead low-BNB alert. */
  gasWatch?: Record<string, { bnb: number; at: string; alertedAt?: string }>;
}

/** Live wallet runtime info (not persisted — keys live only in memory). */
export interface WalletRuntime {
  id: string;
  label: string;
  address: string;
  canSign: boolean;
}

/** A wallet's live portfolio view for the dashboard. */
export interface WalletPortfolio {
  id: string;
  label: string;
  address: string;
  armed: boolean;
  canSign: boolean;
  bnb: number;
  usdt: number;
  positions: Array<
    Position & {
      currentPrice: number;
      currentValue: number;
      unrealizedPnlUsdt: number;
      unrealizedPnlPct: number;
    }
  >;
  positionValueUsdt: number;
  realizedPnlUsdt: number;
  claimableUsdt: number;
}
