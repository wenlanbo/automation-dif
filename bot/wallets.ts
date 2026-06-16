// Wallet manager: turns env-provided keys into in-memory signers.
// Private keys live only in process memory — never written to disk or logs.
import type { Address } from "viem";
import { makeSigner, type Signer } from "./chain.ts";
import type { WalletKey } from "./config.ts";
import type { WalletRuntime } from "./types.ts";

export interface ManagedWallet {
  id: string;
  label: string;
  address: Address;
  signer: Signer;
}

export function buildWallets(keys: WalletKey[]): ManagedWallet[] {
  const seenAddr = new Set<string>();
  const out: ManagedWallet[] = [];
  for (const k of keys) {
    const signer = makeSigner(k.privateKey);
    if (seenAddr.has(signer.address.toLowerCase())) continue;
    seenAddr.add(signer.address.toLowerCase());
    out.push({ id: k.id, label: k.label, address: signer.address, signer });
  }
  return out;
}

export function runtimeView(wallets: ManagedWallet[]): WalletRuntime[] {
  return wallets.map((w) => ({
    id: w.id,
    label: w.label,
    address: w.address,
    canSign: true,
  }));
}
