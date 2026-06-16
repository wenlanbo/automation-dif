#!/usr/bin/env bun
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  bebeAbi,
  factoryAbi,
  lensV2Abi,
  marketAbi,
  routerV2Abi,
} from "../references/abis.ts";

// === CONFIG ===
function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0)
    throw new Error(`ERROR: set ${name} env var`);
  return value;
}

// === ADDRESSES (BSC Mainnet Production) ===
const ROUTER: Address = getAddress(
  "0x888888886619275d33c00D3BC62DF94D700DCD42",
);
const LENS: Address = getAddress("0x4AAd5A856941FB64df10362024e3Ece24023d4d1"); // note: lens can be redeployed but the contract itself is immutable, if preferred you can use older versions or deploy one yourself
const USDT: Address = getAddress("0x55d398326f99059fF775485246999027B3197955");
const BEBE: Address = getAddress("0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2");
const MAX_UINT256: bigint = (1n << 256n) - 1n;
const BEBE_MODE_SINGLE_BATCH: Hex =
  "0x0100000000000000000000000000000000000000000000000000000000000000";
const TICK_SIZE = 2; // tick size is dependent on the curve itself, but we can assume 2 for now

// === CLIENTS ===
function loadConfig() {
  const RPC = process.env.BSC_RPC ?? "https://bsc-dataseed.bnbchain.org";
  const PK_RAW = required("BSC_PRIVATE_KEY", process.env.BSC_PRIVATE_KEY);
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK_RAW)) {
    throw new Error("BSC_PRIVATE_KEY must be 0x + 64 hex chars");
  }
  const PRIVATE_KEY: Hex = PK_RAW as Hex;
  const account = privateKeyToAccount(PRIVATE_KEY);
  const WALLET: Address = account.address;
  const publicClient = createPublicClient({ chain: bsc, transport: http(RPC) });
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(RPC),
  });

  const integratorAddress: Address = getAddress(
    process.env.INTEGRATOR_ADDRESS || zeroAddress,
  );
  const integratorBpsRaw = process.env.INTEGRATOR_FEE_BPS || "0";
  if (!/^\d+$/.test(integratorBpsRaw)) {
    throw new Error("INTEGRATOR_FEE_BPS must be a non-negative integer");
  }
  const integratorFeeBps = BigInt(integratorBpsRaw);
  if (integratorAddress === zeroAddress && integratorFeeBps > 0n) {
    throw new Error(
      "INTEGRATOR_FEE_BPS > 0 requires INTEGRATOR_ADDRESS to be set",
    );
  }

  return {
    account,
    WALLET,
    publicClient,
    walletClient,
    integratorAddress,
    integratorFeeBps,
  };
}

type GlobalConfig = ReturnType<typeof loadConfig>;
let account!: GlobalConfig["account"];
let WALLET!: GlobalConfig["WALLET"];
let publicClient!: GlobalConfig["publicClient"];
let walletClient!: GlobalConfig["walletClient"];
let integratorAddress!: GlobalConfig["integratorAddress"];
let integratorFeeBps!: GlobalConfig["integratorFeeBps"];

// === GUESS ENCODING (mirrors 42 frontend) ===
const DEFAULT_MAX_ITER = 50n;

function smartEps(collateralAmount: number): bigint {
  if (!Number.isFinite(collateralAmount) || collateralAmount <= 0) {
    throw new Error("collateralAmount must be finite and positive");
  }
  if (collateralAmount < 5) return 200000000000000000n; // 20% for tiny trades
  if (collateralAmount <= 3000) return 1000000000000000n; // 0.1% normal
  return BigInt(Math.floor((1 / collateralAmount) * 1e18)); // proportional for large
}

function encodeDataGuess(guess: bigint, maxIter: bigint, eps: bigint): Hex {
  if (eps <= 0n) throw new Error("eps must be > 0");
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [guess, maxIter, eps],
  );
}

// === HELPERS ===
async function readUserStates(markets: readonly Address[], user: Address) {
  if (markets.length === 0) throw new Error("markets must be non-empty");
  const contracts = markets.map(
    (m) =>
      ({
        address: LENS,
        abi: lensV2Abi,
        functionName: "getUserState",
        args: [m, user],
      }) as const,
  );
  return publicClient.multicall({ contracts, allowFailure: false });
}

async function ensureERC20Approval(
  spender: Address,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new Error("amount must be > 0");
  const current = await publicClient.readContract({
    address: USDT,
    abi: erc20Abi,
    functionName: "allowance",
    args: [WALLET, spender],
  });
  if (current < amount) {
    console.log(`  Approving USDT for ${spender.slice(0, 10)}...`);
    const hash = await walletClient.writeContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, MAX_UINT256],
      account,
      chain: bsc,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
    console.log("  Approved!");
  }
}

async function ensureERC6909Approval(
  market: Address,
  tokenId: number,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new Error("amount must be > 0");
  const current = await publicClient.readContract({
    address: market,
    abi: marketAbi,
    functionName: "allowance",
    args: [WALLET, ROUTER, BigInt(tokenId)],
  });
  if (current < amount) {
    console.log(`  Approving tokenId ${tokenId} for Router...`);
    const hash = await walletClient.writeContract({
      address: market,
      abi: marketAbi,
      functionName: "approve",
      args: [ROUTER, BigInt(tokenId), MAX_UINT256],
      account,
      chain: bsc,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
    console.log("  Approved!");
  }
}

// === SIMULATION via Lens ===
async function simulateBuy(
  market: Address,
  tokenId: number,
  usdtAmount: string,
) {
  const notional = parseFloat(usdtAmount);
  if (!(notional > 0)) throw new Error("usdtAmount must be > 0");
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    throw new Error("tokenId must be non-negative int");
  }
  const amountWei = parseUnits(usdtAmount, 18);
  const dataGuess = encodeDataGuess(0n, 100n, smartEps(notional));

  const { result } = await publicClient.simulateContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "simulateMint",
    args: [
      market,
      BigInt(tokenId),
      amountWei,
      true,
      "0x",
      dataGuess,
      integratorFeeBps,
    ],
  });
  const [pre, post, quote] = result;
  return {
    priceBefore: pre.price,
    priceAfter: post.price,
    otToUser: quote.otToUser,
    costFromUser: quote.collateralFromUser,
    feeToTreasury: quote.collateralToTreasury,
  };
}

async function simulateSell(
  market: Address,
  tokenId: number,
  otAmountWei: bigint,
) {
  if (otAmountWei <= 0n) throw new Error("otAmountWei must be > 0");
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    throw new Error("tokenId must be non-negative int");
  }

  const { result } = await publicClient.simulateContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "simulateRedeem",
    args: [
      market,
      BigInt(tokenId),
      otAmountWei,
      true,
      "0x",
      "0x",
      integratorFeeBps,
    ],
  });
  const [pre, post, quote] = result;
  return {
    priceBefore: pre.price,
    priceAfter: post.price,
    collateralToUser: quote.collateralToUser,
    feeToTreasury: quote.collateralToTreasury,
  };
}

// === ACTION: BUY ===
async function buyOutcome(
  marketRaw: string,
  tokenId: number,
  usdtAmount: string,
  slippagePct: number,
): Promise<void> {
  if (!isAddress(marketRaw)) throw new Error("invalid market");
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    throw new Error("tokenId must be non-negative int");
  }
  if (slippagePct < 0 || slippagePct >= 100)
    throw new Error("slippage out of range");
  const market = getAddress(marketRaw);
  const amountWei = parseUnits(usdtAmount, 18);
  if (amountWei <= 0n) throw new Error("usdtAmount must be > 0");

  // Step 1: Simulate to get expected OT out
  console.log("\n  Simulating buy...");
  const sim = await simulateBuy(market, tokenId, usdtAmount);
  console.log("  Expected OT:", formatUnits(sim.otToUser, 18));
  console.log("  Price before:", formatUnits(sim.priceBefore, 18));
  console.log("  Price after:", formatUnits(sim.priceAfter, 18));
  console.log("  Fee:", formatUnits(sim.feeToTreasury, 18), "USDT");

  // Step 2: Ensure USDT approval
  await ensureERC20Approval(ROUTER, amountWei);

  // Step 3: Build swap with dataGuess (using sim result as offchain hint)
  const dataGuess = encodeDataGuess(
    sim.otToUser,
    DEFAULT_MAX_ITER,
    smartEps(parseFloat(usdtAmount)),
  );

  // Slippage: minOtOut = expectedOt * (100 - slippage%) / 100
  const slippageBips = BigInt(Math.floor(slippagePct * 100));
  if (slippagePct > 0 && slippageBips === 0n) {
    throw new Error(
      `slippagePct=${slippagePct} is below 1-bps resolution; use 0 for no protection or >= 0.01`,
    );
  }
  const minOtOut = (sim.otToUser * (10000n - slippageBips)) / 10000n;
  if (minOtOut <= 0n) throw new Error("minOtOut computed as zero");

  console.log(
    "  Slippage:",
    slippagePct + "%",
    "| Min OT:",
    formatUnits(minOtOut, 18),
  );
  console.log("  Executing...");
  const hash = await walletClient.writeContract({
    address: ROUTER,
    abi: routerV2Abi,
    functionName: "swap",
    args: [
      market,
      WALLET,
      BigInt(tokenId),
      {
        isMint: true,
        amount: amountWei,
        isExactIn: true,
        minOutOrMaxIn: minOtOut,
      },
      "0x",
      dataGuess,
      integratorAddress,
      integratorFeeBps,
    ],
    account,
    chain: bsc,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  console.log(
    `  TX: ${hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`,
  );
}

// === ACTION: SELL ===
async function sellOutcome(
  marketRaw: string,
  tokenId: number,
  otAmount: string,
  slippagePct: number,
): Promise<void> {
  if (!isAddress(marketRaw)) throw new Error("invalid market");
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    throw new Error("tokenId must be non-negative int");
  }
  if (slippagePct < 0 || slippagePct >= 100)
    throw new Error("slippage out of range");
  const market = getAddress(marketRaw);
  const otAmountTicked = parseFloat(otAmount).toFixed(TICK_SIZE);
  const otAmountWei = parseUnits(otAmountTicked, 18);
  if (otAmountWei <= 0n) {
    throw new Error(
      `otAmount=${otAmount} rounds to zero at tickSize=${TICK_SIZE}; minimum sellable is 1e-${TICK_SIZE} OT`,
    );
  }

  // Step 1: Simulate
  console.log("\n  Simulating sell...");
  const sim = await simulateSell(market, tokenId, otAmountWei);
  console.log("  Expected USDT back:", formatUnits(sim.collateralToUser, 18));
  console.log("  Price before:", formatUnits(sim.priceBefore, 18));
  console.log("  Price after:", formatUnits(sim.priceAfter, 18));
  console.log("  Fee:", formatUnits(sim.feeToTreasury, 18), "USDT");

  // Step 2: Ensure ERC6909 approval for this tokenId
  await ensureERC6909Approval(market, tokenId, otAmountWei);

  // Step 3: Slippage
  const slippageBips = BigInt(Math.floor(slippagePct * 100));
  if (slippagePct > 0 && slippageBips === 0n) {
    throw new Error(
      `slippagePct=${slippagePct} is below 1-bps resolution; use 0 for no protection or >= 0.01`,
    );
  }
  const minCollateral =
    (sim.collateralToUser * (10000n - slippageBips)) / 10000n;
  if (minCollateral <= 0n) throw new Error("minCollateral computed as zero");

  console.log(
    "  Slippage:",
    slippagePct + "%",
    "| Min USDT:",
    formatUnits(minCollateral, 18),
  );
  console.log("  Executing...");
  const hash = await walletClient.writeContract({
    address: ROUTER,
    abi: routerV2Abi,
    functionName: "swap",
    args: [
      market,
      WALLET,
      BigInt(tokenId),
      {
        isMint: false,
        amount: otAmountWei,
        isExactIn: true,
        minOutOrMaxIn: minCollateral,
      },
      "0x",
      "0x",
      integratorAddress,
      integratorFeeBps,
    ],
    account,
    chain: bsc,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  console.log(
    `  TX: ${hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`,
  );
}

// === ACTION: CLAIM ===
async function claimMarkets(marketAddrs: readonly string[]): Promise<void> {
  if (marketAddrs.length === 0) throw new Error("provide at least one market");
  if (marketAddrs.length > 32)
    throw new Error("too many markets in one run (max 32)");
  for (const raw of marketAddrs) {
    if (!isAddress(raw)) throw new Error(`invalid market address: ${raw}`);
  }
  const markets = marketAddrs.map((a) => getAddress(a));

  const states = await readUserStates(markets, WALLET);

  let claimed = 0;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    const s = states[i]!;
    if (!s.state.isFinalised)
      throw new Error(`market not finalised: ${market}`);

    const tokenIds: bigint[] = [];
    const amounts: bigint[] = [];
    for (const ot of s.ots) {
      if (ot.otHolding > 0n) {
        tokenIds.push(ot.tokenId);
        amounts.push(ot.otHolding);
      }
    }
    if (tokenIds.length === 0) {
      continue;
    }

    console.log(
      `\n  Market ${market.slice(0, 10)} claiming ${tokenIds.length} tokenId(s)...`,
    );
    const hash = await walletClient.writeContract({
      address: market,
      abi: marketAbi,
      functionName: "claim",
      args: [WALLET, tokenIds, amounts],
      account,
      chain: bsc,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
    console.log(
      `    TX: ${hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`,
    );
    claimed++;
  }
  console.log(`\n  Claimed across ${claimed} market(s).`);
}

// === ACTION: CLAIM (VIA BEBE) ===
async function bebeClaimMarkets(marketAddrs: readonly string[]): Promise<void> {
  if (marketAddrs.length === 0) throw new Error("provide at least one market");
  if (marketAddrs.length > 32)
    throw new Error("too many markets in one run (max 32)");
  for (const raw of marketAddrs) {
    if (!isAddress(raw)) throw new Error(`invalid market address: ${raw}`);
  }
  const markets = marketAddrs.map((a) => getAddress(a));

  const states = await readUserStates(markets, WALLET);

  type BebeCall = { to: Address; value: bigint; data: Hex };
  const calls: BebeCall[] = [];
  let totalTokens = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    const s = states[i]!;
    if (!s.state.isFinalised)
      throw new Error(`market not finalised: ${market}`);

    const tokenIds: bigint[] = [];
    const amounts: bigint[] = [];
    for (const ot of s.ots) {
      if (ot.otHolding > 0n) {
        tokenIds.push(ot.tokenId);
        amounts.push(ot.otHolding);
      }
    }
    if (tokenIds.length === 0) {
      continue;
    }

    calls.push({
      to: market,
      value: 0n,
      data: encodeFunctionData({
        abi: marketAbi,
        functionName: "claim",
        args: [WALLET, tokenIds, amounts],
      }),
    });
    totalTokens += tokenIds.length;
    console.log(
      `    ${market.slice(0, 10)}... ${tokenIds.length} tokenId(s) queued`,
    );
  }

  if (calls.length === 0) {
    console.log("  No claimable positions; nothing to do.");
    return;
  }

  console.log(
    `\n  Batching ${calls.length} market claim(s) via BEBE (${totalTokens} tokenId(s) total)...`,
  );

  // ERC-7821 executionData: abi.encode(Call[]) where Call = (to, value, data).
  const executionData = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [calls],
  );
  const bebeCalldata = encodeFunctionData({
    abi: bebeAbi,
    functionName: "execute",
    args: [BEBE_MODE_SINGLE_BATCH, executionData],
  });

  console.log("  Signing 7702 authorization to BEBE and sending...");
  const authorization = await walletClient.signAuthorization({
    contractAddress: BEBE,
    executor: "self",
  });
  const hash = await walletClient.sendTransaction({
    authorizationList: [authorization],
    to: WALLET,
    data: bebeCalldata,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  console.log(
    `  TX: ${hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`,
  );
  console.log("  EOA remains delegated to BEBE. Run `undelegate` when done.");
}

// === ACTION: UNDELEGATE ===
// Clears any EIP-7702 delegation on the EOA by signing an authorization with
// contractAddress = zeroAddress and sending it to self. No-op if already clean.
async function undelegateSelf(): Promise<void> {
  const code = await publicClient.getCode({ address: WALLET });
  if (!code || code === "0x") {
    console.log("  No delegation to clear; wallet has no code.");
    return;
  }
  if (code.toLowerCase().startsWith("0xef0100")) {
    const delegate = getAddress(`0x${code.slice(8, 48)}`);
    console.log(`  Current delegate: ${delegate}`);
  } else {
    console.log(
      "  Warning: wallet has non-7702 code; proceeding with undelegate anyway.",
    );
  }
  console.log("  Signing zero-address authorization and sending...");
  const authorization = await walletClient.signAuthorization({
    contractAddress: zeroAddress,
    executor: "self",
  });
  const hash = await walletClient.sendTransaction({
    authorizationList: [authorization],
    to: WALLET,
    data: "0x",
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  console.log(
    `  TX: ${hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`,
  );
  console.log("  Delegation cleared.");
}

// === ACTION: INFO ===
async function showInfo(marketRaw: string): Promise<void> {
  if (!isAddress(marketRaw)) throw new Error("invalid market");
  const market = getAddress(marketRaw);

  const registryRaw = await publicClient.readContract({
    address: market,
    abi: marketAbi,
    functionName: "registry",
  });
  if (!isAddress(registryRaw)) {
    throw new Error("market.registry() returned non-address");
  }
  const controller = getAddress(registryRaw);

  const [snap, config] = await publicClient.multicall({
    contracts: [
      {
        address: LENS,
        abi: lensV2Abi,
        functionName: "snapshotMarket",
        args: [market],
      },
      {
        address: controller,
        abi: factoryAbi,
        functionName: "getConfig",
        args: [market],
      },
    ],
    allowFailure: false,
  });
  const numOutcomes = Number(snap.state.numOutcomes);
  if (numOutcomes < 2) throw new Error("numOutcomes must be >= 2");

  const [, feeRate, , timestampEnd, , isFinalised] = config;

  let names: readonly string[] = [];
  try {
    names = await publicClient.readContract({
      address: controller,
      abi: factoryAbi,
      functionName: "getOutcomeNames",
      args: [snap.deploy.questionId],
    });
  } catch {
    /* names unavailable */
  }

  console.log("Market:", market);
  console.log("  Outcomes:", numOutcomes);
  console.log("  Fee rate:", ((Number(feeRate) / 1e18) * 100).toFixed(2) + "%");
  console.log("  End:", new Date(Number(timestampEnd) * 1000).toISOString());
  console.log("  Finalised:", isFinalised);
  console.log(
    "  Total market cap:",
    formatUnits(snap.state.totalMarketCap, 18),
    "USDT\n",
  );
  for (let i = 0; i < numOutcomes; i++) {
    const ot = snap.ots[i];
    if (ot === undefined) continue;
    const name = names[i] ?? `Token ${ot.tokenId}`;
    console.log(`  [tokenId=${ot.tokenId}] ${name}`);
    console.log(
      `      Price: ${formatUnits(ot.price, 18)} USDT | Supply: ${formatUnits(ot.supply, 18)} OT | Payout/OT: ${formatUnits(ot.payoutPerOt, 18)}`,
    );
  }
}

// === ACTION: QUOTE ===
async function showQuote(
  marketRaw: string,
  tokenId: number,
  usdtAmount: string | undefined,
): Promise<void> {
  if (!isAddress(marketRaw)) throw new Error("invalid market");
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    throw new Error("tokenId must be non-negative int");
  }
  const market = getAddress(marketRaw);

  if (usdtAmount) {
    const sim = await simulateBuy(market, tokenId, usdtAmount);
    console.log("Current price:", formatUnits(sim.priceBefore, 18), "USDT");
    console.log(`\nBuy quote for ${usdtAmount} USDT:`);
    console.log("  OT you'd get:", formatUnits(sim.otToUser, 18));
    console.log("  Actual cost:", formatUnits(sim.costFromUser, 18), "USDT");
    console.log("  Fee:", formatUnits(sim.feeToTreasury, 18), "USDT");
    console.log(
      "  Price impact:",
      formatUnits(sim.priceBefore, 18),
      "->",
      formatUnits(sim.priceAfter, 18),
    );
    return;
  }

  // No USDT amount, just return price
  const ot = await publicClient.readContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "snapshotOt",
    args: [market, BigInt(tokenId)],
  });
  console.log("Current price:", formatUnits(ot.price, 18), "USDT");
}

// === ACTION: PORTFOLIO ===
async function showPortfolio(marketRaw: string): Promise<void> {
  if (!isAddress(marketRaw)) throw new Error("invalid market");
  const market = getAddress(marketRaw);
  const states = await readUserStates([market], WALLET);
  const snap = states[0]!;

  console.log(
    `Portfolio for ${WALLET.slice(0, 6)}...${WALLET.slice(-4)} on ${market.slice(0, 10)}...`,
  );
  let totalValue = 0;
  for (const ot of snap.ots) {
    if (ot.otHolding > 0n) {
      const balFmt = parseFloat(formatUnits(ot.otHolding, 18));
      const priceFmt = parseFloat(formatUnits(ot.price, 18));
      const value = balFmt * priceFmt;
      totalValue += value;
      console.log(
        `  tokenId=${ot.tokenId}: ${balFmt} OT x ${priceFmt.toFixed(6)} = ${value.toFixed(4)} USDT`,
      );
    }
  }
  if (totalValue === 0) console.log("  No positions");
  else console.log(`  Total value: ~${totalValue.toFixed(4)} USDT`);
  if (snap.state.isFinalised && snap.collateralClaimable > 0n) {
    console.log(
      `  Claimable: ${formatUnits(snap.collateralClaimable, 18)} USDT (run \`claim\` or \`bebe-claim\`)`,
    );
  }
}

// === ACTION: STATUS ===
async function showStatus(): Promise<void> {
  const [bnb, usdtMulti, code] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.multicall({
      contracts: [
        {
          address: USDT,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [WALLET],
        },
        {
          address: USDT,
          abi: erc20Abi,
          functionName: "allowance",
          args: [WALLET, ROUTER],
        },
      ],
      allowFailure: false,
    }),
    publicClient.getCode({ address: WALLET }),
  ]);
  const [usdt, allowance] = usdtMulti;
  console.log("Wallet:", WALLET);
  console.log("  BNB:", formatUnits(bnb, 18));
  console.log("  USDT:", formatUnits(usdt, 18));
  console.log(
    "  USDT allowance for Router:",
    allowance > 0n ? "unlimited" : "none",
  );
  // EIP-7702 delegation marker: 0xef0100 || 20-byte delegate address.
  if (code && code !== "0x" && code.toLowerCase().startsWith("0xef0100")) {
    const delegate = getAddress(`0x${code.slice(8, 48)}`);
    console.log(
      `  EIP-7702 delegation: ${delegate}${
        delegate.toLowerCase() === BEBE.toLowerCase() ? " (BEBE)" : ""
      } — run \`undelegate\` to clear`,
    );
  }
}

// === CLI ===
function usage(): void {
  console.log("42.space Trading CLI v3.1 (bun + viem + ts)\n");
  console.log("Usage:");
  console.log(
    "  bun trade.ts                                       wallet status",
  );
  console.log(
    "  bun trade.ts info <market>                         market details + outcomes",
  );
  console.log(
    "  bun trade.ts quote <market> <tokenId> [usdt]       price quote + simulation",
  );
  console.log(
    "  bun trade.ts buy <market> <tokenId> <usdt> [slip%] buy outcome tokens",
  );
  console.log(
    "  bun trade.ts sell <market> <tokenId> <amt> [slip%] sell outcome tokens",
  );
  console.log(
    "  bun trade.ts claim <market> [market2 ...]          claim (direct market.claim, N sequential txs)",
  );
  console.log(
    "  bun trade.ts bebe-claim <market> [market2 ...]     batch claim via BEBE/EIP-7702 (1 tx)",
  );
  console.log(
    "  bun trade.ts undelegate                            clear EIP-7702 delegation on this wallet",
  );
  console.log(
    "  bun trade.ts portfolio <market>                    show positions",
  );
  console.log(
    "\nEnvironment: BSC_PRIVATE_KEY (required — wallet address is derived), BSC_RPC (optional), INTEGRATOR_ADDRESS (optional), INTEGRATOR_FEE_BPS (optional; > 0 requires INTEGRATOR_ADDRESS)",
  );
}

type Action = (argv: readonly string[]) => Promise<void>;

function req(argv: readonly string[], i: number, label: string): string {
  const v = argv[i];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing argument: ${label}`);
  }
  return v;
}

const DISPATCH: Record<string, Action> = {
  status: async () => showStatus(),
  info: async (argv) => showInfo(req(argv, 3, "market")),
  quote: async (argv) =>
    showQuote(
      req(argv, 3, "market"),
      parseInt(req(argv, 4, "tokenId"), 10),
      argv[5],
    ),
  buy: async (argv) =>
    buyOutcome(
      req(argv, 3, "market"),
      parseInt(req(argv, 4, "tokenId"), 10),
      req(argv, 5, "usdt"),
      argv[6] !== undefined ? parseFloat(argv[6]) : 1,
    ),
  sell: async (argv) =>
    sellOutcome(
      req(argv, 3, "market"),
      parseInt(req(argv, 4, "tokenId"), 10),
      req(argv, 5, "amount"),
      argv[6] !== undefined ? parseFloat(argv[6]) : 1,
    ),
  claim: async (argv) => claimMarkets(argv.slice(3)),
  "bebe-claim": async (argv) => bebeClaimMarkets(argv.slice(3)),
  undelegate: async () => undelegateSelf(),
  portfolio: async (argv) => showPortfolio(req(argv, 3, "market")),
};

async function main(): Promise<void> {
  const action = process.argv[2] ?? "status";
  if (action === "help" || action === "--help" || action === "-h") {
    usage();
    return;
  }
  const fn = DISPATCH[action];
  if (!fn) {
    usage();
    process.exit(1);
  }
  ({
    account,
    WALLET,
    publicClient,
    walletClient,
    integratorAddress,
    integratorFeeBps,
  } = loadConfig());
  await fn(process.argv);
}

main().catch((e: unknown) => {
  const err = e as {
    shortMessage?: string;
    message?: string;
    cause?: { message?: string };
  };
  console.error("ERROR:", err.shortMessage ?? err.message ?? String(e));
  if (err.cause?.message) console.error("Cause:", err.cause.message);
  process.exit(1);
});
