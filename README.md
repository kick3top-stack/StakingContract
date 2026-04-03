# StakingContract

Multi-plan ERC20 staking: each stake is a separate **position** with its own lock end, APR, and reward accounting. The **implementation** is **UUPS upgradeable** and **pausable**; users interact with the **ERC-1967 proxy** address (constant for your app). One staking token is set in `initialize`.


## Architecture

| Piece | Role |
|-------|------|
| `StakingContract.sol` | Upgradeable implementation: `OwnableUpgradeable` + `PausableUpgradeable` + `UUPSUpgradeable`; `initialize(token, owner)`; `pause` / `unpause`; `upgradeToAndCall` (owner) |
| `contracts/proxy/StakingERC1967Proxy.sol` | Thin `ERC1967Proxy` subclass so Hardhat/deploy scripts have an artifact |
> Update this table after each deployment. Always use the **proxy** address for integrations — never the implementation.PLOY_MOCK_TOKEN` |
| `scripts/deploy.js` | Deploy implementation + proxy, `initialize`, optional plans, saves `deployments/<network>.json` |
| `scripts/verify.js` | Verify implementation + proxy on Etherscan, reads addresses from `deployments/<network>.json` |

**Proxy vs implementation**: Integrate wallets and indexers with the **proxy** address. The implementation address can change after an upgrade; read it via `implementation()` on the proxy (or block explorer "Read as proxy").

**Token**: `IERC20 public stakingToken` — set in `initialize` (proxies cannot use `immutable`; treat the token as fixed by product policy).

**Plans** (`struct Plan`): lock duration (`period` in seconds), `apr` as whole percent (e.g. `10` = 10%), `penalty` (0–100) applied to the **reward** portion on early `unstake`. Plans are identified by id `0 … nextPlanId - 1`; there is no plan deletion.

**Positions** (`struct Stake`): one row per `createStake` — `planId`, `amount`, **`apr` / `penalty` (snapshot at open)**, `startTime`, `endTime`, `staker`. Lock end is fixed at open; rewards use the snapshot APR/penalty, not the live plan. Stakes are indexed by user via `_stakesByUser` (`getStakeIdsByUser`, `getStakeCountByUser`, `getStakesByUser`).

**Access control**: `OwnableUpgradeable` — owner upgrades the implementation, pauses, manages plans, and funds rewards.

**Pausable**: `pause()` / `unpause()` are **owner-only**. `createStake` and `unstake` use `whenNotPaused`; `depositRewards`, `addPlan`, `updatePlan`, and pause/unpause still work while paused so you can recover or top up reserves.

**Reentrancy**: OpenZeppelin **`ReentrancyGuard`** (`nonReentrant` on `createStake` / `unstake`). Uses a dedicated EIP-7201 storage slot — safe through an ERC-1967 proxy on OZ v5+.

**Reward liquidity**: The contract does not mint rewards. The owner must `depositRewards(amount)` (after `approve` to the **proxy** address). It is the owner's responsibility to keep reserves funded — if the contract cannot cover a reward at `unstake` time the transaction will revert.

**Upgrades (UUPS)**: Owner calls `upgradeToAndCall(newImplementation, data)` on the **proxy**. New implementations must preserve storage layout (append-only).

## Reward formula

Gross accrual uses staking duration from `startTime` up to `min(now, endTime)`:

```
raw = (principal × APR × elapsed) / (100 × YEAR)
```

- `APR` is a whole-number percent (`8` = 8%).
- `YEAR = 365 days`.

**After lock** (`now >= endTime`): `reward = raw` (full term, no penalty).

**Early unstake** (`now < endTime`): `reward = raw × (100 - penalty) / 100` — penalty applies only to the reward; principal is always returned in full.

**`pendingReward(stakeId)`** returns the **penalty-adjusted** amount — i.e. exactly what the user would receive as reward if they called `unstake` right now. After the lock ends it returns the full gross reward.

## Plan updates vs existing stakes

When a user calls `createStake`, the contract copies the plan's `apr`, `penalty`, and `period` into the position. Later `updatePlan` changes only the **template** for **new** stakes. Open positions keep their original APR, penalty, and lock end.

## Key assumptions

1. **Decimals**: APR is applied to raw `amount` units — consistent with your token's decimals.
2. **Solvency**: There is no on-chain check that reserves cover pending rewards. Keep the contract well-funded — if balance runs dry, `unstake` will revert when trying to pay rewards.
3. **Plan changes**: `updatePlan` affects **new** stakes only. Lock length for an existing position is fixed at `endTime`.

## Prerequisites

- Node.js 18+

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

### Against a local JSON-RPC node

Terminal A:
```bash
npx hardhat node
```

Terminal B:
```bash
npx hardhat test --network localhost
```

## Deploy

After deploy, addresses are saved to `deployments/<network>.json` automatically.

| Variable | Effect |
|----------|--------|
| `STAKING_TOKEN` | ERC20 address passed to `initialize` |
| `DEPLOY_MOCK_TOKEN` | `true` / `1` — deploy `MockERC20` first (local/dev only, blocked on mainnet) |
| `PROXY_OWNER` | Ownable / upgrade / pause owner (defaults to deployer) |
| `SETUP_EXAMPLE_PLANS` | `true` / `1` — add four plans: 30/90/180/365 days |
| `EARLY_PENALTY_PERCENT` | Used with `SETUP_EXAMPLE_PLANS` (default `50`; must be 0–100) |

**Local node** (run `npx hardhat node` first):

```powershell
$env:DEPLOY_MOCK_TOKEN="true"; $env:SETUP_EXAMPLE_PLANS="true"
npx hardhat run scripts/deploy.js --network localhost
```

**Sepolia**:

```powershell
$env:SEPOLIA_RPC_URL="https://sepolia.infura.io/v3/YOUR_KEY"
$env:SEPOLIA_PRIVATE_KEY="0xYOUR_KEY"
$env:STAKING_TOKEN="0xYOUR_ERC20"
$env:SETUP_EXAMPLE_PLANS="true"
npx hardhat run scripts/deploy.js --network sepolia
```

**Mainnet**: same as Sepolia but use `MAINNET_RPC_URL` / `MAINNET_PRIVATE_KEY` and `--network mainnet`. `DEPLOY_MOCK_TOKEN` is rejected on mainnet.

> On Unix use `export VAR=value` instead of `$env:VAR=`.

After deploy, fund rewards before users can stake:
```
approve(<proxyAddress>, amount)   # on the token contract
depositRewards(amount)            # on the proxy
```

### Sepolia testnet Deployment
- Mocktoken: 0x7D72143Ee6A6bb2E710e1Aa3CE19fcFBA3423220
- StakingContract: 0x1A14477D67bFdD5a7CcB46b8433A7Ce495276e43
- Proxy: 0x08c4390bf06080E8775Ed2c5fb5C4E36a465435C

## Verify on Etherscan

Requires an [Etherscan API key](https://etherscan.io/myapikey) and a completed deploy (so `deployments/<network>.json` exists).

Add to `hardhat.config.js` → `verify.etherscan.apiKey` (already wired via `configVariable("ETHERSCAN_API_KEY")`), then:

```powershell
$env:ETHERSCAN_API_KEY="YOUR_KEY"
npx hardhat run scripts/verify.js --network sepolia
```

The script reads proxy and implementation addresses from `deployments/sepolia.json` automatically — no copy-pasting needed. It verifies both contracts and prints the Etherscan link.

### Verify URLs(Sepolia testnet)

- StakingContract.sol   https://sepolia.etherscan.io/address/0x1A14477D67bFdD5a7CcB46b8433A7Ce495276e43#code
- Proxy https://sepolia.etherscan.io/address/0x08c4390bf06080E8775Ed2c5fb5C4E36a465435C#code


## Hardhat config

Targets **Hardhat 3** with `@nomicfoundation/hardhat-toolbox-mocha-ethers`. Networks: `localhost`, `sepolia` (opt-in via env), `mainnet` (opt-in via env). Etherscan verification via `verify.etherscan.apiKey`.
