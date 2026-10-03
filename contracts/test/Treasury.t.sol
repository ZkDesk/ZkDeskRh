// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {MockERC4626} from "../src/mocks/MockERC4626.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {LedgerVerifier, IVerifier} from "../src/verifiers/LedgerVerifier.sol";
import {RoleAuthVerifier} from "../src/verifiers/RoleAuthVerifier.sol";
import {TreasuryAttestVerifier} from "../src/verifiers/TreasuryAttestVerifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// Real UltraHonk proofs from circuits/scripts/fixtures.mjs (m4.json), in order:
/// 0 create ledger (Owner Alice), 1 deposit 1000 USDG into the ledger, 2 attest 900 liabilities,
/// 3 allocate 600 to the vault (Treasurer), 4 transfer 50 (Payer, under the threshold),
/// 5 transfer 200 (Payer, over the threshold), 6 Owner approves 5, 7 deallocate (Treasurer),
/// 8 rotate: Eve replaces Carol as Payer, 9 transfer 10 (Eve).
contract TreasuryTest is Test {
    address constant USDG = address(0xa55e7);
    address constant SPY = address(0x5b1);
    address constant VAULT = address(0x7a017);
    address[4] stocks = [SPY, address(0x9991), address(0x4e7da), address(0x7e51a)];
    address alice = makeAddr("alice");

    string json;
    AssetGate gate;
    ZKDeskPool pool;
    Marker marker;
    MockAggregatorV3 feed;
    TreasuryLedger ledger;
    uint256 id;

    uint256 constant T4 = 1_790_000_000; // the fixtures' transfers are proven at this time

    function setUp() public {
        vm.warp(T4); // start at the proof time, so the mock vault accrues no yield in between
        json = vm.readFile("../circuits/fixtures/m4.json");
        id = vm.parseJsonUint(json, ".ledgerId");
        deployCodeTo("MockUSDG.sol:MockUSDG", USDG);
        for (uint256 i; i < 4; ++i) deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode("Test stock", "tSTK", address(this)), stocks[i]);
        deployCodeTo("MockERC4626.sol:MockERC4626", abi.encode(USDG), VAULT);
        gate = new AssetGate(address(this), address(this));
        gate.setAsset(USDG, true);
        gate.setAsset(VAULT, true);
        pool = new ZKDeskPool(new TransactVerifier(), gate, 60);
        marker = new Marker(address(this), address(this), 1 hours);
        feed = new MockAggregatorV3("SPY / USD", address(this), address(this));
        feed.setAnswer(500e8);
        marker.setFeed(SPY, IAggregatorV3(address(feed)));
        marker.pin(SPY);
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

    // ---- fixture decoding ----

    function _k(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".txs[", vm.toString(i), "].", field);
    }

    function _x(uint256 i) internal view returns (bytes32[] memory) {
        return vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
    }

    function _auth(uint256 i) internal view returns (TreasuryLedger.AuthProof memory p, bytes[] memory shares, bytes memory config) {
        bytes32[] memory x = _x(i);
        p = TreasuryLedger.AuthProof(vm.parseJsonBytes(json, _k(i, "proof")), uint256(x[0]), uint256(x[1]), uint256(x[2]), uint8(uint256(x[3])), uint256(x[4]));
        shares = vm.parseJsonBytesArray(json, _k(i, "ext.shares"));
        config = vm.parseJsonBytes(json, _k(i, "ext.config"));
    }

    function _act(uint256 i) internal view returns (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) {
        bytes32[] memory x = _x(i);
        p.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        p.root = uint256(x[0]);
        p.ledgerId = uint256(x[1]);
        p.action = uint8(uint256(x[4]));
        p.asset = address(uint160(uint256(x[5])));
        p.outAsset = address(uint160(uint256(x[6])));
        p.publicAmount = uint256(x[7]);
        p.publicAmountOut = uint256(x[8]);
        p.extDataHash = uint256(x[9]);
        p.inputNullifiers = [uint256(x[10]), uint256(x[11])];
        p.outputCommitments = [uint256(x[12]), uint256(x[13])];
        p.cosignIntent = uint256(x[14]);
        p.t = uint256(x[16]);
        p.budgetOld = uint256(x[17]);
        p.budgetNew = uint256(x[18]);
        p.budgetCt = [uint256(x[19]), uint256(x[20])];
        e = TreasuryLedger.LedgerExt({
            recipient: vm.parseJsonAddress(json, _k(i, "ext.recipient")),
            extAmount: vm.parseJsonInt(json, _k(i, "ext.extAmount")),
            encryptedOutput1: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput1")),
            encryptedOutput2: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput2"))
        });
    }

    function _attest(uint256 i) internal view returns (TreasuryLedger.AttestProof memory p) {
        bytes32[] memory x = _x(i);
        p.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        p.root = uint256(x[0]);
        p.ledgerId = uint256(x[1]);
        p.liabilities = uint256(x[2]);
        for (uint256 j; j < 8; ++j) p.nullifiers[j] = uint256(x[15 + j]);
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
        feed.setAnswer(500e8);
        marker.pin(SPY);
        pool.clear(0);
    }

    function _runAuth(uint256 i) internal {
        (TreasuryLedger.AuthProof memory p, bytes[] memory s, bytes memory c) = _auth(i);
        ledger.authorize(p, s, c, address(0));
    }

    function _runAct(uint256 i) internal {
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(i);
        if (p.action == ledger.TRANSFER_OUT() && block.timestamp < p.t) vm.warp(p.t); // the proof's time
        vm.prank(address(0xbeef)); // relayed: any sender
        ledger.act(p, e);
    }

    /// Runs the first n fixtures in chain order (the Owner approval lands before the transfer it approves).
    function _through(uint256 n) internal {
        uint8[10] memory order = [0, 1, 2, 3, 4, 6, 5, 7, 8, 9];
        for (uint256 k; k < n; ++k) {
            uint256 i = order[k];
            if (i == 1) _deposit();
            else if (i == 2) ledger.attest(_attest(2));
            else if (i == 0 || i == 6 || i == 8) _runAuth(i);
            else _runAct(i);
        }
    }

    // ---- tests ----

    function test_createStoresOnlyCommitments() public {
        vm.recordLogs();
        _runAuth(0);
        (uint256 roles, uint256 policy, uint64 epoch) = ledger.ledgers(id);
        assertEq(roles, vm.parseJsonUint(json, ".rolesCommit"));
        assertEq(policy, vm.parseJsonUint(json, ".policyHash"));
        assertEq(epoch, 0);
        assertEq(vm.getRecordedLogs().length, 1 + 4 + 1, "created + 4 key shares + config");
        (TreasuryLedger.AuthProof memory p, bytes[] memory s, bytes memory c) = _auth(0);
        vm.expectRevert(TreasuryLedger.LedgerExists.selector);
        ledger.authorize(p, s, c, address(0));
    }

    /// L-c (v3.2): the mailbox key is part of the create proof's ext hash; another key cannot ride on it.
    function test_v32_mailboxKeyIsBoundToTheCreateProof() public {
        (TreasuryLedger.AuthProof memory p, bytes[] memory s, bytes memory c) = _auth(0);
        vm.expectRevert(); // proven with no mailbox key
        ledger.authorize(p, s, c, address(0xbad));
        ledger.authorize(p, s, c, address(0));
    }

    function test_keySharesAndConfigAreBoundToTheProof() public {
        (TreasuryLedger.AuthProof memory p, bytes[] memory s, bytes memory c) = _auth(0);
        s[0] = hex"ff"; // a relayer swapping a member's key share
        vm.expectRevert();
        ledger.authorize(p, s, c, address(0));
    }

    function test_treasuryLifecycle() public {
        _through(4); // create, deposit, attest, allocate
        assertEq(IERC20(VAULT).balanceOf(address(pool)), vm.parseJsonUint(json, ".shares600"), "pool holds the ledger's vault shares");
        assertEq(IERC4626(VAULT).totalAssets(), 600e6);
        assertEq(pool.shieldedSupply(USDG), 400e6);
        _runAct(4); // Payer 50 under the threshold: private transfer, nothing leaves the pool
        assertEq(pool.shieldedSupply(USDG), 400e6);
        _runAuth(6); // Owner approves the 200 transfer
        _runAct(5);
        _runAct(7); // deallocate
        assertEq(IERC20(VAULT).balanceOf(address(pool)), 0);
        assertEq(pool.shieldedSupply(USDG), 400e6 + vm.parseJsonUint(json, ".vaultBack"));
        assertGe(IERC20(USDG).balanceOf(address(pool)), pool.shieldedSupply(USDG) + pool.pendingSupply(USDG));
    }

    /// M-3 (v3): a transfer never checks the asset listing, so a de-listed asset can still leave a treasury.
    function test_v3_delistedAssetStillLeavesTreasury() public {
        _through(4);
        gate.setAsset(USDG, false);
        _runAct(4); // the Payer's 50 USDG transfer
        assertEq(pool.shieldedSupply(USDG), 400e6);
    }

    function test_overThresholdNeedsOwnerApproval() public {
        _through(5); // up to the 50 transfer
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(5);
        assertEq(p.cosignIntent, vm.parseJsonUint(json, ".intent"));
        vm.expectRevert(TreasuryLedger.NotApproved.selector);
        ledger.act(p, e);
        _runAuth(6);
        assertTrue(ledger.approved(id, p.cosignIntent));
        ledger.act(p, e);
        assertFalse(ledger.approved(id, p.cosignIntent), "an approval is used once (audit M-4)");
    }

    function test_actionIsBoundByTheProof() public {
        _through(4);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(4);
        e.encryptedOutput2 = hex"09"; // a relayer swapping the payee ciphertext
        vm.expectRevert(TreasuryLedger.ExtDataHashMismatch.selector);
        ledger.act(p, e);
        (p, e) = _act(4);
        p.outputCommitments[1] ^= 1; // tamper with the payee note
        vm.expectRevert();
        ledger.act(p, e);
    }

    function test_rotationRevokesTheOldPayer() public {
        _through(8);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(9);
        vm.expectRevert(); // Eve is not yet a member: her proof does not match the stored roles
        ledger.act(p, e);
        assertTrue(ledger.budgetCommit(id) != 0);
        _runAuth(8);
        assertEq(ledger.budgetCommit(id), 0, "a rotation resets the spending accumulator (v3.4)");
        (uint256 roles,,) = ledger.ledgers(id);
        assertEq(roles, vm.parseJsonUint(json, ".rolesCommit2"));
        ledger.act(p, e);
        // The pre-rotation approval proof is now stale.
        (TreasuryLedger.AuthProof memory a, bytes[] memory s, bytes memory c) = _auth(6);
        vm.expectRevert(TreasuryLedger.StaleRoles.selector);
        ledger.authorize(a, s, c, address(0));
    }

    function test_attestationPublishesOnlyTheStatement() public {
        _through(2);
        vm.recordLogs();
        ledger.attest(_attest(2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[1], bytes32(id));
        (uint64 epoch, uint256 liabilities) = abi.decode(logs[0].data, (uint64, uint256));
        assertEq(epoch, 1);
        assertEq(liabilities, 900e6, "the declared liabilities and the epoch; no balance");
    }

    function test_attestationNeedsUnspentNotesAndCurrentPrices() public {
        _through(4); // the attested note was spent by the allocation
        vm.expectRevert(TreasuryLedger.NoteSpent.selector);
        ledger.attest(_attest(2));
    }

    function test_attestPricesMoveWithMarks() public {
        _through(2);
        feed.setAnswer(400e8);
        marker.pin(SPY); // different price input: the old proof no longer verifies
        vm.expectRevert();
        ledger.attest(_attest(2));
        (, uint256[6] memory prices) = ledger.attestPrices();
        assertEq(prices[2], 400e6);
        assertEq(prices[3], 0, "unpinned stock counts at zero");
    }

    // ---- Audit M-4 ----
    // 10 create a second ledger (Carol owns it), 11 Carol approves the Ops intent there,
    // 12 Owner limits transfers without approval to 1 per day, 13 first transfer, 14 second transfer.

    /// M-4: an approval given on another ledger does not approve this ledger's transfer.
    function test_audit_m4_approvalFromAnotherLedgerDoesNotCount() public {
        _through(5); // create, deposit, attest, allocate, transfer 50
        _runAuth(10);
        _runAuth(11);
        assertTrue(ledger.approved(vm.parseJsonUint(json, ".ledgerId2"), vm.parseJsonUint(json, ".intent")));
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(5);
        vm.expectRevert(TreasuryLedger.NotApproved.selector);
        ledger.act(p, e);
    }

    /// M-4: the Owner's limit on transfers without approval bounds the cumulative outflow.
    function test_audit_m4_transferLimit() public {
        _through(10);
        _runAuth(12);
        (uint64 maxTransfers, uint64 period,,) = ledger.limits(id);
        assertEq(maxTransfers, 1);
        assertEq(period, 1 days);
        _runAct(13);
        (TreasuryLedger.LedgerProof memory p, TreasuryLedger.LedgerExt memory e) = _act(14);
        vm.expectRevert(TreasuryLedger.LimitReached.selector);
        ledger.act(p, e);
        vm.warp(p.t); // a new period (the 2nd transfer is proven a day later)
        ledger.act(p, e);
    }

    /// v3.4: a governance proof applies once. Replaying the Owner's SET_LIMIT would restart the window
    /// (and an older one could loosen the limit); the ledger's governance nonce has moved on.
    function test_v34_governanceProofAppliesOnce() public {
        _through(10);
        _runAuth(12);
        _runAct(13); // one transfer used
        assertEq(ledger.authNonce(id), 4, "create, approve, rotate, limit");
        (TreasuryLedger.AuthProof memory p, bytes[] memory s, bytes memory c) = _auth(12);
        vm.expectRevert(); // the proof bound nonce 3; the verifier rejects it for nonce 4
        ledger.authorize(p, s, c, address(0));
        (,,, uint64 used) = ledger.limits(id);
        assertEq(used, 1, "the window was not restarted");
    }

    /// M-7: the ledger is a pool module because the deployer named it, once; nobody can add another.
    function test_ledgerIsAFixedModule() public {
        assertTrue(pool.isModule(address(ledger)));
        address[] memory modules = new address[](1);
        modules[0] = address(0xbad);
        vm.expectRevert(ZKDeskPool.NotAuthorized.selector);
        pool.setModules(modules);
    }
}
