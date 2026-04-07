import { network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Deploys a new StakingContract implementation and upgrades the proxy.
 * Proxy address is read from deployments/<network>.json.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade.js --network sepolia
 *
 * Env override (optional):
 *   PROXY_ADDRESS=0x...  — falls back to deployment file
 */

const { ethers } = await network.connect();
const [deployer] = await ethers.getSigners();
console.log("Upgrader:", deployer.address);

const { chainId } = await ethers.provider.getNetwork();
const chainNetworkMap = { 1n: "mainnet", 11155111n: "sepolia", 31337n: "localhost" };
const networkName = chainNetworkMap[chainId] ?? process.env.HARDHAT_NETWORK ?? `chain-${chainId}`;
const deploymentFile = path.resolve("deployments", `${networkName}.json`);

let saved = {};
if (fs.existsSync(deploymentFile)) {
  saved = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  console.log(`Loaded deployment from ${deploymentFile}`);
} else {
  console.warn(`No deployment file at ${deploymentFile} — falling back to env var.`);
}

const proxyAddr = process.env.PROXY_ADDRESS?.trim() || saved.proxy;
if (!proxyAddr) throw new Error("Set PROXY_ADDRESS or run deploy.js first");

// 1. Deploy new implementation
const ImplFactory = await ethers.getContractFactory("StakingContract");
const newImpl = await ImplFactory.deploy();
await newImpl.waitForDeployment();
const newImplAddr = await newImpl.getAddress();
console.log("New implementation deployed:", newImplAddr);

// 2. Upgrade proxy to new implementation
const proxy = ImplFactory.attach(proxyAddr);
const tx = await proxy.connect(deployer).upgradeToAndCall(newImplAddr, "0x");
await tx.wait();
console.log("Proxy upgraded. Tx:", tx.hash);

// 3. Verify the upgrade took effect
const activeImpl = await proxy.implementation();
console.log("Active implementation:", activeImpl);
if (activeImpl.toLowerCase() !== newImplAddr.toLowerCase()) {
  throw new Error("Upgrade verification failed — implementation address mismatch");
}
console.log("Upgrade verified successfully.");

// 4. Update deployments file
const deploymentsDir = path.resolve("deployments");
if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir);
saved.proxy = saved.proxy || proxyAddr;
saved.implementation = newImplAddr;
saved.upgradedAt = new Date().toISOString();
const outFile = path.join(deploymentsDir, `${networkName}.json`);
fs.writeFileSync(outFile, JSON.stringify(saved, null, 2));
console.log(`${outFile} updated.`);

console.log(`
Summary:
  Proxy (unchanged):       ${proxyAddr}
  Old implementation:      (see git history)
  New implementation:      ${newImplAddr}

Next: run verify.js to verify the new implementation on Etherscan.
`);
