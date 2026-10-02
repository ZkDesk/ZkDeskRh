// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Registered assets, converters and the screening role. Owned by governance (timelock); the
/// pool itself stays immutable and only reads from here, for what may enter it. Pool modules are
/// fixed in the pool at deployment, not here.
contract AssetGate is Ownable {
    mapping(address asset => bool) public isAllowed;
    mapping(address converter => bool) public isConverter;
    address public screener;

    event AssetSet(address indexed asset, bool allowed);
    event ConverterSet(address indexed converter, bool allowed);
    event ScreenerSet(address indexed screener);

    constructor(address owner_, address screener_) Ownable(owner_) {
        screener = screener_;
        emit ScreenerSet(screener_);
    }

    function setAsset(address asset, bool allowed) external onlyOwner {
        isAllowed[asset] = allowed;
        emit AssetSet(asset, allowed);
    }

    function setConverter(address converter, bool allowed) external onlyOwner {
        isConverter[converter] = allowed;
        emit ConverterSet(converter, allowed);
    }

    function setScreener(address screener_) external onlyOwner {
        screener = screener_;
        emit ScreenerSet(screener_);
    }
}
