// Per-wallet persisted state (armed flag, positions, PnL). Atomic JSON file.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { BotState, WalletState } from "./types.ts";

function emptyState(): BotState {
  return { wallets: {}, lastRun: null };
}

function emptyWallet(): WalletState {
  return { armed: false, positions: [], closed: [], cooldowns: {}, realizedPnlUsdt: 0 };
}

export function loadState(path: string): BotState {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BotState>;
    return { ...emptyState(), ...raw, wallets: raw.wallets ?? {} };
  } catch (e) {
    throw new Error(`corrupt state file ${path}: ${(e as Error).message}`);
  }
}

export function saveState(path: string, state: BotState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Get (creating if absent) a wallet's state slot. */
export function walletSlot(state: BotState, id: string): WalletState {
  if (!state.wallets[id]) state.wallets[id] = emptyWallet();
  return state.wallets[id];
}

export function totalExposure(ws: WalletState): number {
  return ws.positions.reduce((sum, p) => sum + p.usdtCost, 0);
}

export function inCooldown(
  ws: WalletState,
  tokenId: number,
  cooldownHours: number,
  now: number,
): boolean {
  if (cooldownHours <= 0) return false;
  const ts = ws.cooldowns[String(tokenId)];
  if (!ts) return false;
  return now - new Date(ts).getTime() < cooldownHours * 3600_000;
}
