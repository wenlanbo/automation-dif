# 42.space Trading Bot — Single Market + Multi-Wallet Dashboard

An automated bot that trades **one** 42.space market
(`0x38D8CA35d8662b2c6C94199497d787c93Aa34fEE` — *2026 World Cup Winner*) across
**multiple wallets**, with a web **dashboard** (market metrics + expandable
per-wallet portfolios + a per-wallet **safe switch**) and **Slack** alerting
(errors / warnings / heartbeat).

> **Dry-run by default.** No transaction is sent until `DRY_RUN=false`. And even
> then, a wallet is traded **only when you arm it** in the dashboard — every wallet
> starts SAFE.

## Architecture

```
                 ┌───────────────── bot/server.ts ─────────────────┐
   REST + Lens ──▶ buildMarketSnapshot ─▶ engine.runCycle ─▶ state │
   (per cycle)      (market.ts)            per ARMED wallet:        │
                                            exits → entries        │
                    ▲                       (chain.ts signer)      │
   Dashboard ───────┘  /api/market  /api/wallets  /api/.../arm     │
   (ui.ts)             password session auth                       │
                       Slack heartbeat / error / warning (notify)  │
                 └──────────────────────────────────────────────────┘
```

| File | Role |
|---|---|
| `bot/server.ts` | **Main entry.** Bun.serve dashboard + API + background loop |
| `bot/bot.ts` | CLI: `run`, `status`, `scan`, `arm` (testing / cron) |
| `bot/engine.ts` | Per-wallet exit/entry cycle on the target market |
| `bot/market.ts` | Full market snapshot (Lens price/supply/cap + REST momentum) |
| `bot/portfolio.ts` | Per-wallet holdings, value, uPnL, balances, claimable |
| `bot/wallets.ts` | Loads env keys → in-memory signers (keys never hit disk) |
| `bot/chain.ts` | viem read layer + per-wallet execute (buy/sell) |
| `bot/rules.ts` | Generic metric/operator entry-rule evaluator |
| `bot/state.ts` | Per-wallet armed flag + positions + PnL (atomic JSON) |
| `bot/notify.ts` | Slack info/warn/error/heartbeat |
| `bot/ui.ts` | Self-contained dashboard HTML (no build step) |
| `strategy.config.json` | **Your strategy** — entry/exit/sizing/execution |

## The safe switch (per wallet)

- Every wallet starts **SAFE (disarmed)** → the bot never touches it.
- Flip it **ARMED** in the dashboard (or `bun run bot:arm wallet1 on`) to let the bot
  trade that wallet.
- **Armed + `DRY_RUN=true`** → paper fills (simulated, no tx) — perfect for testing.
- **Armed + `DRY_RUN=false`** → real on-chain trades.
- Disarmed wallets are fully ignored (no entries *and* no exits) — arm a wallet to let
  the bot manage its stop-loss/take-profit.

## Run locally

```bash
bun install
cp .env.example .env        # fill in WALLET_1_KEY, DASHBOARD_PASSWORD, SLACK_WEBHOOK
bun run bot:scan            # see the market's outcomes + which pass your rules (no trades)
bun run bot:server          # dashboard at http://localhost:4242  (DRY_RUN defaults true)
```

Open the dashboard, sign in, expand a wallet, and flip its switch to ARMED to watch
the bot paper-trade. CLI helpers:

```bash
bun run bot:status         # market summary + each wallet's armed state & balances
bun run bot:run            # one cycle then exit (cron-friendly)
bun run bot:arm wallet1 on # arm/disarm from the terminal
```

## Wallets (env vars)

Keys are read from the environment and held only in memory — never written to disk,
logs, or git. Add as many as you like:

```bash
WALLET_1_KEY=0x<64 hex>     # required to load a wallet
WALLET_1_LABEL=Main         # shown in the dashboard
WALLET_2_KEY=0x...
WALLET_2_LABEL=Alt
```

## Strategy (`strategy.config.json`)

Entry rules are evaluated against each **outcome** of the target market. Calibrate
against the live numbers from `bun run bot:scan`.

Metrics: `price`, `payout`, `traders`, `totalVolume`, `buyVolume`, `sellVolume`,
`collateral`, `buyRatio` (−1..1), and `priceChange/volumeChange/collateralChange`
for `30m/1h/4h/24h` (**percent**, e.g. `4.4` = +4.4%).
Operators: `>` `>=` `<` `<=` `==` `abs>` `abs<`. `combine`: `"all"` or `"any"`.

```jsonc
"entry":  { "rules": [
              {"metric":"priceChange1h","op":">","value":3},
              {"metric":"volumeChange24h","op":">","value":20},
              {"metric":"buyRatio","op":">","value":0.1}
            ], "combine":"all", "minPriceUsdt":0.01, "maxPriceUsdt":0.95 },
"exit":   { "takeProfitPct":25, "stopLossPct":15, "maxHoldHours":72, "exitBeforeEndHours":6 },
"sizing": { "usdtPerTrade":5, "maxConcurrentPositions":3,
            "maxTotalExposureUsdt":25, "reentryCooldownHours":12 },   // per wallet
"execution": { "slippagePct":2, "minBnbReserve":0.005 }
```

> 42 markets are multi-outcome, so individual outcome prices are often `0.01–0.05`.
> Keep `minPriceUsdt` low and verify with `bot:scan`.

## Slack alerts

Set `SLACK_WEBHOOK` (an incoming-webhook URL). You get:
- 🚨 **errors** — failed cycles or trades (with the reason)
- ⚠️ **warnings** — low gas, finalised market, skipped buys
- 📊 **market-volume update** — every `MARKET_INTERVAL` sec (default 1800 = 30 min):
  total market volume + the change since the last update, market cap, top outcomes,
  and per-engine progress. (Replaces the old market-summary heartbeat.)
- 💼 **portfolio review** — every `PORTFOLIO_INTERVAL` sec (default 3600 = 1 h): one
  message per *trading* wallet with its real on-chain holdings (or paper ledger in
  dry-run) valued at live price, cash, gas, volume done, and P&L.
- 🟢🔴 **trade fills** — every buy/sell from the campaign + volume engines
- ℹ️ **info** — bot online, wallet armed/disarmed, window started/complete

## Deploy on Railway

The server is one long-running process (dashboard + loop).

1. Push to GitHub → Railway **Deploy from repo** (it uses `Dockerfile` / `railway.json`).
2. **Add a Volume mounted at `/data`** so `bot-state.json` (positions, armed flags)
   survives redeploys — the Dockerfile sets `BOT_STATE_PATH=/data/bot-state.json`.
3. Set **Variables** (use sealed secrets for keys):
   - `WALLET_1_KEY`, `WALLET_1_LABEL`, `WALLET_2_KEY`, …
   - `DASHBOARD_PASSWORD` (required before exposing publicly)
   - `SLACK_WEBHOOK`
   - `DRY_RUN=true` to start — flip to `false` when ready
   - optional: `BSC_RPC` (private RPC recommended), `BOT_INTERVAL`, `MARKET_INTERVAL`,
     `PORTFOLIO_INTERVAL`, `TARGET_MARKET`, `INTEGRATOR_ADDRESS` / `INTEGRATOR_FEE_BPS`
4. Railway injects `PORT`; the server binds it automatically. The public URL serves
   the dashboard; `/healthz` is the health check.

## Going live (checklist)

1. Run dry-run on Railway, arm a wallet, watch paper trades + heartbeats in Slack.
2. Fund each wallet with BNB (gas) + B-USDT (collateral).
3. Set `DASHBOARD_PASSWORD`, then `DRY_RUN=false`.
4. Arm wallets one at a time from the dashboard, starting with small
   `usdtPerTrade` / `maxTotalExposureUsdt`.

## Security

- Never commit `.env` or `bot-state.json` (both gitignored).
- Use dedicated wallets funded only with capital you intend to trade.
- Always set `DASHBOARD_PASSWORD` before exposing the dashboard — it controls the
  trading kill-switches.
