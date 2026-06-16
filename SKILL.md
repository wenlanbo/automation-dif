---
name: 42space-trading
title: "42.space Prediction Market Trading on BSC"
description: "Complete guide for AI agents to trade prediction market outcome tokens on 42.space (BNB Smart Chain). Covers market mechanics, REST API for data queries, on-chain trading via smart contracts, and optional integrations with 0x (token swaps) and Privy (managed wallets with gas sponsorship)."
tags:
  [prediction-markets, bsc, trading, defi, web3, ethers, 42space, bonding-curve]
version: "2.0.0"
---

# 42.space Prediction Market Trading

A complete, agent-agnostic guide. Any AI agent with terminal access and Node.js can use this to discover, analyze, and trade prediction markets on 42.space.

---

## 1. How 42.space Works

### What Is It?

42.space is a **prediction market protocol** on **BNB Smart Chain (BSC)**. Users trade **outcome tokens** for real-world events — elections, crypto prices, sports, product launches, etc.

### The Bonding Curve Mechanism

Unlike traditional exchanges with orderbooks, 42.space uses a **power bonding curve** for pricing:

- **No counterparty needed.** You buy from and sell to the curve itself (a smart contract).
- **Price rises with demand.** As more tokens are minted (bought) for an outcome, the price increases along the curve. Selling (redeeming) pushes it back down.
- **Continuous liquidity.** You can always buy or sell — there's no need to find a matching order.
- **Price ≠ probability.** Price is the curve's marginal cost — it indicates relative market confidence between outcomes, but does **not** map 1:1 to probability.

### Multi-Outcome Markets

Markets are NOT limited to Yes/No. A single market can have **2 to 10+ outcomes**:

```
"Who will win the 2026 NBA MVP?"
  Token 0: (reserved/null)     — price: ~0.00 USDT
  Token 1: Luka Doncic         — price: 0.28 USDT  ← highest curve price (most collateral committed)
  Token 2: Nikola Jokic        — price: 0.22 USDT
  Token 3: Jayson Tatum        — price: 0.15 USDT
  ...
```

Each outcome is a separate token identified by a **tokenId** (0-indexed integer).

### Outcome Tokens (OT)

- Follow the **ERC6909** standard (multi-token, similar to ERC1155 but simpler)
- Held directly on the market contract: `market.balanceOf(walletAddress, tokenId)`
- Denominated in 18 decimals (like ETH wei)
- **Tick size:** `0.01e18` (10000000000000000 wei) — all OT amounts must be multiples of this

### Market Lifecycle

```
live → ended → resolved → finalised
```

1. **Live:** Trading is open. Buy and sell freely.
2. **Ended:** Trading window closed. No new trades.
3. **Resolved:** Admin sets the winning outcome.
4. **Finalised:** Challenge period passed. Winners can claim.

### Settlement

When a market is **finalised**, the **entire pooled market cap** is distributed **pro-rata** to holders of the winning outcome token. Losing outcomes pay **0**. There is **no fixed 1 USDT payout**.

Formulas:

```
payoutPerOt = totalMarketCap / supplyOfWinningToken
payoutUser  = (totalMarketCap * userHolding) / supplyOfWinningToken
```

Example: if the market collected **10,000 USDT** across all outcomes and the winning outcome has **5,000 OT** in circulation, each winning OT pays out **2 USDT**. If only **2,000 OT** were minted for the winner, each pays **5 USDT**. The per-OT payout depends entirely on the ratio of collected collateral to winning-token supply — it can be well above or below 1 USDT.

### Key Numbers

| Parameter               | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **Chain**               | BNB Smart Chain (Chain ID: 56)                                                      |
| **Collateral**          | USDT (BEP-20) on BSC — **18 decimals** (NOT 6 like Ethereum USDT)                   |
| **Protocol Fee rate**   | **~0.4%**, stored as `4e15` (i.e. `8_000_000_000_000_000`) on a `1e18 = 100%` scale |
| **Integrator Fee rate** | Dynamically allocated according to the frontend integrator on a `1e4 = 100%` scale  |
| **Tick size**           | Dependent on curve, recommended to stick to tick size of `1e16` wei = `0.01` OT.    |
| **Market URL**          | `https://www.42.space/event/{contract_address}`                                     |

---

## 2. REST API — Querying Market Data

The 42.space REST API provides read-only access to all market data. **No authentication required.**

### Base URL

```
https://rest.ft.42.space
```

All endpoints are **GET** requests returning JSON with `{data, pagination}` structure.

### 2.1 Market Discovery

**List live markets by volume:**

```bash
curl -s "https://rest.ft.42.space/api/v1/markets?status=live&order=volume&limit=10"
```

| Parameter  | Values                                   |
| ---------- | ---------------------------------------- |
| `status`   | `live`, `ended`, `resolved`, `finalised` |
| `category` | Filter by category name                  |
| `order`    | `volume` (descending)                    |
| `limit`    | Max results (up to 500)                  |
| `offset`   | Pagination offset                        |

**Get a specific market:**

```bash
curl -s "https://rest.ft.42.space/api/v1/markets/{market_address}"
```

**List all outcome tokens for a market (KEY ENDPOINT):**

```bash
curl -s "https://rest.ft.42.space/api/v1/markets/tokens?market_address={address}"
```

This returns each outcome's `tokenId`, `name`, `price`, `volume`, `marketCap`, `mintedQuantity`, and `symbol`. **Use this to know what you're buying.**

**Market timeline (lifecycle events):**

```bash
curl -s "https://rest.ft.42.space/api/v1/markets/{address}/timeline"
```

**All categories:**

```bash
curl -s "https://rest.ft.42.space/api/v1/markets/categories"
```

### Market Data Schema (Key Fields)

```
address             — on-chain contract address (use this for trading)
questionId          — bytes32 identifier
question            — human-readable question text
description         — detailed description with resolution criteria
slug                — URL-friendly identifier
collateralAddress   — USDT contract address
curve               — bonding curve contract address
startDate, endDate  — market open/close timestamps
status              — live / ended / resolved / finalised
resolvedAnswer      — winning tokenId (after resolution)
totalMarketCap      — total value locked
volume              — total trading volume in USDT
traders             — number of unique traders
categories[]        — category tags
outcomes[]:
  tokenId           — integer ID (use this for on-chain calls)
  name              — outcome name (e.g., "Yes", "Luka Doncic")
  index             — same as tokenId
  price             — current marginal price in USDT (curve-dependent, can exceed 1)
  volume            — outcome-specific volume
  marketCap         — outcome-specific market cap
  payout            — payout per token after resolution
  mintedQuantity    — total OT supply
  symbol            — token symbol string
```

### 2.2 Pricing & Charts

**Current prices for all outcomes:**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/prices?market={address}"
```

**Price history:**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/prices/history?market={address}&outcome_index=0&duration=24h"
# Durations: 1h, 4h, 24h, 7d, 30d, 90d, 1y, all
```

**OHLCV candles:**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/ohlc?market={address}&outcome_index=0&interval=1d"
# Intervals: 10s, 1m, 3m, 30m, 2h, 6h, 12h, 1d
```

### 2.3 Token Stats & Holders

**Token stats with price/volume deltas:**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/tokens/stats?status=live&order_by=volume&limit=100"
```

Returns `statsChanges` with `priceChange1h`, `priceChange4h`, `volumeChange1h`, `volumeChange24h` — useful for alerts and scanning.

**Batch market stats (up to 50):**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/stats?markets={addr1},{addr2}"
```

**Token holder distribution:**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/holders?market={address}&outcome_index=0"
```

Returns: `userAddress`, `amount`, `avgPrice`, `currentPrice`, `realizedPnl`, `unrealizedPnl`.

### 2.4 Portfolio & Activity

**Open positions (with unrealized PnL):**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/positions?user={wallet_address}"
```

**Closed positions (realized PnL):**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/closed-positions?user={wallet_address}"
```

**Activity feed (trade history):**

```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/activity?user={wallet_address}"
# Event types: MINT (buy), REDEEM (sell), FINALISE, CLAIM
```

### 2.5 Leaderboard

```bash
# Top traders by PnL
curl -s "https://rest.ft.42.space/api/v1/market-data/leaderboard?sort_by=pnl&period=7d&limit=20"

# Single wallet stats
curl -s "https://rest.ft.42.space/api/v1/market-data/leaderboard/wallet-stats?wallet={address}"

# Top trades globally
curl -s "https://rest.ft.42.space/api/v1/market-data/leaderboard/top-trades?period=7d"
```

### Common Workflow: Find a Market and Its Outcomes

```bash
# Step 1: Find live markets
curl -s "https://rest.ft.42.space/api/v1/markets?status=live&order=volume&limit=5" | jq '.data[0]'

# Step 2: Get the market address from the response, then list its outcome tokens
curl -s "https://rest.ft.42.space/api/v1/markets/tokens?market_address=0x4E44AC67..." | jq '.data[] | {tokenId, name, price, volume}'

# Step 3: Check your positions
curl -s "https://rest.ft.42.space/api/v1/market-data/positions?user=0xYOUR_WALLET"
```

---

## 3. On-Chain Trading — Smart Contracts

### 3.0 Requirements

- **Node.js** >= 18
- **ethers.js** v6: `npm install ethers`
- A BSC wallet with:
  - **BNB** for gas (~0.01 BNB per trade ≈ $0.03)
  - **USDT (BEP-20)** for trading
- **RPC endpoint:** `https://bsc-dataseed1.binance.org` (public, free)
- Store private keys in **environment variables**, never hardcode them

### 3.1 Contract Addresses (BSC Mainnet)

| Contract    | Address                                      | Role                                            |
| ----------- | -------------------------------------------- | ----------------------------------------------- |
| **Router**  | `0x88888888338e60bfB4657187169cFFa5c8640E42` | Entry point for all trades (multicall)          |
| **Factory** | `0xF21b2D4F8989b27f732e369907F25f0E8D95Fe62` | Market registry, config, question data          |
| **Curve**   | `0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da` | Bonding curve pricing engine                    |
| **Lens**    | `0x9a9846037238599b10f60a59C2607a8c3159E827` | Simulation & snapshots (recommended for quotes) |
| **USDT**    | `0x55d398326f99059fF775485246999027B3197955` | Collateral (BEP-20, 18 decimals)                |

Architecture:

```
User → Router (multicall) → Market (ERC6909 tokens)
                          → Curve (pricing)
       Factory (registry) → Market config / question data
       Lens (read-only)   → Simulations & snapshots (pre/post state)
```

### 3.2 Setup

```javascript
const { ethers } = require("ethers");

const RPC = "https://bsc-dataseed1.binance.org";
const PRIVATE_KEY = process.env.BSC_PRIVATE_KEY; // NEVER hardcode
const WALLET = new ethers.Wallet(PRIVATE_KEY).address; // derive, don't store separately

const ROUTER_ADDR = "0x88888888338e60bfB4657187169cFFa5c8640E42";
const CURVE_ADDR = "0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da";
const LENS_ADDR = "0xc936813410B0c157324D39EDc18062FE5E2C8189"; // V2 lens
const USDT_ADDR = "0x55d398326f99059fF775485246999027B3197955";

// Load ABIs (see references/ directory for full JSON files)
const ROUTER_ABI = require("./references/router-abi.json");
const FACTORY_ABI = require("./references/factory-abi.json");
const CURVE_ABI = require("./references/curve-abi.json");
const LENS_ABI = require("./references/lens-v2-abi.json"); // V2 — NOT lens-abi.json
const MARKET_ABI = require("./references/market-abi.json"); // ERC-6909 + claim

// Minimal ERC-20 subset for USDT interactions.
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, wallet);
const curve = new ethers.Contract(CURVE_ADDR, CURVE_ABI, provider);
const lens = new ethers.Contract(LENS_ADDR, LENS_ABI, provider);
```

### 3.3 Get the Factory

```javascript
const factoryAddr = await router.controller();
const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
```

### 3.4 Read Market Info

```javascript
const market = "0x4E44AC673bcc315cD97424CaEfCF9CcCC8eAcA6b"; // example

// Verify it's a real 42.space market
const isReal = await factory.isMarket(market); // true or false

// Get config
const config = await factory.getConfig(market);
// Returns: _treasury, _feeRate, _numOutcomes, _timestampEnd, _answer, _isFinalised
console.log("Outcomes:", Number(config._numOutcomes));
console.log("End:", new Date(Number(config._timestampEnd) * 1000));
console.log("Finalised:", config._isFinalised);
```

### 3.5 Read Prices

```javascript
// Marginal price of a specific outcome token
const price = await curve.calMarginalPrice(market, tokenId);
console.log("Price:", ethers.formatUnits(price, 18), "USDT");

// Full market state
const state = await curve.readMarketState(market, tokenId);
console.log("OT supply:", ethers.formatUnits(state.otCurrent, 18));
console.log("Tick:", state.tick.toString());
console.log("Fee rate:", state.feeRate.toString());
```

### 3.6 Get Price Quotes

**How many OT for X USDT?**

```javascript
const usdtIn = ethers.parseUnits("10", 18); // 10 USDT
const [otDelta, actualCost] = await curve.calOtDeltaByMintCost(
  market,
  tokenId,
  usdtIn,
  "0x", // CRITICAL: pass "0x" for data param
);
console.log("You'd get:", ethers.formatUnits(otDelta, 18), "OT");
console.log("Actual cost:", ethers.formatUnits(actualCost, 18), "USDT");
```

**How much USDT to buy X OT?**

```javascript
const otAmount = ethers.parseUnits("1000", 18);
const [costFromUser, feeToTreasury] = await curve.calMintCostByOtDelta(
  market,
  tokenId,
  otAmount,
  "0x",
);
console.log("Cost:", ethers.formatUnits(costFromUser, 18), "USDT");
```

**Sell quote (how much USDT you'd get back):**

```javascript
const [collateralBack, sellFee] = await curve.calRedeemValueByOtDelta(
  market,
  tokenId,
  otAmount,
  "0x",
);
console.log("You'd receive:", ethers.formatUnits(collateralBack, 18), "USDT");
```

### 3.6b Lens V2 — Simulations and User State (Recommended)

Lens V2 (`0xc936…`) is the one-stop read layer. Use it for quotes, per-user aggregation, and market snapshots. It is **not view-callable onchain**: the simulation entry points are `nonpayable` because simulating requires internal state changes, so always call them with `.staticCall(...)` in ethers.js (or `simulateContract` / `multicall` in viem).

```javascript
// 1) Full market snapshot — all outcomes in one RPC call
const snap = await lens.snapshotMarket.staticCall(market);
snap.ots.forEach((ot, i) => {
  console.log(
    `[${i}] price=${ethers.formatUnits(ot.price, 18)} supply=${ethers.formatUnits(ot.supply, 18)} payoutPerOt=${ethers.formatUnits(ot.payoutPerOt, 18)}`,
  );
});
console.log(
  "Total market cap:",
  ethers.formatUnits(snap.state.totalMarketCap, 18),
  "USDT",
);
console.log("Finalised:", snap.state.isFinalised);
// snap.deploy.questionId is the bytes32 — use it for factory.getOutcomeNames(questionId)

// 2) Per-user state — ONE call replaces N balanceOf + N price reads
const user = await lens.getUserState.staticCall(market, WALLET);
user.ots.forEach((ot, i) => {
  if (ot.otHolding > 0n) {
    console.log(
      `Token ${i}: hold=${ethers.formatUnits(ot.otHolding, 18)} OT, price=${ethers.formatUnits(ot.price, 18)}`,
    );
  }
});
if (user.state.isFinalised) {
  console.log("Claimable:", ethers.formatUnits(user.otClaimable, 18), "USDT");
}

// 3) Buy simulation. dataGuess seeds the on-chain Newton's method; pass "0x" for
//    the first call, then re-encode with the returned otToUser for the execution.
const FIRST_GUESS = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "uint256", "uint256"],
  [0n, 100n, 1_000_000_000_000_000n], // guess=0, maxIter=100, eps=0.1%
);
const sim = await lens.simulateMint.staticCall(
  market,
  tokenId,
  ethers.parseUnits("10", 18), // collateral in
  true, // isExactIn
  "0x", // dataSwap (always "0x")
  FIRST_GUESS, // dataGuess
  0n, // integratorFeeBps (V2 only)
);
console.log("OT received:", ethers.formatUnits(sim.quote.otToUser, 18));
console.log(
  "Cost:",
  ethers.formatUnits(sim.quote.collateralFromUser, 18),
  "USDT",
);
console.log(
  "Fee:",
  ethers.formatUnits(sim.quote.collateralToTreasury, 18),
  "USDT",
);
console.log(
  "Price impact:",
  ethers.formatUnits(sim.pre.price, 18),
  "→",
  ethers.formatUnits(sim.post.price, 18),
);

// 4) Sell simulation. Redeem is closed-form (exactIn = exact OT in), so dataGuess = "0x".
const sellSim = await lens.simulateRedeem.staticCall(
  market,
  tokenId,
  otAmountWei,
  true,
  "0x",
  "0x",
  0n,
);
console.log(
  "USDT back:",
  ethers.formatUnits(sellSim.quote.collateralToUser, 18),
);
```

**`dataGuess` encoding — for BUYS (mints) only:**

```javascript
ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "uint256", "uint256"],
  [otDeltaGuessOffchain, maxIterations, eps],
);
// otDeltaGuessOffchain: expected OT output from simulation (pass 0 on the first sim call)
// maxIterations: 100 for off-chain simulation, 50 for the on-chain execution
// eps (stop condition):
//   trade < $5   → 2e17  (20%, dust tolerance)
//   $5..$3000    → 1e15  (0.1%, normal)
//   trade > $3000 → floor((1/usdt) * 1e18), proportional
```

**For SELLS, `dataGuess` MUST be `"0x"`** — redeem math is closed-form; passing an encoded guess reverts with `GuessInvalidDataLength`.

**For BUYS, `dataGuess` should be encoded** (as above) to seed Newton's method and save gas. Passing `"0x"` works for some shapes but can revert on large/skewed trades.

### 3.7 Approve USDT (One-Time)

```javascript
const usdt = new ethers.Contract(USDT_ADDR, ERC20_ABI, wallet);
const allowance = await usdt.allowance(WALLET, ROUTER_ADDR);
if (allowance === 0n) {
  const tx = await usdt.approve(ROUTER_ADDR, ethers.MaxUint256);
  await tx.wait();
}
```

### 3.8 Buy Outcome Tokens

Buying is a **single direct `router.swapSimple(...)` call**. The Router pulls USDT via the ERC-20 allowance you set in 3.7 — you **no longer** need `multicall` + `erc20TransferFromInitiator` for a simple buy.

The flow:

1. Simulate via Lens to get the expected OT amount.
2. Encode `dataGuess` with that expected amount as the Newton's-method seed.
3. Compute `minOutOrMaxIn` from the simulation + your slippage tolerance.
4. Call `router.swapSimple(...)`.

```javascript
const amountIn = ethers.parseUnits("10", 18); // 10 USDT
const tokenId = 1; // which outcome to buy
const slippageBips = 100n; // 1.00% (bips = hundredths of a %)

// --- 1) simulate via Lens V2 to learn the expected output and price impact ---
const FIRST_GUESS = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "uint256", "uint256"],
  [0n, 100n, 1_000_000_000_000_000n], // guess=0, maxIter=100, eps=0.1%
);
const sim = await lens.simulateMint.staticCall(
  market,
  tokenId,
  amountIn,
  true,
  "0x",
  FIRST_GUESS,
  0n,
);
const expectedOt = sim.quote.otToUser;

// --- 2) execution dataGuess: seed with the sim's otToUser, maxIter=50 ---
const execGuess = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "uint256", "uint256"],
  [expectedOt, 50n, 1_000_000_000_000_000n], // 0.1% eps for a $10 trade
);

// --- 3) slippage-protected min OT out ---
const minOtOut = (expectedOt * (10_000n - slippageBips)) / 10_000n;

// --- 4) execute ---
const tx = await router.swapSimple(
  market, // market address
  WALLET, // receiver
  tokenId, // outcome tokenId
  {
    isMint: true, // true = buy / mint OT
    amount: amountIn, // USDT to spend
    isExactIn: true, // exact collateral in, variable OT out
    minOutOrMaxIn: minOtOut, // revert if OT out < this
  },
  "0x", // dataSwap — always "0x"
  execGuess, // dataGuess — ABI-encoded (guess, maxIter, eps)
);
const receipt = await tx.wait();
console.log("Bought! TX:", receipt.hash, "block:", receipt.blockNumber);
```

> **Do not pass `minOutOrMaxIn: 0n` in production.** That's "accept any price" and exposes you to sandwich attacks. Always compute it from the simulation.

### 3.9 Check Your Position

Single outcome (direct ERC-6909 read):

```javascript
const marketContract = new ethers.Contract(market, MARKET_ABI, provider);
const balance = await marketContract.balanceOf(WALLET, tokenId);
console.log("Balance:", ethers.formatUnits(balance, 18), "OT");
```

All outcomes at once (**preferred** — one RPC call returns prices, balances, and claimable):

```javascript
const user = await lens.getUserState.staticCall(market, WALLET);
user.ots.forEach((ot, i) => {
  if (ot.otHolding === 0n) return;
  const hold = ethers.formatUnits(ot.otHolding, 18);
  const price = ethers.formatUnits(ot.price, 18);
  console.log(`Token ${i}: ${hold} OT @ ${price} USDT`);
});
if (user.state.isFinalised) {
  console.log("Claimable:", ethers.formatUnits(user.otClaimable, 18), "USDT");
}
```

### 3.10 Sell Outcome Tokens

Selling is also a **single direct `router.swapSimple(...)` call** — no multicall wrapping needed. The only extra step is a **per-`tokenId` ERC-6909 approval** so the Router can burn your OT.

```javascript
const otToSell = ethers.parseUnits("100", 18);
const slippageBips = 100n; // 1%

// --- 1) one-time per-tokenId approval (ERC-6909 signature: approve(spender, id, amount)) ---
const marketContract = new ethers.Contract(market, MARKET_ABI, wallet);
const otAllowance = await marketContract.allowance(
  WALLET,
  ROUTER_ADDR,
  tokenId,
);
if (otAllowance < otToSell) {
  const approveTx = await marketContract.approve(
    ROUTER_ADDR,
    tokenId,
    ethers.MaxUint256,
  );
  await approveTx.wait();
}

// --- 2) simulate to learn USDT out (dataGuess is "0x" — redeem is closed-form) ---
const sellSim = await lens.simulateRedeem.staticCall(
  market,
  tokenId,
  otToSell,
  true,
  "0x",
  "0x",
  0n,
);
const expectedUsdt = sellSim.quote.collateralToUser;
const minUsdtOut = (expectedUsdt * (10_000n - slippageBips)) / 10_000n;

// --- 3) execute — both dataSwap AND dataGuess are "0x" for sells ---
const tx = await router.swapSimple(
  market,
  WALLET,
  tokenId,
  {
    isMint: false, // sell / redeem
    amount: otToSell, // OT to burn
    isExactIn: true,
    minOutOrMaxIn: minUsdtOut, // revert if USDT back < this
  },
  "0x", // dataSwap
  "0x", // dataGuess — MUST be "0x" for redeems
);
const receipt = await tx.wait();
console.log("Sold! TX:", receipt.hash);
```

> The ERC-6909 `approve(spender, tokenId, amount)` signature is **three args** — `tokenId` in the middle. Don't confuse it with the ERC-20 two-arg form.

### 3.11 Claim Winnings (Direct)

After a market is finalised, you claim by calling `market.claim(receiver, tokenIds[], otToBurn[])` **directly on the market** — no Router, no `setOperator`. The caller is the token owner burning their own OTs, so no delegated spend is needed.

Use Lens V2 `getUserState` to discover which tokenIds you hold in a single call:

```javascript
const marketContract = new ethers.Contract(market, MARKET_ABI, wallet);

// 1) Verify finalised and gather all non-zero holdings in one RPC
const user = await lens.getUserState.staticCall(market, WALLET);
if (!user.state.isFinalised) throw new Error("Market not finalised yet");

const tokenIds = [];
const amounts = [];
for (let i = 0; i < user.ots.length; i++) {
  const hold = user.ots[i].otHolding;
  if (hold > 0n) {
    tokenIds.push(BigInt(i));
    amounts.push(hold);
  }
}
if (tokenIds.length === 0) {
  console.log("No positions");
  return;
}

// 2) Single claim tx — burns ALL your OTs (winning + losing) and pays out the pro-rata share
const tx = await marketContract.claim(WALLET, tokenIds, amounts);
const receipt = await tx.wait();
console.log("Claimed! TX:", receipt.hash);
// Payout lands as USDT in your wallet. Per the Settlement formulas, each winning OT pays
// (totalMarketCap / supplyOfWinningToken). Losing OTs contribute nothing but must still be
// included to be cleared from your balance.
```

Each market requires its own tx (an EOA cannot atomically batch writes across contracts). For multiple finalised markets, see **3.12 Batch Claim via BEBE** below.

### 3.12 Batch Claim via BEBE (EIP-7702)

[BEBE](https://github.com/Vectorized/bebe) (`0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2`) is a stateless ERC-7821 batch executor designed for EIP-7702 delegation. By signing a 7702 authorization that delegates your EOA to BEBE, you can then send a **single tx to yourself** whose calldata instructs BEBE to run an array of `(to, value, data)` calls as if each were made from your EOA. `msg.sender` inside each inner call is your address, so every `market.claim(...)` authenticates normally.

This batches N claims into **one tx** instead of N sequential txs.

```javascript
const BEBE = "0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2";
const BEBE_ABI = require("./references/bebe-abi.json");
const bebe = new ethers.Interface(BEBE_ABI);
const marketIface = new ethers.Interface(MARKET_ABI);

// ERC-7821 mode: single batch, no opData, revert on failure.
const MODE_SINGLE_BATCH =
  "0x0100000000000000000000000000000000000000000000000000000000000000";

// --- 1) Read all markets' user state in one multicall (see your preferred multicall lib) ---
//     You want the { tokenIds, amounts } per market where otHolding > 0. Skeleton:
async function buildClaimCalls(markets) {
  const calls = [];
  for (const market of markets) {
    const u = await lens.getUserState.staticCall(market, WALLET);
    if (!u.state.isFinalised)
      throw new Error(`Market not finalised: ${market}`);
    const tokenIds = [],
      amounts = [];
    for (let i = 0; i < u.ots.length; i++) {
      if (u.ots[i].otHolding > 0n) {
        tokenIds.push(BigInt(i));
        amounts.push(u.ots[i].otHolding);
      }
    }
    if (tokenIds.length === 0) continue;
    calls.push({
      to: market,
      value: 0n,
      data: marketIface.encodeFunctionData("claim", [
        WALLET,
        tokenIds,
        amounts,
      ]),
    });
  }
  return calls;
}

// --- 2) ABI-encode the Call[] array as ERC-7821 executionData ---
const calls = await buildClaimCalls([marketA, marketB, marketC]);
const executionData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(address to, uint256 value, bytes data)[]"],
  [calls],
);

// --- 3) Build the BEBE.execute(mode, executionData) calldata ---
const bebeCalldata = bebe.encodeFunctionData("execute", [
  MODE_SINGLE_BATCH,
  executionData,
]);

// --- 4) Sign the EIP-7702 authorization (delegating your EOA to BEBE) ---
//     ethers v6: wallet.authorize({ address, nonce? }) -> AuthorizationLike
const auth = await wallet.authorize({ address: BEBE });

// --- 5) Send a tx to SELF with authorizationList + the BEBE calldata ---
const tx = await wallet.sendTransaction({
  to: WALLET,
  data: bebeCalldata,
  authorizationList: [auth],
});
const receipt = await tx.wait();
console.log("Batched claim TX:", receipt.hash);
console.log(
  "⚠ Your EOA is now delegated to BEBE. Run the undelegate flow in 3.13 when done.",
);
```

**What EIP-7702 actually does:** each included authorization sets your EOA's account code to `0xef0100 || <delegate address>`, turning the EOA into a smart account that dispatches calls to BEBE's implementation. The delegation persists on-chain until a new authorization replaces it (including the zero-address "undelegate" one in 3.13). Any _other_ interaction with the EOA after this point (ERC-20 transfers, normal sends) still works — BEBE only adds the `execute` entry point and validation helpers; it does not hijack plain calls.

### 3.13 Undelegate (Clear EIP-7702 Delegation)

Sign an authorization pointing at the zero address and send an empty tx to yourself to restore your EOA to a plain account:

```javascript
const ZERO = "0x0000000000000000000000000000000000000000";
const clearAuth = await wallet.authorize({ address: ZERO });

const tx = await wallet.sendTransaction({
  to: WALLET,
  data: "0x",
  authorizationList: [clearAuth],
});
await tx.wait();
console.log("Delegation cleared.");
```

Check whether your EOA is currently delegated by reading its code: a delegated EOA returns `0xef0100 || <20-byte delegate>` from `provider.getCode(WALLET)`. A fresh EOA returns `"0x"`.

### Function Reference

**Router (user-facing):**

| Function                                                                 | Purpose                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `swapSimple(market, receiver, tokenId, SwapParams, dataSwap, dataGuess)` | Buy (`isMint: true`) or sell (`isMint: false`). USDT is pulled via pre-set ERC-20 allowance — no separate transfer op needed. |
| `multicall(Call[])`                                                      | Batch multiple Router ops atomically (advanced; not required for basic buy/sell)                                              |
| `controller()`                                                           | Returns Factory address                                                                                                       |

> The V1 `claimAllSimple` / `claimSimple` router helpers exist but require `market.setOperator(ROUTER, true)` so the Router can burn your OT. The current script bypasses them and calls `market.claim(...)` **directly** — no operator approval, no Router involvement. Prefer the direct path.

**Factory (read-only for traders):**

| Function                      | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `getConfig(market)`           | feeRate, numOutcomes, endTime, answer, isFinalised |
| `isMarket(market)`            | Verify address is a real market                    |
| `getQuestion(questionId)`     | Title, description, outcome names                  |
| `getOutcomeNames(questionId)` | Array of outcome name strings                      |
| `isFinalised(questionId)`     | Whether resolution is final                        |

**Curve (pricing):**

| Function                                                     | Purpose                              |
| ------------------------------------------------------------ | ------------------------------------ |
| `calMarginalPrice(market, tokenId)`                          | Current price per OT                 |
| `calOtDeltaByMintCost(market, tokenId, collateral, "0x")`    | OT you'd get for X USDT              |
| `calMintCostByOtDelta(market, tokenId, otDelta, "0x")`       | USDT cost for X OT                   |
| `calRedeemValueByOtDelta(market, tokenId, otDelta, "0x")`    | USDT from selling X OT               |
| `calOtDeltaByRedeemValue(market, tokenId, collateral, "0x")` | OT to sell for X USDT                |
| `readMarketState(market, tokenId)`                           | Full state: otCurrent, tick, feeRate |
| `tick()`                                                     | Minimum OT increment (0.01e18)       |

**All `bytes` params in Curve functions: always pass `"0x"` (empty bytes).**

### ABI Files

Full JSON ABIs are in the `references/` directory. Regenerate `references/abis.ts` with `bun scripts/gen-abis.ts` after any change:

- `references/router-abi.json` — Router V1 (`swapSimple`, `multicall`, `controller`)
- `references/router-v2-abi.json` — Router V2 (new `swap` entry; not used by the current script)
- `references/factory-abi.json` — Factory (market registry, `getConfig`, `getOutcomeNames`, `isMarket`)
- `references/curve-abi.json` — Curve (pricing, `calMarginalPrice`, `calMintCostByOtDelta`, `calRedeemValueByOtDelta`)
- `references/lens-abi.json` — Lens V1 (**legacy**; do not use)
- `references/lens-v2-abi.json` — **Lens V2** (`simulateMint/Redeem` with `integratorFeeBps`, `simulateMints/Redeems`, `getUserState`, `snapshotMarket/Ot`)
- `references/market-abi.json` — Market / ERC-6909 (`balanceOf(owner,id)`, `approve(spender,id,amount)`, `allowance(owner,spender,id)`, `setOperator`, `claim(receiver,tokenIds[],otToBurn[])`)
- `references/market-v2-abi.json` — Market V2 (same ERC-6909 surface; `claim` signature unchanged)
- `references/bebe-abi.json` — BEBE (`execute(bytes32 mode, bytes executionData)` + ERC-1271 `isValidSignature`)

### Ready-to-Use Script

`scripts/trade.ts` is the current CLI (bun + viem + TypeScript):

```
bun scripts/trade.ts                                       # wallet status + delegation check
bun scripts/trade.ts info <market>                         # market details + all outcome prices
bun scripts/trade.ts quote <market> <tokenId> [usdt]       # price quote (uses Lens V2)
bun scripts/trade.ts buy <market> <tokenId> <usdt> [slip%] # buy outcome tokens
bun scripts/trade.ts sell <market> <tokenId> <amt> [slip%] # sell outcome tokens
bun scripts/trade.ts claim <market> [market2 ...]          # claim per-market (N sequential txs)
bun scripts/trade.ts bebe-claim <market> [market2 ...]     # batch claim via BEBE/EIP-7702 (1 tx)
bun scripts/trade.ts undelegate                            # clear EIP-7702 delegation
bun scripts/trade.ts portfolio <market>                    # show positions (+ claimable)
```

Configure via environment variables: `BSC_PRIVATE_KEY` (required — wallet address is derived), `BSC_RPC` (optional override), `INTEGRATOR_ADDRESS` (optional), `INTEGRATOR_FEE_BPS` (optional, any value > 0 requires `INTEGRATOR_ADDRESS`; 100 bps = 1%).

---

## 4. Critical Pitfalls

### 1. USDT has 18 decimals on BSC (NOT 6)

On Ethereum USDT has 6 decimals. On BSC it has **18**. Always use `ethers.parseUnits(amount, 18)`.

### 2. dataGuess encoding differs for buy vs sell

- `dataSwap`: **always `"0x"`** for both buy and sell.
- `dataGuess` for **buys (mint)**: pass an **ABI-encoded** `(uint256 guess, uint256 maxIter, uint256 eps)` tuple (see 3.6b). Seeding with the Lens simulation's `otToUser` lets the on-chain Newton's method converge in far fewer iterations. Passing `"0x"` can work for small/symmetric trades but may revert with `GuessInvalidDataLength` on others.
- `dataGuess` for **sells (redeem)**: **MUST be `"0x"`** — redeem is closed-form. Passing an encoded guess reverts with `GuessInvalidDataLength`.

### 3. OT amounts must be tick-aligned

Tick = `0.01e18`. The `calOtDeltaByMintCost` function returns tick-aligned values automatically.

### 4. Buy is a single direct `router.swapSimple` call

The Router pulls USDT via your ERC-20 allowance. You do **not** need `multicall` + `erc20TransferFromInitiator` for a basic buy. The old two-op pattern is legacy; prefer direct `swapSimple`.

### 5. Sell is a single direct `router.swapSimple` call

Plus a one-time per-tokenId ERC-6909 `approve(ROUTER, tokenId, amount)` so the Router can burn your OT.

### 6. gasLimit should be ~800000

Bonding curve math is gas-intensive. Default estimation may undercount.

### 7. BSC public RPCs rate-limit getLogs

Use the REST API (Section 2) for market discovery instead of scanning events on-chain.

### 8. tokenId 0 often has zero supply

Active outcomes typically start at tokenId 1. Token 0 is a default/null state.

### 9. Address checksum enforcement

ethers.js v6 enforces EIP-55. Fix with `ethers.getAddress(addr.toLowerCase())`.

### 10. Use slippage protection in production

Set `minOutOrMaxIn` in SwapParams to protect against price movement and sandwich attacks.

### 11. Selling needs ERC-6909 `approve`; direct claiming needs nothing

- **Sell:** call `market.approve(ROUTER, tokenId, maxUint256)` once per tokenId — the Router burns OT on your behalf.
- **Direct claim:** `market.claim(receiver, tokenIds[], otToBurn[])` is called **by the owner on their own OTs**.
- **BEBE batch claim (EIP-7702):** no approvals either

### 12. Use Lens V2 for simulations, not Curve directly

Lens V2 (`0xc936813410B0c157324D39EDc18062FE5E2C8189`) exposes `simulateMint` / `simulateRedeem` (with a trailing `integratorFeeBps` arg — pass `0` if you are not applying fees) and `getUserState` for per-user aggregation. Seed on-chain execution with the simulation's `otToUser` via an encoded `dataGuess` (buys only) to save gas.

---

## 5. (Optional) 0x Swap API — Token Swaps on BSC

Use [0x](https://0x.org) to swap any BSC tokens (e.g., BNB ↔ USDT) with DEX-aggregated best prices.

### When to Use

- Convert BNB to USDT for prediction market trading
- Swap between any BEP-20 tokens
- Get best price across PancakeSwap, SushiSwap, and 150+ DEXes

### Setup

1. Get API key at [dashboard.0x.org](https://dashboard.0x.org/create-account)
2. Required headers: `0x-api-key: YOUR_KEY` and `0x-version: v2`

### Get a Price Quote

```bash
curl "https://api.0x.org/swap/allowance-holder/price?\
chainId=56&\
sellToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&\
buyToken=0x55d398326f99059fF775485246999027B3197955&\
sellAmount=10000000000000000&\
taker=0xYOUR_WALLET" \
  -H "0x-api-key: YOUR_KEY" \
  -H "0x-version: v2"
```

### Execute a Swap

```bash
# 1. Get executable quote
curl "https://api.0x.org/swap/allowance-holder/quote?..." \
  -H "0x-api-key: YOUR_KEY" -H "0x-version: v2"

# 2. Response includes a `transaction` object with to, data, value, gas
# 3. Approve AllowanceHolder (0x0000000000001fF3684f28c67538d4D072C22734)
# 4. Sign and submit the transaction
```

### Key Details

| Item                | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| **Base URL**        | `https://api.0x.org`                                     |
| **BSC chain ID**    | `56`                                                     |
| **AllowanceHolder** | `0x0000000000001fF3684f28c67538d4D072C22734`             |
| **Rate limit**      | 5 RPS (free tier)                                        |
| **Native token**    | Use `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` for BNB |
| **Cross-chain**     | Private beta only — same-chain swaps only                |

---

## 6. (Optional) Privy — Managed Wallets & Gas Sponsorship

Use [Privy](https://privy.io) for secure managed wallets instead of raw private keys. Keys are secured in TEEs and never exposed. Supports policy guardrails (spending limits, contract allowlists).

### Option A: Agent CLI (Simple)

Best for quick setup — no API keys needed, login via browser.

**Install:**

```bash
npm install -g @privy-io/agent-wallet-cli
```

**Login (two-step):**

```bash
# Step 1: Initiate — opens browser URL for authentication
npx @privy-io/agent-wallet-cli login --non-interactive

# Step 2: User authenticates in browser, copies JSON credentials, then:
npx @privy-io/agent-wallet-cli login --non-interactive '{"ethereum":{"wallet_id":"...","address":"0x..."},"solana":{"wallet_id":"...","address":"..."}}'
```

**List wallets:**

```bash
npx @privy-io/agent-wallet-cli list-wallets
```

**Send a BSC transaction:**

```bash
npx @privy-io/agent-wallet-cli rpc --json '{
  "method": "eth_sendTransaction",
  "caip2": "eip155:56",
  "params": {
    "transaction": {
      "to": "0xCONTRACT_ADDRESS",
      "value": "0x0",
      "data": "0xCALLDATA_HERE"
    }
  }
}'
```

**Session info:**

- Stored at `~/.privy/session.json` (encrypted)
- Expires after **7 days** — re-login needed
- Backup: `cp ~/.privy/session.json ~/.privy/session.backup.json`

### Option B: Server Wallets API (Full Control)

Best for production — full policy enforcement, gas sponsorship, programmatic access.

**Setup:**

1. Create account at [dashboard.privy.io](https://dashboard.privy.io)
2. Get **App ID** and **App Secret**

**Create a wallet:**

```bash
curl -X POST "https://api.privy.io/v1/wallets" \
  -u "YOUR_APP_ID:YOUR_APP_SECRET" \
  -H "privy-app-id: YOUR_APP_ID" \
  -H "Content-Type: application/json" \
  -d '{"chain_type": "ethereum"}'
```

**Send a transaction:**

```bash
curl -X POST "https://api.privy.io/v1/wallets/WALLET_ID/rpc" \
  -u "YOUR_APP_ID:YOUR_APP_SECRET" \
  -H "privy-app-id: YOUR_APP_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "eth_sendTransaction",
    "caip2": "eip155:56",
    "params": {
      "transaction": {
        "to": "0x88888888338e60bfB4657187169cFFa5c8640E42",
        "value": "0x0",
        "data": "0xMULTICALL_DATA"
      }
    }
  }'
```

### Gas Sponsorship (Pay Gas with USDT, No BNB Needed)

With gas sponsorship enabled, Privy's paymaster covers BNB gas fees — your wallet only needs USDT.

**Setup:**

1. Go to [dashboard.privy.io](https://dashboard.privy.io) → your app
2. Open the **Gas Sponsorship** tab
3. Enable sponsorship and select **BNB Smart Chain**
4. Add gas credits (deposit funds)
5. Note: your organization must be **7+ days old**

**Use:** Add `"sponsor": true` to the RPC body:

```bash
curl -X POST "https://api.privy.io/v1/wallets/WALLET_ID/rpc" \
  -u "APP_ID:APP_SECRET" \
  -H "privy-app-id: APP_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "eth_sendTransaction",
    "caip2": "eip155:56",
    "sponsor": true,
    "params": {
      "transaction": {
        "to": "0x88888888338e60bfB4657187169cFFa5c8640E42",
        "value": "0x0",
        "data": "0xMULTICALL_DATA"
      }
    }
  }'
```

The Agent CLI also supports `sponsor`:

```bash
npx @privy-io/agent-wallet-cli rpc --json '{
  "method": "eth_sendTransaction",
  "caip2": "eip155:56",
  "sponsor": true,
  "params": {
    "transaction": { "to": "0x...", "value": "0x0", "data": "0x..." }
  }
}'
```

**Without sponsorship:** Keep ~0.01 BNB in the wallet for gas. Covers 300+ trades.

---

## 7. Monitoring & Alerting

The `scripts/monitor.js` tool provides real-time monitoring of 42 markets with configurable alerts via Slack and/or Telegram.

### What It Monitors

| Monitor              | Description                                               | Default Threshold |
| -------------------- | --------------------------------------------------------- | ----------------- |
| **Price movements**  | Alerts when any outcome token price changes significantly | ±10%              |
| **Volume spikes**    | Detects unusual trading activity on outcomes              | +200% in 1h       |
| **New markets**      | Notifies when new markets appear with volume              | >$100 volume      |
| **Markets ending**   | Warns before a market's trading window closes             | 24h before        |
| **Position PnL**     | Tracks your open positions for profit/loss thresholds     | +50% / -20%       |
| **Resolved markets** | Alerts when markets resolve or finalise                   | Immediate         |
| **Whale trades**     | Detects large trades in the last hour                     | >$500             |

### Usage

```bash
# Single scan (ideal for cron)
node scripts/monitor.js run

# Continuous monitoring (runs every 5 min by default)
node scripts/monitor.js watch

# Check monitor state and recent alerts
node scripts/monitor.js status

# Reset state (start fresh)
node scripts/monitor.js reset
```

### Environment Variables

```bash
# Required for position monitoring
export BSC_WALLET_ADDRESS="0xYOUR_WALLET"

# Alert destinations (one or both)
export SLACK_WEBHOOK="https://hooks.slack.com/services/..."
export TELEGRAM_BOT_TOKEN="your_bot_token"
export TELEGRAM_CHAT_ID="your_chat_id"

# Tuning (all optional)
export MONITOR_INTERVAL=300       # seconds between scans in watch mode
export PRICE_CHANGE_PCT=10        # % price change to alert
export VOLUME_SPIKE_PCT=200       # % volume spike to alert
export PNL_LOSS_PCT=20            # % unrealized loss to alert
export PNL_PROFIT_PCT=50          # % unrealized profit to alert
export NEW_MARKET_MIN_VOL=100     # min $ volume for new market alert
export MARKET_ENDING_HOURS=24     # hours before end to alert
```

### Running as Cron Job

```bash
# Scan every 5 minutes
*/5 * * * * cd /path/to/wenlanbot && node scripts/monitor.js run >> /tmp/42-monitor.log 2>&1
```

### Running as Systemd Service

```ini
# /etc/systemd/system/42-monitor.service
[Unit]
Description=42 Market Monitor
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/wenlanbot/scripts/monitor.js watch
Restart=always
Environment=BSC_WALLET_ADDRESS=0xYOUR_WALLET
Environment=SLACK_WEBHOOK=https://hooks.slack.com/services/...

[Install]
WantedBy=multi-user.target
```

### Alert Format

Alerts are sent with emoji icons for quick scanning:

- 📈 Price movements
- 🔥 Volume spikes
- 🆕 New markets
- ⏰ Markets ending soon
- 💰 Position in profit
- 🔻 Position at loss
- ✅ Market resolved
- 🏁 Market finalised
- 🐋 Whale trades

### State Management

The monitor maintains state in `monitor-state.json` to avoid duplicate alerts:

- Price snapshots for delta calculation
- Known markets to detect new ones
- Alert deduplication keys
- Last 200 alerts for history

State persists across restarts. Use `monitor.js reset` to start fresh.
