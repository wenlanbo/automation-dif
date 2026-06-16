import fs from "node:fs";
import path from "node:path";

// === CONFIG ===
const API_BASE = "https://rest.ft.42.space";
// import.meta.dirname is supported by Bun and Node ≥ 21.2 — replaces CJS __dirname.
const STATE_FILE = process.env.MONITOR_STATE || path.join(import.meta.dirname, "../monitor-state.json");
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const WALLET = process.env.BSC_WALLET_ADDRESS || "";

// Alert thresholds (configurable via env)
const PRICE_CHANGE_THRESHOLD = parseFloat(process.env.PRICE_CHANGE_PCT || "10");    // % change to alert
const VOLUME_SPIKE_THRESHOLD = parseFloat(process.env.VOLUME_SPIKE_PCT || "200");    // % volume spike
const PNL_LOSS_THRESHOLD = parseFloat(process.env.PNL_LOSS_PCT || "20");             // % unrealized loss
const PNL_PROFIT_THRESHOLD = parseFloat(process.env.PNL_PROFIT_PCT || "50");         // % unrealized profit
const NEW_MARKET_MIN_VOLUME = parseFloat(process.env.NEW_MARKET_MIN_VOL || "100");   // min volume for new market alert
const MARKET_ENDING_HOURS = parseFloat(process.env.MARKET_ENDING_HOURS || "24");     // hours before end to alert

// === STATE ===
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRun: null, knownMarkets: {}, priceSnapshots: {}, alerts: [] };
  }
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// === API ===
async function api(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
  return res.json();
}

// === ALERTING ===
async function sendAlert(alert) {
  const msg = formatAlert(alert);
  console.log(`[ALERT] ${msg}`);

  // Slack
  if (SLACK_WEBHOOK) {
    try {
      await fetch(SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: msg,
          blocks: [{
            type: "section",
            text: { type: "mrkdwn", text: msg }
          }]
        })
      });
    } catch (e) { console.error("Slack error:", e.message); }
  }

  // Telegram
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: msg,
          parse_mode: "Markdown"
        })
      });
    } catch (e) { console.error("Telegram error:", e.message); }
  }
}

function formatAlert(alert) {
  const icons = {
    price_move: "📈",
    volume_spike: "🔥",
    new_market: "🆕",
    market_ending: "⏰",
    position_profit: "💰",
    position_loss: "🔻",
    market_resolved: "✅",
    market_finalised: "🏁",
    large_trade: "🐋"
  };
  const icon = icons[alert.type] || "⚡";
  return `${icon} *${alert.title}*\n${alert.message}\n${alert.link || ""}`;
}

// === MONITORS ===

// 1. Price movement alerts
async function checkPriceMovements(state) {
  const alerts = [];
  const { data: tokens } = await api("/api/v1/market-data/tokens/stats?status=live&order_by=volume&limit=100");

  for (const token of tokens || []) {
    const key = `${token.marketAddress}-${token.outcomeIndex}`;
    const prev = state.priceSnapshots[key];
    const price = parseFloat(token.price || 0);

    if (prev && prev.price > 0 && price > 0) {
      const changePct = ((price - prev.price) / prev.price) * 100;
      if (Math.abs(changePct) >= PRICE_CHANGE_THRESHOLD) {
        alerts.push({
          type: changePct > 0 ? "price_move" : "price_move",
          title: `${token.outcomeName} ${changePct > 0 ? "surged" : "dropped"} ${Math.abs(changePct).toFixed(1)}%`,
          message: `Market: ${token.question || token.marketAddress}\nOutcome: ${token.outcomeName}\nPrice: $${prev.price.toFixed(4)} → $${price.toFixed(4)} (${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}%)`,
          link: `https://www.42.space/event/${token.marketAddress}`
        });
      }
    }

    // Check volume spikes (1h)
    const volChange1h = parseFloat(token.statsChanges?.volumeChange1h || 0);
    if (volChange1h >= VOLUME_SPIKE_THRESHOLD) {
      alerts.push({
        type: "volume_spike",
        title: `Volume spike on ${token.outcomeName}`,
        message: `Market: ${token.question || token.marketAddress}\n1h volume change: +${volChange1h.toFixed(0)}%\nCurrent volume: $${parseFloat(token.volume || 0).toFixed(2)}`,
        link: `https://www.42.space/event/${token.marketAddress}`
      });
    }

    state.priceSnapshots[key] = { price, timestamp: Date.now() };
  }

  return alerts;
}

// 2. New market detection
async function checkNewMarkets(state) {
  const alerts = [];
  const { data: markets } = await api("/api/v1/markets?status=live&order=volume&limit=50");

  for (const market of markets || []) {
    if (!state.knownMarkets[market.address]) {
      state.knownMarkets[market.address] = {
        firstSeen: Date.now(),
        question: market.question
      };

      if (parseFloat(market.volume || 0) >= NEW_MARKET_MIN_VOLUME) {
        const outcomes = (market.outcomes || []).map(o =>
          `  ${o.symbol}: $${parseFloat(o.price || 0).toFixed(4)}`
        ).join("\n");

        alerts.push({
          type: "new_market",
          title: `New market: ${market.question}`,
          message: `Volume: $${parseFloat(market.volume).toFixed(2)}\nTraders: ${market.traders}\nEnds: ${market.endDate}\nOutcomes:\n${outcomes}`,
          link: `https://www.42.space/event/${market.address}`
        });
      }
    }
  }

  return alerts;
}

// 3. Market ending soon
async function checkEndingSoon(state) {
  const alerts = [];
  const { data: markets } = await api("/api/v1/markets?status=live&order=volume&limit=100");
  const now = Date.now();
  const threshold = MARKET_ENDING_HOURS * 60 * 60 * 1000;

  for (const market of markets || []) {
    const endTime = new Date(market.endDate).getTime();
    const timeLeft = endTime - now;
    const alertKey = `ending-${market.address}`;

    if (timeLeft > 0 && timeLeft <= threshold && !state.knownMarkets[alertKey]) {
      state.knownMarkets[alertKey] = true;
      const hoursLeft = (timeLeft / (60 * 60 * 1000)).toFixed(1);

      alerts.push({
        type: "market_ending",
        title: `Market ending in ${hoursLeft}h`,
        message: `${market.question}\nVolume: $${parseFloat(market.volume || 0).toFixed(2)}\nTraders: ${market.traders}`,
        link: `https://www.42.space/event/${market.address}`
      });
    }
  }

  return alerts;
}

// 4. Position monitoring (PnL alerts)
async function checkPositions(state) {
  if (!WALLET) return [];
  const alerts = [];

  try {
    const { data: positions } = await api(`/api/v1/market-data/positions?user=${WALLET}`);

    for (const pos of positions || []) {
      const unrealizedPnl = parseFloat(pos.unrealizedPnl || 0);
      const costBasis = parseFloat(pos.costBasis || pos.totalCost || 1);
      if (costBasis === 0) continue;

      const pnlPct = (unrealizedPnl / Math.abs(costBasis)) * 100;
      const posKey = `pos-${pos.marketAddress}-${pos.outcomeIndex}`;

      // Profit alert
      if (pnlPct >= PNL_PROFIT_THRESHOLD && !state.knownMarkets[`profit-${posKey}`]) {
        state.knownMarkets[`profit-${posKey}`] = true;
        alerts.push({
          type: "position_profit",
          title: `Position up ${pnlPct.toFixed(1)}%!`,
          message: `Market: ${pos.question || pos.marketAddress}\nOutcome: ${pos.outcomeName}\nUnrealized PnL: $${unrealizedPnl.toFixed(2)} (${pnlPct.toFixed(1)}%)\nConsider taking profit.`,
          link: `https://www.42.space/event/${pos.marketAddress}`
        });
      }

      // Loss alert
      if (pnlPct <= -PNL_LOSS_THRESHOLD && !state.knownMarkets[`loss-${posKey}`]) {
        state.knownMarkets[`loss-${posKey}`] = true;
        alerts.push({
          type: "position_loss",
          title: `Position down ${Math.abs(pnlPct).toFixed(1)}%`,
          message: `Market: ${pos.question || pos.marketAddress}\nOutcome: ${pos.outcomeName}\nUnrealized PnL: $${unrealizedPnl.toFixed(2)} (${pnlPct.toFixed(1)}%)\nReview position.`,
          link: `https://www.42.space/event/${pos.marketAddress}`
        });
      }
    }
  } catch (e) {
    console.error("Position check error:", e.message);
  }

  return alerts;
}

// 5. Resolved/finalised market detection
async function checkResolved(state) {
  const alerts = [];

  for (const [addr, info] of Object.entries(state.knownMarkets)) {
    if (typeof info !== "object" || !info.question || info.resolved) continue;

    try {
      const { data: market } = await api(`/api/v1/markets/${addr}`);
      if (!market) continue;

      if (market.status === "resolved" && !info.resolvedAlerted) {
        state.knownMarkets[addr].resolvedAlerted = true;
        alerts.push({
          type: "market_resolved",
          title: `Market resolved: ${market.question}`,
          message: `Winner: ${market.resolvedAnswer || "TBD"}\nTotal volume: $${parseFloat(market.volume || 0).toFixed(2)}`,
          link: `https://www.42.space/event/${addr}`
        });
      }

      if (market.status === "finalised" && !info.finalisedAlerted) {
        state.knownMarkets[addr].finalisedAlerted = true;
        state.knownMarkets[addr].resolved = true;
        alerts.push({
          type: "market_finalised",
          title: `Market finalised: ${market.question}`,
          message: `Winner: ${market.resolvedAnswer || "TBD"}\nClaim your winnings if applicable!`,
          link: `https://www.42.space/event/${addr}`
        });
      }
    } catch { /* market may not exist anymore */ }
  }

  return alerts;
}

// 6. Large trade detection (whale watching)
async function checkLargeTrades(state) {
  const alerts = [];

  try {
    const { data: trades } = await api("/api/v1/market-data/leaderboard/top-trades?period=1h&limit=5");

    for (const trade of trades || []) {
      const volume = parseFloat(trade.volume || trade.amount || 0);
      const tradeKey = `trade-${trade.txHash || trade.id || Date.now()}`;

      if (volume >= 500 && !state.knownMarkets[tradeKey]) {
        state.knownMarkets[tradeKey] = true;
        alerts.push({
          type: "large_trade",
          title: `Whale trade: $${volume.toFixed(2)}`,
          message: `Market: ${trade.question || trade.marketAddress}\nOutcome: ${trade.outcomeName || "?"}\nTrader: ${trade.wallet?.slice(0, 10)}...`,
          link: `https://www.42.space/event/${trade.marketAddress}`
        });
      }
    }
  } catch (e) {
    console.error("Large trade check error:", e.message);
  }

  return alerts;
}

// === MAIN ===
async function main() {
  const action = process.argv[2] || "run";

  if (action === "run" || action === "scan") {
    const state = loadState();
    const allAlerts = [];

    console.log(`[${new Date().toISOString()}] Running monitor scan...`);

    const checks = [
      { name: "prices", fn: checkPriceMovements },
      { name: "new_markets", fn: checkNewMarkets },
      { name: "ending_soon", fn: checkEndingSoon },
      { name: "positions", fn: checkPositions },
      { name: "resolved", fn: checkResolved },
      { name: "large_trades", fn: checkLargeTrades }
    ];

    for (const check of checks) {
      try {
        const alerts = await check.fn(state);
        allAlerts.push(...alerts);
        console.log(`  ${check.name}: ${alerts.length} alert(s)`);
      } catch (e) {
        console.error(`  ${check.name}: ERROR - ${e.message}`);
      }
    }

    // Send alerts
    for (const alert of allAlerts) {
      await sendAlert(alert);
    }

    // Record alerts in state
    state.alerts = (state.alerts || []).concat(
      allAlerts.map(a => ({ ...a, timestamp: new Date().toISOString() }))
    ).slice(-200); // keep last 200

    saveState(state);
    console.log(`Done. ${allAlerts.length} total alert(s) sent.\n`);

  } else if (action === "watch") {
    // Continuous monitoring mode
    const interval = parseInt(process.env.MONITOR_INTERVAL || "300") * 1000; // default 5 min
    console.log(`Starting continuous monitor (interval: ${interval/1000}s)...`);
    console.log(`Thresholds: price=${PRICE_CHANGE_THRESHOLD}%, volume=${VOLUME_SPIKE_THRESHOLD}%, loss=${PNL_LOSS_THRESHOLD}%, profit=${PNL_PROFIT_THRESHOLD}%`);

    const runOnce = async () => {
      try {
        const state = loadState();
        const allAlerts = [];
        const checks = [
          checkPriceMovements, checkNewMarkets, checkEndingSoon,
          checkPositions, checkResolved, checkLargeTrades
        ];
        for (const fn of checks) {
          try { allAlerts.push(...await fn(state)); } catch {}
        }
        for (const alert of allAlerts) await sendAlert(alert);
        state.alerts = (state.alerts || []).concat(
          allAlerts.map(a => ({ ...a, timestamp: new Date().toISOString() }))
        ).slice(-200);
        saveState(state);
        if (allAlerts.length) console.log(`[${new Date().toISOString()}] ${allAlerts.length} alert(s)`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Scan error: ${e.message}`);
      }
    };

    await runOnce();
    setInterval(runOnce, interval);

  } else if (action === "status") {
    const state = loadState();
    console.log("Monitor Status");
    console.log("==============");
    console.log(`Last run: ${state.lastRun || "never"}`);
    console.log(`Known markets: ${Object.keys(state.knownMarkets).length}`);
    console.log(`Price snapshots: ${Object.keys(state.priceSnapshots || {}).length}`);
    console.log(`Recent alerts: ${(state.alerts || []).length}`);
    console.log("\nLast 10 alerts:");
    for (const a of (state.alerts || []).slice(-10)) {
      console.log(`  [${a.timestamp}] ${a.type}: ${a.title}`);
    }

  } else if (action === "reset") {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRun: null, knownMarkets: {}, priceSnapshots: {}, alerts: [] }, null, 2));
    console.log("State reset.");

  } else {
    console.log("42 Market Monitor");
    console.log("=================");
    console.log("Usage (Bun auto-loads .env; under Node pass --env-file=.env):");
    console.log("  bun scripts/monitor.js run      - Single scan (cron-friendly)");
    console.log("  bun scripts/monitor.js watch    - Continuous monitoring");
    console.log("  bun scripts/monitor.js status   - Show monitor state & recent alerts");
    console.log("  bun scripts/monitor.js reset    - Reset state");
    console.log("");
    console.log("Environment variables:");
    console.log("  BSC_WALLET_ADDRESS         - Wallet to monitor positions for");
    console.log("  SLACK_WEBHOOK              - Slack incoming webhook URL");
    console.log("  TELEGRAM_BOT_TOKEN         - Telegram bot token for alerts");
    console.log("  TELEGRAM_CHAT_ID           - Telegram chat ID for alerts");
    console.log("  MONITOR_INTERVAL           - Seconds between scans in watch mode (default: 300)");
    console.log("  PRICE_CHANGE_PCT           - Price change % to trigger alert (default: 10)");
    console.log("  VOLUME_SPIKE_PCT           - Volume spike % to trigger alert (default: 200)");
    console.log("  PNL_LOSS_PCT               - Unrealized loss % to alert (default: 20)");
    console.log("  PNL_PROFIT_PCT             - Unrealized profit % to alert (default: 50)");
    console.log("  NEW_MARKET_MIN_VOL         - Min volume for new market alert (default: 100)");
    console.log("  MARKET_ENDING_HOURS        - Hours before end to alert (default: 24)");
  }
}

main().catch(e => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
