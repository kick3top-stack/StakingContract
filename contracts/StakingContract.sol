// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title StakingContract
 * @dev UUPS upgradeable + {Pausable}. Deploy behind an {ERC1967Proxy} and call `initialize`.
 *      Uses OpenZeppelin {ReentrancyGuard} (EIP-7201 storage slot; safe through ERC-1967 proxy).
 */
contract StakingContract is OwnableUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint private constant YEAR = 365 days;

    struct Plan {
        uint period;
        uint apr;
        uint penalty;
    }

    struct Stake {
        uint planId;
        uint amount;
        uint apr;
        uint penalty;
        uint startTime;
        uint endTime;
        address staker;
    }

    IERC20 public stakingToken;

    mapping(uint => Plan) private _plans;
    uint private _nextPlanId;

    mapping(uint => Stake) private _stakes;
    uint private _nextStakeId;

    mapping(address => uint[]) private _stakesByUser;

    event PlanAdded(uint indexed planId, uint period, uint apr, uint penalty);
    event PlanUpdated(uint indexed planId, uint period, uint apr, uint penalty);
    event StakeCreated(
        uint indexed stakeId,
        address indexed staker,
        uint indexed planId,
        uint amount,
        uint apr,
        uint penalty
    );
    event Unstaked(uint indexed stakeId, address indexed staker, uint amount, uint reward);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _stakingToken, address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Pausable_init();
        require(_stakingToken != address(0), "Zero token");
        stakingToken = IERC20(_stakingToken);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner whenPaused {
        _unpause();
    }

    function addPlan(uint _days, uint _apr, uint _penalty) external onlyOwner {
        require(_days > 0, "Period must be > 0");
        require(_apr > 0, "APR must be > 0");
        require(_penalty <= 100, "Penalty cannot exceed 100");
        uint planId = _nextPlanId++;
        _plans[planId] = Plan({period: _days * 1 days, apr: _apr, penalty: _penalty});
        emit PlanAdded(planId, _days * 1 days, _apr, _penalty);
    }

    /// @notice Updates the plan template for *new* stakes only.
    function updatePlan(uint _planId, uint _days, uint _apr, uint _penalty) external whenPaused onlyOwner {
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

    function depositRewards(uint _amount) external onlyOwner whenPaused{
        require(_amount > 0, "Amount must be > 0");
        stakingToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function createStake(uint _planId, uint _amount) external whenNotPaused nonReentrant {
        require(_planId < _nextPlanId, "Plan not found");
        require(_amount > 0, "Amount must be > 0");

        Plan memory plan = _plans[_planId];
        stakingToken.safeTransferFrom(msg.sender, address(this), _amount);

        uint stakeId = _nextStakeId++;
        uint t = block.timestamp;
        _stakes[stakeId] = Stake({
            planId: _planId,
            amount: _amount,
            apr: plan.apr,
            penalty: plan.penalty,
            startTime: t,
            endTime: t + plan.period,
            staker: msg.sender
        });
        _stakesByUser[msg.sender].push(stakeId);

        emit StakeCreated(stakeId, msg.sender, _planId, _amount, plan.apr, plan.penalty);
    }

    function unstake(uint _stakeId) external whenNotPaused nonReentrant {
        Stake storage s = _stakes[_stakeId];
        require(s.staker == msg.sender, "Not staker");

        uint upper = block.timestamp < s.endTime ? block.timestamp : s.endTime;
        uint elapsed = upper > s.startTime ? upper - s.startTime : 0;
        uint rawReward = s.amount * s.apr * elapsed / (100 * YEAR);

        uint reward;
        if (block.timestamp < s.endTime) {
            reward = rawReward * (100 - s.penalty) / 100;
        } else {
            reward = rawReward;
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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

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

    /// @notice ERC-1967 implementation address (only meaningful when called via proxy).
    function implementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    function getPlan(uint _planId) external view returns (Plan memory) {
        require(_planId < _nextPlanId, "Plan not found");
        return _plans[_planId];
    }

    function getStake(uint _stakeId) external view returns (Stake memory) {
        Stake memory s = _stakes[_stakeId];
        require(s.staker != address(0), "Stake not found");
        return s;
    }

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
        uint upper = block.timestamp < s.endTime ? block.timestamp : s.endTime;
        uint elapsed = upper > s.startTime ? upper - s.startTime : 0;
        uint rawReward = s.amount * s.apr * elapsed / (100 * YEAR);
        if (block.timestamp < s.endTime) {
            return rawReward * (100 - s.penalty) / 100;
        }
        return rawReward;
    }
}
