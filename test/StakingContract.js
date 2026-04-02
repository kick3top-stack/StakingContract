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
  return { staking: ImplFactory.attach(await proxy.getAddress()), impl, proxy };
}

/** Full fixture: proxy + 1 plan + funded rewards + alice approved */
async function deployFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const token = await ethers.deployContract("MockERC20", owner);
  const tokenAddr = await token.getAddress();
  const { staking, impl, proxy } = await deployStakingProxy(tokenAddr, owner);
  const stakingAddr = await staking.getAddress();

  await staking.connect(owner).addPlan(30, 10, 50);

  await token.mint(owner, ethers.parseEther("100000"));
  await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
  await staking.connect(owner).depositRewards(ethers.parseEther("50000"));

  await token.mint(alice, ethers.parseEther("10000"));
  await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
  await token.mint(bob, ethers.parseEther("10000"));
  await token.connect(bob).approve(stakingAddr, ethers.MaxUint256);

  return { owner, alice, bob, carol, token, staking, impl, proxy, tokenAddr, stakingAddr };
}

/** Proxy + token only (no plans / rewards) — owner funds separately */
async function deployFixtureBare() {
  const [owner, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("MockERC20", owner);
  const tokenAddr = await token.getAddress();
  const { staking, impl, proxy } = await deployStakingProxy(tokenAddr, owner);
  const stakingAddr = await staking.getAddress();
  return { owner, alice, bob, token, staking, impl, proxy, tokenAddr, stakingAddr };
}

describe("StakingContract (UUPS proxy)", function () {
  // ---------------------------------------------------------------------------
  // Initialization & deployment
  // ---------------------------------------------------------------------------
  describe("Initialization", function () {
    it("reverts proxy deploy when initialize uses zero token", async function () {
      const [owner] = await ethers.getSigners();
      const ImplFactory = await ethers.getContractFactory("StakingContract");
      const impl = await ImplFactory.deploy();
      await impl.waitForDeployment();
      const initData = ImplFactory.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        owner.address,
      ]);
      const ProxyFactory = await ethers.getContractFactory("StakingERC1967Proxy");
      await expect(
        ProxyFactory.deploy(await impl.getAddress(), initData),
      ).to.be.revertedWith("Zero token");
    });

    it("reverts proxy deploy when initialize uses zero owner", async function () {
      const [owner] = await ethers.getSigners();
      const token = await ethers.deployContract("MockERC20", owner);
      const ImplFactory = await ethers.getContractFactory("StakingContract");
      const impl = await ImplFactory.deploy();
      await impl.waitForDeployment();
      const initData = ImplFactory.interface.encodeFunctionData("initialize", [
        await token.getAddress(),
        ethers.ZeroAddress,
      ]);
      const ProxyFactory = await ethers.getContractFactory("StakingERC1967Proxy");
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(
        ImplFactory,
        "OwnableInvalidOwner",
      );
    });

    it("cannot initialize again on an already initialized proxy", async function () {
      const { staking, owner, tokenAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await expect(staking.initialize(tokenAddr, owner.address)).to.be.revertedWithCustomError(
        staking,
        "InvalidInitialization",
      );
    });

    it("exposes implementation address when queried on the proxy", async function () {
      const { staking, impl } = await networkHelpers.loadFixture(deployFixture);
      expect(await staking.implementation()).to.equal(await impl.getAddress());
    });
  });

  // ---------------------------------------------------------------------------
  // addPlan / updatePlan
  // ---------------------------------------------------------------------------
  describe("Plans (addPlan / updatePlan)", function () {
    it("reverts addPlan when non-owner", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixtureBare);
      await expect(staking.connect(alice).addPlan(1, 1, 0)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts addPlan when period is zero", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await expect(staking.connect(owner).addPlan(0, 10, 0)).to.be.revertedWith("Period must be > 0");
    });

    it("reverts addPlan when APR is zero", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await expect(staking.connect(owner).addPlan(30, 0, 0)).to.be.revertedWith("APR must be > 0");
    });

    it("reverts addPlan when penalty exceeds 100", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await expect(staking.connect(owner).addPlan(30, 10, 101)).to.be.revertedWith(
        "Penalty cannot exceed 100",
      );
    });

    it("assigns sequential plan ids and allows getPlan for each", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(7, 5, 10);
      await staking.connect(owner).addPlan(14, 7, 20);
      const p0 = await staking.getPlan(0n);
      const p1 = await staking.getPlan(1n);
      expect(p0.period).to.equal(7n * 24n * 60n * 60n);
      expect(p0.apr).to.equal(5n);
      expect(p1.apr).to.equal(7n);
    });

    it("reverts updatePlan for unknown plan id", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 0);
      await expect(staking.connect(owner).updatePlan(5n, 30, 10, 0)).to.be.revertedWith("Plan not found");
    });

    it("reverts updatePlan when non-owner", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 0);
      await expect(staking.connect(alice).updatePlan(0n, 30, 10, 0)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts updatePlan with invalid parameters", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 0);
      await expect(staking.connect(owner).updatePlan(0n, 0, 10, 0)).to.be.revertedWith("Period must be > 0");
      await expect(staking.connect(owner).updatePlan(0n, 30, 0, 0)).to.be.revertedWith("APR must be > 0");
      await expect(staking.connect(owner).updatePlan(0n, 30, 10, 101)).to.be.revertedWith(
        "Penalty cannot exceed 100",
      );
    });

    it("reverts getPlan for unknown id", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 0);
      await expect(staking.getPlan(99n)).to.be.revertedWith("Plan not found");
    });

    it("emits PlanAdded with correct args", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await expect(staking.connect(owner).addPlan(30, 10, 50))
        .to.emit(staking, "PlanAdded")
        .withArgs(0n, 30n * 24n * 60n * 60n, 10n, 50n);
    });

    it("emits PlanUpdated with correct args", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 50);
      await expect(staking.connect(owner).updatePlan(0n, 60, 20, 25))
        .to.emit(staking, "PlanUpdated")
        .withArgs(0n, 60n * 24n * 60n * 60n, 20n, 25n);
    });

    it("new stake after updatePlan uses updated params", async function () {
      const { staking, owner, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 50);
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).depositRewards(ethers.parseEther("10000"));
      await token.mint(alice, ethers.parseEther("1000"));
      await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).updatePlan(0n, 60, 20, 10);
      await staking.connect(alice).createStake(0n, ethers.parseEther("100"));
      const s = await staking.getStake(0n);
      expect(s.apr).to.equal(20n);
      expect(s.penalty).to.equal(10n);
      expect(s.endTime - s.startTime).to.equal(60n * 24n * 60n * 60n);
    });

    it("keeps APR/penalty snapshot on open stakes when plan is updated", async function () {
      const { staking, owner, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 50);
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).depositRewards(ethers.parseEther("10000"));
      await token.mint(alice, ethers.parseEther("1000"));
      await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);

      const amount = ethers.parseEther("1000");
      await staking.connect(alice).createStake(0n, amount);
      await staking.connect(owner).updatePlan(0n, 90, 99, 10);

      const stakeAfter = await staking.getStake(0n);
      expect(stakeAfter.apr).to.equal(10n);
      expect(stakeAfter.penalty).to.equal(50n);

      const elapsed = 5n * 24n * 60n * 60n;
      await networkHelpers.time.increase(elapsed);
      const pending = await staking.pendingReward(0n);
      // pendingReward now returns penalty-adjusted value; plan has 50% penalty so halve the gross
      const grossApprox = expectedReward(amount, 10, elapsed);
      const approx = (grossApprox * 50n) / 100n;
      const slack = rewardPerSeconds(amount, 10, 3n);
      expect(pending).to.be.at.least(approx > slack ? approx - slack : 0n);
      expect(pending).to.be.at.most(approx + slack);
    });
  });

  // ---------------------------------------------------------------------------
  // depositRewards
  // ---------------------------------------------------------------------------
  describe("depositRewards", function () {
    it("reverts when non-owner", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).depositRewards(1n)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts when amount is zero", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(owner).depositRewards(0n)).to.be.revertedWith("Amount must be > 0");
    });

    it("reverts when owner has not approved allowance", async function () {
      const { staking, owner, token } = await networkHelpers.loadFixture(deployFixtureBare);
      await token.mint(owner, ethers.parseEther("10"));
      await expect(staking.connect(owner).depositRewards(ethers.parseEther("1"))).to.revert(ethers);
    });

    it("increases contract token balance by deposited amount", async function () {
      const { staking, owner, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await token.mint(owner, ethers.parseEther("500"));
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      const before = await token.balanceOf(stakingAddr);
      await staking.connect(owner).depositRewards(ethers.parseEther("500"));
      expect(await token.balanceOf(stakingAddr)).to.equal(before + ethers.parseEther("500"));
    });
  });

  // ---------------------------------------------------------------------------
  // Pausable
  // ---------------------------------------------------------------------------
  describe("Pausable", function () {
    it("reverts pause when non-owner", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).pause()).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts unpause when non-owner", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(owner).pause();
      await expect(staking.connect(alice).unpause()).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts second pause while already paused", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(owner).pause();
      await expect(staking.connect(owner).pause()).to.be.revertedWithCustomError(staking, "EnforcedPause");
    });

    it("reverts unpause when not paused", async function () {
      const { staking, owner } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(owner).unpause()).to.be.revertedWithCustomError(staking, "ExpectedPause");
    });

    it("blocks createStake and unstake when paused; admin ops still work", async function () {
      const { staking, owner, alice, token } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await networkHelpers.time.increase(24n * 60n * 60n);

      await staking.connect(owner).pause();

      await expect(staking.connect(alice).createStake(0n, ethers.parseEther("1"))).to.be.revertedWithCustomError(
        staking,
        "EnforcedPause",
      );
      await expect(staking.connect(alice).unstake(0n)).to.be.revertedWithCustomError(staking, "EnforcedPause");

      await staking.connect(owner).addPlan(1, 1, 0);
      await staking.connect(owner).updatePlan(1n, 1, 1, 0);
      await token.mint(owner, ethers.parseEther("1"));
      await expect(staking.connect(owner).depositRewards(ethers.parseEther("1"))).to.not.revert(ethers);

      await staking.connect(owner).unpause();
      await expect(staking.connect(alice).unstake(0n)).to.not.revert(ethers);
    });
  });

  // ---------------------------------------------------------------------------
  // createStake
  // ---------------------------------------------------------------------------
  describe("createStake", function () {
    it("reverts when plan id does not exist", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).createStake(99n, ethers.parseEther("1"))).to.be.revertedWith(
        "Plan not found",
      );
    });

    it("reverts when amount is zero", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).createStake(0n, 0n)).to.be.revertedWith("Amount must be > 0");
    });

    it("reverts when reward reserves are insufficient", async function () {
      const { staking, owner, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 0);
      await token.mint(alice, ethers.parseEther("1000"));
      await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
      // no depositRewards — contract balance is zero
      await expect(
        staking.connect(alice).createStake(0n, ethers.parseEther("1000")),
      ).to.be.revertedWith("Insufficient reward reserves");
    });

    it("reverts when user has insufficient token balance", async function () {
      const { staking, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      const [owner] = await ethers.getSigners();
      await staking.connect(owner).addPlan(30, 10, 0);
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).depositRewards(ethers.parseEther("10000"));
      await token.mint(alice, ethers.parseEther("1"));
      await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
      await expect(staking.connect(alice).createStake(0n, ethers.parseEther("100"))).to.revert(ethers);
    });

    it("reverts when user has not approved token", async function () {
      const { staking, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      const [owner] = await ethers.getSigners();
      await staking.connect(owner).addPlan(30, 10, 0);
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).depositRewards(ethers.parseEther("10000"));
      await token.mint(alice, ethers.parseEther("100"));
      await expect(staking.connect(alice).createStake(0n, ethers.parseEther("1"))).to.revert(ethers);
    });

    it("reverts when paused", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(owner).pause();
      await expect(staking.connect(alice).createStake(0n, ethers.parseEther("1"))).to.be.revertedWithCustomError(
        staking,
        "EnforcedPause",
      );
    });

    it("emits StakeCreated with correct snapshot fields", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).createStake(0n, ethers.parseEther("5")))
        .to.emit(staking, "StakeCreated")
        .withArgs(0n, alice.address, 0n, ethers.parseEther("5"), 10n, 50n);
    });

    it("getStake returns correct fields after createStake", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("5");
      const tx = await staking.connect(alice).createStake(0n, amount);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const s = await staking.getStake(0n);
      expect(s.planId).to.equal(0n);
      expect(s.amount).to.equal(amount);
      expect(s.apr).to.equal(10n);
      expect(s.penalty).to.equal(50n);
      expect(s.staker).to.equal(alice.address);
      expect(s.startTime).to.equal(BigInt(block.timestamp));
      expect(s.endTime).to.equal(BigInt(block.timestamp) + 30n * 24n * 60n * 60n);
    });

    it("getStakeIdsByUser and getStakesByUser reflect new stake", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("3");
      await staking.connect(alice).createStake(0n, amount);
      const ids = await staking.getStakeIdsByUser(alice.address);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(0n);
      const stakes = await staking.getStakesByUser(alice.address);
      expect(stakes.length).to.equal(1);
      expect(stakes[0].amount).to.equal(amount);
      expect(stakes[0].staker).to.equal(alice.address);
    });
  });

  // ---------------------------------------------------------------------------
  // unstake
  // ---------------------------------------------------------------------------
  describe("unstake", function () {
    it("reverts for non-existent stake id (no position)", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.connect(alice).unstake(99n)).to.be.revertedWith("Not staker");
    });

    it("reverts when another user tries to unstake", async function () {
      const { staking, alice, bob } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await networkHelpers.time.increase(60n);
      await expect(staking.connect(bob).unstake(0n)).to.be.revertedWith("Not staker");
    });

    it("reverts on second unstake of the same stake id", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await networkHelpers.time.increase(30n * 24n * 60n * 60n);
      await staking.connect(alice).unstake(0n);
      await expect(staking.connect(alice).unstake(0n)).to.be.revertedWith("Not staker");
    });

    it("immediate unstake returns principal and at most dust rewards (adjacent txs may advance clock)", async function () {
      const { staking, alice, token } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("10");
      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).createStake(0n, amount);
      await staking.connect(alice).unstake(0n);
      const after = await token.balanceOf(alice.address);
      const netGain = after - before;
      const maxDust = rewardPerSeconds(amount, 10, 5n);
      expect(netGain).to.be.at.least(0n);
      expect(netGain).to.be.at.most(maxDust);
    });

    it("reverts when paused after stake was created", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await staking.connect(owner).pause();
      await expect(staking.connect(alice).unstake(0n)).to.be.revertedWithCustomError(staking, "EnforcedPause");
    });

    it("emits Unstaked with principal and reward", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amt = ethers.parseEther("10");
      await staking.connect(alice).createStake(0n, amt);
      await networkHelpers.time.increase(10n * 24n * 60n * 60n);
      // pendingReward now returns penalty-adjusted value directly
      const pendingAfterPenalty = await staking.pendingReward(0n);
      await expect(staking.connect(alice).unstake(0n))
        .to.emit(staking, "Unstaked")
        .withArgs(0n, alice.address, amt, (r) => {
          expect(r).to.be.at.least(pendingAfterPenalty - rewardPerSeconds(amt, 10, 3n));
          expect(r).to.be.at.most(pendingAfterPenalty + rewardPerSeconds(amt, 10, 3n));
          return true;
        });
    });
  });

  // ---------------------------------------------------------------------------
  // Penalty boundaries
  // ---------------------------------------------------------------------------
  describe("Penalty boundaries", function () {
    it("0% penalty: early unstake pays full raw reward", async function () {
      const { staking, owner, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 0);
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).depositRewards(ethers.parseEther("10000"));
      await token.mint(alice, ethers.parseEther("100"));
      await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(alice).createStake(0n, ethers.parseEther("100"));
      await networkHelpers.time.increase(10n * 24n * 60n * 60n);
      const pending = await staking.pendingReward(0n); // no penalty, equals raw
      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      const gain = (await token.balanceOf(alice.address)) - before - ethers.parseEther("100");
      const slack = rewardPerSeconds(ethers.parseEther("100"), 10, 3n);
      expect(gain).to.be.at.least(pending > slack ? pending - slack : 0n);
      expect(gain).to.be.at.most(pending + slack);
    });

    it("100% penalty: early unstake pays zero reward but returns principal", async function () {
      const { staking, owner, alice, token, stakingAddr } = await networkHelpers.loadFixture(deployFixtureBare);
      await staking.connect(owner).addPlan(30, 10, 100);
      await token.connect(owner).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(owner).depositRewards(ethers.parseEther("10000"));
      await token.mint(alice, ethers.parseEther("100"));
      await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
      await staking.connect(alice).createStake(0n, ethers.parseEther("100"));
      await networkHelpers.time.increase(10n * 24n * 60n * 60n);
      // pendingReward returns 0 when penalty is 100%
      expect(await staking.pendingReward(0n)).to.equal(0n);
      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("100"));
    });
  });

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  describe("Views", function () {
    it("getStake / pendingReward revert for missing stake", async function () {
      const { staking } = await networkHelpers.loadFixture(deployFixture);
      await expect(staking.getStake(999n)).to.be.revertedWith("Stake not found");
      await expect(staking.pendingReward(999n)).to.be.revertedWith("Stake not found");
    });

    it("getStakeCountByUser / getStakeIdsByUser / getStakesByUser are empty for new user", async function () {
      const { staking, carol } = await networkHelpers.loadFixture(deployFixture);
      expect(await staking.getStakeCountByUser(carol.address)).to.equal(0n);
      const ids = await staking.getStakeIdsByUser(carol.address);
      expect(ids.length).to.equal(0);
      const stakes = await staking.getStakesByUser(carol.address);
      expect(stakes.length).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-user & stake index hygiene
  // ---------------------------------------------------------------------------
  describe("Multi-user & positions", function () {
    it("isolates stakes per user", async function () {
      const { staking, alice, bob } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await staking.connect(bob).createStake(0n, ethers.parseEther("2"));
      expect(await staking.getStakeCountByUser(alice.address)).to.equal(1n);
      expect(await staking.getStakeCountByUser(bob.address)).to.equal(1n);
      const a = await staking.getStake(0n);
      const b = await staking.getStake(1n);
      expect(a.staker).to.equal(alice.address);
      expect(b.staker).to.equal(bob.address);
    });

    it("removes middle stake id from user list correctly", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await staking.connect(alice).createStake(0n, ethers.parseEther("2"));
      await staking.connect(alice).createStake(0n, ethers.parseEther("3"));
      await networkHelpers.time.increase(30n * 24n * 60n * 60n);
      await staking.connect(alice).unstake(1n);
      const ids = await staking.getStakeIdsByUser(alice.address);
      expect(ids.length).to.equal(2);
      expect(await staking.getStakeCountByUser(alice.address)).to.equal(2n);
    });
  });

  // ---------------------------------------------------------------------------
  // UUPS upgrade
  // ---------------------------------------------------------------------------
  describe("UUPS upgrade", function () {
    it("non-owner cannot upgrade", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const ImplFactory = await ethers.getContractFactory("StakingContract");
      const newImpl = await ImplFactory.deploy();
      await newImpl.waitForDeployment();
      await expect(
        staking.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    });

    it("owner can upgrade to a new implementation", async function () {
      const { staking, owner, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("5"));
      const ImplFactory = await ethers.getContractFactory("StakingContract");
      const newImpl = await ImplFactory.deploy();
      await newImpl.waitForDeployment();
      const newAddr = await newImpl.getAddress();
      await staking.connect(owner).upgradeToAndCall(newAddr, "0x");
      expect(await staking.implementation()).to.equal(newAddr);
      expect(await staking.getStakeCountByUser(alice.address)).to.equal(1n);
    });
  });

  // ---------------------------------------------------------------------------
  // Rewards (integration, timing slack)
  // ---------------------------------------------------------------------------
  describe("Rewards (unstake)", function () {
    it("pendingReward matches penalty-adjusted accrual formula", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      await staking.connect(alice).createStake(0n, amount);
      const elapsed = 10n * 24n * 60n * 60n;
      await networkHelpers.time.increase(elapsed);
      const pending = await staking.pendingReward(0n);
      // plan has 50% penalty, so expected = gross * 50 / 100
      const grossApprox = expectedReward(amount, 10, elapsed);
      const approx = (grossApprox * 50n) / 100n;
      const slack = rewardPerSeconds(amount, 10, 3n);
      expect(pending).to.be.at.least(approx > slack ? approx - slack : 0n);
      expect(pending).to.be.at.most(approx + slack);
    });

    it("after lock: unstake returns principal and full gross reward", async function () {
      const { staking, alice, token } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("50");
      await staking.connect(alice).createStake(0n, amount);
      const lockSeconds = 30n * 24n * 60n * 60n;
      await networkHelpers.time.increase(lockSeconds);
      const preReward = await staking.pendingReward(0n); // no penalty after lock
      const slack = rewardPerSeconds(amount, 10, 5n);
      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      const rewardPaid = (await token.balanceOf(alice.address)) - before - amount;
      expect(rewardPaid).to.be.at.least(preReward);
      expect(rewardPaid).to.be.at.most(preReward + slack);
    });

    it("before lock end: default plan penalizes reward portion", async function () {
      const { staking, alice, token } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, amount);
      await networkHelpers.time.increase(15n * 24n * 60n * 60n);
      const prePending = await staking.pendingReward(0n); // already penalty-adjusted
      const extraPending = (rewardPerSeconds(amount, 10, 5n) * 50n) / 100n;
      const before = await token.balanceOf(alice.address);
      await staking.connect(alice).unstake(0n);
      const rewardPaid = (await token.balanceOf(alice.address)) - before - amount;
      expect(rewardPaid).to.be.at.least(prePending > extraPending ? prePending - extraPending : 0n);
      expect(rewardPaid).to.be.at.most(prePending + extraPending);
    });

    it("caps gross accrual at lock end after maturity", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("200");
      await staking.connect(alice).createStake(0n, amount);
      const lockSeconds = 30n * 24n * 60n * 60n;
      await networkHelpers.time.increase(lockSeconds + 5n * 24n * 60n * 60n);
      const fullTermReward = expectedReward(amount, 10, lockSeconds); // no penalty after lock
      const slack = rewardPerSeconds(amount, 10, 2n);
      const pending = await staking.pendingReward(0n);
      expect(pending).to.be.at.least(fullTermReward - slack);
      expect(pending).to.be.at.most(fullTermReward + slack);
      await staking.connect(alice).unstake(0n);
      expect(await staking.getStakeCountByUser(alice.address)).to.equal(0n);
    });

    it("pendingReward stops growing after endTime", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await staking.connect(alice).createStake(0n, amount);
      const lockSeconds = 30n * 24n * 60n * 60n;
      await networkHelpers.time.increase(lockSeconds);
      const atMaturity = await staking.pendingReward(0n);
      await networkHelpers.time.increase(10n * 24n * 60n * 60n);
      const afterMaturity = await staking.pendingReward(0n);
      expect(afterMaturity).to.equal(atMaturity);
    });
  });

  // ---------------------------------------------------------------------------
  // Unstake index hygiene (first / last)
  // ---------------------------------------------------------------------------
  describe("Unstake index hygiene", function () {
    it("removes first stake id from user list correctly", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1")); // id 0
      await staking.connect(alice).createStake(0n, ethers.parseEther("2")); // id 1
      await networkHelpers.time.increase(30n * 24n * 60n * 60n);
      await staking.connect(alice).unstake(0n);
      const ids = await staking.getStakeIdsByUser(alice.address);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(1n);
    });

    it("removes last stake id from user list correctly", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1")); // id 0
      await staking.connect(alice).createStake(0n, ethers.parseEther("2")); // id 1
      await networkHelpers.time.increase(30n * 24n * 60n * 60n);
      await staking.connect(alice).unstake(1n);
      const ids = await staking.getStakeIdsByUser(alice.address);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(0n);
    });

    it("user list is empty after unstaking the only stake", async function () {
      const { staking, alice } = await networkHelpers.loadFixture(deployFixture);
      await staking.connect(alice).createStake(0n, ethers.parseEther("1"));
      await networkHelpers.time.increase(30n * 24n * 60n * 60n);
      await staking.connect(alice).unstake(0n);
      expect(await staking.getStakeCountByUser(alice.address)).to.equal(0n);
      const ids = await staking.getStakeIdsByUser(alice.address);
      expect(ids.length).to.equal(0);
      const stakes = await staking.getStakesByUser(alice.address);
      expect(stakes.length).to.equal(0);
    });
  });
});
