# StakingContract

Multi-plan ERC20 staking: each stake is a separate **position** with its own lock end, APR, and reward accounting. The contract is bound to **one** staking token (set in the constructor, `immutable` for cheap reads). Admins configure plans; rewards are paid in that same token.

## Architecture

| Piece | Role |
|--------|------|
| `StakingContract.sol` | Core logic: plans, per-user stake lists, `claimReward`, `unstake`, `depositRewards` |
| `contracts/mocks/MockERC20.sol` | Test / local token with `mint` — optional deploy via `DEPLOY_MOCK_TOKEN` |
| `scripts/deploy.js` | Deploy ERC20 (optional mock), then `StakingContract(stakingToken)`; optional example plans |

**Token**: `IERC20 public immutable stakingToken` — single ERC20 for principal and rewards.

**Plans** (`struct Plan`): lock duration (`period` in seconds), `apr` as whole percent (e.g. `10` = 10%), `penalty` (0–100) on the **reward** portion at early `unstake`. Plans are identified by id `0 … nextPlanId - 1`; there is no plan deletion.

**Positions** (`struct Stake`): one row per `createStake` — `planId`, `amount`, `startTime`, `endTime`, `lastClaimTime`, `staker`. Stakes are indexed by user via `_stakesByUser` (`getStakeIdsByUser`, `getStakeCountByUser`, `getStakesByUser`).

**Access control**: OpenZeppelin `Ownable` for admin functions; `ReentrancyGuard` on user entrypoints (`createStake`, `claimReward`, `unstake`).

**Reward liquidity**: The contract does not mint rewards. The owner must `depositRewards(amount)` (after `approve`) so `claimReward` / `unstake` transfers succeed.

View functions are declared **after** state-changing logic in the contract source.

## Reward formula

Accrual uses elapsed time since `lastClaimTime`, capped at `endTime` (lock end):

\[
\text{reward} = \frac{\text{principal} \times \text{APR} \times \text{elapsed}}{100 \times \text{YEAR}}
\]

- `APR` is a whole number percent (8 means 8%).
- `YEAR = 365 days` (Solidity `365 days`).

On **early** `unstake` (`block.timestamp < endTime`), the contract pays:

\[
\text{reward} = \left\lfloor \frac{\text{principal} \times \text{APR} \times (\text{now} - \text{lastClaimTime})}{100 \times \text{YEAR}} \right\rfloor \times \frac{100 - \text{penalty}}{100}
\]

`claimReward` before lock end pays the **uncapped** formula (no penalty). Penalty applies only to rewards settled at **early** `unstake`. `pendingReward` does not include the early-unstake penalty.

## Key assumptions

1. **Decimals**: The formula is token-decimal agnostic; APR is applied to the raw `amount` units. Treat amounts as consistent with your token’s decimals.
2. **Solvency**: There is no on-chain check that the contract holds enough ERC20 to cover all pending rewards.
3. **Plan changes**: `updatePlan` affects **existing** open stakes on that `planId` (APR/period/penalty read from storage on each interaction).

## Prerequisites

- Node.js 18+ (for native ESM / top-level `await` in tests and scripts)

## Install

```bash
npm install
```

## Compile

```bash
npx hardhat compile
```

## Test

```bash
npx hardhat test
```

That uses Hardhat’s **in-process** network (nothing listens on a port; the chain is discarded when the process exits).

### Tests against a local JSON-RPC node

To hit a **persistent local testnet** (same as `deploy --network localhost`):

**Terminal A** — start the node (default `http://127.0.0.1:8545`, matches `hardhat.config.js` → `localhost`):

```bash
npx hardhat node
```

**Terminal B** — run the suite against that RPC:

```bash
npx hardhat test --network localhost
```

You can combine with Mocha filters, for example:

```bash
npx hardhat test --network localhost --grep Admin
```

Tests use Hardhat 3 with Mocha, `ethers` v6, and `@nomicfoundation/hardhat-network-helpers` (`loadFixture`, `time.increase`). Assertions allow a small time slack because the reward view and the executing transaction can fall on adjacent blocks.

## Deploy

The script deploys the staking token (unless `STAKING_TOKEN` is set), then `new StakingContract(stakingToken)`. **You must supply a token**: either `STAKING_TOKEN` or `DEPLOY_MOCK_TOKEN=true`.

| Variable | Effect |
|----------|--------|
| `STAKING_TOKEN` | Existing ERC20 address passed to the `StakingContract` constructor |
| `DEPLOY_MOCK_TOKEN` | If `true` / `1` and `STAKING_TOKEN` is unset, deploy `MockERC20` first (local / dev only) |
| `SETUP_EXAMPLE_PLANS` | If `true` / `1`, add four plans: 30d @ 8%, 90d @ 12%, 180d @ 16%, 365d @ 20% APR |
| `EARLY_PENALTY_PERCENT` | Used with `SETUP_EXAMPLE_PLANS` (default `50`); must be 0–100 |

On **Ethereum mainnet**, `DEPLOY_MOCK_TOKEN` is rejected by the script (use a real `STAKING_TOKEN`).

**Default in-process network** (state is not persisted after the process exits):

```bash
set DEPLOY_MOCK_TOKEN=true
npx hardhat run scripts/deploy.js
```

**Local JSON-RPC node** (terminal A: `npx hardhat node`; default port `8545`):

```bash
set DEPLOY_MOCK_TOKEN=true
set SETUP_EXAMPLE_PLANS=true
npx hardhat run scripts/deploy.js --network localhost
```

**Sepolia** (only if `SEPOLIA_RPC_URL` and `SEPOLIA_PRIVATE_KEY` are set — see `hardhat.config.js`):

```bash
set SEPOLIA_RPC_URL=https://...
set SEPOLIA_PRIVATE_KEY=0x...
set STAKING_TOKEN=0x...
npx hardhat run scripts/deploy.js --network sepolia
```

**Ethereum mainnet** (only if `MAINNET_RPC_URL` and `MAINNET_PRIVATE_KEY` are set in `hardhat.config.js`):

Use a dedicated deployer key with enough ETH for gas. Never commit keys or put them in the repo.

```bash
set MAINNET_RPC_URL=https://...
set MAINNET_PRIVATE_KEY=0x...
set STAKING_TOKEN=0x...your_production_erc20...
npx hardhat run scripts/deploy.js --network mainnet
```

Add plans in the same run if you intend to:

```bash
set SETUP_EXAMPLE_PLANS=true
```

Review APRs, lock lengths, and penalties before enabling `SETUP_EXAMPLE_PLANS` on mainnet; they are real economic parameters. After deploy, verify the contract (e.g. Hardhat verify / Etherscan) and transfer `Ownable` to a multisig if required.

(Use `export` instead of `set` on Unix shells.)

After deploy, the owner must fund rewards: `approve(staking, amount)` then `depositRewards(amount)`.

## Hardhat config

This repo targets **Hardhat 3** and uses `@nomicfoundation/hardhat-toolbox-mocha-ethers` (not the deprecated `hardhat-toolbox` `latest` package, which does not load under Hardhat 3). Optional networks in `hardhat.config.js`: `localhost`, `sepolia` (`SEPOLIA_RPC_URL` + `SEPOLIA_PRIVATE_KEY`), and `mainnet` (`MAINNET_RPC_URL` + `MAINNET_PRIVATE_KEY`, `chainId: 1`).
