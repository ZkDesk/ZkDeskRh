// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only Chainlink-style feed (8 decimals). Robinhood stock feeds report
/// price x uiMultiplier; the marker service posts that combined value here.
contract MockAggregatorV3 is Ownable {
    uint8 public constant decimals = 8;
    string public description;
    address public updater;
    uint80 internal round;
    int256 internal answer;
    uint256 internal updatedAt;

    error NotUpdater();

    constructor(string memory description_, address owner_, address updater_) Ownable(owner_) {
        description = description_;
        updater = updater_;
    }

    function setUpdater(address updater_) external onlyOwner {
        updater = updater_;
    }

    function setAnswer(int256 answer_) external {
        if (msg.sender != updater && msg.sender != owner()) revert NotUpdater();
        answer = answer_;
        updatedAt = block.timestamp;
        round++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, updatedAt, updatedAt, round);
    }
}
