// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract StakingContract is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint private constant YEAR = 365 days;

    struct Plan {
        uint period; // lock duration (seconds)
        uint apr; // whole percent, e.g. 10 = 10%
        uint penalty; // early-unstake penalty on rewards, 0–100
    }

    struct Stake {
        uint planId;
        uint amount;
        uint startTime;
        uint endTime;
        uint lastClaimTime;
        address staker;
    }

    IERC20 public immutable stakingToken;

    mapping(uint => Plan) private _plans;
    uint private _nextPlanId;

    mapping(uint => Stake) private _stakes;
    uint private _nextStakeId;

    /// @notice stake IDs per user (each position is independent)
    mapping(address => uint[]) private _stakesByUser;

    event PlanAdded(uint indexed planId, uint period, uint apr, uint penalty);
    event PlanUpdated(uint indexed planId, uint period, uint apr, uint penalty);
    event StakeCreated(uint indexed stakeId, address indexed staker, uint indexed planId, uint amount);
    event Unstaked(uint indexed stakeId, address indexed staker, uint amount, uint reward);
    event RewardClaimed(uint indexed stakeId, address indexed staker, uint reward);

    constructor(IERC20 _stakingToken) Ownable(msg.sender) {
        require(address(_stakingToken) != address(0), "Zero token");
        stakingToken = _stakingToken;
    }

    function addPlan(uint _days, uint _apr, uint _penalty) external onlyOwner {
        require(_days > 0, "Period must be > 0");
        require(_apr > 0, "APR must be > 0");
        require(_penalty <= 100, "Penalty cannot exceed 100");
        uint planId = _nextPlanId++;
        _plans[planId] = Plan({period: _days * 1 days, apr: _apr, penalty: _penalty});
        emit PlanAdded(planId, _days * 1 days, _apr, _penalty);
    }

    function updatePlan(uint _planId, uint _days, uint _apr, uint _penalty) external onlyOwner {
        require(_planId < _nextPlanId, "Plan not found");
        require(_days > 0, "Period must be > 0");
        require(_apr > 0, "APR must be > 0");
        require(_penalty <= 100, "Penalty cannot exceed 100");
        Plan storage p = _plans[_planId];
        p.period = _days * 1 days;
        p.apr = _apr;
        p.penalty = _penalty;
        emit PlanUpdated(_planId, _days * 1 days, _apr, _penalty);
    }

    /// @notice Pull reward budget into the contract (same token as staking)
    function depositRewards(uint _amount) external onlyOwner {
        require(_amount > 0, "Amount must be > 0");
        stakingToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function createStake(uint _planId, uint _amount) external nonReentrant {
        require(_planId < _nextPlanId, "Plan not found");
        require(_amount > 0, "Amount must be > 0");

        Plan memory plan = _plans[_planId];
        stakingToken.safeTransferFrom(msg.sender, address(this), _amount);

        uint stakeId = _nextStakeId++;
        uint t = block.timestamp;
        _stakes[stakeId] = Stake({
            planId: _planId,
            amount: _amount,
            startTime: t,
            endTime: t + plan.period,
            lastClaimTime: t,
            staker: msg.sender
        });
        _stakesByUser[msg.sender].push(stakeId);

        emit StakeCreated(stakeId, msg.sender, _planId, _amount);
    }

    function claimReward(uint _stakeId) external nonReentrant {
        Stake storage s = _stakes[_stakeId];
        require(s.staker == msg.sender, "Not staker");

        Plan storage plan = _plans[s.planId];
        uint elapsed = _clampElapsed(s.lastClaimTime, s.endTime);
        uint reward = s.amount * plan.apr * elapsed / (100 * YEAR);
        require(reward > 0, "No reward to claim");

        s.lastClaimTime = block.timestamp < s.endTime ? block.timestamp : s.endTime;

        stakingToken.safeTransfer(msg.sender, reward);
        emit RewardClaimed(_stakeId, msg.sender, reward);
    }

    function unstake(uint _stakeId) external nonReentrant {
        Stake storage s = _stakes[_stakeId];
        require(s.staker == msg.sender, "Not staker");

        Plan storage plan = _plans[s.planId];
        bool isEarly = block.timestamp < s.endTime;

        uint reward;
        if (isEarly) {
            uint elapsed = block.timestamp - s.lastClaimTime;
            uint rawReward = s.amount * plan.apr * elapsed / (100 * YEAR);
            reward = rawReward * (100 - plan.penalty) / 100;
        } else {
            uint elapsed = _clampElapsed(s.lastClaimTime, s.endTime);
            reward = s.amount * plan.apr * elapsed / (100 * YEAR);
        }

        uint principal = s.amount;
        _removeUserStake(msg.sender, _stakeId);
        delete _stakes[_stakeId];

        stakingToken.safeTransfer(msg.sender, principal);
        if (reward != 0) {
            stakingToken.safeTransfer(msg.sender, reward);
        }

        emit Unstaked(_stakeId, msg.sender, principal, reward);
    }

    function _clampElapsed(uint lastClaimTime, uint endTime) private view returns (uint) {
        uint to = block.timestamp < endTime ? block.timestamp : endTime;
        if (to <= lastClaimTime) return 0;
        return to - lastClaimTime;
    }

    function _removeUserStake(address _user, uint _stakeId) private {
        uint[] storage ids = _stakesByUser[_user];
        uint len = ids.length;
        for (uint i = 0; i < len; ) {
            if (ids[i] == _stakeId) {
                ids[i] = ids[len - 1];
                ids.pop();
                break;
            }
            unchecked {
                ++i;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Views (kept last)
    // -------------------------------------------------------------------------

    function getPlan(uint _planId) external view returns (Plan memory) {
        require(_planId < _nextPlanId, "Plan not found");
        return _plans[_planId];
    }

    function getStake(uint _stakeId) external view returns (Stake memory) {
        Stake memory s = _stakes[_stakeId];
        require(s.staker != address(0), "Stake not found");
        return s;
    }

    /// @notice All stake IDs owned by `user` (order may change after unstakes)
    function getStakeIdsByUser(address _user) external view returns (uint[] memory) {
        return _stakesByUser[_user];
    }

    function getStakeCountByUser(address _user) external view returns (uint) {
        return _stakesByUser[_user].length;
    }

    function getStakesByUser(address _user) external view returns (Stake[] memory) {
        uint[] storage ids = _stakesByUser[_user];
        uint n = ids.length;
        Stake[] memory result = new Stake[](n);
        for (uint i = 0; i < n; ) {
            result[i] = _stakes[ids[i]];
            unchecked {
                ++i;
            }
        }
        return result;
    }

    function pendingReward(uint _stakeId) external view returns (uint) {
        Stake storage s = _stakes[_stakeId];
        require(s.staker != address(0), "Stake not found");
        Plan storage plan = _plans[s.planId];
        uint elapsed = _clampElapsed(s.lastClaimTime, s.endTime);
        return s.amount * plan.apr * elapsed / (100 * YEAR);
    }
}
