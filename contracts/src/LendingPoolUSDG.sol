// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IConverter} from "./interfaces/IConverter.sol";

interface IDeskDebt {
    function totalDebt() external view returns (uint256);
}

/// @notice USDG lenders' pool. Shares are NAV-accruing: totalAssets = cash + outstanding desk debt
/// (at the live rate index) - reserves. The desk borrows from here; repayments flow back as cash.
/// Also a converter so the shielded pool can hold shares as private notes (lender positions stay
/// private; only the aggregate is public). Withdrawals are limited by available cash.
contract LendingPoolUSDG is ERC4626, Ownable, IConverter {
    using SafeERC20 for IERC20;

    IDeskDebt public desk;
    /// @notice The 10% interest spread, kept as reserves. There is no withdrawal path for it.
    uint256 public reserves;

    event DeskSet(address desk);
    event Borrowed(uint256 amount);
    event ReservesAdded(uint256 amount);
    event LossCovered(uint256 loss, uint256 fromReserves);

    error NotDesk();
    error DeskAlreadySet();
    error InsufficientLiquidity();
    error BadConvert();

    constructor(IERC20 usdg, address owner_) ERC20("ZKDesk Lending Share", "zkLS") ERC4626(usdg) Ownable(owner_) {}

    modifier onlyDesk() {
        if (msg.sender != address(desk)) revert NotDesk();
        _;
    }

    function setDesk(IDeskDebt desk_) external onlyOwner {
        if (address(desk) != address(0)) revert DeskAlreadySet();
        desk = desk_;
        emit DeskSet(address(desk_));
    }

    function cash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// Lenders' assets: cash plus debt minus reserves, never below zero (write-offs are covered by the
    /// reserves first, see coverLoss; this guards rounding).
    function totalAssets() public view override returns (uint256) {
        uint256 debt = address(desk) == address(0) ? 0 : desk.totalDebt();
        uint256 gross = cash() + debt;
        return gross > reserves ? gross - reserves : 0;
    }

    /// @notice Share of lent-out funds in basis points (drives the public rate curve).
    function utilizationBps() external view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        uint256 debt = address(desk) == address(0) ? 0 : desk.totalDebt();
        return Math.min(debt * 10_000 / assets, 10_000);
    }

    /// Cash not set aside as reserves (zero, never an underflow, when nearly fully lent out).
    function available() public view returns (uint256) {
        uint256 c = cash();
        return c > reserves ? c - reserves : 0;
    }

    function borrow(uint256 amount, address to) external onlyDesk {
        if (amount > available()) revert InsufficientLiquidity();
        IERC20(asset()).safeTransfer(to, amount);
        emit Borrowed(amount);
    }

    function addReserves(uint256 amount) external onlyDesk {
        reserves += amount;
        emit ReservesAdded(amount);
    }

    /// @notice Debt written off in a liquidation (collateral sold out, debt left) is covered by the
    /// reserves first; lenders bear only what exceeds them.
    function coverLoss(uint256 loss) external onlyDesk {
        uint256 covered = Math.min(loss, reserves);
        reserves -= covered;
        emit LossCovered(loss, covered);
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), available());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), convertToShares(available()));
    }

    /// @notice USDG -> shares (supply) or shares -> USDG (redeem), for private notes in the pool.
    function convert(address assetIn, uint256 amountIn, address assetOut, uint256 minOut) external returns (uint256 out) {
        if (assetIn == asset() && assetOut == address(this)) out = deposit(amountIn, msg.sender);
        else if (assetIn == address(this) && assetOut == asset()) out = redeem(amountIn, msg.sender, msg.sender);
        else revert BadConvert();
        if (out < minOut) revert BadConvert();
    }

    /// Virtual-share offset guards against first-depositor inflation.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
