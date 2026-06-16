// On-chain layer. Read functions share one public client; writes take a
// per-wallet Signer so the bot can trade many wallets. Mirrors scripts/trade.ts.
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { lensV2Abi, marketAbi, routerV2Abi } from "../references/abis.ts";

const ROUTER: Address = getAddress("0x888888886619275d33c00D3BC62DF94D700DCD42");
const LENS: Address = getAddress("0x4AAd5A856941FB64df10362024e3Ece24023d4d1");
const USDT: Address = getAddress("0x55d398326f99059fF775485246999027B3197955");
const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_MAX_ITER = 50n;

let publicClient: PublicClient;
let rpcUrl = "";
let integratorAddress: Address = zeroAddress;
let integratorFeeBps = 0n;

export interface Signer {
  account: Account;
  walletClient: WalletClient;
  address: Address;
}

export function initRead(opts: {
  rpc: string;
  integratorAddress?: string;
  integratorFeeBps?: bigint;
}): void {
  rpcUrl = opts.rpc;
  publicClient = createPublicClient({ chain: bsc, transport: http(opts.rpc) });
  integratorAddress = getAddress(opts.integratorAddress || zeroAddress);
  integratorFeeBps = opts.integratorFeeBps ?? 0n;
}

/** Build a signer from a private key (kept only in memory). 0x prefix optional. */
export function makeSigner(privateKey: string): Signer {
  let key = privateKey.trim();
  if (!/^0x/i.test(key)) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("private key must be 64 hex chars (0x prefix optional)");
  const account = privateKeyToAccount(key as Hex);
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });
  return { account, walletClient, address: account.address };
}

function smartEps(amount: number): bigint {
  if (amount < 5) return 200000000000000000n;
  if (amount <= 3000) return 1000000000000000n;
  return BigInt(Math.floor((1 / amount) * 1e18));
}

function encodeDataGuess(guess: bigint, maxIter: bigint, eps: bigint): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [guess, maxIter, eps],
  );
}

// ---- READS ----

export interface MarketSnap {
  numOutcomes: number;
  totalMarketCap: number;
  isFinalised: boolean;
  questionId: Hex;
  ots: Array<{ tokenId: number; price: number; supply: number; payoutPerOt: number }>;
}

export async function snapshotMarket(market: Address): Promise<MarketSnap> {
  const snap = await publicClient.readContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "snapshotMarket",
    args: [market],
  });
  const numOutcomes = Number(snap.state.numOutcomes);
  const ots = snap.ots.slice(0, numOutcomes).map((ot) => ({
    tokenId: Number(ot.tokenId),
    price: parseFloat(formatUnits(ot.price, 18)),
    supply: parseFloat(formatUnits(ot.supply, 18)),
    payoutPerOt: parseFloat(formatUnits(ot.payoutPerOt, 18)),
  }));
  return {
    numOutcomes,
    totalMarketCap: parseFloat(formatUnits(snap.state.totalMarketCap, 18)),
    isFinalised: snap.state.isFinalised,
    questionId: snap.deploy.questionId,
    ots,
  };
}

export interface UserState {
  isFinalised: boolean;
  claimableUsdt: number;
  holdings: Array<{ tokenId: number; otHolding: bigint; price: number }>;
}

export async function getUserState(market: Address, addr: Address): Promise<UserState> {
  const s = await publicClient.readContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "getUserState",
    args: [market, addr],
  });
  return {
    isFinalised: s.state.isFinalised,
    claimableUsdt: parseFloat(formatUnits(s.collateralClaimable, 18)),
    holdings: s.ots.map((ot) => ({
      tokenId: Number(ot.tokenId),
      otHolding: ot.otHolding,
      price: parseFloat(formatUnits(ot.price, 18)),
    })),
  };
}

export async function getBalances(addr: Address): Promise<{ bnb: number; usdt: number }> {
  const [bnb, usdt] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    }),
  ]);
  return {
    bnb: parseFloat(formatUnits(bnb, 18)),
    usdt: parseFloat(formatUnits(usdt as bigint, 18)),
  };
}

export interface BuySim {
  otToUserWei: bigint;
  costUsdt: number;
  feeUsdt: number;
  priceBefore: number;
  priceAfter: number;
}

export async function simulateBuy(market: Address, tokenId: number, usdt: number): Promise<BuySim> {
  const amountWei = parseUnits(usdt.toString(), 18);
  const dataGuess = encodeDataGuess(0n, 100n, smartEps(usdt));
  const { result } = await publicClient.simulateContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "simulateMint",
    args: [market, BigInt(tokenId), amountWei, true, "0x", dataGuess, integratorFeeBps],
  });
  const [pre, post, quote] = result;
  return {
    otToUserWei: quote.otToUser,
    costUsdt: parseFloat(formatUnits(quote.collateralFromUser, 18)),
    feeUsdt: parseFloat(formatUnits(quote.collateralToTreasury, 18)),
    priceBefore: parseFloat(formatUnits(pre.price, 18)),
    priceAfter: parseFloat(formatUnits(post.price, 18)),
  };
}

export interface SellSim {
  collateralUsdt: number;
  priceBefore: number;
  priceAfter: number;
}

export async function simulateSell(
  market: Address,
  tokenId: number,
  otAmountWei: bigint,
): Promise<SellSim> {
  const { result } = await publicClient.simulateContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "simulateRedeem",
    args: [market, BigInt(tokenId), otAmountWei, true, "0x", "0x", integratorFeeBps],
  });
  const [pre, post, quote] = result;
  return {
    collateralUsdt: parseFloat(formatUnits(quote.collateralToUser, 18)),
    priceBefore: parseFloat(formatUnits(pre.price, 18)),
    priceAfter: parseFloat(formatUnits(post.price, 18)),
  };
}

// ---- WRITES (per-wallet) ----

async function ensureERC20Approval(s: Signer, amount: bigint): Promise<void> {
  const current = await publicClient.readContract({
    address: USDT,
    abi: erc20Abi,
    functionName: "allowance",
    args: [s.address, ROUTER],
  });
  if (current < amount) {
    const hash = await s.walletClient.writeContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "approve",
      args: [ROUTER, MAX_UINT256],
      account: s.account,
      chain: bsc,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`USDT approve reverted: ${hash}`);
  }
}

async function ensureERC6909Approval(
  s: Signer,
  market: Address,
  tokenId: number,
  amount: bigint,
): Promise<void> {
  const current = await publicClient.readContract({
    address: market,
    abi: marketAbi,
    functionName: "allowance",
    args: [s.address, ROUTER, BigInt(tokenId)],
  });
  if (current < amount) {
    const hash = await s.walletClient.writeContract({
      address: market,
      abi: marketAbi,
      functionName: "approve",
      args: [ROUTER, BigInt(tokenId), MAX_UINT256],
      account: s.account,
      chain: bsc,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`OT approve reverted: ${hash}`);
  }
}

export async function executeBuy(
  s: Signer,
  market: Address,
  tokenId: number,
  usdt: number,
  slippagePct: number,
  sim: BuySim,
): Promise<{ hash: Hex; otAmountWei: bigint }> {
  const amountWei = parseUnits(usdt.toString(), 18);
  await ensureERC20Approval(s, amountWei);
  const dataGuess = encodeDataGuess(sim.otToUserWei, DEFAULT_MAX_ITER, smartEps(usdt));
  const slippageBips = BigInt(Math.floor(slippagePct * 100));
  const minOtOut = (sim.otToUserWei * (10000n - slippageBips)) / 10000n;
  if (minOtOut <= 0n) throw new Error("minOtOut computed as zero");
  const hash = await s.walletClient.writeContract({
    address: ROUTER,
    abi: routerV2Abi,
    functionName: "swap",
    args: [
      market,
      s.address,
      BigInt(tokenId),
      { isMint: true, amount: amountWei, isExactIn: true, minOutOrMaxIn: minOtOut },
      "0x",
      dataGuess,
      integratorAddress,
      integratorFeeBps,
    ],
    account: s.account,
    chain: bsc,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`buy reverted: ${hash}`);
  return { hash, otAmountWei: sim.otToUserWei };
}

// ---- transfers (for withdraw / fund retrieval) ----

/** Exact USDT (B-USDT) balance of an address, in wei (18 decimals). */
export async function usdtBalanceWei(addr: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDT,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
}

/** Transfer an exact USDT amount (wei) to `to`. */
export async function transferUsdt(s: Signer, to: Address, amountWei: bigint): Promise<Hex> {
  const hash = await s.walletClient.writeContract({
    address: USDT,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amountWei],
    account: s.account,
    chain: bsc,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`USDT transfer reverted: ${hash}`);
  return hash;
}

/**
 * Send (almost) all native BNB to `to`, leaving just enough for this tx's gas
 * plus a small buffer. Returns null if the balance can't cover the gas.
 */
export async function sendAllBnb(s: Signer, to: Address): Promise<{ hash: Hex; valueWei: bigint } | null> {
  const [bal, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: s.address }),
    publicClient.getGasPrice(),
  ]);
  const gasLimit = 21000n;
  const fee = gasPrice * gasLimit;
  const buffer = fee; // keep an extra fee's worth as headroom
  const value = bal - fee - buffer;
  if (value <= 0n) return null;
  const hash = await s.walletClient.sendTransaction({ account: s.account, to, value, chain: bsc });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`BNB transfer reverted: ${hash}`);
  return { hash, valueWei: value };
}

export async function executeSell(
  s: Signer,
  market: Address,
  tokenId: number,
  otAmountWei: bigint,
  slippagePct: number,
  sim: SellSim,
): Promise<{ hash: Hex }> {
  await ensureERC6909Approval(s, market, tokenId, otAmountWei);
  const slippageBips = BigInt(Math.floor(slippagePct * 100));
  const expected = parseUnits(sim.collateralUsdt.toFixed(18), 18);
  const minCollateral = (expected * (10000n - slippageBips)) / 10000n;
  const hash = await s.walletClient.writeContract({
    address: ROUTER,
    abi: routerV2Abi,
    functionName: "swap",
    args: [
      market,
      s.address,
      BigInt(tokenId),
      { isMint: false, amount: otAmountWei, isExactIn: true, minOutOrMaxIn: minCollateral },
      "0x",
      "0x",
      integratorAddress,
      integratorFeeBps,
    ],
    account: s.account,
    chain: bsc,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`sell reverted: ${hash}`);
  return { hash };
}
