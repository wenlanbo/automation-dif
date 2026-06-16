#!/usr/bin/env bun
// Dashboard server + background trading loop.
//   bun bot/server.ts
// Serves the dashboard (market metrics, per-wallet portfolios, arm/disarm),
// and runs the strategy on a loop. Trades only armed wallets; dry-run safe.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, type Address } from "viem";
import { loadRuntime, loadStrategy } from "./config.ts";
import { initRead } from "./chain.ts";
import { initNotify, error as notifyError, info as notifyInfo, message as notifyMessage } from "./notify.ts";
import { buildPortfolioSummary } from "./reviews.ts";
import { withdrawAll } from "./withdraw.ts";
import { buildWallets } from "./wallets.ts";
import { buildPortfolio } from "./portfolio.ts";
import { oneCycle, type CycleResult } from "./orchestrator.ts";
import { loadState, saveState, walletSlot } from "./state.ts";
import { dashboardHtml } from "./ui.ts";
import type { BotState } from "./types.ts";

const rc = loadRuntime();
const cfg = loadStrategy(rc.configPath);
initRead({ rpc: rc.rpc, integratorAddress: rc.integratorAddress, integratorFeeBps: rc.integratorFeeBps });
initNotify({ slackWebhook: rc.slackWebhook, dryRun: rc.dryRun });

const wallets = buildWallets(rc.wallets);
const state: BotState = loadState(rc.statePath);
// One-shot reset: clear volume progress + flags so fresh windows start now.
// Set VOLUME_RESET=1, deploy once, then unset it (otherwise every reboot resets).
if (process.env.VOLUME_RESET) {
  delete state.volume;
  delete state.volumeDoneAlerted;
  delete state.paused;
  delete state.gasWatch;
  console.warn("⚠️  VOLUME_RESET set — cleared volume progress, paused flag, and gas watch.");
}
// Ensure a slot exists for each loaded wallet.
for (const w of wallets) walletSlot(state, w.id);
saveState(rc.statePath, state);

let latest: CycleResult | null = null;
let running = false;
let withdrawing = false;

if (!rc.dashboardPassword)
  console.warn("⚠️  DASHBOARD_PASSWORD not set — dashboard is UNAUTHENTICATED. Set it before exposing publicly.");

// ---- session auth (HMAC cookie) ----
const COOKIE = "bot_session";
function sign(exp: number): string {
  const mac = createHmac("sha256", rc.sessionSecret).update(String(exp)).digest("hex");
  return `${exp}.${mac}`;
}
function makeSessionCookie(): string {
  const exp = Date.now() + rc.sessionSeconds * 1000;
  const val = sign(exp);
  return `${COOKIE}=${val}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${rc.sessionSeconds}`;
}
function validCookie(req: Request): boolean {
  if (!rc.dashboardPassword) return true; // no password configured => open (dev)
  const raw = req.headers.get("cookie") ?? "";
  const m = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [expStr, mac] = m[1].split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || Date.now() > exp) return false;
  const expected = sign(exp).split(".")[1];
  try {
    return timingSafeEqual(Buffer.from(mac ?? ""), Buffer.from(expected));
  } catch {
    return false;
  }
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// ---- background loop ----
async function tick(): Promise<void> {
  if (running || withdrawing) return; // never trade while a withdraw is draining wallets
  running = true;
  try {
    latest = await oneCycle(rc, cfg, wallets, state);
    const s = latest.summary;
    console.log(
      `[cycle] ${new Date().toISOString()} status=${s.status} armed=${s.armedWallets} ` +
        `entries=${s.entries.length} exits=${s.exits.length} errors=${s.errors.length} ` +
        `open=${s.openPositions} exposure=${s.exposureUsdt.toFixed(2)}`,
    );
  } catch (e) {
    await notifyError(`cycle failed: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

// ---- HTTP ----
const server = Bun.serve({
  hostname: rc.host,
  port: rc.port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html")
      return new Response(dashboardHtml({ dryRun: rc.dryRun, market: rc.targetMarket }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    if (pathname === "/healthz") return json({ ok: true, lastRun: state.lastRun });

    if (pathname === "/api/login" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { password?: string };
      if (!rc.dashboardPassword || body.password === rc.dashboardPassword)
        return json({ ok: true }, 200, { "set-cookie": makeSessionCookie() });
      return json({ error: "invalid password" }, 401);
    }
    if (pathname === "/api/logout" && req.method === "POST")
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` });

    // everything below requires auth
    if (!validCookie(req)) return json({ error: "unauthorized" }, 401);

    if (pathname === "/api/market") {
      if (!latest) return json({ error: "warming up" }, 503);
      return json(latest.snapshot);
    }

    if (pathname === "/api/wallets") {
      const snap = latest?.snapshot;
      if (!snap) return json({ error: "warming up" }, 503);
      const portfolios = await Promise.all(
        wallets.map((w) =>
          buildPortfolio(rc.targetMarket, w, state, snap).catch((e) => ({
            id: w.id,
            label: w.label,
            address: w.address,
            armed: walletSlot(state, w.id).armed,
            canSign: true,
            bnb: 0,
            usdt: 0,
            positions: [],
            positionValueUsdt: 0,
            realizedPnlUsdt: walletSlot(state, w.id).realizedPnlUsdt,
            claimableUsdt: 0,
            error: (e as Error).message,
          })),
        ),
      );
      return json({ wallets: portfolios });
    }

    // Retrieve all funds: pause the strategy, then (in the background) sell all
    // positions and send USDT then BNB to `to`. One drain at a time.
    if (pathname === "/api/withdraw" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { to?: string; confirm?: boolean };
      if (!body.confirm) return json({ error: "confirm:true required" }, 400);
      let to: Address;
      try {
        to = getAddress(body.to ?? "") as Address;
      } catch {
        return json({ error: "invalid 'to' address" }, 400);
      }
      if (withdrawing) return json({ error: "drain already in progress" }, 409);
      withdrawing = true;
      state.paused = { reason: `withdraw to ${to}`, at: new Date().toISOString() };
      saveState(rc.statePath, state);
      void (async () => {
        try {
          for (let i = 0; i < 90 && running; i++) await new Promise((r) => setTimeout(r, 1000));
          await withdrawAll(rc, wallets, { to });
        } catch (e) {
          await notifyError(`withdraw failed: ${(e as Error).message}`);
        } finally {
          withdrawing = false;
        }
      })();
      return json({ ok: true, started: true, to });
    }

    // Liquidate-only: pause, then sell all positions to USDT (kept in wallets).
    if (pathname === "/api/liquidate" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
      if (!body.confirm) return json({ error: "confirm:true required" }, 400);
      if (withdrawing) return json({ error: "drain already in progress" }, 409);
      withdrawing = true;
      state.paused = { reason: "liquidate to USDT", at: new Date().toISOString() };
      saveState(rc.statePath, state);
      void (async () => {
        try {
          for (let i = 0; i < 90 && running; i++) await new Promise((r) => setTimeout(r, 1000));
          await withdrawAll(rc, wallets, {});
        } catch (e) {
          await notifyError(`liquidate failed: ${(e as Error).message}`);
        } finally {
          withdrawing = false;
        }
      })();
      return json({ ok: true, started: true });
    }

    // Send the live portfolio summary to Slack (dashboard "Send summary" button).
    if (pathname === "/api/report" && req.method === "POST") {
      const snap = latest?.snapshot;
      if (!snap) return json({ error: "warming up" }, 503);
      const summary = await buildPortfolioSummary(rc, state, snap, wallets);
      await notifyMessage(summary);
      return json({ ok: true });
    }

    // Automation status (drives the dashboard's paused banner / Resume button).
    if (pathname === "/api/automation") {
      return json({ paused: state.paused ?? null, dryRun: rc.dryRun, withdrawing });
    }

    // Resume the volume strategy after an error-pause. Shifts each still-trading
    // wallet's window clock forward by the pause duration so it keeps its full
    // remaining trading window (and trades don't all fire at once on resume).
    if (pathname === "/api/resume" && req.method === "POST") {
      if (!state.paused) return json({ ok: true, resumed: false });
      const shiftMs = Math.max(0, Date.now() - new Date(state.paused.at).getTime());
      const bump = (iso: string) => new Date(new Date(iso).getTime() + shiftMs).toISOString();
      for (const p of Object.values(state.volume ?? {})) {
        if (p.phase !== "trading") continue;
        p.startedAt = bump(p.startedAt);
        p.nextBuyAt = bump(p.nextBuyAt);
        p.nextSellAt = bump(p.nextSellAt);
      }
      const reason = state.paused.reason;
      delete state.paused;
      saveState(rc.statePath, state);
      await notifyInfo(`▶️ Volume automation RESUMED (was paused: ${reason}). Window clocks shifted +${Math.round(shiftMs / 60000)}m.`);
      return json({ ok: true, resumed: true });
    }

    const armMatch = pathname.match(/^\/api\/wallets\/([^/]+)\/arm$/);
    if (armMatch && req.method === "POST") {
      const id = armMatch[1];
      if (!wallets.some((w) => w.id === id)) return json({ error: "unknown wallet" }, 404);
      const body = (await req.json().catch(() => ({}))) as { armed?: boolean };
      const ws = walletSlot(state, id);
      ws.armed = !!body.armed;
      saveState(rc.statePath, state);
      const label = wallets.find((w) => w.id === id)?.label ?? id;
      await notifyInfo(`${label} ${ws.armed ? "ARMED 🟢 (will trade)" : "disarmed ⚪ (safe)"}`);
      return json({ ok: true, armed: ws.armed });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(
  `\n42 bot dashboard → http://${rc.host}:${server.port}\n` +
    `  market=${rc.targetMarket}\n  wallets=${wallets.length}  dryRun=${rc.dryRun}  interval=${rc.intervalSec}s\n`,
);
await notifyInfo(`Bot online. Market ${rc.targetMarket.slice(0, 10)}…, ${wallets.length} wallet(s) loaded (all SAFE until armed).`);

// 24/7 resilience: never let a stray async error kill the long-running process.
// Each cycle already has its own try/catch (tick); these catch anything escaping
// fire-and-forget promises (e.g. a failed Slack post) so the loop keeps going.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  void notifyError(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`).catch(() => {});
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  void notifyError(`uncaughtException: ${err.message}`).catch(() => {});
});

// kick off the loop
await tick();
setInterval(tick, rc.intervalSec * 1000);
