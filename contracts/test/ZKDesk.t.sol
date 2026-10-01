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
        IVerifier[3] memory verifiers = [IVerifier(address(new PositionVerifier())), IVerifier(address(new HealthEpochVerifier())), IVerifier(address(new LiquidateVerifier()))];
        uint256[2] memory operatorPk = [vm.parseJsonUint(json, ".operatorPk[0]"), vm.parseJsonUint(json, ".operatorPk[1]")];
        desk = new CreditDesk(verifiers, pool, marker, lending, operatorPk, address(this));
        lending.setDesk(IDeskDebt(address(desk)));
        gate.setModule(address(desk), true);
        desk.setClass(SPY, 6000, 7000, 1_000_000e18, true);
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
        desk.act(p, e);
    }

    function _expectPosRevert(uint256 i, bytes4 err) internal {
        (CreditDesk.PositionProof memory p, CreditDesk.PositionExt memory e) = _pos(i);
        vm.expectRevert(err);
        desk.act(p, e);
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
        desk.setClass(SPY, 6000, 7000, 5e18, true);
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
    // 5 batch, market open (A 100% deep, B 20% shallow), 6 batch off-hours (A only), 7 close A after 5.

    address constant NVDA = address(0x4e7da);
    address bonusSink = makeAddr("bonusSink");
    MockAggregatorV3 nvFeed;
    MockAMM amm;

    function _m3() internal {
        json = vm.readFile("../circuits/fixtures/m3.json");
        deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode("NVIDIA (test)", "tNVDA", address(this)), NVDA);
        gate.setAsset(NVDA, true);
        nvFeed = new MockAggregatorV3("NVDA / USD", address(this), address(this));
        nvFeed.setAnswer(120e8);
        marker.setFeed(NVDA, IAggregatorV3(address(nvFeed)));
        desk.setClass(NVDA, 4500, 5500, 1_000_000e18, true); // classList: [SPY, NVDA]
        amm = new MockAMM(marker, MockUSDG(USDG));
        desk.setVenue(ISaleVenue(address(amm)), bonusSink);
        marker.setMarketOpen(true);
        _nvPrice(120e8);
        MockUSDG(USDG).faucet(5000e6); // lender liquidity
        IERC20(USDG).approve(LENDING, type(uint256).max);
        lending.deposit(5000e6, address(this));
        vm.startPrank(alice);
        MockStockToken(NVDA).faucet(20e18);
        IERC20(NVDA).approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /// Posts and pins a new NVDA round (and refreshes SPY so both marks are usable).
    function _nvPrice(int256 price) internal {
        nvFeed.setAnswer(price);
        marker.pin(NVDA);
        feed.setAnswer(500e8);
        marker.pin(SPY);
    }

    function _health(uint256 i) internal view returns (CreditDesk.HealthProof memory h) {
        bytes32[] memory x = vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
        h.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        for (uint256 k; k < 4; ++k) h.marks[k] = uint256(x[68 + k]);
        h.rateIndex = uint256(x[76]);
        h.sumValue = uint256(x[77]);
        h.sumDebt = uint256(x[78]);
        h.breachCommit = uint256(x[79]);
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
            if (i == 0) {
                _runTx(0, alice);
                vm.warp(block.timestamp + 60);
                _nvPrice(120e8);
                pool.clear(0);
            } else if (i == 3) {
                desk.attest(_health(3));
            } else if (i == 4) {
                _nvPrice(72e8); // NVDA -40%
                desk.attest(_health(4));
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
        _m3Through(2); // only A is live: the epoch proof (made over A and B) no longer matches the slots
        vm.expectRevert();
        desk.attest(_health(3));
        _m3Steps(2, 3);
        CreditDesk.HealthProof memory h = _health(4);
        h.marks[1] = 120e8; // the $72 proof presented at the $120 mark
        vm.expectRevert();
        desk.attest(h);
        h = _health(3);
        h.sumDebt -= 1;
        vm.expectRevert();
        desk.attest(h);
    }

    function test_m3_epochNeedsUsableMarks() public {
        _m3();
        _m3Through(3);
        vm.warp(block.timestamp + 11 minutes); // marks stale
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
        vm.expectRevert(CreditDesk.SlotMismatch.selector);
        desk.liquidate(_liq(5));
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
        desk.attest(_health(3));
        assertTrue(desk.healthy());
        assertEq(desk.epoch(), 1);
    }
}
