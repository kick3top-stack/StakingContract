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
        uint period;  
        uint apr;     
        uint penalty; 
        bool active;
    }

    struct Stake {
        uint planId;
        uint stakeId;
        address token;
        uint amount;
        uint startTime;
        uint endTime;
        uint lastClaimTime;
        uint claimedReward;
        address staker;
    }

    mapping(uint => Plan) private _plans;
    uint private _currentPlanId;

    mapping(uint => Stake) private _stakes;
    uint private _currentStakeId;

    mapping(address => uint[]) private _userStakeIds;

    mapping(address => bool) private _isTokenSupported;

    event PlanAdded(uint indexed planId, uint period, uint apr, uint penalty);
    event PlanUpdated(uint indexed planId, uint period, uint apr, uint penalty);
    event PlanDeleted(uint indexed planId);
    event TokenAdded(address indexed token);
    event StakeCreated(uint indexed stakeId, address indexed staker, uint planId, address token, uint amount);
    event Unstaked(uint indexed stakeId, address indexed staker, uint amount, uint reward);
    event RewardClaimed(uint indexed stakeId, address indexed staker, uint reward);

    constructor() Ownable(msg.sender) {}

    function addPlan(uint _days, uint _apr, uint _penalty) external onlyOwner {
        require(_days > 0, "Period must be > 0");
        require(_apr > 0, "APR must be > 0");
        require(_penalty <= 100, "Penalty cannot exceed 100");
        uint planId = _currentPlanId++;
        _plans[planId] = Plan({
            period: _days * 1 days,
            apr: _apr,
            penalty: _penalty,
            active: true
        });
        emit PlanAdded(planId, _days * 1 days, _apr, _penalty);
    }

    function updatePlan(uint _planId, uint _days, uint _apr, uint _penalty) external onlyOwner {
        require(_plans[_planId].active, "Plan not found");
        require(_days > 0, "Period must be > 0");
        require(_apr > 0, "APR must be > 0");
        require(_penalty <= 100, "Penalty cannot exceed 100");
        _plans[_planId].period = _days * 1 days;
        _plans[_planId].apr = _apr;
        _plans[_planId].penalty = _penalty;
        emit PlanUpdated(_planId, _days * 1 days, _apr, _penalty);
    }

    function deletePlan(uint _planId) external onlyOwner {
        require(_plans[_planId].active, "Plan not found");
        _plans[_planId].active = false;
        emit PlanDeleted(_planId);
    }

    function addToken(address _token) external onlyOwner {
        require(_token != address(0), "Zero address");
        require(!_isTokenSupported[_token], "Token already supported");
        _isTokenSupported[_token] = true;
        emit TokenAdded(_token);
    }

    function depositRewards(address _token, uint _amount) external onlyOwner {
        require(_isTokenSupported[_token], "Token not supported");
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
    }

    function getPlan(uint _planId) public view returns (Plan memory) {
        require(_plans[_planId].active, "Plan not found");
        return _plans[_planId];
    }

    function getStake(uint _stakeId) public view returns (Stake memory) {
        require(_stakes[_stakeId].staker != address(0), "Stake not found");
        return _stakes[_stakeId];
    }

    function getStakesByUser(address _user) external view returns (Stake[] memory) {
        uint[] storage ids = _userStakeIds[_user];
        Stake[] memory result = new Stake[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            result[i] = _stakes[ids[i]];
        }
        return result;
    }

    function pendingReward(uint _stakeId) public view returns (uint) {
        Stake storage s = _stakes[_stakeId];
        require(s.staker != address(0), "Stake not found");
        Plan storage plan = _plans[s.planId];

        uint elapsed = _clampElapsed(s.lastClaimTime, s.endTime);
        return s.amount * plan.apr * elapsed / (100 * YEAR);
    }

    function createStake(uint _planId, address _token, uint _amount) external nonReentrant {
        require(_plans[_planId].active, "Plan not found");
        require(_isTokenSupported[_token], "Token not supported");
        require(_amount > 0, "Amount must be > 0");

        Plan memory plan = _plans[_planId];
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);

        uint stakeId = _currentStakeId++;
        _stakes[stakeId] = Stake({
            planId: _planId,
            stakeId: stakeId,
            token: _token,
            amount: _amount,
            startTime: block.timestamp,
            endTime: block.timestamp + plan.period,
            lastClaimTime: block.timestamp,
            claimedReward: 0,
            staker: msg.sender
        });
        _userStakeIds[msg.sender].push(stakeId);

        emit StakeCreated(stakeId, msg.sender, _planId, _token, _amount);
    }

    function claimReward(uint _stakeId) external nonReentrant {
        Stake storage s = _stakes[_stakeId];
        require(s.staker == msg.sender, "Not staker");
        require(s.staker != address(0), "Stake not found");

        Plan storage plan = _plans[s.planId];

        // Rewards accrue up to endTime; no penalty for normal claims
        uint elapsed = _clampElapsed(s.lastClaimTime, s.endTime);
        uint reward = s.amount * plan.apr * elapsed / (100 * YEAR);
        require(reward > 0, "No reward to claim");

        s.claimedReward += reward;
        s.lastClaimTime = block.timestamp < s.endTime ? block.timestamp : s.endTime;

        IERC20(s.token).safeTransfer(msg.sender, reward);
        emit RewardClaimed(_stakeId, msg.sender, reward);
    }

    function unstake(uint _stakeId) external nonReentrant {
        Stake storage s = _stakes[_stakeId];
        require(s.staker == msg.sender, "Not staker");
        require(s.staker != address(0), "Stake not found");

        Plan storage plan = _plans[s.planId];
        bool isEarly = block.timestamp < s.endTime;

        uint reward;
        if (isEarly) {
            // Reward for elapsed time, with penalty applied
            uint elapsed = block.timestamp - s.lastClaimTime;
            uint rawReward = s.amount * plan.apr * elapsed / (100 * YEAR);
            reward = rawReward * (100 - plan.penalty) / 100;
        } else {
            // Full reward for remaining unclaimed period, no penalty
            uint elapsed = _clampElapsed(s.lastClaimTime, s.endTime);
            reward = s.amount * plan.apr * elapsed / (100 * YEAR);
        }

        uint principal = s.amount;
        address token = s.token;

        _removeUserStake(msg.sender, _stakeId);
        delete _stakes[_stakeId];

        IERC20(token).safeTransfer(msg.sender, principal);
        if (reward > 0) {
            IERC20(token).safeTransfer(msg.sender, reward);
        }

        emit Unstaked(_stakeId, msg.sender, principal, reward);
    }

    function _clampElapsed(uint lastClaimTime, uint endTime) private view returns (uint) {
        uint to = block.timestamp < endTime ? block.timestamp : endTime;
        if (to <= lastClaimTime) return 0;
        return to - lastClaimTime;
    }

    function _removeUserStake(address _user, uint _stakeId) private {
        uint[] storage ids = _userStakeIds[_user];
        for (uint i = 0; i < ids.length; i++) {
            if (ids[i] == _stakeId) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                break;
            }
        }
    }
}
