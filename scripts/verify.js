import { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Reads addresses from deployments/<network>.json written by deploy.js.
 *
 * Usage:
 *   npx hardhat run scripts/verify.js --network sepolia
 *
 * Env overrides (optional — falls back to deployment file):
 *   PROXY_ADDRESS, IMPL_ADDRESS, STAKING_TOKEN, PROXY_OWNER, MOCK_TOKEN_ADDRESS
 */

const networkName = process.env.HARDHAT_NETWORK ?? "unknown";
const deploymentFile = path.resolve("deployments", `${networkName}.json`);

let saved = {};
if (fs.existsSync(deploymentFile)) {
  saved = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  console.log(`Loaded deployment from ${deploymentFile}`);
} else {
  console.warn(`No deployment file found at ${deploymentFile} — falling back to env vars.`);
}

const { ethers } = await network.connect();
const [deployer] = await ethers.getSigners();

const proxyAddr     = process.env.PROXY_ADDRESS?.trim()       || saved.proxy;
const implAddr      = process.env.IMPL_ADDRESS?.trim()        || saved.implementation;
const tokenAddr     = process.env.STAKING_TOKEN?.trim()       || saved.stakingToken;
const ownerAddr     = process.env.PROXY_OWNER?.trim()         || saved.owner || deployer.address;
const mockTokenAddr = process.env.MOCK_TOKEN_ADDRESS?.trim()  || saved.mockToken || null;

if (!proxyAddr) throw new Error("Set PROXY_ADDRESS or run deploy.js first");
if (!implAddr)  throw new Error("Set IMPL_ADDRESS or run deploy.js first");
if (!tokenAddr) throw new Error("Set STAKING_TOKEN or run deploy.js first");

// 1. Verify MockERC20 (no constructor args — constructor only calls _mint internally)
if (mockTokenAddr) {
  console.log("\nVerifying MockERC20:", mockTokenAddr);
  await verifyContract({ address: mockTokenAddr, constructorArgs: [] }, hre);
  console.log("MockERC20 verified.");
} else {
  console.log("\nNo mockToken in deployment — skipping MockERC20 verification.");
}

// 2. Verify implementation (no constructor args)
console.log("\nVerifying implementation:", implAddr);
await verifyContract({ address: implAddr, constructorArgs: [] }, hre);
console.log("Implementation verified.");

// 3. Verify proxy — constructor(address implementation, bytes memory _data)
const ImplFactory = await ethers.getContractFactory("StakingContract");
const initData = ImplFactory.interface.encodeFunctionData("initialize", [tokenAddr, ownerAddr]);

console.log("\nVerifying proxy:", proxyAddr);
await verifyContract(
  { address: proxyAddr, constructorArgs: [implAddr, initData] },
  hre,
);
console.log("Proxy verified.");

const explorer = networkName === "mainnet"
  ? `https://etherscan.io/address/${proxyAddr}#code`
  : `https://${networkName}.etherscan.io/address/${proxyAddr}#code`;
console.log(`\nView on Etherscan: ${explorer}`);
