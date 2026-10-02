// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {PositionVerifier, IVerifier} from "../src/verifiers/PositionVerifier.sol";
import {HealthEpochVerifier} from "../src/verifiers/HealthEpochVerifier.sol";
import {LiquidateVerifier} from "../src/verifiers/LiquidateVerifier.sol";
import {EvictVerifier} from "../src/verifiers/EvictVerifier.sol";
import {MockAMM} from "../src/mocks/MockAMM.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Real UltraHonk proofs from circuits/scripts/fixtures.mjs (bb.js, evm target), in order:
/// 0 deposit 1000 USDG, 1 lend 600 privately, 2 deposit 10 SPY, 3 open (10 SPY, draw 500),
/// 4 repay 200, 5 withdraw 2 SPY, 6 close (repay 300, 8 SPY back), 7 redeem shares privately.
/// M3 (m3.json) is listed above its tests.
contract ZKDeskTest is Test {
    address constant USDG = address(0xa55e7);
    address constant SPY = address(0x5b1);
    address constant LENDING = address(0x1e4d);
    address alice = makeAddr("alice");
    address screener = makeAddr("screener");

    string json;
    AssetGate gate;
    ZKDeskPool pool;
    Marker marker;
    MockAggregatorV3 feed;
    CreditDesk desk;
    LendingPoolUSDG lending;

    function setUp() public {
        json = vm.readFile("../circuits/fixtures/m2.json");
        deployCodeTo("MockUSDG.sol:MockUSDG", USDG);
        deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode("SPDR S&P 500 (test)", "tSPY", address(this)), SPY);
        deployCodeTo("LendingPoolUSDG.sol:LendingPoolUSDG", abi.encode(USDG, address(this)), LENDING);
        lending = LendingPoolUSDG(LENDING);
        gate = new AssetGate(address(this), screener);
        gate.setAsset(USDG, true);
        gate.setAsset(SPY, true);
        gate.setAsset(LENDING, true);
        gate.setConverter(LENDING, true);
        pool = new ZKDeskPool(new TransactVerifier(), gate, 60);
        feed = new MockAggregatorV3("SPY / USD", address(this), address(this));
        feed.setAnswer(500e8);
        marker = new Marker(address(this), address(this), 10 minutes);
        marker.setFeed(SPY, IAggregatorV3(address(feed)));
        marker.pin(SPY);
        IVerifier[4] memory verifiers = [IVerifier(address(new PositionVerifier())), IVerifier(address(new HealthEpochVerifier())), IVerifier(address(new LiquidateVerifier())), IVerifier(address(new EvictVerifier()))];
        uint256[2] memory operatorPk = [vm.parseJsonUint(json, ".operatorPk[0]"), vm.parseJsonUint(json, ".operatorPk[1]")];
        desk = new CreditDesk(verifiers, pool, marker, lending, operatorPk, address(this));
        lending.setDesk(IDeskDebt(address(desk)));
        address[] memory modules = new address[](1);
        modules[0] = address(desk);
        pool.setModules(modules);
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, 0, 0, true);
        vm.startPrank(alice);
        MockUSDG(USDG).faucet(1000e6);
        MockStockToken(SPY).faucet(10e18);
        IERC20(USDG).approve(address(pool), type(uint256).max);
        IERC20(SPY).approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    // ---- fixture decoding ----

    function _k(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".txs[", vm.toString(i), "].", field);
    }

    function _tx(uint256 i) internal view returns (ZKDeskPool.Proof memory p, ZKDeskPool.ExtData memory e) {
        bytes32[] memory x = vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
        p = ZKDeskPool.Proof({
            proof: vm.parseJsonBytes(json, _k(i, "proof")),
            root: uint256(x[0]),
            publicAmount: uint256(x[1]),
            extDataHash: uint256(x[2]),
            asset: address(uint160(uint256(x[3]))),
            outAsset: address(uint160(uint256(x[4]))),
            publicAmountOut: uint256(x[5]),
            inputNullifiers: [uint256(x[6]), uint256(x[7])],
            outputCommitments: [uint256(x[8]), uint256(x[9])]
        });
        e = ZKDeskPool.ExtData({
            recipient: vm.parseJsonAddress(json, _k(i, "ext.recipient")),
            extAmount: vm.parseJsonInt(json, _k(i, "ext.extAmount")),
            relayer: vm.parseJsonAddress(json, _k(i, "ext.relayer")),
            fee: vm.parseJsonUint(json, _k(i, "ext.fee")),
            converter: vm.parseJsonAddress(json, _k(i, "ext.converter")),
            encryptedOutput1: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput1")),
            encryptedOutput2: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput2"))
        });
    }

    function _pos(uint256 i) internal view returns (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) {
        bytes32[] memory x = vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
        p.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        p.slot = uint8(vm.parseJsonUint(json, _k(i, "slot")));
        p.root = uint256(x[0]);
        p.extDataHash = uint256(x[1]);
        p.collAsset = address(uint160(uint256(x[2])));
        p.inAsset = address(uint160(uint256(x[4])));
        p.mark = uint256(x[5]);
        p.rateIndex = uint256(x[7]);
        p.oldLeaf = uint256(x[8]);
        p.newLeaf = uint256(x[9]);
        p.collIn = uint256(x[10]);
        p.collOut = uint256(x[11]);
        p.draw = uint256(x[12]);
        p.repay = uint256(x[13]);
        p.drawScaled = uint256(x[14]);
        p.repayScaled = uint256(x[15]);
        p.inputNullifiers = [uint256(x[16]), uint256(x[17])];
        p.outputCommitments = [uint256(x[18]), uint256(x[19])];
        p.operatorEph = [uint256(x[22]), uint256(x[23])];
        p.operatorCipher = [uint256(x[24]), uint256(x[25]), uint256(x[26]), uint256(x[27])];
        e = CreditDesk.PositionExt({
            relayer: vm.parseJsonAddress(json, _k(i, "ext.relayer")),
            fee: vm.parseJsonUint(json, _k(i, "ext.fee")),
            encryptedOutput1: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput1")),
            encryptedOutput2: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput2")),
            encryptedPosition: vm.parseJsonBytes(json, _k(i, "ext.encryptedPosition"))
        });
    }

    function _runTx(uint256 i, address sender) internal {
        (ZKDeskPool.Proof memory p, ZKDeskPool.ExtData memory e) = _tx(i);
        vm.prank(sender);
        pool.transact(p, e);
    }

    function _runPos(uint256 i) internal {
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(i);
        _space(p);
        desk.act(p, e);
    }

    function _expectPosRevert(uint256 i, bytes4 err) internal {
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(i);
        _space(p);
        vm.expectRevert(err);
        desk.act(p, e);
    }

    /// Steps on a live slot are STEP_INTERVAL apart (v3, audit N-1): wait it out and re-pin the marks.
    function _space(CreditDesk.PositionProof memory p) internal {
        if (p.oldLeaf == 0 || p.newLeaf == 0 || desk.slots(p.slot) != p.oldLeaf) return;
        uint256 next = desk.touchedAt(p.slot) + desk.STEP_INTERVAL();
        if (block.timestamp >= next) return;
        vm.warp(next);
        feed.setAnswer(500e8);
        marker.pin(SPY);
        if (address(nvFeed) != address(0)) {
            nvFeed.setAnswer(nvNow);
            marker.pin(NVDA);
        }
    }

    /// Runs fixtures [0, n): deposits are cleared after standby like the cron does.
    function _through(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            if (i == 0 || i == 2) {
                _runTx(i, alice);
                vm.warp(block.timestamp + 60);
                feed.setAnswer(500e8); // keep the oracle fresh across warps
                marker.pin(SPY);
                pool.clear(i == 0 ? 0 : 1);
            } else if (i == 1 || i == 7) {
                _runTx(i, address(0xbeef)); // relayed: any sender
            } else {
                _runPos(i);
            }
        }
    }

    function _assertSolvent() internal view {
        address[3] memory assets = [USDG, SPY, LENDING];
        for (uint256 i; i < 3; ++i) {
            assertGe(IERC20(assets[i]).balanceOf(address(pool)), pool.shieldedSupply(assets[i]) + pool.pendingSupply(assets[i]));
        }
    }

    // ---- tests ----

    function test_poseidonMatchesCircomlibAndNoir() public pure {
        assertEq(PoseidonT3.hash([uint256(1), 2]), 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a);
    }

    function test_privateLendingShares() public {
        _through(2);
        uint256 shares = vm.parseJsonUint(json, ".shares");
        assertEq(lending.balanceOf(address(pool)), shares, "pool holds lender shares privately");
        assertEq(pool.shieldedSupply(LENDING), shares);
        assertEq(lending.totalAssets(), 600e6);
    }

    function test_lifecycleAccounting() public {
        _through(3);
        _runPos(3); // open
        assertEq(desk.totalCollateral(SPY), 10e18);
        assertEq(desk.totalDebtScaled(), 500e6, "draw at index 1e18");
        assertEq(lending.cash(), 100e6);
        assertEq(pool.shieldedSupply(USDG), 900e6, "400 change + 500 drawn");
        assertTrue(desk.slots(0) != 0);
        // Debt counts toward lender NAV. Draws settle at the last checkpoint index, so a few units of
        // interest since that checkpoint already accrue (conservative for lenders).
        assertApproxEqAbs(lending.totalAssets(), 600e6, 1e3, "debt counts toward lender NAV");

        _runPos(4); // repay 200
        assertEq(desk.totalDebtScaled(), 300e6);
        assertEq(lending.cash(), 300e6);
        _runPos(5); // withdraw 2 SPY
        assertEq(desk.totalCollateral(SPY), 8e18);
        _runPos(6); // close
        assertEq(desk.slots(0), 0, "slot freed");
        assertEq(desk.totalDebtScaled(), 0);
        assertEq(desk.totalCollateral(SPY), 0);
        assertEq(IERC20(SPY).balanceOf(address(desk)), 0);
        _runTx(7, address(0xbeef)); // redeem shares privately
        assertEq(lending.balanceOf(address(pool)), 0);
        assertEq(pool.shieldedSupply(USDG), vm.parseJsonUint(json, ".redeemAssets") + 400e6 + 500e6 - 200e6 - 300e6);
        _assertSolvent();
    }

    function test_staleMarkBlocksNewRiskButNotRepay() public {
        _through(4); // opened
        vm.warp(block.timestamp + 11 minutes);
        _runPos(4); // repay works while the oracle is stale
        vm.warp(block.timestamp + desk.STEP_INTERVAL()); // the next step is due; the oracle is still stale
        _expectPosRevert(5, CreditDesk.MarkUnusable.selector); // withdraw collateral does not
        feed.setAnswer(500e8);
        marker.pin(SPY);
        _runPos(5); // fresh again
    }

    function test_oraclePausedBlocksWithdrawButCloseWorks() public {
        _through(5); // opened + repaid
        MockStockToken(SPY).setOraclePaused(true);
        _expectPosRevert(5, CreditDesk.MarkUnusable.selector);
        MockStockToken(SPY).setOraclePaused(false);
        _runPos(5);
        MockStockToken(SPY).setOraclePaused(true);
        _runPos(6); // close is always allowed
        assertEq(desk.slots(0), 0);
    }

    function test_deskPauseOnlyBlocksNewRisk() public {
        _through(4);
        desk.setPaused(true);
        _runPos(4); // repay
        _expectPosRevert(5, CreditDesk.DeskPaused.selector);
    }

    function test_previousPinStillUsableThenExpires() public {
        _through(3);
        feed.setAnswer(400e8);
        marker.pin(SPY); // current 400, previous 500: the 500-mark proof stays valid
        assertTrue(marker.usable(SPY, 500e8));
        feed.setAnswer(300e8);
        marker.pin(SPY); // 500 is no longer pinned
        _expectPosRevert(3, CreditDesk.MarkUnusable.selector);
    }

    function test_uiMultiplierIsNotAppliedTwice() public {
        _through(3);
        // A 2:1 split doubles the multiplier; the feed (price x multiplier per base unit) is unchanged,
        // so collateral value and the open proof are unaffected.
        MockStockToken(SPY).setUiMultiplier(2e18);
        assertTrue(marker.usable(SPY, 500e8));
        _runPos(3);
        assertEq(desk.totalCollateral(SPY), 10e18);
    }

    function test_rateIndexAccrualAndLenderNav() public {
        _through(4); // 500 drawn of 600 supplied: utilization 83% (above the kink)
        uint256 apr = desk.aprBps(lending.utilizationBps());
        assertGt(apr, 1_000);
        vm.warp(block.timestamp + 30 days);
        desk.accrue();
        uint256 idx = desk.index();
        assertGt(idx, 1e18);
        assertEq(desk.prevIndex(), 1e18);
        // debt = principal x index ratio (within 1 unit)
        assertApproxEqAbs(desk.totalDebt(), 500e6 * idx / 1e18, 1);
        uint256 interest = desk.totalDebt() - 500e6;
        assertApproxEqAbs(lending.reserves(), interest / 10, 1, "10% spread to reserves");
        assertApproxEqAbs(lending.totalAssets(), 600e6 + interest - lending.reserves(), 1);
        assertGt(lending.convertToAssets(vm.parseJsonUint(json, ".shares")), 600e6, "lender NAV accrues");
        _runPos(4); // repay proof made at the previous checkpoint is accepted
        vm.warp(block.timestamp + 1 hours);
        desk.accrue();
        _expectPosRevert(5, CreditDesk.StaleIndex.selector); // two checkpoints later it is not
    }

    function test_accrueIsRateLimited() public {
        vm.warp(block.timestamp + 5 minutes);
        desk.accrue();
        assertEq(desk.index(), 1e18);
    }

    function test_exposureCap() public {
        _through(3);
        desk.setClass(SPY, 6000, 7000, 5e18, 0, 0, true);
        _expectPosRevert(3, CreditDesk.ExposureCap.selector);
    }

    function test_positionIsBoundToItsSlot() public {
        _through(4);
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(4);
        p.slot = 1;
        vm.expectRevert(CreditDesk.SlotMismatch.selector);
        desk.act(p, e);
    }

    function test_tamperedPositionRejected() public {
        _through(3);
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(3);
        p.draw = 600e6; // try to draw more than proven
        vm.expectRevert(); // verifier rejects (SumcheckFailed) before InvalidProof
        desk.act(p, e);
    }

    function test_doubleSpendAndTamperedConvert() public {
        _through(2);
        (ZKDeskPool.Proof memory p, ZKDeskPool.ExtData memory e) = _tx(1);
        vm.expectRevert(ZKDeskPool.NullifierSpent.selector);
        pool.transact(p, e);
    }

    function test_convertBindsConverterAndMinOut() public {
        _through(1);
        (ZKDeskPool.Proof memory p, ZKDeskPool.ExtData memory e) = _tx(1);
        e.converter = address(0xbad);
        vm.expectRevert(ZKDeskPool.ExtDataHashMismatch.selector);
        pool.transact(p, e);
        (p, e) = _tx(1);
        p.publicAmountOut += 1;
        vm.expectRevert(); // verifier rejects (SumcheckFailed) before InvalidProof
        pool.transact(p, e);
    }

    function test_convertNeedsApprovedConverter() public {
        _through(1);
        gate.setConverter(LENDING, false);
        (ZKDeskPool.Proof memory p, ZKDeskPool.ExtData memory e) = _tx(1);
        vm.expectRevert(ZKDeskPool.BadConvert.selector);
        pool.transact(p, e);
    }

    function test_onlyModulesUseHooks() public {
        vm.expectRevert(ZKDeskPool.NotAuthorized.selector);
        pool.moduleTake(USDG, 1, address(this));
        vm.expectRevert(ZKDeskPool.NotAuthorized.selector);
        pool.moduleInsert(1, "");
    }

    function test_depositorCanRefundDuringStandby() public {
        _runTx(0, alice);
        vm.prank(alice);
        pool.refundToOrigin(0);
        assertEq(IERC20(USDG).balanceOf(alice), 1000e6);
        vm.warp(block.timestamp + 60);
        vm.expectRevert(ZKDeskPool.NotPending.selector);
        pool.clear(0);
    }

    function test_flaggedDepositOnlyReturnsToOrigin() public {
        _runTx(0, alice);
        vm.prank(screener);
        pool.flag(0);
        vm.warp(block.timestamp + 60);
        vm.expectRevert(ZKDeskPool.Flagged.selector);
        pool.clear(0);
        pool.refundToOrigin(0);
        assertEq(IERC20(USDG).balanceOf(alice), 1000e6);
        _assertSolvent();
    }

    // ---- M3: health epochs and sealed liquidations (circuits/fixtures/m3.json) ----
    // 0 deposit 20 NVDA, 1 open A (slot 3, 45% LTV at $120), 2 open B (slot 5, 34% LTV),
    // 3 epoch at $120 (no breach), 4 epoch at $72 (slots 3 and 5 breached),
    // 5 batch, market open (A 100% deep, B 20% shallow), 6 batch off-hours (A only), 7 close A after 5,
    // 8 deposit 1 NVDA, 9 open C (slot 7, 1 NVDA, no debt), 10 evict C (after 5, 7, 8, 9).

    address constant NVDA = address(0x4e7da);
    address bonusSink = makeAddr("bonusSink");
    MockAggregatorV3 nvFeed;
    int256 nvNow;
    MockAMM amm;

    function _m3() internal {
        json = vm.readFile("../circuits/fixtures/m3.json");
        deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode("NVIDIA (test)", "tNVDA", address(this)), NVDA);
        gate.setAsset(NVDA, true);
        nvFeed = new MockAggregatorV3("NVDA / USD", address(this), address(this));
        nvFeed.setAnswer(120e8);
        marker.setFeed(NVDA, IAggregatorV3(address(nvFeed)));
        desk.setClass(NVDA, 4500, 5500, 1_000_000e18, 0, 0, true); // classList: [SPY, NVDA]
        amm = new MockAMM(marker, MockUSDG(USDG));
        desk.setVenue(ISaleVenue(address(amm)), bonusSink);
        marker.setMarketOpen(true);
        _nvPrice(120e8);
        MockUSDG(USDG).faucet(5000e6); // lender liquidity
        IERC20(USDG).approve(LENDING, type(uint256).max);
        lending.deposit(5000e6, address(this));
        vm.startPrank(alice);
        MockStockToken(NVDA).faucet(21e18); // 20 for A and B, 1 for C
        IERC20(NVDA).approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /// Posts and pins a new NVDA round (and refreshes SPY so both marks are usable).
    function _nvPrice(int256 price) internal {
        nvNow = price;
        nvFeed.setAnswer(price);
        marker.pin(NVDA);
        feed.setAnswer(500e8);
        marker.pin(SPY);
    }

    function _health(uint256 i) internal view returns (CreditDesk.HealthProof memory h) {
        bytes32[] memory x = vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
        h.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        for (uint256 j; j < 64; ++j) h.leaves[j] = uint256(x[j]);
        for (uint256 k; k < 4; ++k) h.marks[k] = uint256(x[68 + k]);
        h.rateIndex = uint256(x[76]);
        h.sumValue = uint256(x[77]);
        h.sumDebt = uint256(x[78]);
        h.breachCommit = uint256(x[79]);
        h.snapshotId = uint256(x[80]);
    }

    /// Snapshots the slots, then attests epoch fixture i (fixture 3 proves snapshot 1, fixture 4 snapshot 2).
    function _attest(uint256 i) internal {
        desk.snapshot();
        desk.attest(_health(i));
    }

    function _liq(uint256 i) internal view returns (CreditDesk.LiquidationProof memory p) {
        bytes32[] memory x = vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
        p.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        p.collAsset = address(uint160(uint256(x[1])));
        p.mark = uint256(x[2]);
        p.price = uint256(x[3]);
        p.rateIndex = uint256(x[5]);
        for (uint256 j; j < 4; ++j) {
            p.slots[j] = uint8(uint256(x[7 + j]));
            p.oldLeaves[j] = uint256(x[11 + j]);
            p.newLeaves[j] = uint256(x[15 + j]);
            p.encSold[j] = uint256(x[19 + j]);
            p.encRepaid[j] = uint256(x[23 + j]);
        }
        p.totalSold = uint256(x[27]);
        p.totalValue = uint256(x[28]);
        p.totalRepay = uint256(x[29]);
        p.totalRepaidScaled = uint256(x[30]);
        p.totalWrittenOff = uint256(x[31]);
    }

    /// Runs M3 fixtures [0, n).
    function _m3Through(uint256 n) internal {
        _m3Steps(0, n);
    }

    function _m3Steps(uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to; ++i) {
            if (i == 0 || i == 8) {
                _runTx(i, alice);
                vm.warp(block.timestamp + 60);
                _nvPrice(i == 0 ? int256(120e8) : int256(72e8));
                pool.clear(i == 0 ? 0 : 1);
            } else if (i == 6) {
                continue; // the off-hours alternative to batch 5
            } else if (i == 3) {
                _attest(3);
            } else if (i == 4) {
                _nvPrice(72e8); // NVDA -40%
                _attest(4);
            } else if (i == 5) {
                desk.liquidate(_liq(5));
            } else {
                _runPos(i);
            }
        }
    }

    function test_m3_epochAttestsOverEverySlot() public {
        _m3();
        _m3Through(4);
        assertEq(desk.epoch(), 1);
        assertEq(desk.lastAttestedAt(), block.timestamp);
        assertEq(desk.breachCommit(), _health(3).breachCommit);
        CreditDesk.HealthProof memory h = _health(3);
        assertEq(h.sumDebt, 948e6, "sum of debt is public, per-position debt is not");
        assertEq(h.sumValue, 2400e6, "sum of collateral value at the pinned marks");
    }

    function test_m3_omittedOrMispricedSlotFails() public {
        _m3();
        _m3Through(2); // only A is live: the epoch proof (made over A and B) does not match snapshot 1
        desk.snapshot();
        vm.expectRevert(CreditDesk.SlotMismatch.selector);
        desk.attest(_health(3));
        _m3Steps(2, 3);
        desk.snapshot(); // 2: A and B
        CreditDesk.HealthProof memory h = _health(4);
        h.marks[1] = 120e8; // the $72 proof presented at the $120 mark
        vm.expectRevert();
        desk.attest(h);
        h = _health(4);
        h.sumDebt -= 1;
        vm.expectRevert();
        desk.attest(h);
    }

    function test_m3_epochNeedsUsableMarks() public {
        _m3();
        _m3Through(3);
        vm.warp(block.timestamp + 11 minutes); // marks stale
        desk.snapshot();
        vm.expectRevert(CreditDesk.MarkUnusable.selector);
        desk.attest(_health(3));
    }

    function test_m3_breachAndSealedBatch() public {
        _m3();
        _m3Through(5);
        CreditDesk.LiquidationProof memory p = _liq(5);
        uint256 cashBefore = lending.cash();
        uint256 lenderAssetsBefore = lending.totalAssets();
        desk.liquidate(p);

        assertEq(desk.slots(3), p.newLeaves[0], "A keeps its unsold collateral");
        assertTrue(p.newLeaves[0] != 0 && p.newLeaves[1] != 0);
        assertEq(desk.slots(5), p.newLeaves[1]);
        assertEq(p.totalWrittenOff, 0);
        // A (deep, below 95% health): all 540 of its debt repaid; B (shallow): 20% of its 408.
        assertEq(desk.totalDebtScaled(), 948e6 - p.totalRepaidScaled);
        assertEq(p.totalRepaidScaled, 540e6 + 408e6 / 5);
        assertEq(lending.cash(), cashBefore + p.totalRepay);
        assertApproxEqAbs(lending.totalAssets(), lenderAssetsBefore, 1e3, "lenders are made whole");
        uint256 proceeds = p.totalSold * amm.quote(NVDA) / 1e20;
        assertEq(IERC20(USDG).balanceOf(bonusSink), proceeds - p.totalRepay, "bonus + surplus to the bond pool");
        assertEq(IERC20(NVDA).balanceOf(address(amm)), p.totalSold);
        assertEq(desk.totalCollateral(NVDA), 20e18 - p.totalSold);
        assertEq(IERC20(NVDA).balanceOf(address(desk)), 20e18 - p.totalSold);

        // The owner follows the masked amounts and takes A's remaining collateral back.
        _runPos(7);
        assertEq(desk.slots(3), 0);
        assertEq(desk.totalDebtScaled(), 408e6 - 408e6 / 5);
                assertEq(pool.shieldedSupply(NVDA), 20e18 - p.totalSold - desk.totalCollateral(NVDA), "A remainder back in note form");
        assertGe(IERC20(NVDA).balanceOf(address(pool)), pool.shieldedSupply(NVDA));
    }

    function test_m3_liquidationNeedsTheAttestedBreachSet() public {
        _m3();
        _m3Through(4); // latest epoch at $120: nothing breached
        _nvPrice(72e8);
        vm.expectRevert(); // breach commitment differs: the proof fails
        desk.liquidate(_liq(5));
    }

    function test_m3_offHoursOnlyBelowHardFloor() public {
        _m3();
        _m3Through(5);
        marker.setMarketOpen(false);
        vm.expectRevert(); // the open-market batch includes B (shallow): not provable off-hours
        desk.liquidate(_liq(5));
        CreditDesk.LiquidationProof memory p = _liq(6);
        desk.liquidate(p);
        assertEq(desk.slots(3), p.newLeaves[0]);
        assertEq(desk.slots(5), _liq(5).oldLeaves[1], "B untouched off-hours");
    }

    function test_m3_batchPriceMustBeInBand() public {
        _m3();
        _m3Through(5);
        CreditDesk.LiquidationProof memory p = _liq(5);
        p.price = p.mark * 97 / 100;
        vm.expectRevert(CreditDesk.PriceOutOfBand.selector);
        desk.liquidate(p);
        marker.setMarketOpen(false); // off-hours band is wider (5%) but still bounded
        p.price = p.mark * 94 / 100;
        vm.expectRevert(CreditDesk.PriceOutOfBand.selector);
        desk.liquidate(p);
    }

    function test_m3_batchCannotReplayOrSkipOrder() public {
        _m3();
        _m3Through(5);
        CreditDesk.LiquidationProof memory p = _liq(5);
        (p.slots[0], p.slots[1]) = (p.slots[1], p.slots[0]);
        vm.expectRevert(CreditDesk.SlotMismatch.selector);
        desk.liquidate(p);
        desk.liquidate(_liq(5));
        // A replay finds its slots changed: skipped (v3), nothing moves.
        uint256 debt = desk.totalDebtScaled();
        uint256 coll = desk.totalCollateral(NVDA);
        vm.expectEmit(address(desk));
        emit CreditDesk.BatchSkipped(NVDA, _liq(5).slots);
        desk.liquidate(_liq(5));
        assertEq(desk.totalDebtScaled(), debt);
        assertEq(desk.totalCollateral(NVDA), coll);
    }

    function test_m3_twoMissedEpochsHaltDraws() public {
        _m3();
        _m3Through(2); // A open
        vm.warp(block.timestamp + 46 minutes); // market hours: 15 min epochs, none attested
        _nvPrice(120e8);
        assertFalse(desk.healthy());
        _expectPosRevert(2, CreditDesk.HealthStale.selector); // open B draws: halted
        marker.setMarketOpen(false); // off-hours epochs are 1 h: not yet two missed
        assertTrue(desk.healthy());
        _runPos(2);
    }

    function test_m3_attestationRestoresDraws() public {
        _m3();
        _m3Through(3);
        vm.warp(block.timestamp + 46 minutes);
        _nvPrice(120e8);
        assertFalse(desk.healthy());
        _attest(3);
        assertTrue(desk.healthy());
        assertEq(desk.epoch(), 1);
    }

    // ---- Audit findings: each test fails on the v1 contracts ----

    function _evict() internal view returns (CreditDesk.EvictProof memory e) {
        e.proof = vm.parseJsonBytes(json, _k(10, "proof"));
        e.slot = uint8(vm.parseJsonUint(json, _k(10, "slot")));
        e.asset = address(uint160(vm.parseJsonUint(json, _k(10, "asset"))));
        e.collateral = vm.parseJsonUint(json, _k(10, "collateral"));
        e.commitment = vm.parseJsonUint(json, _k(10, "commitment"));
    }

    /// H-1: the class minimum is a public input of every position proof, so an open below it fails.
    function test_audit_h1_minimumCollateralIsBound() public {
        _through(3);
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, 11e18, 0, true); // the fixture opens with 10 SPY
        vm.expectRevert(); // proven with min 0: the verifier rejects it under min 11
        _runPos(3);
    }

    /// H-1: an idle position without debt is evicted; the owner gets a note, the slot is free.
    function test_audit_h1_idleZeroDebtPositionIsEvicted() public {
        _m3();
        _m3Through(10);
        CreditDesk.EvictProof memory e = _evict();
        assertTrue(desk.slots(7) != 0);
        vm.expectRevert(CreditDesk.NotIdle.selector);
        desk.evict(e);
        vm.warp(block.timestamp + desk.EVICT_AFTER());
        uint256 size = pool.size();
        uint256 supply = pool.shieldedSupply(NVDA);
        uint256 coll = desk.totalCollateral(NVDA);
        desk.evict(e);
        assertEq(desk.slots(7), 0, "slot freed");
        assertEq(pool.size(), size + 1, "owner note inserted");
        assertEq(pool.shieldedSupply(NVDA), supply + 1e18, "collateral back in note form");
        assertEq(desk.totalCollateral(NVDA), coll - 1e18);
        vm.expectRevert(CreditDesk.SlotMismatch.selector);
        desk.evict(e);
    }

    /// H-1: an eviction proof cannot be pointed at another slot.
    function test_audit_h1_evictionIsBoundToItsLeaf() public {
        _m3();
        _m3Through(10);
        vm.warp(block.timestamp + desk.EVICT_AFTER());
        CreditDesk.EvictProof memory e = _evict();
        e.slot = 5; // B: has debt, different leaf
        vm.expectRevert();
        desk.evict(e);
    }

    /// M-1: an old epoch proof (made before a price drop) cannot replace the breached set.
    function test_audit_m1_oldEpochCannotBeReplayed() public {
        _m3();
        _m3Through(5); // epoch at $72: A and B breached
        vm.expectRevert(CreditDesk.StaleSnapshot.selector);
        desk.attest(_health(3)); // the $120 proof (snapshot 1, no breach): snapshot ids are single-use
        vm.expectRevert(CreditDesk.StaleSnapshot.selector);
        desk.attest(_health(4)); // nor can the current epoch be re-sent to keep draws open
        assertEq(desk.breachCommit(), _health(4).breachCommit, "breached set unchanged");
    }

    /// M-1: the operator attests and liquidates in one transaction.
    function test_audit_m1_attestAndLiquidateIsAtomic() public {
        _m3();
        _m3Through(4);
        _nvPrice(72e8);
        CreditDesk.LiquidationProof[] memory batches = new CreditDesk.LiquidationProof[](1);
        batches[0] = _liq(5);
        desk.snapshot();
        desk.attestAndLiquidate(_health(4), batches);
        assertEq(desk.slots(3), batches[0].newLeaves[0]);
        assertEq(desk.slots(5), batches[0].newLeaves[1]);
    }

    /// M-1: the previous rate index is only accepted for an epoch just after a checkpoint.
    function test_audit_m1_previousIndexOnlyBriefly() public {
        _m3();
        _m3Through(3);
        vm.warp(block.timestamp + 2 hours);
        desk.accrue(); // index moves on; the fixture was proven at the old one
        _nvPrice(120e8);
        uint256 state = vm.snapshotState();
        _attest(3); // within the grace period after the checkpoint
        vm.revertToState(state);
        vm.warp(block.timestamp + desk.ATTEST_GRACE() + 1);
        _nvPrice(120e8);
        desk.snapshot();
        vm.expectRevert(CreditDesk.StaleIndex.selector);
        desk.attest(_health(3));
    }

    /// M-3: disabling a class stops new risk but never repay, add or close.
    function test_audit_m3_disabledClassStillExits() public {
        _through(4); // open
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, 0, 0, false);
        _runPos(4); // repay
        _expectPosRevert(5, CreditDesk.ClassDisabled.selector); // withdraw from a live position: new risk
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, 0, 0, true);
        _runPos(5);
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, 0, 0, false);
        _runPos(6); // close
        assertEq(desk.slots(0), 0);
    }

    /// M-3: a de-listed asset cannot enter the pool, but notes of it still leave (desk close here).
    function test_audit_m3_delistedAssetBlocksEntryNotExit() public {
        _through(6); // opened, repaid, withdrawn
        gate.setAsset(SPY, false);
        _runPos(6); // 8 SPY return to note form
        gate.setAsset(USDG, false);
        (ZKDeskPool.Proof memory p, ZKDeskPool.ExtData memory e) = _tx(0);
        vm.prank(alice);
        vm.expectRevert(ZKDeskPool.AssetNotAllowed.selector);
        pool.transact(p, e); // a deposit of a de-listed asset
    }

    /// M-2: the empty root only while the tree is empty, and roots expire after ROOT_HISTORY insertions.
    function test_audit_m2_rootHistory() public {
        ZKDeskPool p2 = new ZKDeskPool(new TransactVerifier(), gate, 60);
        address[] memory modules = new address[](1);
        modules[0] = address(this);
        p2.setModules(modules);
        assertTrue(p2.isKnownRoot(0), "empty tree");
        p2.moduleInsert(1, "");
        assertFalse(p2.isKnownRoot(0), "never again once a note exists");
        uint256 first = p2.root();
        assertTrue(p2.isKnownRoot(first));
        for (uint256 i = 2; i <= p2.ROOT_HISTORY(); ++i) p2.moduleInsert(i, "");
        assertTrue(p2.isKnownRoot(first), "still within the last ROOT_HISTORY roots");
        p2.moduleInsert(5000, "");
        assertFalse(p2.isKnownRoot(first), "expired");
        assertEq(p2.MAX_LEAVES(), 2 ** 32);
    }

    /// M-7: the module set is fixed once by the deployer; nobody can add a module later.
    function test_audit_m7_modulesAreFixed() public {
        address[] memory modules = new address[](1);
        modules[0] = address(0xbad);
        vm.expectRevert(ZKDeskPool.NotAuthorized.selector);
        pool.setModules(modules); // already set in setUp
        assertFalse(pool.isModule(address(0xbad)));
        ZKDeskPool p2 = new ZKDeskPool(new TransactVerifier(), gate, 60);
        vm.prank(address(0xbad));
        vm.expectRevert(ZKDeskPool.NotAuthorized.selector);
        p2.setModules(modules); // only the deployer
    }

    // ---- v3 (fix-to-8 Parts A and C): each test fails on the v2 contracts ----

    /// N-1: a step must move collateral or debt; a no-op re-randomization is refused before the verifier.
    function test_v3_emptyStepRejected() public {
        _through(4);
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(4);
        _space(p);
        (p.collIn, p.collOut, p.draw, p.repay) = (0, 0, 0, 0);
        vm.expectRevert(CreditDesk.EmptyStep.selector);
        desk.act(p, e);
    }

    /// N-1: a step that adds risk within STEP_INTERVAL of the last one is refused; closing, adding
    /// collateral and repaying are not (v3.2, audit L-b).
    function test_v3_stepsAreSpacedButCloseIsNot() public {
        _through(4); // opened
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(4);
        desk.act(p, e); // repay right after opening
        (p, e) = _pos(5);
        vm.expectRevert(CreditDesk.TooSoon.selector); // a withdrawal waits
        desk.act(p, e);
        _runPos(5);
        _runPos(6); // the close right after the withdrawal: never rate limited
        assertEq(desk.slots(0), 0);
    }

    /// N-1: a breached position can only step to a cured state (the circuit refuses anything else, see
    /// circuits/position tests), and only at the latest pin, not an old one.
    function test_v3_breachedStepMustCure() public {
        _m3();
        _m3Through(3); // A and B open at $120
        vm.warp(block.timestamp + desk.STEP_INTERVAL());
        _nvPrice(72e8); // A breached at 55%
        _nvPrice(80e8);
        vm.warp(block.timestamp + desk.ATTEST_GRACE() + 1);
        _nvPrice(90e8); // 72 is no longer pinned
        _expectPosRevert(11, CreditDesk.MarkUnusable.selector);
        _nvPrice(72e8);
        _runPos(11); // repay 150 at $72: 390 debt <= 55% of 720
        assertEq(desk.slots(3), vm.parseJsonUint(json, ".cureLeaf"));
    }

    /// N-1: a step between the snapshot and the liquidation neither blocks the epoch nor reverts the
    /// call: the epoch is proven over the snapshot, and the stale batch is skipped.
    function test_v3_churnBetweenSnapshotAndLiquidate() public {
        _m3();
        _m3Through(4); // epoch 1 at $120
        vm.warp(block.timestamp + desk.STEP_INTERVAL());
        _nvPrice(72e8);
        desk.snapshot(); // 2: A and B breached
        _runPos(11); // A cures after the snapshot
        CreditDesk.LiquidationProof[] memory batches = new CreditDesk.LiquidationProof[](1);
        batches[0] = _liq(5);
        uint256 debt = desk.totalDebtScaled();
        desk.attestAndLiquidate(_health(4), batches);
        assertEq(desk.epoch(), 2, "the epoch lands");
        assertEq(desk.breachCommit(), _health(4).breachCommit);
        assertEq(desk.totalDebtScaled(), debt, "the stale batch is skipped, nothing sold");
        assertEq(desk.slots(5), batches[0].oldLeaves[1], "B is liquidated next epoch");
    }

    /// H-1: debt is zero or at least the class minimum. The minimum is a public input of every step
    /// and liquidation: a proof made under another minimum fails, and a partial sale that would leave
    /// dust repays the position in full.
    function test_v3_dustDebtCannotHoldSlots() public {
        _m3();
        _m3Through(5); // epoch at $72
        desk.setClass(NVDA, 4500, 5500, 1_000_000e18, 0, 400e6, true);
        vm.expectRevert(); // the 20% partial sale on B (408 debt) was proven with minimum 0
        desk.liquidate(_liq(5));
        desk.liquidate(_liq(12));
        assertEq(desk.totalDebtScaled(), 0, "A and B repaid in full, no dust left");
    }

    /// The step's public inputs carry the class liquidation threshold: a proof made under another one
    /// fails (so the health check cannot be proven at a looser threshold).
    function test_v3_stepBindsLiquidationThreshold() public {
        _through(3);
        desk.setClass(SPY, 6000, 8000, 1_000_000e18, 0, 0, true);
        vm.expectRevert();
        _runPos(3);
    }

    /// H-1: the minimum debt is a public input of every step: the open (500 drawn, proven with minimum
    /// 0) fails under a 1000 USDG minimum.
    function test_v3_stepBindsMinimumDebt() public {
        _through(3);
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, 0, 1000e6, true);
        vm.expectRevert();
        _runPos(3);
    }

    /// M-3: converts are governed by the converter list only, so redeeming lender shares into a
    /// de-listed USDG still works; deposits of it do not.
    function test_v3_delistedAssetStillConverts() public {
        _through(7);
        gate.setAsset(USDG, false);
        gate.setAsset(LENDING, false);
        _runTx(7, address(0xbeef)); // redeem shares into USDG notes
        assertEq(lending.balanceOf(address(pool)), 0);
    }

    /// Bad debt written off in a liquidation is covered by the reserves first, so lender NAV never
    /// underflows (found by the liquidation invariant handler).
    function test_v3_writeOffIsCoveredByReserves() public {
        _through(4); // 500 drawn
        vm.warp(block.timestamp + 365 days);
        desk.accrue(); // reserves accrue
        uint256 reserves = lending.reserves();
        assertGt(reserves, 0);
        vm.prank(address(desk));
        lending.coverLoss(reserves / 2);
        assertEq(lending.reserves(), reserves - reserves / 2);
        vm.prank(address(desk));
        lending.coverLoss(type(uint128).max); // more than the reserves: they go to zero, lenders bear the rest
        assertEq(lending.reserves(), 0);
        vm.expectRevert(LendingPoolUSDG.NotDesk.selector);
        lending.coverLoss(1);
    }

    /// C: available cash saturates at zero instead of underflowing when reserves exceed cash.
    function test_v3_lendingAvailableSaturates() public {
        _through(4); // 500 of 600 lent
        vm.warp(block.timestamp + 36_500 days);
        desk.accrue();
        assertGt(lending.reserves(), lending.cash());
        assertEq(lending.available(), 0);
        assertEq(lending.maxWithdraw(address(pool)), 0);
    }
}
