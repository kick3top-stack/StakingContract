# StakingContract

Multi-plan ERC20 staking: each stake is a separate **position** with its own lock end, APR, and reward accounting. Admins configure plans and whitelisted staking tokens; rewards are paid in the same token as the stake.

## Architecture

| Piece | Role |
|--------|------|
| `StakingContract.sol` | Core logic: plans, stakes, `claimReward`, `unstake`, `depositRewards` |
| `contracts/mocks/MockERC20.sol` | Test-only ERC20 with `mint` (not used on mainnet) |

**Plans** (`struct Plan`): lock duration (`period` in seconds), `apr` as whole percent (e.g. `10` = 10%), `penalty` (0–100) applied to the **reward** on early `unstake`, and `active` (soft-delete via `deletePlan`).

**Positions** (`struct Stake`): one row per `createStake` — `planId`, `token`, `amount`, `startTime`, `endTime`, `lastClaimTime`, `staker`, etc. A user may hold many stakes across plans and time.

**Access control**: OpenZeppelin `Ownable` for admin functions; `ReentrancyGuard` on user entrypoints.

**Reward liquidity**: The contract does not mint rewards. The owner must `depositRewards` with the same ERC20 so `claimReward` / `unstake` transfers succeed.

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
4. **Supported tokens**: Only `addToken` addresses may be staked; staking pulls principal via `safeTransferFrom`.
5. **Soft-deleted plans**: `deletePlan` blocks new stakes and `getPlan`; existing stakes still unwind using stored plan parameters.

## Prerequisites

- Node.js 18+ (for native ESM / top-level `await` in tests)

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

Tests use Hardhat 3 with Mocha, `ethers` v6, and `@nomicfoundation/hardhat-network-helpers` (`loadFixture`, `time.increase`). Assertions allow a small time slack because the reward view and the executing transaction can fall on adjacent blocks.

## Deploy (manual outline)

1. Deploy `StakingContract` (no constructor arguments beyond `Ownable` setting `msg.sender` as owner).
2. Call `addToken` for each ERC20 users may stake.
3. Call `addPlan(days, aprPercent, penaltyPercent)` for each product tier.
4. Transfer reward budget to the contract (e.g. `ERC20.transfer`) and/or use `depositRewards` after approving the staking contract.

For production, add a verified deployment script or Ignition module and document your network RPC and addresses.

## Hardhat config

This repo targets **Hardhat 3** and uses `@nomicfoundation/hardhat-toolbox-mocha-ethers` (not the deprecated `hardhat-toolbox` `latest` package, which does not load under Hardhat 3).
