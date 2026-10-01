// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockAggregatorV3} from "./MockAggregatorV3.sol";
import {Marker} from "../Marker.sol";

/// @notice Testnet-only: the marker service posts every mock feed price and pins them in one
/// transaction (one gas payment instead of one per feed). Real Chainlink feeds need no keeper.
contract FeedKeeper is Ownable {
    Marker public immutable marker;
    address public keeper;

    error NotKeeper();

    constructor(Marker marker_, address owner_, address keeper_) Ownable(owner_) {
        marker = marker_;
        keeper = keeper_;
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
    }

    function push(address[] calldata assets, MockAggregatorV3[] calldata feeds, int256[] calldata prices) external {
        if (msg.sender != keeper) revert NotKeeper();
        for (uint256 i; i < feeds.length; ++i) feeds[i].setAnswer(prices[i]);
        marker.pinMany(assets);
    }
}
