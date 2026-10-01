// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only stand-in for $ZKD (18 decimals). Anyone can mint a capped amount.
contract MockZKD is ERC20 {
    uint256 public constant FAUCET_CAP = 10_000e18;

    error FaucetCapExceeded();

    constructor() ERC20("ZKDesk Test Token", "tZKD") {}

    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert FaucetCapExceeded();
        _mint(msg.sender, amount);
    }
}
