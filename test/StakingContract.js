import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

const YEAR = 365n * 24n * 60n * 60n;

function expectedReward(amount, aprPercent, elapsedSec) {
  return (amount * BigInt(aprPercent) * BigInt(elapsedSec)) / (100n * YEAR);
}

function rewardPerSeconds(amount, aprPercent, seconds) {
  return (amount * BigInt(aprPercent) * BigInt(seconds)) / (100n * YEAR);
}

/** Deploy implementation + ERC1967Proxy, return StakingContract at proxy address */
async function deployStakingProxy(tokenAddr, ownerSigner) {
  const ImplFactory = await ethers.getContractFactory("StakingContract");
  const impl = await ImplFactory.deploy();
  await impl.waitForDeployment();
  const initData = ImplFactory.interface.encodeFunctionData("initialize", [
    tokenAddr,
    ownerSigner.address,
  ]);
  const ProxyFactory = await ethers.getContractFactory("StakingERC1967Proxy");
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return ImplFactory.attach(await proxy.getAddress());
}

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("MockERC20", owner);
  const tokenAddr = await token.getAddress();
  const staking = await deployStakingProxy(tokenAddr, owner);
  const stakingAddr = await staking.getAddress();

  await staking.connect(owner).addPlan(30, 10, 50);

  await token.mint(owner, ethers.parseEther("100000"));
  await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
  await staking.connect(owner).depositRewards(ethers.parseEther("50000"));

  await token.mint(alice, ethers.parseEther("10000"));
  await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);

  return { owner, alice, bob, token, staking, tokenAddr, stakingAddr };
}

describe("StakingContract (UUPS proxy)", function () {
  describe("Admin", function () {
    it("reverts when non-owner adds a plan", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).addPlan(7, 5, 0)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount",
      );
    });

    it("adds and updates plans", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixture);
      let plan = await staking.getPlan(0n);
      expect(plan.period).to.equal(30n * 24n * 60n * 60n);
      expect(plan.apr).to.equal(10n);
      expect(plan.penalty).to.equal(50n);

      await staking.connect(owner).updatePlan(0n, 60, 12, 25);
      plan = await staking.getPlan(0n);
      expect(plan.period).to.equal(60n * 24n * 60n * 60n);
      expect(plan.apr).to.equal(12n);
      expect(plan.penalty).to.equal(25n);
    });

    it("keeps APR/penalty snapshot on open stakes when plan is updated", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      await staking.connect(alice).createStake(0n, amount);

      const stakeBefore = await staking.getStake(0n);
      expect(stakeBefore.apr).to.equal(10n);
      expect(stakeBefore.penalty).to.equal(50n);

      await staking.connect(owner).updatePlan(0n, 90, 99, 10);

      const stakeAfter = await staking.getStake(0n);
      expect(stakeAfter.apr).to.equal(10n);
      expect(stakeAfter.penalty).to.equal(50n);

      const elapsed = 5n * 24n * 60n * 60n;
      await networkHelpers.time.increase(elapsed);
      const pending = await staking.pendingReward(0n);
      const approx = expectedReward(amount, 10, elapsed);
      const slack = rewardPerSeconds(amount, 10, 3n);
      expect(pending).to.be.at.least(approx > slack ? approx - slack : 0n);
      expect(pending).to.be.at.most(approx + slack);
    });
  });

  describe("Pausable", function () {
    it("blocks createStake and unstake when paused", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await networkHelpers.time.increase(24n * 60n * 60n);

      await staking.connect(owner).pause();

      await expect(staking.connect(alice).createStake(0n, ethers.parseEther("1"))).to.be.revertedWithCustomError(
        staking,
        "EnforcedPause",
      );
      await expect(staking.connect(alice).unstake(0n)).to.be.revertedWithCustomError(staking, "EnforcedPause");

      await staking.connect(owner).unpause();
      await expect(staking.connect(alice).unstake(0n)).to.not.revert(ethers);
    });

    it("owner can still depositRewards while paused", async function () {
      const { staking, owner, token } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(owner).pause();
      const stakingAddr = await staking.getAddress();
      await token.mint(owner, ethers.parseEther("1"));
      await expect(staking.connect(owner).depositRewards(ethers.parseEther("1"))).to.not.revert(ethers);
    });
  });

  describe("Staking & positions", function () {
    it("creates independent positions per user and tracks stake ids", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("10"));
      await staking.connect(alice).createStake(0n, ethers.parseEther("20"));

      expect(await staking.getStakeCountByUser(alice.address)).to.equal(2n);
      const ids = await staking.getStakeIdsByUser(alice.address);
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(0n);
      expect(ids[1]).to.equal(1n);

      const stakes = await staking.getStakesByUser(alice.address);
      expect(stakes.length).to.equal(2);
      expect(stakes[0].amount).to.equal(ethers.parseEther("10"));
      expect(stakes[1].amount).to.equal(ethers.parseEther("20"));
      expect(stakes[0].staker).to.equal(alice.address);
    });
  });

  describe("Rewards (unstake only)", function () {
    it("pendingReward matches gross accrual formula", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      await staking.connect(alice).createStake(0n, amount);

      const elapsed = 10n * 24n * 60n * 60n;
      await networkHelpers.time.increase(elapsed);

      const pending = await staking.pendingReward(0n);
      expect(pending).to.equal(expectedReward(amount, 10, elapsed));
    });

    it("after lock: unstake returns principal and full gross reward", async function () {
      const { staking, alice, token } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("50");
      await staking.connect(alice).createStake(0n, amount);

      const lockSeconds = 30n * 24n * 60n * 60n;
      await networkHelpers.time.increase(lockSeconds);
      const preReward = await staking.pendingReward(0n);
      const slack = rewardPerSeconds(amount, 10, 5n);

      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      const rewardPaid =
        (await token.balanceOf(alice.address)) - before - amount;
      expect(rewardPaid).to.be.at.least(preReward);
      expect(rewardPaid).to.be.at.most(preReward + slack);
    });

    it("before lock end: unstake penalizes reward portion only", async function () {
      const { staking, alice, token } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, amount);

      await networkHelpers.time.increase(15n * 24n * 60n * 60n);
      const preRaw = await staking.pendingReward(0n);
      const extraRaw = rewardPerSeconds(amount, 10, 5n);
      const minPaid = (preRaw * 50n) / 100n;
      const maxPaid = ((preRaw + extraRaw) * 50n) / 100n;

      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      const rewardPaid =
        (await token.balanceOf(alice.address)) - before - amount;
      expect(rewardPaid).to.be.at.least(minPaid);
      expect(rewardPaid).to.be.at.most(maxPaid);
    });

    it("caps gross accrual at lock end then pays full reward on unstake", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("200");
      await staking.connect(alice).createStake(0n, amount);

      const lockSeconds = 30n * 24n * 60n * 60n;
      await networkHelpers.time.increase(lockSeconds + 5n * 24n * 60n * 60n);

      const fullTermReward = expectedReward(amount, 10, lockSeconds);
      expect(await staking.pendingReward(0n)).to.equal(fullTermReward);

      await staking.connect(alice).unstake(0n);
      expect(await staking.getStakeCountByUser(alice.address)).to.equal(0n);
    });

    it("reverts unstake for non-staker", async function () {
      const { staking, alice, bob } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await networkHelpers.time.increase(24n * 60n * 60n);
      await expect(staking.connect(bob).unstake(0n)).to.be.revertedWith("Not staker");
    });
  });
});
