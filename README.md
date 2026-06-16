# 42.space Trading Skill

A complete, agent-agnostic guide for AI agents to trade prediction markets on [42.space](https://42.space) (BNB Smart Chain).

## What's Included

- **SKILL.md** — Full trading guide: market mechanics, REST API, on-chain trading, optional 0x and Privy integrations
- **references/** — Complete smart contract ABIs (Router, Factory, Curve)
- **scripts/trade.ts** — Ready-to-use CLI trading tool (TypeScript/Bun)

## Prerequisites

- **[Bun](https://bun.sh)** — primary runtime. `curl -fsSL https://bun.sh/install | bash`
- A BSC wallet with some **BNB** for gas (~0.01 BNB ≈ $0.03 per trade) and **B-USDT (BEP-20, 18 decimals)** for trade collateral.
- Optional: a private BSC RPC. The default (`https://bsc-dataseed.bnbchain.org`) works for light use but is rate-limited.

## Install

```bash
git clone git@github.com:wenlanbo/wenlanbot.git wenlanbot
cd wenlanbot
bun install
```

## Configure

Copy the example env and fill in your key:

```bash
cp .env.example .env
# edit .env — BSC_PRIVATE_KEY is required
```

> For running `scripts/trade.ts` / `scripts/monitor.js` under Node, pass the flag: `node --env-file=.env scripts/trade.ts status`.

### Env vars

| Variable | Required | Notes |
|---|---|---|---|
| `BSC_PRIVATE_KEY` | yes | `0x` + 64 hex. Wallet address is derived automatically. |
| `BSC_RPC` | no | Defaults to `https://bsc-dataseed.bnbchain.org`. |
| `INTEGRATOR_ADDRESS` | no | Integrator wallet to receive trade fees. Optional. |
| `INTEGRATOR_FEE_BPS` | no | Integrator fee in basis points (100 bps = 1%). Defaults to `0`. Any value > 0 requires `INTEGRATOR_ADDRESS` to be set. |
| `BSC_WALLET_ADDRESS` | only for `monitor.js` | `trade.ts` derives this from `BSC_PRIVATE_KEY`. |
| `SLACK_WEBHOOK`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MONITOR_*` | optional | See `SKILL.md` §7 for the full list. |

## Usage

```bash
# Help
bun scripts/trade.ts help

# Check wallet status
bun scripts/trade.ts

# Get market info
bun scripts/trade.ts info 0xMARKET_ADDRESS

# Trade
bun scripts/trade.ts buy 0xMARKET_ADDRESS 1 10 [slippage%] # tokenId=1, 10 USDT
bun scripts/trade.ts sell 0xMARKET_ADDRESS 1 100 [slippage%] # tokenId=1, 100 OT
```

`bun run trade <cmd>` shortcuts the same thing via `package.json`.

## Faster cold start (optional)

Build and run a tree-shaken bundle to avoid traversing module graph.

```bash
bun run build
bun dist/trade.js help
```

For a zero-dependency distributable (no Bun required on the target machine):

```bash
bun build --compile --minify --target=bun --outfile bin/trade scripts/trade.ts
./bin/trade help
```

## For AI Agents

Read `SKILL.md` — it contains everything needed to:
1. Discover and analyze markets via REST API
2. Execute trades on-chain (buy, sell, claim)
3. Optionally use 0x for token swaps and Privy for managed wallets

## License

MIT
