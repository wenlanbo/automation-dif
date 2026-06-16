// REST client for the target market: question metadata + per-outcome stats.
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export interface MarketMeta {
  question: string;
  status: string;
  endDate: string | null;
  volume: number;
  traders: number;
}

export async function fetchMarketMeta(base: string, market: string): Promise<MarketMeta> {
  const body = await getJson<{ data?: Record<string, unknown> }>(
    `${base}/api/v1/markets/${market}`,
  );
  const m = (body.data ?? body) as Record<string, unknown>;
  return {
    question: String(m.question ?? "Unknown market"),
    status: String(m.status ?? "unknown"),
    endDate: (m.endDate as string) ?? null,
    volume: Number(m.volume ?? 0),
    traders: Number(m.traders ?? 0),
  };
}

export interface OutcomeStat {
  tokenId: number;
  name: string;
  price: number;
  volume: number;
  traders: number;
  metrics: Record<string, number>;
}

/** Per-outcome stats for ONE market, keyed by tokenId. */
export async function fetchOutcomeStats(
  base: string,
  market: string,
): Promise<Map<number, OutcomeStat>> {
  // The stats endpoint is global; pull a wide page and filter to our market.
  const url = `${base}/api/v1/market-data/tokens/stats?status=live&order_by=volume&limit=500`;
  const body = await getJson<{ data?: any[] }>(url);
  const rows = (body.data ?? []).filter(
    (r) => String(r.marketAddress).toLowerCase() === market.toLowerCase(),
  );
  const out = new Map<number, OutcomeStat>();
  for (const r of rows) {
    const total = Number(r.totalVolume ?? 0);
    const metrics: Record<string, number> = {
      price: Number(r.price ?? 0),
      payout: Number(r.payout ?? 0),
      traders: Number(r.traders ?? 0),
      totalVolume: total,
      buyVolume: Number(r.buyVolume ?? 0),
      sellVolume: Number(r.sellVolume ?? 0),
      collateral: Number(r.collateral ?? 0),
      buyRatio: total > 0 ? (Number(r.buyVolume ?? 0) - Number(r.sellVolume ?? 0)) / total : 0,
      ...(r.statsChanges ?? {}),
    };
    out.set(parseInt(r.tokenId, 10), {
      tokenId: parseInt(r.tokenId, 10),
      name: r.outcome?.name || `Token ${r.tokenId}`,
      price: Number(r.price ?? 0),
      volume: total,
      traders: Number(r.traders ?? 0),
      metrics,
    });
  }
  return out;
}
