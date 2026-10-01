// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockUSDG} from "./MockUSDG.sol";

/// @notice Testnet-only stand-in for the Morpho USDG vault (treasury yield leg). NAV accrues at a
/// fixed 4% a year: every deposit/withdrawal first mints the accrued yield from the tUSDG faucet.
contract MockERC4626 is ERC4626 {
    uint256 public constant RATE_BPS = 400;
    MockUSDG public immutable usdg;
    uint64 public lastAccrual;

    constructor(MockUSDG usdg_) ERC20("ZKDesk Test USDG Vault", "tvUSDG") ERC4626(usdg_) {
        usdg = usdg_;
        lastAccrual = uint64(block.timestamp);
    }

    function accrue() public {
        uint256 y = totalAssets() * RATE_BPS * (block.timestamp - lastAccrual) / 10_000 / 365 days;
        lastAccrual = uint64(block.timestamp);
        while (y > 0) {
            uint256 m = y < usdg.FAUCET_CAP() ? y : usdg.FAUCET_CAP();
            usdg.faucet(m);
            y -= m;
        }
    }

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        accrue();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        accrue();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        accrue();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        accrue();
        return super.redeem(shares, receiver, owner);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
