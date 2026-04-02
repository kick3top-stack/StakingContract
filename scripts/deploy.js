import { network } from "hardhat";

const { ethers } = await network.connect();

function envBool(name) {
  const v = process.env[name];
  return v === "1" || v?.toLowerCase() === "true";
}

const { chainId } = await ethers.provider.getNetwork();
const isMainnet = chainId === 1n;

const [deployer] = await ethers.getSigners();
console.log("Deployer:", deployer.address);
if (isMainnet) {
  console.log("Network: Ethereum mainnet (chainId 1)");
}

if (isMainnet && envBool("DEPLOY_MOCK_TOKEN")) {
  throw new Error(
    "DEPLOY_MOCK_TOKEN is not allowed on mainnet. Set STAKING_TOKEN to your production ERC20 address.",
  );
}

let tokenAddr = process.env.STAKING_TOKEN?.trim();
if (!tokenAddr && envBool("DEPLOY_MOCK_TOKEN")) {
  const mock = await ethers.deployContract("MockERC20", deployer);
  await mock.waitForDeployment();
  tokenAddr = await mock.getAddress();
  console.log("MockERC20 (test token):", tokenAddr);
}

if (!tokenAddr) {
  throw new Error(
    "Set STAKING_TOKEN to the ERC20 address, or DEPLOY_MOCK_TOKEN=true for local/dev.",
  );
}

const staking = await ethers.deployContract("StakingContract", [tokenAddr], deployer);
await staking.waitForDeployment();
const stakingAddr = await staking.getAddress();
console.log("StakingContract:", stakingAddr);
console.log("Staking token (immutable):", tokenAddr);

if (envBool("SETUP_EXAMPLE_PLANS")) {
  const penalty = Number(process.env.EARLY_PENALTY_PERCENT ?? "50");
  if (penalty < 0 || penalty > 100) {
    throw new Error("EARLY_PENALTY_PERCENT must be 0–100");
  }
  const tiers = [
    [30, 8],
    [90, 12],
    [180, 16],
    [365, 20],
  ];
  for (const [days, apr] of tiers) {
    const tx = await staking.addPlan(days, apr, penalty);
    await tx.wait();
    console.log(`Plan added: ${days} days, ${apr}% APR, ${penalty}% early penalty on rewards`);
  }
} else {
  console.log("Example plans skipped — set SETUP_EXAMPLE_PLANS=true to add 30/90/180/365 day tiers.");
}

console.log(`
Next steps (owner):
  • addPlan / updatePlan as needed
  • Approve staking contract, then depositRewards(amount) to fund reward payouts
  • Users: approve + createStake(planId, amount)
`);
