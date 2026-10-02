// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {LendingPoolUSDG} from "../src/LendingPoolUSDG.sol";
import {Marker} from "../src/Marker.sol";
import {UniswapV3Venue, ISwapRouter02} from "../src/UniswapV3Venue.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {IVerifier} from "../src/verifiers/PositionVerifier.sol";

/// Fuzz tests on the public math (audit "fuzz tests on LTV math") and the mainnet sale venue.
contract FuzzTest is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    ZKDeskPool pool;
    CreditDesk desk;

    function setUp() public {
        AssetGate gate = new AssetGate(address(this), address(this));
        pool = new ZKDeskPool(new TransactVerifier(), gate, 60);
        MockUSDG usdg = new MockUSDG();
        LendingPoolUSDG lending = new LendingPoolUSDG(usdg, address(this));
        Marker marker = new Marker(address(this), address(this), 1 hours);
        IVerifier v = IVerifier(address(0x1));
        desk = new CreditDesk([v, v, v, v], pool, marker, lending, [uint256(1), 2], address(this));
    }

    /// The rate curve is continuous at the kink, monotonic, and bounded by its base and maximum.
    function testFuzz_aprCurveIsMonotonicAndBounded(uint256 a, uint256 b) public view {
        a = bound(a, 0, 10_000);
        b = bound(b, a, 10_000);
        assertLe(desk.aprBps(a), desk.aprBps(b), "monotonic");
        assertGe(desk.aprBps(a), desk.BASE_BPS());
        assertLe(desk.aprBps(b), desk.MAX_RATE_BPS());
        assertEq(desk.aprBps(desk.KINK_BPS()), desk.KINK_RATE_BPS(), "continuous at the kink");
    }

    /// The circuit's public amount is extAmount - fee in the field: deposits positive, spends wrapped.
    function testFuzz_publicAmountEncoding(int256 ext, uint256 fee) public view {
        ext = bound(ext, -int256(2 ** 100) + 1, int256(2 ** 100) - 1);
        fee = bound(fee, 0, 2 ** 100 - 1);
        uint256 got = pool.publicAmountOf(ext, fee);
        int256 value = ext - int256(fee);
        assertLt(got, FIELD);
        if (value >= 0) assertEq(got, uint256(value));
        else assertEq(addmod(got, uint256(-value), FIELD), 0, "negative values wrap mod p");
    }

    function testFuzz_publicAmountRejectsOutOfRange(uint256 fee) public {
        fee = bound(fee, 2 ** 100, type(uint256).max);
        vm.expectRevert(ZKDeskPool.InvalidAmount.selector);
        pool.publicAmountOf(0, fee);
    }

    /// Debt rounding against the index: a draw is never under-recorded, a repayment never over-credited
    /// (mirrors circuits/position: draw_scaled = ceil(draw * 1e18 / index), repay_scaled = floor).
    function testFuzz_scaledDebtRounding(uint256 amount, uint256 index) public pure {
        amount = bound(amount, 1, 2 ** 100);
        index = bound(index, 1e18, 1e24);
        uint256 drawScaled = (amount * 1e18 + index - 1) / index;
        uint256 repayScaled = amount * 1e18 / index;
        assertGe(drawScaled * index, amount * 1e18, "borrowers owe at least what they drew");
        assertLe(repayScaled * index, amount * 1e18, "repayment credits at most what was paid");
        assertLe(drawScaled - repayScaled, 1);
    }

    /// LTV rule of circuits/position in integers: debt_scaled * index * 1e6 <= coll * mark * ltv.
    /// Raising collateral or lowering debt never turns an allowed position into a refused one.
    function testFuzz_ltvRuleIsMonotonic(uint256 coll, uint256 debt, uint256 mark, uint256 ltv, uint256 extra) public pure {
        coll = bound(coll, 1, 2 ** 100);
        debt = bound(debt, 0, 2 ** 100);
        mark = bound(mark, 1, 2 ** 64);
        ltv = bound(ltv, 1, 9_999);
        extra = bound(extra, 0, 2 ** 100);
        uint256 index = 1e18;
        bool ok = debt * index * 1e6 <= coll * mark * ltv;
        if (ok) {
            assertTrue((debt / 2) * index * 1e6 <= (coll + extra) * mark * ltv);
        }
    }

    /// Interest accrual only ever raises the index, at the curve's rate.
    function testFuzz_accrueRaisesIndex(uint256 dt) public {
        dt = bound(dt, desk.MIN_ACCRUAL_INTERVAL(), 365 days);
        uint256 before = desk.index();
        vm.warp(block.timestamp + dt);
        desk.accrue();
        assertGe(desk.index(), before);
        assertEq(desk.prevIndex(), before);
    }
}

contract TestToken is ERC20 {
    constructor(string memory s) ERC20(s, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Swaps at a fixed price; reverts below the caller's minimum (as Uniswap's router does).
contract MockRouter is ISwapRouter02 {
    TestToken public immutable out;
    uint256 public price; // tokenOut per 1e18 tokenIn
    ExactInputSingleParams public last;

    constructor(TestToken out_) {
        out = out_;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        last = p;
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn * price / 1e18;
        require(amountOut >= p.amountOutMinimum, "Too little received");
        out.mint(p.recipient, amountOut);
    }
}

/// UniswapV3Venue (audit: 0% coverage).
contract UniswapV3VenueTest is Test {
    TestToken usdg = new TestToken("USDG");
    TestToken stock = new TestToken("STK");
    MockRouter router = new MockRouter(usdg);
    UniswapV3Venue venue;
    address desk = makeAddr("desk");

    function setUp() public {
        venue = new UniswapV3Venue(router, usdg, address(this));
        router.setPrice(250e6); // 250 USDG per token
        stock.mint(desk, 10e18);
        vm.prank(desk);
        stock.approve(address(venue), type(uint256).max);
    }

    function test_unknownTokenHasNoPool() public {
        vm.prank(desk);
        vm.expectRevert(UniswapV3Venue.NoPool.selector);
        venue.swap(address(stock), 1e18, 0);
    }

    function test_swapSellsThroughTheConfiguredPoolToTheCaller() public {
        venue.setPool(address(stock), 3000);
        vm.prank(desk);
        uint256 out = venue.swap(address(stock), 2e18, 490e6);
        assertEq(out, 500e6);
        assertEq(usdg.balanceOf(desk), 500e6, "proceeds go to the caller");
        assertEq(stock.balanceOf(address(router)), 2e18);
        (address tokenIn, address tokenOut, uint24 fee, address recipient,, uint256 minOut,) = router.last();
        assertEq(tokenIn, address(stock));
        assertEq(tokenOut, address(usdg));
        assertEq(fee, 3000);
        assertEq(recipient, desk);
        assertEq(minOut, 490e6, "the desk's band minimum is passed through");
    }

    function testFuzz_swapNeverSellsBelowTheMinimum(uint256 amount, uint256 price, uint256 minOut) public {
        venue.setPool(address(stock), 500);
        amount = bound(amount, 1, 10e18);
        price = bound(price, 1, 1_000e6);
        minOut = bound(minOut, 0, 10_000e6);
        router.setPrice(price);
        vm.prank(desk);
        try venue.swap(address(stock), amount, minOut) returns (uint256 out) {
            assertGe(out, minOut);
        } catch {
            assertLt(amount * price / 1e18, minOut, "only reverts when the pool would pay too little");
        }
    }

    function test_onlyOwnerSetsPools() public {
        vm.prank(desk);
        vm.expectRevert();
        venue.setPool(address(stock), 3000);
    }
}
