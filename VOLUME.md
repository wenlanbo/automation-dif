# Volume-Generation Strategy

A TypeScript port of the quant's `WorldCupTradingStrategy` (the Python design in
`WC_Winner_bot/strategy.py`), wired into the bot as a third trading engine
alongside the rules engine and the distribute-out campaign.

Its goal is **volume generation**, not directional profit: each wallet
continuously buys and sells the market's outcomes to a target volume multiple
while holding a target cash ratio, with randomized timing and sizes so the flow
looks organic. Capital is recycled, not bet.

## How it works

Per managed wallet, on every server tick:

1. **Schedule** — randomized next-buy / next-sell times (5 min – 2 h). When one
   is due, that event fires and reschedules.
2. **Portfolio** — built from real on-chain balances + holdings when live, or
   from a persisted **paper ledger** in dry-run. Prices always come live from the
   market snapshot.
3. **Decide** — `bot/volume-strategy.ts` (a faithful port of `execute_buy` /
   `execute_sell`) returns trade *intents* using two PI controllers:
   - a **volume controller** tracking the target generation rate, and
   - a **cash controller** holding the wallet at `targetCashRatio` (10% cash / 90% deployed).

   Plus log-normal sized orders, large-buy→cascade/large-sell reactions, asset-swap
   funding, and probability-weighted outcome selection.
4. **Execute** — intents become on-chain orders via the shared `chain.ts` layer
   (real quotes through `simulateMint`/`simulateRedeem`, so dry-run fills already
   reflect real price impact). Realized amounts feed back into the controllers.

State persists across restarts (`state.volume[walletId]`) and every fill is logged
to Slack.

## Files

| File | Role |
|---|---|
| `bot/volume-strategy.ts` | Pure decision logic (PI controllers, sizing, cascades, liquidation). No I/O. |
| `bot/volume-engine.ts` | Scheduling, paper/live portfolio, intent execution, Slack logging, persistence. |
| `bot/volume-config.ts` | Loads + validates `volume.config.json`. |
| `volume.config.json` | Your strategy parameters (disabled by default). |
| `scripts/volume-sim.ts` | Offline backtester — runs the live decision logic on a constant-price model. |

## Safety

- **Disabled by default** (`enabled: false`) — nothing runs until you turn it on.
- Starts in whatever `DRY_RUN` mode the bot is in. Dry-run = paper ledger, **no tx**.
- A wallet running a volume window is automatically **skipped by the rules engine**,
  so it can never be double-traded.
- Live buys are gated on a BNB gas reserve and the wallet's USDT balance.

## Configure (`volume.config.json`)

```jsonc
{
  "enabled": false,
  "durationHours": 24,
  "targetVolumeMultiple": 4.0,   // target volume = startingCapital * this
  "continuousTrading": true,     // true: trade all window. false: phase-split liquidation
  "forceLiquidationAtEnd": false,// sweep all inventory to 0 at window end
  "targetCashRatio": 0.10,       // 10% cash, 90% deployed
  "sizeVolatility": 0.8,         // log-normal sigma for order sizes
  "minOrderUsdt": 1.0,
  "slippagePct": 3,
  "buyIntervalSec":  [300, 7200],
  "sellIntervalSec": [300, 7200],
  "repeatWindow": false,         // when a window ends, start a fresh one
  "paperBalanceUsdt": 1000,      // dry-run starting cash per wallet
  "minBnbReserve": 0.005,
  "outcomes": [ { "name": "France", "weight": 0.20 }, ... ],  // matched to market by name
  "wallets": []                  // wallet ids to manage; [] = all loaded wallets
}
```

> Outcome **names** are matched (case-insensitive) against the live market; prices
> are read on-chain, not configured. Live starting capital = the wallet's USDT
> balance at window start (dry-run uses `paperBalanceUsdt`).

## Backtest before deploying

```bash
bun run vol:sim [wallets] [balance] [multiple]   # e.g. bun run vol:sim 10 5000 4
```

The port reproduces the Python baseline (≈4.1× volume, ~10–14% end cash, ~62
trades/wallet over 24 h in continuous mode; 100% liquidation in phase-split mode).

> ⚠️ The backtester uses a **constant-price, fee-free** model — like `strategy.py`.
> On the real AMM, generating N× volume costs spread + fees on every trade, so live
> P&L will be **negative by roughly the cost of the volume**. Size the capital and
> volume multiple with that bleed in mind. Dry-run on Railway first — its paper
> fills use real on-chain quotes, so the realized USDT in/out already shows the drag.

## Running 24/7

The bot is a single long-running process (`bun bot/server.ts`) that ticks every
`BOT_INTERVAL` seconds (default 300s), forever. On Railway it stays up via:

- **persistent loop** — `setInterval` drives a cycle every tick; each cycle is
  wrapped in try/catch and `process` has `unhandledRejection`/`uncaughtException`
  guards, so no single error stops the loop.
- **auto-restart** — `railway.json` uses `ON_FAILURE` with 100 retries; the
  `/healthz` healthcheck lets Railway detect a hung process.
- **durable state** — progress is written atomically to `/data/bot-state.json` on
  a mounted volume, so windows/positions survive redeploys and restarts.

For the **strategy** to run continuously (not just one 24h window), set
**`repeatWindow: true`** (the default in `volume.config.json`). When a window
completes, the next one starts automatically, seeded from the wallet's **current
portfolio value** (cash + held OT) — so continuous mode recycles its full deployed
capital window after window, indefinitely. Verified across back-to-back windows:
capital recycles and volume keeps generating ~target× every window.

> One engine owns a wallet at a time: a wallet with an **active campaign leg**
> (`campaign.json`) is skipped by the volume strategy, and any volume/campaign
> wallet is skipped by the rules engine. If you want the volume strategy to manage
> wallet1/wallet2, disable the campaign first (`campaign.json` → `"enabled": false`)
> or list different wallet ids in `volume.config.json`.

## Go live

1. Set `volume.config.json` (`wallets`, `targetVolumeMultiple`, outcomes) and commit.
2. Deploy with `DRY_RUN=true`, `enabled: true` → watch paper fills + heartbeat in Slack.
3. Fund wallets with BNB (gas) + B-USDT (collateral).
4. Flip `DRY_RUN=false`. Start with a low `targetVolumeMultiple` and one wallet.
```
