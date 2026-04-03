import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

const sepoliaRpc = process.env.SEPOLIA_RPC_URL;
const sepoliaKey = process.env.SEPOLIA_PRIVATE_KEY;
const mainnetRpc = process.env.MAINNET_RPC_URL;
const mainnetKey = process.env.MAINNET_PRIVATE_KEY;

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    version: "0.8.28",
  },
  networks: {
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
      chainType: "l1",
    },
    ...(sepoliaRpc && sepoliaKey
      ? {
          sepolia: {
            type: "http",
            url: sepoliaRpc,
            chainType: "l1",
            accounts: [sepoliaKey],
          },
        }
      : {}),
    ...(mainnetRpc && mainnetKey
      ? {
          mainnet: {
            type: "http",
            url: mainnetRpc,
            chainType: "l1",
            chainId: 1,
            accounts: [mainnetKey],
          },
        }
      : {}),
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
