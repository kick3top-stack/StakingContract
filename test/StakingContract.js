import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

const YEAR = 365n * 24n * 60n * 60n;

/** Matches on-chain: reward = amount * apr * elapsed / (100 * YEAR) with APR as whole percent */
function expectedReward(amount, aprPercent, elapsedSec) {
  return (amount * BigInt(aprPercent) * BigInt(elapsedSec)) / (100n * YEAR);
}

/** Max reward accrual over `seconds` (upper bound for tolerance math) */
function rewardPerSeconds(amount, aprPercent, seconds) {
  return (amount * BigInt(aprPercent) * BigInt(seconds)) / (100n * YEAR);
}

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("MockERC20", owner);
  const staking = await ethers.deployContract("StakingContract", owner);
  const tokenAddr = await token.getAddress();
  const stakingAddr = await staking.getAddress();

  await staking.connect(owner).addToken(tokenAddr);
  // 30-day lock, 10% APR, 50% early-unstake penalty on rewards
  await staking.connect(owner).addPlan(30, 10, 50);

  await token.mint(owner, ethers.parseEther("100000"));
  await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
  await staking.connect(owner).depositRewards(tokenAddr, ethers.parseEther("50000"));

  await token.mint(alice, ethers.parseEther("10000"));
  await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);

  return { owner, alice, bob, token, staking, tokenAddr, stakingAddr };
}

describe("StakingContract", function () {
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

    it("soft-deletes plan: no new stakes, existing position still unwinds", async function () {
      const { staking, owner, alice, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

      await staking.connect(owner).deletePlan(0n);
      await expect(staking.getPlan(0n)).to.be.revertedWith("Plan not found");
      await expect(staking.connect(alice).createStake(0n, tokenAddr, amount)).to.be.revertedWith(
        "Plan not found",
      );

      await networkHelpers.time.increase(60n * 24n * 60n * 60n);
      await expect(staking.connect(alice).unstake(0n)).to.not.revert(ethers);
    });
  });

  describe("Staking & positions", function () {
    it("creates independent positions per stake", async function () {
      const { staking, alice, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, tokenAddr, ethers.parseEther("10"));
      await staking.connect(alice).createStake(0n, tokenAddr, ethers.parseEther("20"));

      const stakes = await staking.getStakesByUser(alice.address);
      expect(stakes.length).to.equal(2);
      expect(stakes[0].amount).to.equal(ethers.parseEther("10"));
      expect(stakes[1].amount).to.equal(ethers.parseEther("20"));
      expect(stakes[0].stakeId).to.equal(0n);
      expect(stakes[1].stakeId).to.equal(1n);
    });

    it("reverts stake with unsupported token", async function () {
      const { staking, alice, owner } = await networkHelpers.loadFixture(deployFixture);
      const other = await ethers.deployContract("MockERC20", owner);
      await other.mint(alice, ethers.parseEther("1"));
      await other.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
      await expect(
        staking.connect(alice).createStake(0n, await other.getAddress(), 1n),
      ).to.be.revertedWith("Token not supported");
    });
  });

  describe("Rewards", function () {
    it("pendingReward matches formula after time passes", async function () {
      const { staking, alice, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

      const elapsed = 10n * 24n * 60n * 60n;
      await networkHelpers.time.increase(elapsed);

      const pending = await staking.pendingReward(0n);
      expect(pending).to.equal(expectedReward(amount, 10, elapsed));
    });

    it("claim transfers rewards without unstaking principal", async function () {
      const { staking, alice, token, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

      await networkHelpers.time.increase(5n * 24n * 60n * 60n);
      const before = await token.balanceOf(alice.address);
      const preView = await staking.pendingReward(0n);

      await expect(staking.connect(alice).claimReward(0n))
        .to.emit(staking, "RewardClaimed")
        .withArgs(0n, alice.address, (paid) => {
          const slack = rewardPerSeconds(amount, 10, 3n);
          expect(paid).to.be.at.least(preView);
          expect(paid).to.be.at.most(preView + slack);
          return true;
        });

      const delta = (await token.balanceOf(alice.address)) - before;
      const slack = rewardPerSeconds(amount, 10, 3n);
      expect(delta).to.be.at.least(preView);
      expect(delta).to.be.at.most(preView + slack);
      expect(await staking.pendingReward(0n)).to.equal(0n);
    });

    it("caps accrual at lock end then allows full claim", async function () {
      const { staking, alice, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("200");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

      const lockSeconds = 30n * 24n * 60n * 60n;
      await networkHelpers.time.increase(lockSeconds + 5n * 24n * 60n * 60n);

      const fullTermReward = expectedReward(amount, 10, lockSeconds);
      expect(await staking.pendingReward(0n)).to.equal(fullTermReward);

      await staking.connect(alice).claimReward(0n);
      expect(await staking.pendingReward(0n)).to.equal(0n);
    });

    it("reverts claim for non-staker", async function () {
      const { staking, alice, bob, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, tokenAddr, ethers.parseEther("1"));
      await networkHelpers.time.increase(24n * 60n * 60n);
      await expect(staking.connect(bob).claimReward(0n)).to.be.revertedWith("Not staker");
    });
  });

  describe("Unstake", function () {
    it("after lock: returns principal and remaining reward with no penalty", async function () {
      const { staking, alice, token, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("50");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

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

    it("early unstake applies penalty to reward portion only", async function () {
      const { staking, alice, token, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

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

    it("claim before early unstake: claims are unpenalized; unstake pays penalized tail only", async function () {
      const { staking, alice, token, tokenAddr } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, tokenAddr, amount);

      await networkHelpers.time.increase(10n * 24n * 60n * 60n);
      const firstSlice = await staking.pendingReward(0n);
      await staking.connect(alice).claimReward(0n);

      await networkHelpers.time.increase(5n * 24n * 60n * 60n);
      const tailRaw = await staking.pendingReward(0n);
      const extraRaw = rewardPerSeconds(amount, 10, 5n);
      const minTailPaid = (tailRaw * 50n) / 100n;
      const maxTailPaid = ((tailRaw + extraRaw) * 50n) / 100n;

      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      const gained = (await token.balanceOf(alice.address)) - before;
      const rewardPaid = gained - amount;
      expect(rewardPaid).to.be.at.least(minTailPaid);
      expect(rewardPaid).to.be.at.most(maxTailPaid);
      expect(firstSlice).to.be.gt(0n);
    });
  });
});
