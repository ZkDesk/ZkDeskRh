// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IStockToken {
    function oraclePaused() external view returns (bool);
}

/// @notice Pins oracle marks so proofs can reference a fixed price. Proofs may use the current or
/// the previous pin (so a pin landing mid-proof doesn't invalidate it). Fail-closed: a mark is only
/// usable for new risk while fresh and while the token's oracle is not paused.
/// Chainlink stock feeds already include uiMultiplier, so it is never applied here.
contract Marker is Ownable {
    struct Mark {
        uint64 price; // 8 decimals, per 1e18 base token units
        uint64 updatedAt;
        uint80 round;
    }

    mapping(address asset => IAggregatorV3) public feeds;
    mapping(address asset => Mark) public current;
    mapping(address asset => Mark) public previous;
    uint64 public maxAge;
    bool public marketOpen;
    address public pinner;

    event FeedSet(address indexed asset, address feed);
    event Pinned(address indexed asset, uint64 price, uint80 round, uint64 updatedAt);
    event MarketStatus(bool open);

    error BadFeed();
    error NotPinner();

    constructor(address owner_, address pinner_, uint64 maxAge_) Ownable(owner_) {
        pinner = pinner_;
        maxAge = maxAge_;
    }

    function setFeed(address asset, IAggregatorV3 feed) external onlyOwner {
        if (feed.decimals() != 8) revert BadFeed();
        feeds[asset] = feed;
        emit FeedSet(asset, address(feed));
    }

    function setPinner(address pinner_) external onlyOwner {
        pinner = pinner_;
    }

    function setMaxAge(uint64 maxAge_) external onlyOwner {
        maxAge = maxAge_;
    }

    /// @notice Informational market-hours flag (used by the liquidation policy in M3).
    function setMarketOpen(bool open) external {
        if (msg.sender != pinner && msg.sender != owner()) revert NotPinner();
        marketOpen = open;
        emit MarketStatus(open);
    }

    /// @notice Anyone may pin the latest feed round.
    function pin(address asset) public {
        IAggregatorV3 feed = feeds[asset];
        if (address(feed) == address(0)) revert BadFeed();
        (uint80 round, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || answer > int256(uint256(type(uint64).max))) revert BadFeed();
        if (round == current[asset].round) return;
        previous[asset] = current[asset];
        current[asset] = Mark(uint64(uint256(answer)), uint64(updatedAt), round);
        emit Pinned(asset, uint64(uint256(answer)), round, uint64(updatedAt));
    }

    function pinMany(address[] calldata assets) external {
        for (uint256 i; i < assets.length; ++i) pin(assets[i]);
    }

    /// @notice True if `price` is a pinned mark for `asset` that is fresh and not oracle-paused.
    function usable(address asset, uint256 price) external view returns (bool) {
        if (IStockToken(asset).oraclePaused()) return false;
        Mark memory c = current[asset];
        Mark memory p = previous[asset];
        uint64 updatedAt;
        if (c.price != 0 && price == c.price) updatedAt = c.updatedAt;
        else if (p.price != 0 && price == p.price) updatedAt = p.updatedAt;
        else return false;
        return block.timestamp <= updatedAt + maxAge;
    }
}
