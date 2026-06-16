# Handoff — Volume Bot v2 (new, independent project)

This is a **separate** 42.space volume bot, forked from the original `automation`
repo's infrastructure. It runs its **own strategy, its own wallets, and its own
Railway project** — fully independent from the original bot.

## Status
- **Fresh scaffold.** Code is a clean copy of the proven infra (chain layer,
  multi-wallet server, dashboard, Slack, Railway deploy).
- **Trading is DISABLED** (`volume.config.json` → `"enabled": false`) until the
  new strategy is implemented and you arm it.
- **No deployment yet** — no Railway project, no wallets, no secrets committed.

## To set up (new machine / new Railway project)
```bash
# tools
curl -fsSL https://bun.sh/install | bash
npm i -g @railway/cli

# this repo
git clone <your-new-github-url>
cd <repo> && bun install

# new Railway project (separate from the original bot)
railway login
railway init                 # create a NEW project for v2
# add a Volume mounted at /data (state persistence)
# set Variables: WALLET_1_KEY..., DASHBOARD_PASSWORD, SLACK_WEBHOOK, DRY_RUN=true
railway up
```

## What still needs deciding / building
- **The strategy** — this is the whole point of v2: a *different* volume strategy
  from the original. Until implemented, the copied volume engine is a placeholder.
- **Wallets** — new, separate keys (set as `WALLET_N_KEY` in the new Railway project).
- **Market / outcomes** — confirm `TARGET_MARKET` + the `outcomes` list in config.

See `VOLUME.md` and `BOT.md` for the inherited architecture.
