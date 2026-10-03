// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {Marker} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockERC4626} from "../src/mocks/MockERC4626.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {LedgerVerifier, IVerifier} from "../src/verifiers/LedgerVerifier.sol";
import {RoleAuthVerifier} from "../src/verifiers/RoleAuthVerifier.sol";
import {TreasuryAttestVerifier} from "../src/verifiers/TreasuryAttestVerifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// v3.4 Payer scope. Real UltraHonk proofs from circuits/scripts/fixtures.mjs (m6.json), in order:
/// 0 create the agent treasury (allow list: Vic + one address; budget 120 USDG a day), 1 deposit 1000,
/// 2 agent pays Vic 60, 3 agent unshields 50 to the listed address, 4 Owner pays Mallory 300,
/// 5 agent pays Mallory 200 (above the threshold), 6 Owner approves 5, 7 agent pays Vic 100 the next
/// day, 8 Owner lifts the scope (set policy), 9 agent pays Mallory 10.
/// The off-list, over-budget and forged-accumulator proofs cannot be made at all: the circuit rejects
/// them (circuits/ledger/src/tests.nr, rejects_scoped_payer_* / rejects_budget_* / rejects_forged_*).
contract ScopeTest is Test {
    address constant USDG = address(0xa55e7);
    address constant VAULT = address(0x7a017);
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant T6 = 1_790_000_000;
    address[4] stocks = [address(0x5b1), address(0x9991), address(0x4e7da), address(0x7e51a)];
    address alice = makeAddr("alice");

    string json;
    ZKDeskPool pool;
    TreasuryLedger ledger;
    uint256 id;

    function setUp() public {
        vm.warp(T6);
        json = vm.readFile("../circuits/fixtures/m6.json");
        id = vm.parseJsonUint(json, ".ledgerId");
        deployCodeTo("MockUSDG.sol:MockUSDG", USDG);
        for (uint256 i; i < 4; ++i) deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode("Test stock", "tSTK", address(this)), stocks[i]);
        deployCodeTo("MockERC4626.sol:MockERC4626", abi.encode(USDG), VAULT);
        AssetGate gate = new AssetGate(address(this), address(this));
        gate.setAsset(USDG, true);
        pool = new ZKDeskPool(new TransactVerifier(), gate, 60);
        Marker marker = new Marker(address(this), address(this), 1 hours);
        IVerifier[3] memory verifiers = [IVerifier(address(new LedgerVerifier())), IVerifier(address(new RoleAuthVerifier())), IVerifier(address(new TreasuryAttestVerifier()))];
        ledger = new TreasuryLedger(verifiers, pool, marker, IERC4626(VAULT), stocks);
        address[] memory modules = new address[](1);
        modules[0] = address(ledger);
        pool.setModules(modules);
        vm.startPrank(alice);
        MockUSDG(USDG).faucet(1000e6);
        IERC20(USDG).approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    // ---- fixture decoding (as in Treasury.t.sol) ----

    function _k(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".txs[", vm.toString(i), "].", field);
    }

    function _x(uint256 i) internal view returns (bytes32[] memory) {
        return vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
    }

    function _runAuth(uint256 i) internal {
        bytes32[] memory x = _x(i);
        TreasuryLedger.AuthProof memory p =
            TreasuryLedger.AuthProof(vm.parseJsonBytes(json, _k(i, "proof")), uint256(x[0]), uint256(x[1]), uint256(x[2]), uint8(uint256(x[3])), uint256(x[4]));
        ledger.authorize(p, vm.parseJsonBytesArray(json, _k(i, "ext.shares")), vm.parseJsonBytes(json, _k(i, "ext.config")), address(0));
    }

    function _act(uint256 i) internal view returns (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) {
        bytes32[] memory x = _x(i);
        p.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        (p.root, p.ledgerId, p.action) = (uint256(x[0]), uint256(x[1]), uint8(uint256(x[4])));
        (p.asset, p.outAsset) = (address(uint160(uint256(x[5]))), address(uint160(uint256(x[6]))));
        (p.publicAmount, p.publicAmountOut, p.extDataHash) = (uint256(x[7]), uint256(x[8]), uint256(x[9]));
        p.inputNullifiers = [uint256(x[10]), uint256(x[11])];
        p.outputCommitments = [uint256(x[12]), uint256(x[13])];
        p.cosignIntent = uint256(x[14]);
        (p.t, p.budgetOld, p.budgetNew) = (uint256(x[16]), uint256(x[17]), uint256(x[18]));
        p.budgetCt = [uint256(x[19]), uint256(x[20])];
        e = TreasuryLedger.LedgerExt({
            recipient: vm.parseJsonAddress(json, _k(i, "ext.recipient")),
            extAmount: vm.parseJsonInt(json, _k(i, "ext.extAmount")),
            encryptedOutput1: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput1")),
            encryptedOutput2: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput2"))
        });
    }

    function _deposit() internal {
        bytes32[] memory x = _x(1);
        ZKDeskPool.Proof memory p = ZKDeskPool.Proof({
            proof: vm.parseJsonBytes(json, _k(1, "proof")), root: uint256(x[0]), publicAmount: uint256(x[1]), extDataHash: uint256(x[2]),
            asset: address(uint160(uint256(x[3]))), outAsset: address(uint160(uint256(x[4]))), publicAmountOut: uint256(x[5]),
            inputNullifiers: [uint256(x[6]), uint256(x[7])], outputCommitments: [uint256(x[8]), uint256(x[9])]
        });
        ZKDeskPool.ExtData memory e = ZKDeskPool.ExtData({
            recipient: address(0), extAmount: vm.parseJsonInt(json, _k(1, "ext.extAmount")), relayer: address(0), fee: 0, converter: address(0),
            encryptedOutput1: vm.parseJsonBytes(json, _k(1, "ext.encryptedOutput1")), encryptedOutput2: vm.parseJsonBytes(json, _k(1, "ext.encryptedOutput2"))
        });
        vm.prank(alice);
        pool.transact(p, e);
        vm.warp(block.timestamp + 60);
        pool.clear(0);
    }

    function _runAct(uint256 i) internal {
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(i);
        if (block.timestamp < p.t) vm.warp(p.t);
        vm.prank(address(0xbeef)); // relayed: any sender
        ledger.act(p, e);
        assertEq(ledger.budgetCommit(id), p.budgetNew, "the accumulator is the proof's");
    }

    /// Runs the first n fixtures in chain order (the Owner approval lands before the transfer it approves).
    function _through(uint256 n) internal {
        uint8[13] memory order = [0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 11, 12];
        for (uint256 k; k < n; ++k) {
            uint256 i = order[k];
            if (i == 1) _deposit();
            else if (i == 0 || i == 6 || i == 8 || i == 10) _runAuth(i);
            else _runAct(i);
        }
    }

    // ---- tests ----

    function test_v34_scopedAgentLifecycle() public {
        _through(10);
        assertEq(IERC20(USDG).balanceOf(vm.parseJsonAddress(json, ".vaddr")), 50e6, "the listed address got the unshield");
        assertEq(pool.shieldedSupply(USDG), 950e6);
        (, uint256 policy,) = ledger.ledgers(id);
        assertEq(policy, vm.parseJsonUint(json, ".policyHash2"));
    }

    /// One accumulator per ledger: a transfer proven against an older one cannot land.
    function test_v34_accumulatorIsSerialized() public {
        _through(3); // create, deposit, agent pays Vic 60
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(4); // proven after fixture 3
        vm.warp(p.t);
        vm.expectRevert(TreasuryLedger.StaleBudget.selector);
        ledger.act(p, e);
        _runAct(3);
        (p, e) = _act(2); // a replay opens an accumulator that is no longer current
        vm.expectRevert(TreasuryLedger.StaleBudget.selector);
        ledger.act(p, e);
        _runAct(4);
    }

    /// The proof's time sets the budget window, so it must be recent and never in the future.
    function test_v34_proofTimeMustBeFresh() public {
        _through(2);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(2);
        assertLt(block.timestamp, p.t);
        vm.expectRevert(TreasuryLedger.StaleTime.selector);
        ledger.act(p, e);
        uint256 snap = vm.snapshotState();
        vm.warp(p.t + ledger.MAX_PROOF_AGE() + 1);
        vm.expectRevert(TreasuryLedger.StaleTime.selector);
        ledger.act(p, e);
        vm.revertToState(snap);
        vm.warp(p.t + ledger.MAX_PROOF_AGE());
        ledger.act(p, e);
    }

    /// A policy change (and a roles rotation, Treasury.t.sol) resets the accumulator.
    function test_v34_policyChangeResetsTheAccumulator() public {
        _through(8); // through the next day's payment
        assertTrue(ledger.budgetCommit(id) != 0);
        vm.recordLogs();
        _runAuth(8);
        assertEq(ledger.budgetCommit(id), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool reset;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != TreasuryLedger.BudgetNote.selector) continue;
            (uint256 commit, uint256 nonce, uint256[2] memory ct) = abi.decode(logs[i].data, (uint256, uint256, uint256[2]));
            reset = commit == 0 && nonce == 0 && ct[0] == 0 && ct[1] == 0;
        }
        assertTrue(reset, "a reset BudgetNote");
        _runAct(9);
    }

    /// A non-canonical accumulator (>= the field) could never be opened again, freezing the ledger.
    function test_v34_nonCanonicalAccumulatorIsRejected() public {
        _through(2);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(2);
        vm.warp(p.t);
        p.budgetNew += FIELD;
        vm.expectRevert(TreasuryLedger.StaleBudget.selector);
        ledger.act(p, e);
    }

    /// The accumulator is bound by the proof: a relayer cannot swap it.
    function test_v34_accumulatorIsBoundByTheProof() public {
        _through(2);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(2);
        vm.warp(p.t);
        p.budgetNew ^= 1;
        vm.expectRevert();
        ledger.act(p, e);
        (p, e) = _act(2);
        p.budgetCt[1] ^= 1;
        vm.expectRevert();
        ledger.act(p, e);
        (p, e) = _act(2);
        ledger.act(p, e);
    }

    /// On-chain the agent's payment shows only masked values: neither the 60 USDG nor the window.
    function test_v34_budgetNoteIsMasked() public {
        _through(2);
        vm.recordLogs();
        _runAct(2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != TreasuryLedger.BudgetNote.selector) continue;
            (, , uint256[2] memory ct) = abi.decode(logs[i].data, (uint256, uint256, uint256[2]));
            assertTrue(ct[0] != 0 && ct[1] != 60e6, "masked");
            return;
        }
        fail();
    }

    /// v3.5: the Owner gives the agent an access end. The agent pays just before it, the Owner after it
    /// (the circuit refuses any Payer transfer at or after the end: circuits/ledger tests).
    function test_v35_agentAccessEnds() public {
        _through(13);
        (, uint256 policy,) = ledger.ledgers(id);
        assertEq(policy, vm.parseJsonUint(json, ".policyHash3"));
        assertGt(block.timestamp, vm.parseJsonUint(json, ".end"), "the Owner paid after the end");
    }

    /// A payment dated just before the end (a proof may also be made after the end and dated back) may
    /// still land up to MAX_PROOF_AGE after its date, never later.
    function test_v35_landingWindowAfterTheEnd() public {
        _through(11);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(11);
        uint256 end = vm.parseJsonUint(json, ".end");
        assertLt(p.t, end);
        uint256 snap = vm.snapshotState();
        vm.warp(p.t + ledger.MAX_PROOF_AGE() + 1);
        vm.expectRevert(TreasuryLedger.StaleTime.selector);
        ledger.act(p, e);
        vm.revertToState(snap);
        vm.warp(p.t + ledger.MAX_PROOF_AGE());
        assertGt(block.timestamp, end);
        ledger.act(p, e);
    }
}
