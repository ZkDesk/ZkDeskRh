// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {IVerifier} from "../src/verifiers/TransactVerifier.sol";
import {IVerifier as IDeskVerifier} from "../src/verifiers/PositionVerifier.sol";

/// Accepts every proof, so the fuzzer can reach any state the contracts allow. What a proof
/// guarantees (value conservation inside the circuit, ownership) is covered by the circuit tests and
/// the real-proof suites; these invariants check the contracts' own accounting.
contract AlwaysTrue is IVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Drives the pool (deposits, clears, refunds, withdrawals, transfers, double-spend attempts) and the
/// desk (open, repay, add, withdraw, close, accrue) with self-consistent public values, keeping ghost
/// totals of everything that should be true.
contract Handler is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant WAD = 1e18;

    ZKDeskPool public pool;
    CreditDesk public desk;
    LendingPoolUSDG public lending;
    Marker public marker;
    MockUSDG public usdg;
    MockStockToken public stock;

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

    constructor(ZKDeskPool pool_, CreditDesk desk_, LendingPoolUSDG lending_, Marker marker_, MockUSDG usdg_, MockStockToken stock_) {
        (pool, desk, lending, marker, usdg, stock) = (pool_, desk_, lending_, marker_, usdg_, stock_);
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
        draw = desk.healthy() ? bound(draw, 0, lending.cash() - lending.reserves()) : 0;
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

    function repay(uint256 seed, uint256 amount) external {
        (bool found, uint8 slot) = _live(seed);
        if (!found || slotDebt[slot] == 0 || ghostShielded[address(usdg)] == 0) return;
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
}

/// Foundry invariant suite (audit "no invariant or fuzz tests"). Run: forge test --mt invariant_
contract InvariantsTest is Test {
    Handler handler;
    ZKDeskPool pool;
    CreditDesk desk;
    LendingPoolUSDG lending;
    MockUSDG usdg;
    MockStockToken stock;

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
        desk.setClass(address(stock), 6000, 7000, type(uint128).max, 0, true);
        gate.setAsset(address(usdg), true);
        gate.setAsset(address(stock), true);
        address[] memory modules = new address[](1);
        modules[0] = address(desk);
        pool.setModules(modules);
        // Lenders.
        deal(address(usdg), address(this), 10_000_000e6);
        usdg.approve(address(lending), type(uint256).max);
        lending.deposit(10_000_000e6, address(this));

        handler = new Handler(pool, desk, lending, marker, usdg, stock);
        targetContract(address(handler));
    }

    /// The pool always holds at least what every note and pending deposit is owed, per asset, and
    /// its books match the operations that succeeded exactly.
    function invariant_poolConservation() public view {
        for (uint256 i; i < 2; ++i) {
            address a = i == 0 ? address(usdg) : address(stock);
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

    /// One slot per live position, and lender NAV is cash plus debt minus reserves, never negative.
    function invariant_slotsAndLenderNav() public view {
        uint256 live;
        for (uint8 i; i < 64; ++i) if (desk.slots(i) != 0) live++;
        assertEq(live, handler.ghostLive(), "one slot per position");
        assertEq(lending.cash(), usdg.balanceOf(address(lending)));
        assertGe(lending.cash() + desk.totalDebt(), lending.reserves(), "reserves backed");
        assertEq(lending.totalAssets(), lending.cash() + desk.totalDebt() - lending.reserves(), "NAV");
    }
}
