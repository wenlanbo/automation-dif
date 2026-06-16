# 42.space trading bot + dashboard — Railway / container image.
FROM oven/bun:1.3-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Defaults — override in Railway Variables.
ENV DRY_RUN=true
ENV BOT_INTERVAL=300
# Slack reviews: market-volume update every 30 min, portfolio review hourly.
ENV MARKET_INTERVAL=1800
ENV PORTFOLIO_INTERVAL=3600
ENV DASHBOARD_HOST=0.0.0.0
# Railway injects PORT; the server reads PORT then DASHBOARD_PORT then 4242.
ENV DASHBOARD_PORT=4242
# Persist state to a mounted volume so positions survive redeploys.
ENV BOT_STATE_PATH=/data/bot-state.json

# Dashboard + trading loop in one process.
CMD ["bun", "bot/server.ts"]
