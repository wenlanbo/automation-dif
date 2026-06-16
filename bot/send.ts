#!/usr/bin/env bun
// One-off: send a fixed USDT amount from EACH loaded wallet to a destination.
//   bun bot/send.ts <toAddress> [usdtPerWallet=10]
// Safe to run while the bot is paused (no nonce race). Real txs unless DRY_RUN=true.
import { getAddress, parseUnits, formatUnits, type Address } from "viem";
import { loadRuntime } from "./config.ts";
import { initRead, usdtBalanceWei, transferUsdt } from "./chain.ts";
import { buildWallets } from "./wallets.ts";

const to = getAddress(process.argv[2] ?? "") as Address;
const amount = parseFloat(process.argv[3] ?? "10");
const rc = loadRuntime();
initRead({ rpc: rc.rpc, integratorAddress: rc.integratorAddress, integratorFeeBps: rc.integratorFeeBps });
const wallets = buildWallets(rc.wallets);
const amountWei = parseUnits(amount.toString(), 18);

console.log(`\nSend ${amount} USDT from ${wallets.length} wallet(s) → ${to}  (dryRun=${rc.dryRun})\n`);
let sent = 0;
for (const w of wallets) {
  const addr = getAddress(w.address) as Address;
  try {
    const bal = await usdtBalanceWei(addr);
    if (bal < amountWei) {
      console.log(`  SKIP  ${w.label.padEnd(10)} USDT ${formatUnits(bal, 18)} < ${amount}`);
      continue;
    }
    if (rc.dryRun) {
      console.log(`  [DRY] ${w.label.padEnd(10)} would send ${amount} USDT`);
      continue;
    }
    const hash = await transferUsdt(w.signer, to, amountWei);
    sent++;
    console.log(`  ✅ ${w.label.padEnd(10)} sent ${amount} USDT   ${hash}`);
  } catch (e) {
    console.log(`  ❌ ${w.label.padEnd(10)} ${(e as Error).message}`);
  }
}
console.log(`\nDone: ${sent}/${wallets.length} wallets sent ${amount} USDT → ${to} (total ${sent * amount} USDT).\n`);
