import { network } from "hardhat";
import fs from "fs";
import path from "path";

function envBool(name) {
  const v = process.env[name];
  return v === "1" || v?.toLowerCase() === "true";
}

const { ethers } = await network.connect();

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
let mockTokenAddr = null;
if (!tokenAddr && envBool("DEPLOY_MOCK_TOKEN")) {
  const mock = await ethers.deployContract("MockERC20", deployer);
  await mock.waitForDeployment();
  mockTokenAddr = await mock.getAddress();
  tokenAddr = mockTokenAddr;
  console.log("MockERC20 (test token):", tokenAddr);
}

if (!tokenAddr) {
  throw new Error(
    "Set STAKING_TOKEN to the ERC20 address, or DEPLOY_MOCK_TOKEN=true for local/dev.",
  );
}

const ownerAddr = process.env.PROXY_OWNER?.trim() || deployer.address;

const ImplFactory = await ethers.getContractFactory("StakingContract");
const impl = await ImplFactory.deploy();
await impl.waitForDeployment();
const implAddr = await impl.getAddress();
console.log("StakingContract implementation:", implAddr);

const initData = ImplFactory.interface.encodeFunctionData("initialize", [tokenAddr, ownerAddr]);

const ProxyFactory = await ethers.getContractFactory("StakingERC1967Proxy");
const proxy = await ProxyFactory.deploy(implAddr, initData);
await proxy.waitForDeployment();
const proxyAddr = await proxy.getAddress();

const staking = ImplFactory.attach(proxyAddr);
console.log("StakingContract proxy (use this address):", proxyAddr);
console.log("Staking token:", tokenAddr);
console.log("Owner (Ownable / upgrades / pause):", ownerAddr);

// Save deployment info to deployments/<network>.json
const chainNetworkMap = { 1n: "mainnet", 11155111n: "sepolia", 31337n: "localhost" };
const networkName = chainNetworkMap[chainId] ?? process.env.HARDHAT_NETWORK ?? `chain-${chainId}`;
const deploymentsDir = path.resolve("deployments");
if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir);
const deploymentFile = path.join(deploymentsDir, `${networkName}.json`);
const deploymentData = {
  network: networkName,
  chainId: chainId.toString(),
  deployedAt: new Date().toISOString(),
  deployer: deployer.address,
  proxy: proxyAddr,
  implementation: implAddr,
  stakingToken: tokenAddr,
  mockToken: mockTokenAddr,   // null if a real token was used
  owner: ownerAddr,
};
fs.writeFileSync(deploymentFile, JSON.stringify(deploymentData, null, 2));
console.log(`Deployment saved to ${deploymentFile}`);

if (envBool("SETUP_EXAMPLE_PLANS")) {
  if (ownerAddr.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(
      "SETUP_EXAMPLE_PLANS skipped: PROXY_OWNER differs from deployer — add plans manually as owner.",
    );
  } else {
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
      const tx = await staking.connect(deployer).addPlan(days, apr, penalty);
      await tx.wait();
      console.log(`Plan added: ${days} days, ${apr}% APR, ${penalty}% early penalty on rewards`);
    }
  }
} else {
  console.log("Example plans skipped — set SETUP_EXAMPLE_PLANS=true to add 30/90/180/365 day tiers.");
}

console.log(`
UUPS: owner calls upgradeToAndCall(newImplementation, data) on the proxy to upgrade.
Pause: owner calls pause() / unpause(); createStake and unstake respect whenNotPaused.
Next steps:
  • addPlan / updatePlan as needed (owner)
  • Approve proxy, then depositRewards(amount)
  • Users: approve proxy + createStake(planId, amount)
`);
