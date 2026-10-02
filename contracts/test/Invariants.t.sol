// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

/// Accepts every proof, so the fuzzer can reach any state the contracts allow. What a proof
/// guarantees (value conservation inside the circuit, ownership) is covered by the circuit tests and
/// the real-proof suites; these invariants check the contracts' own accounting.
contract AlwaysTrue is IVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Drives the pool (deposits, clears, refunds, withdrawals, transfers, double-spend attempts), the
/// desk (open, repay, withdraw, close, accrue, snapshot + attest, liquidate, stale batches, evict) and
/// treasury ledgers (create, approve, limits, transfers, allocate / deallocate) with self-consistent
/// public values (what an honest prover would submit), keeping ghost totals of what should be true.
contract Handler is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant WAD = 1e18;

    ZKDeskPool public pool;
    CreditDesk public desk;
    LendingPoolUSDG public lending;
    Marker public marker;
    MockUSDG public usdg;
    MockStockToken public stock;
    MockAMM public amm;
    TreasuryLedger public ledger;
    MockERC4626 public vault;

    uint256 nonce;
    uint256[] spentNullifiers;
    struct Pending {
        uint256 id;
        address asset;
        uint256 amount;
    }
    Pending[] pending;

    // Ghost accounting.
    mapping(address asset => uint256) public ghostShielded;
    mapping(address asset => uint256) public ghostPending;
    uint256 public ghostDebtScaled;
    uint256 public ghostCollateral;
    uint256 public ghostLive;
    bool public doubleSpent;
    mapping(uint8 slot => uint256) public slotColl;
    mapping(uint8 slot => uint256) public slotDebt;
    bool public staleBatchMoved; // a batch over changed slots moved funds
    bool public snapshotReused; // a snapshot backed two epochs
    uint256 public liquidations;
    uint256 public evictions;

    // Treasury ledgers.
    uint256[] ledgerIds;
    mapping(uint256 id => uint256[]) intents;
    mapping(uint256 id => uint64) maxTransfers;
    mapping(uint256 id => uint64) windowStart;
    mapping(uint256 id => uint64) usedInWindow;
    bool public intentReused; // an approval paid for two transfers
    bool public unapprovedIntentPaid;
    bool public limitBreached; // more unapproved transfers in a window than the ledger's limit
    uint256 public ledgerActs;

    constructor(ZKDeskPool pool_, CreditDesk desk_, LendingPoolUSDG lending_, Marker marker_, MockUSDG usdg_, MockStockToken stock_, MockAMM amm_, TreasuryLedger ledger_) {
        (pool, desk, lending, marker) = (pool_, desk_, lending_, marker_);
        (usdg, stock, amm, ledger) = (usdg_, stock_, amm_, ledger_);
        vault = MockERC4626(address(ledger_.vault()));
        usdg.approve(address(pool), type(uint256).max);
        stock.approve(address(pool), type(uint256).max);
    }

    function _fresh() internal returns (uint256) {
        return uint256(keccak256(abi.encode("zkdesk", ++nonce))) % (FIELD - 1) + 1;
    }

    function _root() internal view returns (uint256) {
        return pool.size() == 0 ? 0 : pool.root();
    }

    function _transact(address asset, int256 extAmount, uint256 fee, address recipient, uint256[2] memory nullifiers) internal returns (bool ok) {
        ZKDeskPool.ExtData memory e = ZKDeskPool.ExtData(recipient, extAmount, fee == 0 ? address(0) : address(0xfee), fee, address(0), hex"01", hex"02");
        ZKDeskPool.Proof memory p = ZKDeskPool.Proof({
            proof: hex"00", root: _root(), publicAmount: pool.publicAmountOf(extAmount, fee), extDataHash: uint256(keccak256(abi.encode(e))) % FIELD,
            asset: asset, outAsset: asset, publicAmountOut: 0, inputNullifiers: nullifiers, outputCommitments: [_fresh(), _fresh()]
        });
        try pool.transact(p, e) {
            ok = true;
        } catch {}
    }

    // ---- pool ----

    function deposit(bool useStock, uint256 amount) external {
        address asset = useStock ? address(stock) : address(usdg);
        amount = bound(amount, 1, useStock ? 1_000e18 : 100_000e6); // the mocks' faucet caps
        if (useStock) stock.faucet(amount);
        else usdg.faucet(amount);
        if (!_transact(asset, int256(amount), 0, address(0), [_fresh(), _fresh()])) return;
        pending.push(Pending(pool.depositCount() - 1, asset, amount));
        ghostPending[asset] += amount;
    }

    function clear(uint256 i) external {
        if (pending.length == 0) return;
        i = i % pending.length;
        Pending memory d = pending[i];
        vm.warp(block.timestamp + 60);
        pool.clear(d.id);
        (ghostPending[d.asset], ghostShielded[d.asset]) = (ghostPending[d.asset] - d.amount, ghostShielded[d.asset] + d.amount);
        pending[i] = pending[pending.length - 1];
        pending.pop();
    }

    function refund(uint256 i) external {
        if (pending.length == 0) return;
        i = i % pending.length;
        Pending memory d = pending[i];
        pool.refundToOrigin(d.id);
        ghostPending[d.asset] -= d.amount;
        pending[i] = pending[pending.length - 1];
        pending.pop();
    }

    /// Withdrawal (amount > 0) or private transfer (amount 0), paying a relay fee.
    function spend(bool useStock, uint256 amount, uint256 fee) external {
        address asset = useStock ? address(stock) : address(usdg);
        uint256 have = ghostShielded[asset];
        amount = bound(amount, 0, have);
        fee = bound(fee, 0, have - amount);
        uint256[2] memory n = [_fresh(), _fresh()];
        if (!_transact(asset, -int256(amount), fee, amount > 0 ? address(0xdead) : address(0), n)) return;
        ghostShielded[asset] -= amount + fee;
        spentNullifiers.push(n[0]);
    }

    function doubleSpend(uint256 i) external {
        if (spentNullifiers.length == 0) return;
        uint256 n = spentNullifiers[i % spentNullifiers.length];
        if (_transact(address(usdg), 0, 0, address(0), [n, _fresh()])) doubleSpent = true;
    }

    // ---- desk ----

    function _act(CreditDesk.PositionProof memory p) internal returns (bool ok) {
        CreditDesk.PositionExt memory e = CreditDesk.PositionExt(address(0), 0, hex"01", hex"02", hex"03");
        p.extDataHash = uint256(keccak256(abi.encode(e))) % FIELD;
        p.root = _root();
        p.inputNullifiers = [_fresh(), _fresh()];
        p.outputCommitments = [_fresh(), _fresh()];
        (uint64 mark,,) = marker.current(address(stock));
        p.mark = mark;
        p.rateIndex = desk.index();
        try desk.act(p, e) {
            ok = true;
        } catch {}
    }

    function open(uint256 coll, uint256 draw) external {
        uint8 slot = 64;
        for (uint8 i; i < 64; ++i) if (desk.slots(i) == 0) { slot = i; break; }
        if (slot == 64 || ghostShielded[address(stock)] == 0) return;
        coll = bound(coll, 1, ghostShielded[address(stock)]);
        draw = desk.healthy() ? bound(draw, 0, lending.available()) : 0;
        CreditDesk.PositionProof memory p;
        (p.slot, p.collAsset, p.inAsset, p.newLeaf, p.collIn, p.draw) = (slot, address(stock), address(stock), _fresh(), coll, draw);
        p.drawScaled = draw == 0 ? 0 : (draw * WAD + desk.index() - 1) / desk.index();
        if (!_act(p)) return;
        (ghostShielded[address(stock)], ghostShielded[address(usdg)]) = (ghostShielded[address(stock)] - coll, ghostShielded[address(usdg)] + draw);
        (slotColl[slot], slotDebt[slot]) = (coll, p.drawScaled);
        ghostCollateral += coll;
        ghostDebtScaled += p.drawScaled;
        ghostLive++;
    }

    function _live(uint256 seed) internal view returns (bool found, uint8 slot) {
        for (uint256 k; k < 64; ++k) {
            slot = uint8((seed + k) % 64);
            if (desk.slots(slot) != 0) return (true, slot);
        }
    }

    /// Steps on a live slot are STEP_INTERVAL apart (v3); closing is not.
    function _space(uint8 slot) internal {
        uint256 next = desk.touchedAt(slot) + desk.STEP_INTERVAL();
        if (block.timestamp < next) vm.warp(next);
    }

    function repay(uint256 seed, uint256 amount) external {
        (bool found, uint8 slot) = _live(seed);
        if (!found || slotDebt[slot] == 0 || ghostShielded[address(usdg)] == 0) return;
        _space(slot);
        uint256 index = desk.index();
        amount = bound(amount, 1, ghostShielded[address(usdg)]);
        uint256 scaled = amount * WAD / index;
        if (scaled > slotDebt[slot]) (scaled, amount) = (slotDebt[slot], slotDebt[slot] * index / WAD);
        CreditDesk.PositionProof memory p;
        (p.slot, p.collAsset, p.inAsset, p.oldLeaf, p.newLeaf, p.repay, p.repayScaled) = (slot, address(stock), address(usdg), desk.slots(slot), _fresh(), amount, scaled);
        if (!_act(p)) return;
        ghostShielded[address(usdg)] -= amount;
        slotDebt[slot] -= scaled;
        ghostDebtScaled -= scaled;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        (bool found, uint8 slot) = _live(seed);
        if (!found || slotColl[slot] == 0) return;
        amount = bound(amount, 1, slotColl[slot]);
        bool closes = amount == slotColl[slot] && slotDebt[slot] == 0;
        if (!closes) _space(slot);
        CreditDesk.PositionProof memory p;
        (p.slot, p.collAsset, p.inAsset, p.oldLeaf, p.newLeaf, p.collOut) = (slot, address(stock), address(stock), desk.slots(slot), closes ? 0 : _fresh(), amount);
        if (!_act(p)) return;
        ghostShielded[address(stock)] += amount;
        slotColl[slot] -= amount;
        ghostCollateral -= amount;
        if (closes) ghostLive--;
    }

    function accrue(uint256 minutes_) external {
        vm.warp(block.timestamp + bound(minutes_, 1, 60) * 1 minutes);
        desk.accrue();
    }

    /// Snapshot, then attest it; a second epoch over the same snapshot must fail.
    function attest(uint256 salt) external {
        CreditDesk.HealthProof memory h;
        h.proof = hex"00";
        h.snapshotId = desk.snapshot();
        h.leaves = desk.allSlots();
        (uint64 mark,,) = marker.current(address(stock));
        h.marks[0] = mark;
        h.rateIndex = desk.index();
        h.breachCommit = salt % FIELD;
        try desk.attest(h) {} catch {
            return;
        }
        try desk.attest(h) {
            snapshotReused = true;
        } catch {}
    }

    /// A sealed batch over one slot at the venue's price (the honest operator's public values).
    function _batch(uint8 slot) internal view returns (CreditDesk.LiquidationProof memory p) {
        (uint64 mark,,) = marker.current(address(stock));
        (p.proof, p.collAsset, p.mark, p.price, p.rateIndex) = (hex"00", address(stock), mark, amm.quote(address(stock)), desk.index());
        p.slots[0] = slot;
    }

    /// One position sold in a sealed batch: part or all of its collateral, repaying at most the sale
    /// value; selling everything writes off the rest of the debt.
    function liquidate(uint256 seed, uint256 sellBps, uint256 repayBps) external {
        (bool found, uint8 slot) = _live(seed);
        if (!found || slotColl[slot] == 0) return;
        CreditDesk.LiquidationProof memory p = _batch(slot);
        p.totalSold = slotColl[slot] * bound(sellBps, 1, 10_000) / 10_000;
        if (p.totalSold == 0) p.totalSold = slotColl[slot];
        p.totalValue = p.totalSold * p.price / 1e20;
        uint256 cap = p.totalValue * WAD / p.rateIndex;
        p.totalRepaidScaled = (slotDebt[slot] < cap ? slotDebt[slot] : cap) * bound(repayBps, 0, 10_000) / 10_000;
        p.totalRepay = p.totalRepaidScaled * p.rateIndex / WAD;
        bool all = p.totalSold == slotColl[slot];
        if (all) p.totalWrittenOff = slotDebt[slot] - p.totalRepaidScaled;
        (p.oldLeaves[0], p.newLeaves[0]) = (desk.slots(slot), all ? 0 : _fresh());
        try desk.liquidate(p) {} catch {
            return;
        }
        liquidations++;
        ghostCollateral -= p.totalSold;
        ghostDebtScaled -= p.totalRepaidScaled + p.totalWrittenOff;
        slotColl[slot] -= p.totalSold;
        slotDebt[slot] -= p.totalRepaidScaled + p.totalWrittenOff;
        if (all) ghostLive--;
    }

    /// A batch whose slot changed after the snapshot is skipped: nothing moves.
    function staleLiquidation(uint256 seed) external {
        (bool found, uint8 slot) = _live(seed);
        if (!found) return;
        (uint256 debt, uint256 coll, uint256 cash) = (desk.totalDebtScaled(), desk.totalCollateral(address(stock)), lending.cash());
        CreditDesk.LiquidationProof memory p = _batch(slot);
        p.oldLeaves[0] = _fresh(); // not the slot's leaf
        (p.totalSold, p.totalRepaidScaled) = (slotColl[slot], slotDebt[slot]);
        try desk.liquidate(p) {} catch {}
        if (desk.totalDebtScaled() != debt || desk.totalCollateral(address(stock)) != coll || lending.cash() != cash) staleBatchMoved = true;
    }

    /// An idle position without debt goes back to its owner as a note after EVICT_AFTER.
    function evict(uint256 seed) external {
        (bool found, uint8 slot) = _live(seed);
        if (!found || slotDebt[slot] != 0) return;
        uint256 due = desk.touchedAt(slot) + desk.EVICT_AFTER();
        if (block.timestamp < due) vm.warp(due);
        uint256 coll = slotColl[slot];
        try desk.evict(CreditDesk.EvictProof(hex"00", slot, address(stock), coll, _fresh())) {} catch {
            return;
        }
        evictions++;
        ghostShielded[address(stock)] += coll;
        ghostCollateral -= coll;
        slotColl[slot] = 0;
        ghostLive--;
    }

    // ---- treasury ledgers ----

    function _auth(uint256 id, uint8 action, uint256 newValue) internal returns (bool ok) {
        (uint256 roles, uint256 policy,) = ledger.ledgers(id);
        if (action == 0) (roles, policy) = (_fresh(), _fresh());
        try ledger.authorize(TreasuryLedger.AuthProof(hex"00", id, roles, policy, action, newValue), new bytes[](0), "", address(0)) {
            ok = true;
        } catch {}
    }

    function createLedger() external {
        uint256 id = _fresh();
        if (_auth(id, 0, 0)) ledgerIds.push(id);
    }

    function approveIntent(uint256 seed) external {
        if (ledgerIds.length == 0) return;
        uint256 id = ledgerIds[seed % ledgerIds.length];
        uint256 intent = _fresh();
        if (_auth(id, 3, intent)) intents[id].push(intent);
    }

    function setLimit(uint256 seed, uint64 max_, uint64 period) external {
        if (ledgerIds.length == 0) return;
        uint256 id = ledgerIds[seed % ledgerIds.length];
        max_ = uint64(bound(max_, 0, 3));
        period = uint64(bound(period, 1 hours, 2 days));
        if (!_auth(id, 4, uint256(max_) | uint256(period) << 64)) return;
        (maxTransfers[id], windowStart[id], usedInWindow[id]) = (max_, uint64(block.timestamp), 0);
    }

    function _ledgerAct(uint256 id, uint8 action, address asset, address outAsset, uint256 amount, address recipient, uint256 intent) internal returns (bool ok) {
        TreasuryLedger.LedgerExt memory e = TreasuryLedger.LedgerExt(recipient, -int256(amount), hex"01", hex"02");
        TreasuryLedger.LedgerProof memory p;
        (p.proof, p.root, p.ledgerId, p.action, p.asset, p.outAsset) = (hex"00", _root(), id, action, asset, outAsset);
        p.publicAmount = pool.publicAmountOf(e.extAmount, 0);
        p.extDataHash = uint256(keccak256(abi.encode(e))) % FIELD;
        (p.inputNullifiers, p.outputCommitments, p.cosignIntent) = ([_fresh(), _fresh()], [_fresh(), _fresh()], intent);
        try ledger.act(p, e) {
            ok = true;
            ledgerActs++;
        } catch {}
    }

    /// mode 0: no intent; 1: an Owner-approved intent (taken off the list); 2: an intent never approved.
    function _intent(uint256 id, uint256 seed, uint8 mode) internal returns (bool ok, uint256 intent) {
        if (mode == 0) return (true, 0);
        if (mode == 2) return (true, _fresh());
        uint256[] storage list = intents[id];
        if (list.length == 0) return (false, 0);
        uint256 k = seed % list.length;
        intent = list[k];
        list[k] = list[list.length - 1];
        list.pop();
        ok = true;
    }

    /// A Payer transfer (private, or out to an address). Without an intent it counts toward the limit;
    /// an approved intent is then replayed, which must fail.
    function ledgerTransfer(uint256 seed, uint256 amount, bool out, uint256 intentSeed, uint8 mode) external {
        if (ledgerIds.length == 0) return;
        uint256 id = ledgerIds[seed % ledgerIds.length];
        mode = mode % 3;
        (bool ok, uint256 intent) = _intent(id, intentSeed, mode);
        if (!ok) return;
        amount = out ? bound(amount, 0, ghostShielded[address(usdg)]) : 0;
        bool newWindow = _newWindow(id);
        if (!_ledgerAct(id, 2, address(usdg), address(usdg), amount, amount > 0 ? address(0xdead) : address(0), intent)) {
            if (mode == 1) intents[id].push(intent); // still approved
            return;
        }
        ghostShielded[address(usdg)] -= amount;
        if (mode == 2) unapprovedIntentPaid = true;
        if (mode == 1 && _ledgerAct(id, 2, address(usdg), address(usdg), 0, address(0), intent)) intentReused = true;
        if (mode != 0 || maxTransfers[id] == 0) return;
        if (newWindow) (windowStart[id], usedInWindow[id]) = (uint64(block.timestamp), 0);
        if (++usedInWindow[id] > maxTransfers[id]) limitBreached = true;
    }

    function _newWindow(uint256 id) internal view returns (bool) {
        (, uint64 period,,) = ledger.limits(id);
        return block.timestamp >= windowStart[id] + period;
    }

    /// The Treasurer moves USDG into the yield vault, or vault shares back to USDG.
    function ledgerAllocate(uint256 seed, uint256 amount, bool back) external {
        if (ledgerIds.length == 0) return;
        uint256 id = ledgerIds[seed % ledgerIds.length];
        (address from, address to) = back ? (address(vault), address(usdg)) : (address(usdg), address(vault));
        if (ghostShielded[from] == 0) return;
        amount = bound(amount, 1, ghostShielded[from]);
        uint256 before = IERC20(to).balanceOf(address(pool));
        if (!_ledgerAct(id, back ? 1 : 0, from, to, amount, address(0), 0)) return;
        ghostShielded[from] -= amount;
        ghostShielded[to] += IERC20(to).balanceOf(address(pool)) - before;
    }
}

/// Foundry invariant suite (audit "no invariant or fuzz tests"). Run: forge test --mt invariant_
contract InvariantsTest is Test {
    Handler handler;
    ZKDeskPool pool;
    CreditDesk desk;
    LendingPoolUSDG lending;
    MockUSDG usdg;
    MockStockToken stock;
    TreasuryLedger ledger;
    MockERC4626 vault;

    function setUp() public {
        usdg = new MockUSDG();
        stock = new MockStockToken("Test stock", "tSTK", address(this));
        AssetGate gate = new AssetGate(address(this), address(this));
        IVerifier yes = new AlwaysTrue();
        pool = new ZKDeskPool(yes, gate, 60);
        lending = new LendingPoolUSDG(usdg, address(this));
        MockAggregatorV3 feed = new MockAggregatorV3("STK / USD", address(this), address(this));
        feed.setAnswer(100e8);
        Marker marker = new Marker(address(this), address(this), 365 days);
        marker.setFeed(address(stock), IAggregatorV3(address(feed)));
        marker.pin(address(stock));
        IDeskVerifier dyes = IDeskVerifier(address(yes));
        desk = new CreditDesk([dyes, dyes, dyes, dyes], pool, marker, lending, [uint256(1), 2], address(this));
        lending.setDesk(IDeskDebt(address(desk)));
        desk.setClass(address(stock), 6000, 7000, type(uint128).max, 0, 0, true);
        MockAMM amm = new MockAMM(marker, usdg);
        desk.setVenue(ISaleVenue(address(amm)), address(0xb0b));
        vault = new MockERC4626(usdg);
        address s = address(stock);
        ILedgerVerifier lyes = ILedgerVerifier(address(yes));
        ledger = new TreasuryLedger([lyes, lyes, lyes], pool, marker, vault, [s, s, s, s]);
        gate.setAsset(address(usdg), true);
        gate.setAsset(address(stock), true);
        address[] memory modules = new address[](2);
        (modules[0], modules[1]) = (address(desk), address(ledger));
        pool.setModules(modules);
        // Lenders.
        deal(address(usdg), address(this), 10_000_000e6);
        usdg.approve(address(lending), type(uint256).max);
        lending.deposit(10_000_000e6, address(this));

        handler = new Handler(pool, desk, lending, marker, usdg, stock, amm, ledger);
        targetContract(address(handler));
    }

    /// The pool always holds at least what every note and pending deposit is owed, per asset, and
    /// its books match the operations that succeeded exactly.
    function invariant_poolConservation() public view {
        for (uint256 i; i < 3; ++i) {
            address a = i == 0 ? address(usdg) : i == 1 ? address(stock) : address(vault);
            assertEq(pool.shieldedSupply(a), handler.ghostShielded(a), "shielded supply");
            assertEq(pool.pendingSupply(a), handler.ghostPending(a), "pending supply");
            assertGe(IERC20(a).balanceOf(address(pool)), pool.shieldedSupply(a) + pool.pendingSupply(a), "pool solvent");
        }
    }

    /// No nullifier is ever accepted twice.
    function invariant_noDoubleSpend() public view {
        assertFalse(handler.doubleSpent());
    }

    /// Every insertion is a root; the current root is always spendable against.
    function invariant_rootHistory() public view {
        assertEq(pool.rootCount(), pool.size());
        if (pool.size() > 0) assertTrue(pool.isKnownRoot(pool.root()));
    }

    /// The desk holds exactly the collateral its positions account for, and its debt matches.
    function invariant_deskBooks() public view {
        assertEq(stock.balanceOf(address(desk)), desk.totalCollateral(address(stock)), "desk collateral held");
        assertEq(desk.totalCollateral(address(stock)), handler.ghostCollateral(), "collateral ledger");
        assertEq(desk.totalDebtScaled(), handler.ghostDebtScaled(), "debt ledger");
    }

    /// The desk never keeps USDG (sale proceeds go to lenders and the bonus sink in the same call), a
    /// batch over changed slots never moves funds, and a snapshot backs at most one epoch.
    function invariant_liquidationAndEpochs() public view {
        assertEq(usdg.balanceOf(address(desk)), 0, "desk holds no USDG");
        assertFalse(handler.staleBatchMoved(), "stale batch skipped");
        assertFalse(handler.snapshotReused(), "snapshot single-use");
        assertLe(desk.attestedSnapshot(), desk.snapshotCount());
    }

    /// Treasury approvals pay for exactly one transfer, unapproved intents never pay, and unapproved
    /// transfers stay within the ledger's limit per window. The ledger never keeps funds.
    function invariant_treasuryLedger() public view {
        assertFalse(handler.intentReused(), "approval used once");
        assertFalse(handler.unapprovedIntentPaid(), "intent must be approved");
        assertFalse(handler.limitBreached(), "transfer limit");
        assertEq(usdg.balanceOf(address(ledger)), 0, "ledger holds no USDG");
        assertEq(vault.balanceOf(address(ledger)), 0, "ledger holds no vault shares");
    }

    /// One slot per live position, and lender NAV is cash plus debt minus reserves, never negative.
    function invariant_slotsAndLenderNav() public view {
        uint256 live;
        for (uint8 i; i < 64; ++i) if (desk.slots(i) != 0) live++;
        assertEq(live, handler.ghostLive(), "one slot per position");
        assertEq(lending.cash(), usdg.balanceOf(address(lending)));
        assertGe(lending.cash() + desk.totalDebt(), lending.reserves(), "reserves backed");
        assertEq(lending.totalAssets(), lending.cash() + desk.totalDebt() - lending.reserves(), "NAV");
    }

    /// Every handler path the invariants rely on succeeds in a fixed sequence (so a handler that silently
    /// stops working fails here rather than leaving an invariant vacuous).
    function test_handlersReachEveryPath() public {
        handler.deposit(true, 10e18);
        handler.deposit(false, 1_000e6);
        handler.clear(0);
        handler.clear(0);
        handler.open(5e18, 0); // no epoch yet: no draw
        handler.attest(1);
        handler.open(2e18, 100e6);
        handler.liquidate(1, 5_000, 5_000);
        handler.staleLiquidation(1);
        handler.evict(0);
        assertGt(handler.liquidations(), 0, "liquidation");
        assertGt(handler.evictions(), 0, "eviction");
        assertEq(desk.epoch(), 1, "epoch");
        handler.createLedger();
        handler.approveIntent(0);
        handler.setLimit(0, 1, 1 days);
        handler.ledgerTransfer(0, 0, false, 0, 1); // approved intent, then its replay
        handler.ledgerTransfer(0, 0, false, 0, 0); // 1st under the limit
        handler.ledgerTransfer(0, 0, false, 0, 0); // 2nd: over the limit, refused
        handler.ledgerTransfer(0, 0, false, 0, 2); // never approved, refused
        handler.ledgerAllocate(0, 100e6, false);
        handler.ledgerAllocate(0, 1, true);
        assertEq(handler.ledgerActs(), 4, "intent, one limited transfer, allocate, deallocate");
        invariant_poolConservation();
        invariant_deskBooks();
        invariant_liquidationAndEpochs();
        invariant_treasuryLedger();
        invariant_slotsAndLenderNav();
    }
}
