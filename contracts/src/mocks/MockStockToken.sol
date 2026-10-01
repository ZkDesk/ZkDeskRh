// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only Robinhood-style stock token: 18 decimals, ERC-8056-like `uiMultiplier()`
/// (raw balances never change on splits/dividends) and an `oraclePaused()` flag.
contract MockStockToken is ERC20, Ownable {
    uint256 public constant FAUCET_CAP = 1_000e18;
    uint256 public uiMultiplier = 1e18;
    bool public oraclePaused;

    error FaucetCapExceeded();

    constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) Ownable(owner_) {}

    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert FaucetCapExceeded();
        _mint(msg.sender, amount);
    }

    function setUiMultiplier(uint256 multiplier) external onlyOwner {
        uiMultiplier = multiplier;
    }

    function setOraclePaused(bool paused) external onlyOwner {
        oraclePaused = paused;
    }
}
