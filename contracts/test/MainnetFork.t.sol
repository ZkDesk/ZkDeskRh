// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {UniswapV3Venue, ISwapRouter02} from "../src/UniswapV3Venue.sol";

/// Integration boundaries on a fork of Robinhood Chain mainnet (4663): real Chainlink feeds pin and
/// stay usable within the 25 h window, the Uniswap venue sells real stock tokens for USDG and
/// refuses below the desk's minimum, the Morpho vault takes and returns USDG, and real Stock Tokens
/// move in and out of a contract (as the pool and desk do). Skipped unless MAINNET_FORK=1.
contract MainnetForkTest is Test {
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IERC4626 constant MORPHO = IERC4626(0xBeEff033F34C046626B8D0A041844C5d1A5409dd);
    ISwapRouter02 constant ROUTER = ISwapRouter02(0xCaf681a66D020601342297493863E78C959E5cb2);
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;

    Marker marker;
    UniswapV3Venue venue;

    function setUp() public {
        if (!vm.envOr("MAINNET_FORK", false)) vm.skip(true);
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        marker = new Marker(address(this), address(this), 25 hours);
        marker.setFeed(NVDA, IAggregatorV3(NVDA_FEED));
        marker.setFeed(TSLA, IAggregatorV3(TSLA_FEED));
        venue = new UniswapV3Venue(ROUTER, USDG, address(this));
        venue.setPool(NVDA, 500);
        venue.setPool(TSLA, 3000);
    }

    function test_realFeedsPinAndStayUsable() public {
        marker.pin(NVDA);
        (uint64 price, uint64 updatedAt,) = marker.current(NVDA);
        assertGt(price, 0);
        assertTrue(marker.usable(NVDA, price));
        vm.warp(uint256(updatedAt) + 25 hours + 1);
        assertFalse(marker.usable(NVDA, price), "stale after the window");
    }

    function _sell(address token, uint256 amount, uint256 minOut) internal returns (uint256) {
        deal(token, address(this), amount);
        IERC20(token).approve(address(venue), amount);
        return venue.swap(token, amount, minOut);
    }

    function test_venueSellsNearTheMark() public {
        marker.pin(NVDA);
        (uint64 mark,,) = marker.current(NVDA);
        uint256 amount = 10e18;
        uint256 atMark = amount * mark / 1e20; // USDG, 6 decimals
        uint256 before = USDG.balanceOf(address(this));
        uint256 out = _sell(NVDA, amount, atMark * 95 / 100);
        assertEq(USDG.balanceOf(address(this)) - before, out);
        assertGe(out, atMark * 95 / 100);
        emit log_named_uint("NVDA 10 sold, bps of mark", out * 10_000 / atMark);
    }

    function test_venueRefusesBelowMinimum() public {
        marker.pin(TSLA);
        (uint64 mark,,) = marker.current(TSLA);
        deal(TSLA, address(this), 1e18);
        IERC20(TSLA).approve(address(venue), 1e18);
        vm.expectRevert();
        venue.swap(TSLA, 1e18, uint256(mark) * 2 / 1e2); // twice the mark: must not fill
    }

    function test_morphoTakesAndReturnsUsdg() public {
        deal(address(USDG), address(this), 1_000e6);
        USDG.approve(address(MORPHO), 1_000e6);
        uint256 shares = MORPHO.deposit(1_000e6, address(this));
        assertGt(shares, 0);
        assertApproxEqAbs(MORPHO.convertToAssets(shares), 1_000e6, 2);
        uint256 back = MORPHO.redeem(shares, address(this), address(this));
        assertApproxEqAbs(back, 1_000e6, 2);
    }

    function test_stockTokensMoveThroughContracts() public {
        Holder h = new Holder();
        deal(NVDA, address(this), 5e18);
        IERC20(NVDA).transfer(address(h), 5e18);
        h.send(IERC20(NVDA), address(0xBEEF), 5e18);
        assertEq(IERC20(NVDA).balanceOf(address(0xBEEF)), 5e18);
    }
}

contract Holder {
    function send(IERC20 token, address to, uint256 amount) external {
        token.transfer(to, amount);
    }
}
