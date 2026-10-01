// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only stand-in for USDG (6 decimals). Anyone can mint a capped amount.
contract MockUSDG is ERC20 {
    uint256 public constant FAUCET_CAP = 100_000e6;

    error FaucetCapExceeded();

    constructor() ERC20("ZKDesk Test USDG", "tUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert FaucetCapExceeded();
        _mint(msg.sender, amount);
    }
}
