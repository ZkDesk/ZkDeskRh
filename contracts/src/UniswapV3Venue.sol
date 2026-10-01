// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISaleVenue} from "./CreditDesk.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Mainnet liquidation venue: sells a batch's stock collateral for USDG in one Uniswap v3
/// pool per stock (the deepest USDG pool, set by the owner). The desk passes the minimum it accepts
/// (the batch value in the pinned-mark band), so a thin or off-mark pool reverts the batch instead
/// of selling cheaply; the desk retries on a later epoch.
contract UniswapV3Venue is ISaleVenue, Ownable {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    IERC20 public immutable usdg;
    mapping(address token => uint24) public feeOf;

    event PoolSet(address indexed token, uint24 fee);

    error NoPool();

    constructor(ISwapRouter02 router_, IERC20 usdg_, address owner_) Ownable(owner_) {
        router = router_;
        usdg = usdg_;
    }

    function setPool(address token, uint24 fee) external onlyOwner {
        feeOf[token] = fee;
        emit PoolSet(token, fee);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        uint24 fee = feeOf[tokenIn];
        if (fee == 0) revert NoPool();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        out = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams(tokenIn, address(usdg), fee, msg.sender, amountIn, minOut, 0));
    }
}
