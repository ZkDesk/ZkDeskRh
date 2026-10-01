// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Registered assets, converters, pool modules and the screening role. Owned by governance
/// (timelock); the pool itself stays immutable and only reads from here.
contract AssetGate is Ownable {
    mapping(address asset => bool) public isAllowed;
    mapping(address converter => bool) public isConverter;
    mapping(address module => bool) public isModule;
    address public screener;

    event AssetSet(address indexed asset, bool allowed);
    event ConverterSet(address indexed converter, bool allowed);
    event ModuleSet(address indexed module, bool allowed);
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

    function setModule(address module, bool allowed) external onlyOwner {
        isModule[module] = allowed;
        emit ModuleSet(module, allowed);
    }

    function setScreener(address screener_) external onlyOwner {
        screener = screener_;
        emit ScreenerSet(screener_);
    }
}
