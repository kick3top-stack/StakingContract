# StakingContract

Multi-plan ERC20 staking: each stake is a separate **position** with its own lock end, APR, and reward accounting. The **implementation** is **UUPS upgradeable** and **pausable**; users interact with the **ERC-1967 proxy** address (constant for your app). One staking token is set in `initialize`.

## Architecture

| Piece | Role |
|--------|------|
| `StakingContract.sol` | Upgradeable implementation: `OwnableUpgradeable` + `PausableUpgradeable` + `UUPSUpgradeable`; `initialize(token, owner)`; `pause` / `unpause`; `upgradeToAndCall` (owner) |
| `contracts/proxy/StakingERC1967Proxy.sol` | Thin `ERC1967Proxy` subclass so Hardhat/deploy scripts have an artifact |
| `contracts/mocks/MockERC20.sol` | Test / local token with `mint` — optional deploy via `DEPLOY_MOCK_TOKEN` |
| `scripts/deploy.js` | Deploy implementation + proxy, `initialize`, optional plans |

**Proxy vs implementation**: Integrate wallets and indexers with the **proxy** address. The implementation address can change after an upgrade; read it via `implementation()` on the proxy (or block explorer “Read as proxy”).

**Token**: `IERC20 public stakingToken` — set in `initialize` (proxies cannot use `immutable`; treat the token as fixed by product policy).

**Plans** (`struct Plan`): lock duration (`period` in seconds), `apr` as whole percent (e.g. `10` = 10%), `penalty` (0–100) on the **reward** portion at early `unstake`. Plans are identified by id `0 … nextPlanId - 1`; there is no plan deletion.

**Positions** (`struct Stake`): one row per `createStake` — `planId`, `amount`, **`apr` / `penalty` (snapshot at open)**, `startTime`, `endTime`, `staker`. Lock end is fixed at open; rewards use the snapshot APR/penalty, not the live plan. Stakes are indexed by user via `_stakesByUser` (`getStakeIdsByUser`, `getStakeCountByUser`, `getStakesByUser`).

**Access control**: `OwnableUpgradeable` — owner upgrades the implementation, pauses, manages plans, and funds rewards.

**Pausable**: `pause()` / `unpause()` are **owner-only**. `createStake` and `unstake` use `whenNotPaused` so emergencies stop new stakes and exits; `depositRewards`, `addPlan`, `updatePlan`, and pause/unpause still work while paused so you can recover or top up rewards.

**Reentrancy**: OpenZeppelin **`ReentrancyGuard`** (`nonReentrant` on `createStake` / `unstake`). It uses a dedicated EIP-7201 storage slot and works through an ERC-1967 proxy (the proxy slot starts unset; the guard only treats `ENTERED` as locked).

**Reward liquidity**: The contract does not mint rewards. The owner must `depositRewards(amount)` (after `approve` to the **proxy** address) so `unstake` can pay rewards. Users only exit via `unstake` (principal + reward in one step).

**Upgrades (UUPS)**: Owner calls `upgradeToAndCall(newImplementation, data)` on the **proxy**. New implementations must preserve storage layout (append-only) and should be checked with OpenZeppelin’s upgrade safety tooling before mainnet.

View functions are declared **after** state-changing logic in the contract source.

## Reward formula

Gross accrual uses staking duration from `startTime` up to `min(now, endTime)`:

\[
\text{raw} = \frac{\text{principal} \times \text{APR} \times \text{elapsed}}{100 \times \text{YEAR}}
\]

- `APR` is a whole number percent (8 means 8%).
- `YEAR = 365 days` (Solidity `365 days`).

On **`unstake` after lock** (`now \geq endTime`): the user receives `reward = raw` (full term).

On **early `unstake`** (`now < endTime`): `reward = raw \times (100 - \text{penalty}) / 100` — penalty applies only to the reward portion; principal is always returned in full.

`pendingReward` is an off-chain helper: it returns **gross** accrual (no early-exit penalty), using the stake’s **snapshot** APR. For an estimate of tokens received when exiting early, apply the stake’s snapshot **penalty** to that gross amount.

## Plan updates vs existing stakes

**Implemented: snapshot-on-stake** — When a user calls `createStake`, the contract copies the plan’s `apr`, `penalty`, and `period` (via `endTime = now + period`) into the position. Later `updatePlan` changes only the **template** used for **new** stakes. Open positions keep their original APR, penalty, and lock end.

**Other approaches (not implemented here)** — useful for product/governance decisions:

| Approach | Idea | Tradeoff |
|----------|------|----------|
| **Snapshot (this repo)** | Store APR/penalty on each stake | +2 storage words per stake; clearest expectations |
| **Retroactive live plan** | Always read `_plans[planId]` | Simpler storage; admin changes affect all open stakes (risky for users) |
| **Versioned plans only** | Never `updatePlan`; add `addPlan` / new id for new economics | Old stakes stay on old plan id; no overwrite ambiguity |
| **Migration** | Admin calls `migrateStake` to move users to new terms | Complex UX; requires user or admin action |

## Key assumptions

1. **Decimals**: The formula is token-decimal agnostic; APR is applied to the raw `amount` units. Treat amounts as consistent with your token’s decimals.
2. **Solvency**: There is no on-chain check that the contract holds enough ERC20 to cover all pending rewards.
3. **Plan changes**: `updatePlan` affects **new** stakes only; **APR/penalty** on existing stakes come from the snapshot at `createStake`. **Lock length** for an existing position is fixed (`endTime`); changing the plan’s `period` does not extend or shorten an already-open stake.

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

The suite (`test/StakingContract.js`) covers **proxy + `initialize`** (zero token/owner, double init, implementation pointer), **`addPlan` / `updatePlan` / `getPlan`** validation and snapshots, **`depositRewards`** access and allowance failures, **`Pausable`** (owner-only, double pause/unpause, user vs admin paths while paused), **`createStake` / `unstake`** validation, ERC-20 failures, insolvency on reward payout, penalty **0%** and **100%**, multi-user stakes, middle unstake index hygiene, **UUPS** upgrade auth and successful upgrade with state preserved, events, and reward math with small time slack where the VM advances time between txs.

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
| `STAKING_TOKEN` | ERC20 address passed to `initialize` on the proxy |
| `DEPLOY_MOCK_TOKEN` | If `true` / `1` and `STAKING_TOKEN` is unset, deploy `MockERC20` first (local / dev only) |
| `PROXY_OWNER` | Optional `Ownable` / upgrade / pause owner (defaults to deployer). If different from deployer, example plans are skipped |
| `SETUP_EXAMPLE_PLANS` | If `true` / `1`, add four plans (only when `PROXY_OWNER` equals deployer) |
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

After deploy, the owner must fund rewards: `approve(<proxyAddress>, amount)` then `depositRewards(amount)` on the **proxy**.

**Approve / stake against the proxy**, not the implementation address.

## Hardhat config

This repo targets **Hardhat 3** and uses `@nomicfoundation/hardhat-toolbox-mocha-ethers` (not the deprecated `hardhat-toolbox` `latest` package, which does not load under Hardhat 3). Optional networks in `hardhat.config.js`: `localhost`, `sepolia` (`SEPOLIA_RPC_URL` + `SEPOLIA_PRIVATE_KEY`), and `mainnet` (`MAINNET_RPC_URL` + `MAINNET_PRIVATE_KEY`, `chainId: 1`).
