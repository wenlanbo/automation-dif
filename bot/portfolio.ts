// Builds the per-wallet portfolio view for the dashboard, combining tracked
// positions (entry price/cost) with live on-chain price + balances.
import { formatUnits, getAddress, type Address } from "viem";
import * as chain from "./chain.ts";
import type { BotState, MarketSnapshot, WalletPortfolio } from "./types.ts";
import { walletSlot } from "./state.ts";
import type { ManagedWallet } from "./wallets.ts";

export async function buildPortfolio(
  market: string,
  w: ManagedWallet,
  state: BotState,
  snapshot: MarketSnapshot,
): Promise<WalletPortfolio> {
  const addr = getAddress(w.address) as Address;
  const ws = walletSlot(state, w.id);

  const [bal, userState] = await Promise.all([
    chain.getBalances(addr),
    chain.getUserState(getAddress(market) as Address, addr).catch(() => null),
  ]);

  const priceByToken = new Map(snapshot.outcomes.map((o) => [o.tokenId, o.price]));

  const positions = ws.positions.map((p) => {
    const currentPrice = priceByToken.get(p.tokenId) ?? p.entryPrice;
    const otAmount = parseFloat(formatUnits(BigInt(p.otAmountWei), 18));
    const currentValue = otAmount * currentPrice;
    const unrealizedPnlUsdt = currentValue - p.usdtCost;
    const unrealizedPnlPct = p.usdtCost > 0 ? (unrealizedPnlUsdt / p.usdtCost) * 100 : 0;
    return { ...p, currentPrice, currentValue, unrealizedPnlUsdt, unrealizedPnlPct };
  });

  return {
    id: w.id,
    label: w.label,
    address: w.address,
    armed: ws.armed,
    canSign: true,
    bnb: bal.bnb,
    usdt: bal.usdt,
    positions,
    positionValueUsdt: positions.reduce((s, p) => s + p.currentValue, 0),
    realizedPnlUsdt: ws.realizedPnlUsdt,
    claimableUsdt: userState?.claimableUsdt ?? 0,
  };
}
