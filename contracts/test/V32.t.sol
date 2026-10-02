// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {MockAMM} from "../src/mocks/MockAMM.sol";
import {MockERC4626} from "../src/mocks/MockERC4626.sol";
import {IVerifier} from "../src/verifiers/TransactVerifier.sol";
import {IVerifier as IDeskVerifier} from "../src/verifiers/PositionVerifier.sol";
import {IVerifier as ILedgerVerifier} from "../src/verifiers/LedgerVerifier.sol";

/// A verifier the test switches on and off, so each contract rule is checked on its own (the circuit
/// rules have their own Noir tests and real-proof suites).
contract SwitchVerifier is IVerifier {
    bool public ok = true;

    function set(bool v) external {
        ok = v;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return ok;
    }
}

/// v3.2 (rescore of v3): H-1 residual, L-a, L-b, L-c, and the BatchSkipped ordering.
/// v3.3 (V39 rescore): N-A current index for open steps, the re-planned batch, N-3, dust debt moves.
contract V32Test is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint128 constant MIN_COLL = 10e18;
    uint128 constant MIN_DEBT = 250e6;

    SwitchVerifier verifier;
    ZKDeskPool pool;
    CreditDesk desk;
    LendingPoolUSDG lending;
    Marker marker;
    MockAggregatorV3 feed;
    MockUSDG usdg;
    MockStockToken stock;
    TreasuryLedger ledger;
    uint256 nonce;

    function setUp() public {
        usdg = new MockUSDG();
        stock = new MockStockToken("Test stock", "tSTK", address(this));
        AssetGate gate = new AssetGate(address(this), address(this));
        verifier = new SwitchVerifier();
        pool = new ZKDeskPool(verifier, gate, 60);
        lending = new LendingPoolUSDG(usdg, address(this));
        feed = new MockAggregatorV3("STK / USD", address(this), address(this));
        feed.setAnswer(100e8);
        marker = new Marker(address(this), address(this), 365 days);
        marker.setFeed(address(stock), IAggregatorV3(address(feed)));
        marker.pin(address(stock));
        IDeskVerifier dv = IDeskVerifier(address(verifier));
        desk = new CreditDesk([dv, dv, dv, dv], pool, marker, lending, [uint256(1), 2], address(this));
        lending.setDesk(IDeskDebt(address(desk)));
        desk.setClass(address(stock), 6000, 7000, type(uint128).max, MIN_COLL, MIN_DEBT, true);
        desk.setVenue(ISaleVenue(address(new MockAMM(marker, usdg))), address(0xb0b));
        ILedgerVerifier lv = ILedgerVerifier(address(verifier));
        address s = address(stock);
        ledger = new TreasuryLedger([lv, lv, lv], pool, marker, new MockERC4626(usdg), [s, s, s, s]);
        gate.setAsset(address(usdg), true);
        gate.setAsset(address(stock), true);
        address[] memory modules = new address[](2);
        (modules[0], modules[1]) = (address(desk), address(ledger));
        pool.setModules(modules);
        usdg.approve(address(pool), type(uint256).max);
        stock.approve(address(pool), type(uint256).max);
        _shield(address(stock), 500e18);
        _shield(address(usdg), 10_000e6);
    }

    function _fresh() internal returns (uint256) {
        return uint256(keccak256(abi.encode("v32", ++nonce))) % (FIELD - 1) + 1;
    }

    function _root() internal view returns (uint256) {
        return pool.size() == 0 ? 0 : pool.root();
    }

    /// Wallet -> shielded notes (deposit, then clear after the standby).
    function _shield(address asset, uint256 amount) internal {
        if (asset == address(stock)) stock.faucet(amount);
        else usdg.faucet(amount);
        ZKDeskPool.ExtData memory e = ZKDeskPool.ExtData(address(0), int256(amount), address(0), 0, address(0), hex"01", hex"02");
        ZKDeskPool.Proof memory p = ZKDeskPool.Proof({
            proof: hex"00", root: _root(), publicAmount: pool.publicAmountOf(int256(amount), 0), extDataHash: uint256(keccak256(abi.encode(e))) % FIELD,
            asset: asset, outAsset: asset, publicAmountOut: 0, inputNullifiers: [_fresh(), _fresh()], outputCommitments: [_fresh(), _fresh()]
        });
        pool.transact(p, e);
        vm.warp(block.timestamp + 60);
        pool.clear(pool.depositCount() - 1);
    }

    /// One credit step at `mark` (0: the current pin), expected to revert with `err` if set. Returns the new leaf.
    function _step(uint256 oldLeaf, bool close, uint256 collIn, uint256 collOut, uint256 repay, uint256 mark) internal returns (uint256) {
        return _step(oldLeaf, close, collIn, collOut, repay, mark, bytes4(0));
    }

    function _step(uint256 oldLeaf, bool close, uint256 collIn, uint256 collOut, uint256 repay, uint256 mark, bytes4 err) internal returns (uint256 leaf) {
        CreditDesk.PositionExt memory e = CreditDesk.PositionExt(address(0), 0, hex"01", hex"02", hex"03");
        CreditDesk.PositionProof memory p;
        leaf = close ? 0 : _fresh();
        (p.slot, p.collAsset, p.inAsset, p.oldLeaf, p.newLeaf) = (0, address(stock), repay > 0 ? address(usdg) : address(stock), oldLeaf, leaf);
        (p.collIn, p.collOut, p.repay) = (collIn, collOut, repay);
        (uint64 current,,) = marker.current(address(stock));
        p.mark = mark == 0 ? current : mark;
        p.rateIndex = desk.index();
        p.extDataHash = uint256(keccak256(abi.encode(e))) % FIELD;
        p.root = _root();
        p.inputNullifiers = [_fresh(), _fresh()];
        p.outputCommitments = [_fresh(), _fresh()];
        if (err != bytes4(0)) vm.expectRevert(err);
        desk.act(p, e);
    }

    function _price(int256 price) internal {
        feed.setAnswer(price);
        marker.pin(address(stock));
    }

    function _evict(uint256 collateral) internal {
        desk.evict(CreditDesk.EvictProof(hex"00", 0, address(stock), collateral, _fresh()));
    }

    // ---- H-1 residual: a tiny top-up does not keep an idle position from eviction ----

    function test_v32_tinyTopUpDoesNotDelayEviction() public {
        uint256 leaf = _step(0, false, 20e18, 0, 0, 0); // open, no debt
        vm.warp(block.timestamp + 12 hours);
        leaf = _step(leaf, false, 1, 0, 0, 0); // 1 wei: the step lands, but is not activity
        assertEq(desk.touchedAt(0), block.timestamp);
        vm.warp(block.timestamp + 12 hours);
        _evict(20e18 + 1); // a day after opening, despite the top-up
        assertEq(desk.slots(0), 0);
    }

    function test_v32_topUpOfTheMinimumCountsAsActivity() public {
        uint256 leaf = _step(0, false, 20e18, 0, 0, 0);
        vm.warp(block.timestamp + 12 hours);
        _step(leaf, false, MIN_COLL, 0, 0, 0);
        vm.warp(block.timestamp + 12 hours + 1);
        uint256 commitment = _fresh();
        vm.expectRevert(CreditDesk.NotIdle.selector);
        desk.evict(CreditDesk.EvictProof(hex"00", 0, address(stock), 20e18 + MIN_COLL, commitment));
    }

    // ---- L-b: risk-reducing steps are not rate limited ----

    function test_v32_addAndRepaySkipTheStepInterval() public {
        uint256 leaf = _step(0, false, 20e18, 0, 0, 0);
        leaf = _step(leaf, false, 1e18, 0, 0, 0); // add collateral right away
        leaf = _step(leaf, false, 0, 0, 1e6, 0); // repay right away
        _step(leaf, false, 0, 1e18, 0, 0, CreditDesk.TooSoon.selector); // a withdrawal still waits
        vm.warp(block.timestamp + desk.STEP_INTERVAL());
        _price(100e8); // keep the mark fresh
        _step(leaf, false, 0, 1e18, 0, 0);
    }

    // ---- L-a: no step at the old, higher price after a drop ----

    function test_v32_previousMarkOnlyWhenNotHigher() public {
        uint256 leaf = _step(0, false, 20e18, 0, 0, 0);
        _price(80e8); // a drop: previous 100, current 80
        _step(leaf, false, 1e18, 0, 0, 100e8, CreditDesk.MarkUnusable.selector); // a "cure" proven at the old, higher price
        leaf = _step(leaf, false, 1e18, 0, 0, 80e8);
        _price(120e8); // a rise: previous 80, current 120
        leaf = _step(leaf, false, 1e18, 0, 0, 80e8); // a proof in flight at the lower price is conservative
        vm.warp(block.timestamp + desk.ATTEST_GRACE() + 1);
        _step(leaf, false, 1e18, 0, 0, 80e8, CreditDesk.MarkUnusable.selector); // but only briefly
    }

    // ---- lead: a stale batch is reported only if its proof verifies ----

    function test_v32_staleBatchMustVerifyBeforeItIsSkipped() public {
        _step(0, false, 20e18, 0, 0, 0);
        CreditDesk.LiquidationProof memory p;
        (uint64 mark,,) = marker.current(address(stock));
        (p.proof, p.collAsset, p.mark, p.price, p.rateIndex) = (hex"00", address(stock), mark, mark, desk.index());
        (p.slots[0], p.oldLeaves[0]) = (0, _fresh()); // not the slot's leaf
        verifier.set(false);
        vm.expectRevert(CreditDesk.InvalidProof.selector);
        desk.liquidate(p);
        verifier.set(true);
        vm.expectEmit(address(desk));
        emit CreditDesk.BatchSkipped(address(stock), p.slots);
        desk.liquidate(p);
    }

    // ---- L-c: the mailbox key comes with the create proof ----

    function test_v32_mailboxKeyIsSetByTheCreateOnly() public {
        TreasuryLedger.AuthProof memory create = TreasuryLedger.AuthProof(hex"00", 7, 8, 9, 0, 0);
        vm.expectEmit(address(ledger));
        emit TreasuryLedger.MailboxKey(7, address(0xbeef));
        ledger.authorize(create, new bytes[](0), "", address(0xbeef));
        TreasuryLedger.AuthProof memory approve = TreasuryLedger.AuthProof(hex"00", 7, 8, 9, 3, 1);
        vm.expectRevert(TreasuryLedger.BadAction.selector);
        ledger.authorize(approve, new bytes[](0), "", address(0xbeef));
        ledger.authorize(approve, new bytes[](0), "", address(0));
    }

    // ---- v3.3 (V39 rescore) ----

    /// A step in `slot` at `rateIndex`, expected to revert with `err` if set. Returns the new leaf.
    function _act(uint8 slot, uint256 oldLeaf, bool close, uint256 collIn, uint256 repay, uint256 rateIndex, bytes4 err) internal returns (uint256 leaf) {
        CreditDesk.PositionExt memory e = CreditDesk.PositionExt(address(0), 0, hex"01", hex"02", hex"03");
        CreditDesk.PositionProof memory p;
        leaf = close ? 0 : _fresh();
        (p.slot, p.collAsset, p.inAsset, p.oldLeaf, p.newLeaf) = (slot, address(stock), repay > 0 ? address(usdg) : address(stock), oldLeaf, leaf);
        (p.collIn, p.repay) = (collIn, repay);
        (p.mark,,) = marker.current(address(stock));
        p.rateIndex = rateIndex;
        p.extDataHash = uint256(keccak256(abi.encode(e))) % FIELD;
        p.root = _root();
        p.inputNullifiers = [_fresh(), _fresh()];
        p.outputCommitments = [_fresh(), _fresh()];
        if (err != bytes4(0)) vm.expectRevert(err);
        desk.act(p, e);
    }

    function _accrue() internal {
        vm.warp(block.timestamp + 1 hours);
        _price(100e8); // keep the mark fresh
        desk.accrue();
        assertTrue(desk.index() != desk.prevIndex(), "the index moved");
    }

    function _health(uint256 snapshotId, uint256 breachCommit) internal view returns (CreditDesk.HealthProof memory h) {
        h.proof = hex"00";
        h.snapshotId = snapshotId;
        for (uint256 i; i < 64; ++i) h.leaves[i] = desk.slots(i);
        (uint64 mark,,) = marker.current(address(stock));
        h.marks[0] = mark;
        h.rateIndex = desk.index();
        h.breachCommit = breachCommit;
    }

    function _batch(uint8 slot, uint256 oldLeaf) internal view returns (CreditDesk.LiquidationProof memory p) {
        (uint64 mark,,) = marker.current(address(stock));
        (p.proof, p.collAsset, p.mark, p.price, p.rateIndex) = (hex"00", address(stock), mark, mark, desk.index());
        (p.slots[0], p.oldLeaves[0], p.newLeaves[0], p.totalSold) = (slot, oldLeaf, _fresh2(oldLeaf), 1e18);
    }

    function _fresh2(uint256 x) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("v33", x))) % (FIELD - 1) + 1;
    }

    /// N-A: the previous index understates debt, so a step that keeps a position open needs the current one.
    function test_v33_openStepNeedsTheCurrentIndex() public {
        uint256 leaf = _act(0, 0, false, 20e18, 0, desk.index(), bytes4(0));
        _accrue();
        uint256 prev = desk.prevIndex();
        _act(0, leaf, false, 1, 0, prev, CreditDesk.StaleIndex.selector); // the report's tiny add at prevIndex
        _act(0, leaf, false, 0, 1e6, prev, CreditDesk.StaleIndex.selector); // a repay that leaves it open, too
        leaf = _act(0, leaf, false, 1, 0, desk.index(), bytes4(0)); // at the current index it lands
        _accrue();
        _act(0, leaf, true, 0, 1e6, desk.prevIndex(), bytes4(0)); // closing may still use the previous index
        assertEq(desk.slots(0), 0);
    }

    /// N-A, cron half: after a batch is skipped because one position stepped, the others are liquidated
    /// in the same epoch by a re-planned batch under the same breached set.
    function test_v33_skippedBatchIsReplannedInTheSameEpoch() public {
        uint256 a = _act(0, 0, false, 20e18, 0, desk.index(), bytes4(0));
        uint256 b = _act(1, 0, false, 20e18, 0, desk.index(), bytes4(0));
        CreditDesk.HealthProof memory h = _health(desk.snapshot(), 7); // proven over the snapshot's leaves
        CreditDesk.LiquidationProof memory both = _batch(0, a);
        (both.slots[1], both.oldLeaves[1], both.newLeaves[1]) = (1, b, _fresh2(b));
        both.totalSold = 2e18;
        _act(0, a, false, 1e18, 0, desk.index(), bytes4(0)); // slot 0 cures after the snapshot
        CreditDesk.LiquidationProof[] memory list = new CreditDesk.LiquidationProof[](1);
        list[0] = both;
        desk.attestAndLiquidate(h, list); // the batch is skipped: slot 0 changed
        uint256 epoch = desk.epoch();
        assertEq(desk.slots(1), b, "slot 1 escaped with the skipped batch");
        desk.liquidate(_batch(1, b)); // the re-plan without slot 0
        assertEq(desk.slots(1), _fresh2(b), "slot 1 liquidated");
        assertEq(desk.epoch(), epoch, "in the same epoch");
    }

    /// N-3: someone sends the operator's epoch proof first with attest(); attestAndLiquidate still lands.
    function test_v33_frontRunAttestDoesNotBlockTheEpoch() public {
        uint256 a = _act(0, 0, false, 20e18, 0, desk.index(), bytes4(0));
        uint256 id = desk.snapshot();
        CreditDesk.HealthProof memory h = _health(id, 7);
        vm.prank(address(0xbad));
        desk.attest(h);
        uint256 epoch = desk.epoch();
        CreditDesk.LiquidationProof[] memory list = new CreditDesk.LiquidationProof[](1);
        list[0] = _batch(0, a);
        desk.attestAndLiquidate(h, list); // reverted StaleSnapshot before v3.3
        assertEq(desk.epoch(), epoch, "not attested twice");
        assertEq(desk.slots(0), _fresh2(a), "its batch went through");
        h.breachCommit = 8; // another breached set for the same snapshot is still refused
        vm.expectRevert(CreditDesk.StaleSnapshot.selector);
        desk.attestAndLiquidate(h, new CreditDesk.LiquidationProof[](0));
    }

    /// H-1r residual: moving dust debt is not activity, so it cannot keep an idle position.
    function test_v33_dustDebtMovesAreNotActivity() public {
        uint256 leaf = _step(0, false, 20e18, 0, 0, 0);
        vm.warp(block.timestamp + 12 hours);
        _step(leaf, false, 0, 0, 1, 0); // a dust repay lands but is not activity
        vm.warp(block.timestamp + 12 hours);
        _evict(20e18);
        assertEq(desk.slots(0), 0);
    }
}
