// Loads + validates strategy config and runtime env for the single-market bot.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import type { StrategyConfig } from "./types.ts";

/** The one market this bot trades. Override with TARGET_MARKET if needed. */
export const DEFAULT_TARGET_MARKET = "0x38D8CA35d8662b2c6C94199497d787c93Aa34fEE";

export const DEFAULT_CONFIG: StrategyConfig = {
  entry: {
    // Momentum within the target market's outcomes. statsChanges are PERCENT.
    rules: [
      { metric: "priceChange1h", op: ">", value: 3 },
      { metric: "volumeChange24h", op: ">", value: 20 },
      { metric: "buyRatio", op: ">", value: 0.1 },
    ],
    combine: "all",
    minPriceUsdt: 0.01,
    maxPriceUsdt: 0.95,
  },
  exit: {
    takeProfitPct: 25,
    stopLossPct: 15,
    maxHoldHours: 72,
    exitBeforeEndHours: 6,
  },
  sizing: {
    usdtPerTrade: 5,
    maxConcurrentPositions: 3,
    maxTotalExposureUsdt: 25,
    reentryCooldownHours: 12,
  },
  execution: {
    slippagePct: 2,
    minBnbReserve: 0.005,
  },
};

export interface WalletKey {
  id: string;
  label: string;
  privateKey: string;
}

export interface RuntimeConfig {
  dryRun: boolean;
  rpc: string;
  targetMarket: string;
  restBase: string;
  intervalSec: number;
  /** Cadence of the market-volume update to Slack (seconds). */
  marketReviewSec: number;
  /** Cadence of the per-wallet portfolio review to Slack (seconds). */
  portfolioReviewSec: number;
  statePath: string;
  configPath: string;
  integratorAddress?: string;
  integratorFeeBps: bigint;
  slackWebhook?: string;
  // dashboard
  host: string;
  port: number;
  dashboardPassword: string;
  sessionSecret: string;
  sessionSeconds: number;
  wallets: WalletKey[];
}

function deepMerge<T>(base: T, override: unknown): T {
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof override !== "object" ||
    override === null ||
    Array.isArray(override)
  ) {
    return override === undefined ? base : (override as T);
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function loadStrategy(configPath: string): StrategyConfig {
  if (!existsSync(configPath)) {
    console.warn(`  config: ${configPath} not found — using built-in defaults.`);
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`failed to parse ${configPath}: ${(e as Error).message}`);
  }
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  validateStrategy(merged);
  return merged;
}

function validateStrategy(c: StrategyConfig): void {
  const errs: string[] = [];
  if (c.sizing.usdtPerTrade <= 0) errs.push("sizing.usdtPerTrade must be > 0");
  if (c.sizing.maxConcurrentPositions < 1)
    errs.push("sizing.maxConcurrentPositions must be >= 1");
  if (c.sizing.maxTotalExposureUsdt < c.sizing.usdtPerTrade)
    errs.push("sizing.maxTotalExposureUsdt must be >= usdtPerTrade");
  if (c.execution.slippagePct < 0 || c.execution.slippagePct >= 100)
    errs.push("execution.slippagePct must be in [0, 100)");
  if (c.entry.minPriceUsdt < 0 || c.entry.maxPriceUsdt <= c.entry.minPriceUsdt)
    errs.push("entry: require 0 <= minPriceUsdt < maxPriceUsdt");
  if (!Array.isArray(c.entry.rules) || c.entry.rules.length === 0)
    errs.push("entry.rules must be a non-empty array");
  if (errs.length)
    throw new Error("invalid strategy config:\n  - " + errs.join("\n  - "));
}

/**
 * Load wallet keys from env. Scans WALLET_1_KEY..WALLET_50_KEY (and the legacy
 * single BSC_PRIVATE_KEY). Keys never touch disk or logs.
 */
export function loadWalletKeys(): WalletKey[] {
  const env = process.env;
  const out: WalletKey[] = [];
  const seen = new Set<string>();

  const add = (id: string, label: string, raw: string | undefined) => {
    if (!raw) return;
    let key = raw.trim();
    // "EMPTY" (case-insensitive) and blank are cleared-slot sentinels — skip,
    // since Railway's CLI can't store a truly empty value or delete a var.
    if (key === "" || key.toUpperCase() === "EMPTY") return;
    // Accept keys with or without the 0x prefix.
    if (!/^0x/i.test(key)) key = `0x${key}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error(`${id}: private key must be 64 hex chars (0x prefix optional)`);
    if (seen.has(key.toLowerCase())) return; // de-dupe
    seen.add(key.toLowerCase());
    out.push({ id, label, privateKey: key });
  };

  for (let i = 1; i <= 50; i++) {
    add(`wallet${i}`, env[`WALLET_${i}_LABEL`] || `Wallet ${i}`, env[`WALLET_${i}_KEY`]);
  }
  // Legacy single-key support.
  add("primary", env.WALLET_PRIMARY_LABEL || "Primary", env.BSC_PRIVATE_KEY);
  return out;
}

export function loadRuntime(): RuntimeConfig {
  const env = process.env;
  const dryRun = (env.DRY_RUN ?? "true").toLowerCase() !== "false";

  const integratorAddress = env.INTEGRATOR_ADDRESS || undefined;
  const integratorBpsRaw = env.INTEGRATOR_FEE_BPS || "0";
  if (!/^\d+$/.test(integratorBpsRaw))
    throw new Error("INTEGRATOR_FEE_BPS must be a non-negative integer");
  const integratorFeeBps = BigInt(integratorBpsRaw);
  if (!integratorAddress && integratorFeeBps > 0n)
    throw new Error("INTEGRATOR_FEE_BPS > 0 requires INTEGRATOR_ADDRESS");

  const targetMarket = getAddress(env.TARGET_MARKET || DEFAULT_TARGET_MARKET);
  const password = env.DASHBOARD_PASSWORD ?? "";

  return {
    dryRun,
    rpc: env.BSC_RPC ?? "https://bsc-dataseed.bnbchain.org",
    targetMarket,
    restBase: env.REST_BASE ?? "https://rest.ft.42.space",
    intervalSec: env.BOT_INTERVAL ? parseInt(env.BOT_INTERVAL, 10) : 300,
    // Market-volume update: every 30 min (falls back to legacy HEARTBEAT_INTERVAL).
    marketReviewSec: parseInt(env.MARKET_INTERVAL ?? env.HEARTBEAT_INTERVAL ?? "1800", 10),
    // Per-wallet portfolio review: hourly.
    portfolioReviewSec: parseInt(env.PORTFOLIO_INTERVAL ?? "3600", 10),
    statePath: resolve(env.BOT_STATE_PATH ?? "bot-state.json"),
    configPath: resolve(env.BOT_CONFIG_PATH ?? "strategy.config.json"),
    integratorAddress,
    integratorFeeBps,
    slackWebhook: env.SLACK_WEBHOOK || undefined,
    host: env.DASHBOARD_HOST ?? "0.0.0.0",
    port: parseInt(env.PORT ?? env.DASHBOARD_PORT ?? "4242", 10),
    dashboardPassword: password,
    sessionSecret: env.DASHBOARD_SESSION_SECRET || password || "change-me",
    sessionSeconds: env.DASHBOARD_SESSION_SECONDS
      ? parseInt(env.DASHBOARD_SESSION_SECONDS, 10)
      : 43200,
    wallets: loadWalletKeys(),
  };
}
