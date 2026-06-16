// Slack notifications: info / warning / error / raw message. No-op if no webhook.
let webhook: string | undefined;
let dryRun = false;

export function initNotify(opts: { slackWebhook?: string; dryRun: boolean }): void {
  webhook = opts.slackWebhook;
  dryRun = opts.dryRun;
}

async function send(text: string): Promise<void> {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("  slack send failed:", (e as Error).message);
  }
}

const tag = () => (dryRun ? "DRY-RUN" : "LIVE");

/** Send a pre-formatted message verbatim (used for trade logs). */
export function message(text: string): Promise<void> {
  return send(text);
}
/** Send with an @here mention so the channel gets notified (alerts). */
export function alertHere(text: string): Promise<void> {
  return send(`<!here> ${text}`);
}
export function tagStr(): string {
  return tag();
}

export function info(text: string): Promise<void> {
  return send(`ℹ️ [${tag()}] ${text}`);
}
export function warn(text: string): Promise<void> {
  console.warn("  WARN:", text);
  return send(`⚠️ [${tag()}] ${text}`);
}
export function error(text: string): Promise<void> {
  console.error("  ERROR:", text);
  return send(`🚨 [${tag()}] ${text}`);
}
