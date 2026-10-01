// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Swaps one pool asset for another inside a private convert (e.g. USDG <-> lending shares).
/// Pulls `amountIn` of `assetIn` from the caller and sends at least `minOut` of `assetOut` back.
interface IConverter {
    function convert(address assetIn, uint256 amountIn, address assetOut, uint256 minOut) external returns (uint256 amountOut);
}
