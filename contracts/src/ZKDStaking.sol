// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice $ZKD underwriters. Protocol fees arrive as USDG (liquidation bonuses and batch surplus
/// today: the desk's bonus sink points here). Each sync splits new USDG 60% to stakers pro rata and
/// 40% to a public insurance balance. Governance (the timelock) may spend insurance only to cover a
/// shortfall, e.g. bad debt after a collateral sale. Staking never touches note logic.
contract ZKDStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant STAKER_BPS = 6_000;
    uint256 internal constant ACC = 1e18;

    IERC20 public immutable zkd;
    IERC20 public immutable usdg;

    uint256 public totalStaked;
    uint256 public accPerShare; // USDG per staked ZKD, scaled by ACC
    uint256 public insurance; // USDG held for shortfalls
    uint256 public stakerPending; // USDG owed to stakers (claimable or carried)
    uint256 public carry; // staker share that arrived while nobody was staked

    mapping(address => uint256) public staked;
    mapping(address => uint256) internal debt;
    mapping(address => uint256) internal owed;

    event Synced(uint256 toStakers, uint256 toInsurance);
    event Staked(address indexed who, uint256 amount);
    event Unstaked(address indexed who, uint256 amount);
    event Claimed(address indexed who, uint256 amount);
    event ShortfallCovered(address indexed to, uint256 amount, string reason);

    error Insufficient();

    constructor(IERC20 zkd_, IERC20 usdg_, address owner_) Ownable(owner_) {
        zkd = zkd_;
        usdg = usdg_;
    }

    /// @notice Splits USDG that arrived since the last sync. Anyone may call.
    function sync() public {
        uint256 fresh = usdg.balanceOf(address(this)) - insurance - stakerPending;
        if (fresh > 0) {
            uint256 toStakers = fresh * STAKER_BPS / 10_000;
            insurance += fresh - toStakers;
            stakerPending += toStakers;
            carry += toStakers;
            emit Synced(toStakers, fresh - toStakers);
        }
        // The staker share waits while nobody is staked (rounding dust stays in stakerPending).
        if (carry > 0 && totalStaked > 0) {
            accPerShare += carry * ACC / totalStaked;
            carry = 0;
        }
    }

    function stake(uint256 amount) external nonReentrant {
        _settle(msg.sender);
        zkd.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        debt[msg.sender] = staked[msg.sender] * accPerShare / ACC;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        _settle(msg.sender);
        if (amount > staked[msg.sender]) revert Insufficient();
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        debt[msg.sender] = staked[msg.sender] * accPerShare / ACC;
        zkd.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        amount = owed[msg.sender];
        owed[msg.sender] = 0;
        stakerPending -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function claimable(address who) external view returns (uint256) {
        return owed[who] + staked[who] * accPerShare / ACC - debt[who];
    }

    /// @notice Governance only: pay a documented shortfall from insurance (never staker funds).
    function coverShortfall(address to, uint256 amount, string calldata reason) external onlyOwner {
        sync();
        if (amount > insurance) revert Insufficient();
        insurance -= amount;
        usdg.safeTransfer(to, amount);
        emit ShortfallCovered(to, amount, reason);
    }

    function _settle(address who) internal {
        sync();
        uint256 accrued = staked[who] * accPerShare / ACC;
        owed[who] += accrued - debt[who];
        debt[who] = accrued;
    }
}
