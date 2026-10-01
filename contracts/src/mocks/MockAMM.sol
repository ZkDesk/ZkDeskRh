// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Marker} from "../Marker.sol";
import {MockUSDG} from "./MockUSDG.sol";

/// @notice Testnet-only lit-depth stand-in for liquidation sales: buys any amount of a stock token
/// for tUSDG at the pinned mark minus a fixed slippage. It mints its own tUSDG from the faucet when
/// short, so no ops funding is needed. Mainnet uses a real DEX adapter instead.
contract MockAMM {
    using SafeERC20 for IERC20;

    uint256 public constant SLIPPAGE_BPS = 50;
    Marker public immutable marker;
    MockUSDG public immutable usdg;

    error Slippage();

    constructor(Marker marker_, MockUSDG usdg_) {
        marker = marker_;
        usdg = usdg_;
    }

    /// @notice USDG per 1e18 base units, 8 decimals.
    function quote(address tokenIn) public view returns (uint256) {
        (uint64 mark,,) = marker.current(tokenIn);
        return uint256(mark) * (10_000 - SLIPPAGE_BPS) / 10_000;
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        out = amountIn * quote(tokenIn) / 1e20;
        if (out < minOut) revert Slippage();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        for (uint256 bal = usdg.balanceOf(address(this)); bal < out;) {
            uint256 m = out - bal < usdg.FAUCET_CAP() ? out - bal : usdg.FAUCET_CAP();
            usdg.faucet(m);
            bal += m;
        }
        IERC20(address(usdg)).safeTransfer(msg.sender, out);
    }
}
