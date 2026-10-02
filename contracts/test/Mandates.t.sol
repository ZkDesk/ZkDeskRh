// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {LedgerVerifier, IVerifier} from "../src/verifiers/LedgerVerifier.sol";
import {RoleAuthVerifier} from "../src/verifiers/RoleAuthVerifier.sol";
import {TreasuryAttestVerifier} from "../src/verifiers/TreasuryAttestVerifier.sol";
import {MandateAuthVerifier} from "../src/verifiers/MandateAuthVerifier.sol";
import {MandatePullVerifier, IVerifier as IMandateVerifier} from "../src/verifiers/MandatePullVerifier.sol";
import {ReceiptVerifier} from "../src/verifiers/ReceiptVerifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// Real UltraHonk proofs from circuits/scripts/fixtures.mjs (m5.json), in order:
/// 0 create the treasury, 1 deposit 1000 USDG, 2 deposit 10 SPY into it,
/// 3 commit payroll (Payer, 80/month), 4 commit invoice INV-7 (Owner, 150), 5 commit SPY payroll
/// (Treasurer, 100 USDG/week), 6 pay payroll k=0, 7 pay the invoice, 8 pay 0.1 SPY (50 USDG at $500),
/// 9 pause payroll, 10 resume it, 11 revoke SPY payroll, 12 Rita's receipt for 6 (amount disclosed),
/// 13 Rita's receipt for 8 (nothing disclosed).
contract MandatesTest is Test {
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
    MandateRegistry registry;
    uint256 T;

    function setUp() public {
        json = vm.readFile("../circuits/fixtures/m5.json");
        T = vm.parseJsonUint(json, ".T");
        vm.warp(T);
        deployCodeTo("MockUSDG.sol:MockUSDG", USDG);
        for (uint256 i; i < 4; ++i) deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode("Test stock", "tSTK", address(this)), stocks[i]);
        deployCodeTo("MockERC4626.sol:MockERC4626", abi.encode(USDG), VAULT);
        gate = new AssetGate(address(this), address(this));
        gate.setAsset(USDG, true);
        gate.setAsset(SPY, true);
        pool = new ZKDeskPool(new TransactVerifier(), gate, 60);
        marker = new Marker(address(this), address(this), 1 hours);
        feed = new MockAggregatorV3("SPY / USD", address(this), address(this));
        marker.setFeed(SPY, IAggregatorV3(address(feed)));
        _pin();
        ledger = new TreasuryLedger(
            [IVerifier(address(new LedgerVerifier())), IVerifier(address(new RoleAuthVerifier())), IVerifier(address(new TreasuryAttestVerifier()))],
            pool, marker, IERC4626(VAULT), stocks
        );
        registry = new MandateRegistry(
            [IMandateVerifier(address(new MandateAuthVerifier())), IMandateVerifier(address(new MandatePullVerifier())), IMandateVerifier(address(new ReceiptVerifier()))],
            pool, ledger, marker
        );
        address[] memory modules = new address[](2);
        (modules[0], modules[1]) = (address(ledger), address(registry));
        pool.setModules(modules);
        vm.startPrank(alice);
        MockUSDG(USDG).faucet(1000e6);
        MockStockToken(SPY).faucet(10e18);
        IERC20(USDG).approve(address(pool), type(uint256).max);
        IERC20(SPY).approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _pin() internal {
        feed.setAnswer(500e8);
        marker.pin(SPY);
    }

    // ---- fixture decoding ----

    function _k(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".txs[", vm.toString(i), "].", field);
    }

    function _x(uint256 i) internal view returns (bytes32[] memory) {
        return vm.parseJsonBytes32Array(json, _k(i, "publicInputs"));
    }

    function _create() internal {
        bytes32[] memory x = _x(0);
        TreasuryLedger.AuthProof memory p = TreasuryLedger.AuthProof(vm.parseJsonBytes(json, _k(0, "proof")), uint256(x[0]), uint256(x[1]), uint256(x[2]), uint8(uint256(x[3])), uint256(x[4]));
        ledger.authorize(p, vm.parseJsonBytesArray(json, _k(0, "ext.shares")), vm.parseJsonBytes(json, _k(0, "ext.config")));
    }

    function _deposit(uint256 i) internal {
        bytes32[] memory x = _x(i);
        ZKDeskPool.Proof memory p = ZKDeskPool.Proof({
            proof: vm.parseJsonBytes(json, _k(i, "proof")), root: uint256(x[0]), publicAmount: uint256(x[1]), extDataHash: uint256(x[2]),
            asset: address(uint160(uint256(x[3]))), outAsset: address(uint160(uint256(x[4]))), publicAmountOut: uint256(x[5]),
            inputNullifiers: [uint256(x[6]), uint256(x[7])], outputCommitments: [uint256(x[8]), uint256(x[9])]
        });
        ZKDeskPool.ExtData memory e = ZKDeskPool.ExtData({
            recipient: address(0), extAmount: vm.parseJsonInt(json, _k(i, "ext.extAmount")), relayer: address(0), fee: 0, converter: address(0),
            encryptedOutput1: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput1")), encryptedOutput2: vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput2"))
        });
        vm.prank(alice);
        pool.transact(p, e);
    }

    function _auth(uint256 i) internal view returns (MandateRegistry.AuthProof memory p, bytes memory ct) {
        bytes32[] memory x = _x(i);
        p = MandateRegistry.AuthProof(vm.parseJsonBytes(json, _k(i, "proof")), uint256(x[0]), uint8(uint256(x[3])), uint256(x[4]));
        ct = vm.parseJsonBytes(json, _k(i, "ext.ciphertext"));
    }

    function _pull(uint256 i) internal view returns (MandateRegistry.PullProof memory p, MandateRegistry.PullExt memory e) {
        bytes32[] memory x = _x(i);
        p.proof = vm.parseJsonBytes(json, _k(i, "proof"));
        p.root = uint256(x[0]);
        p.ledgerId = uint256(x[1]);
        p.mandateCommit = uint256(x[3]);
        p.asset = address(uint160(uint256(x[4])));
        p.mark = uint256(x[5]);
        p.k = uint256(x[6]);
        p.t = uint256(x[7]);
        p.pullNullifier = uint256(x[8]);
        p.receiptLeaf = uint256(x[9]);
        p.extDataHash = uint256(x[10]);
        p.inputNullifiers = [uint256(x[11]), uint256(x[12])];
        p.outputCommitments = [uint256(x[13]), uint256(x[14])];
        e = MandateRegistry.PullExt(vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput1")), vm.parseJsonBytes(json, _k(i, "ext.encryptedOutput2")));
    }

    function _receipt(uint256 i) internal view returns (MandateRegistry.ReceiptProof memory r) {
        bytes32[] memory x = _x(i);
        r = MandateRegistry.ReceiptProof({
            proof: vm.parseJsonBytes(json, _k(i, "proof")), receiptRoot: uint256(x[0]), ledgerId: uint256(x[1]), k: uint256(x[2]),
            asset: address(uint160(uint256(x[3]))), verifier: uint256(x[4]), discloseAmount: uint256(x[5]) == 1, amount: uint256(x[6]),
            discloseOwner: uint256(x[7]) == 1, owner: uint256(x[8])
        });
    }

    function _manage(uint256 i) internal {
        (MandateRegistry.AuthProof memory p, bytes memory ct) = _auth(i);
        registry.manage(p, ct);
    }

    function _runPull(uint256 i) internal {
        (MandateRegistry.PullProof memory p, MandateRegistry.PullExt memory e) = _pull(i);
        vm.prank(address(0xbeef)); // relayed
        registry.pull(p, e);
    }

    /// Treasury funded (deposits cleared) and the three mandates committed.
    function _ready() internal {
        _create();
        _deposit(1); // each deposit is proven against the tree after the previous one cleared
        vm.warp(T + 60);
        pool.clear(0);
        _deposit(2);
        vm.warp(T + 120);
        pool.clear(1);
        _pin();
        _manage(3);
        _manage(4);
        _manage(5);
    }

    // ---- tests ----

    function test_mandateLifecycle() public {
        _ready();
        (uint256 l,) = registry.mandates(vm.parseJsonUint(json, ".commits.payroll"));
        assertEq(l, vm.parseJsonUint(json, ".ledgerId"));
        _runPull(6);
        _runPull(7);
        _runPull(8);
        assertEq(registry.receiptRoot(), vm.parseJsonUint(json, ".receiptRoot"));
        assertTrue(registry.receiptRoots(vm.parseJsonUint(json, ".receiptRoot")));
        // Payments stay private notes: nothing leaves the pool.
        assertEq(pool.shieldedSupply(USDG), 1000e6);
        assertEq(pool.shieldedSupply(SPY), 10e18);
        _manage(9);
        (, uint8 status) = registry.mandates(vm.parseJsonUint(json, ".commits.payroll"));
        assertEq(status, registry.PAUSED());
        _manage(10);
        _manage(11);
        (, status) = registry.mandates(vm.parseJsonUint(json, ".commits.spy"));
        assertEq(status, registry.REVOKED());
    }

    function test_secondPullInTheSamePeriodReverts() public {
        _ready();
        _runPull(6);
        (MandateRegistry.PullProof memory p, MandateRegistry.PullExt memory e) = _pull(6);
        vm.expectRevert(MandateRegistry.AlreadyPaid.selector);
        registry.pull(p, e);
    }

    function test_pausedOrRevokedMandatesCannotPay() public {
        _ready();
        _manage(9); // pause payroll
        (MandateRegistry.PullProof memory p, MandateRegistry.PullExt memory e) = _pull(6);
        vm.expectRevert(MandateRegistry.NotActive.selector);
        registry.pull(p, e);
        _manage(10); // resume
        registry.pull(p, e);
        _manage(11); // revoke SPY payroll
        (p, e) = _pull(8);
        vm.expectRevert(MandateRegistry.NotActive.selector);
        registry.pull(p, e);
        (MandateRegistry.AuthProof memory a, bytes memory ct) = _auth(10);
        vm.expectRevert(MandateRegistry.BadMandate.selector); // resume a mandate that is not paused
        registry.manage(a, ct);
    }

    function test_mandateCommitsOnceAndStaysWithItsLedger() public {
        _ready();
        (MandateRegistry.AuthProof memory a, bytes memory ct) = _auth(3);
        vm.expectRevert(MandateRegistry.BadMandate.selector);
        registry.manage(a, ct);
        ct = hex"ff"; // a relayer swapping the mandate ciphertext
        a.mandateCommit ^= 1;
        vm.expectRevert();
        registry.manage(a, ct);
    }

    function test_pullTimeAndMarkAreChecked() public {
        _ready();
        vm.warp(T + 2 hours);
        (MandateRegistry.PullProof memory p, MandateRegistry.PullExt memory e) = _pull(6);
        vm.expectRevert(MandateRegistry.StaleTime.selector);
        registry.pull(p, e);
        vm.warp(T + 120);
        _runPull(6);
        _runPull(7); // pull 8 is proven on the tree after these
        MockStockToken(SPY).setOraclePaused(true);
        (p, e) = _pull(8);
        vm.expectRevert(MandateRegistry.MarkUnusable.selector);
        registry.pull(p, e);
        MockStockToken(SPY).setOraclePaused(false);
        registry.pull(p, e);
    }

    function test_pullRevealsNoAmountOrRecipient() public {
        _ready();
        vm.recordLogs();
        _runPull(6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory last = logs[logs.length - 1];
        assertEq(last.topics[0], MandateRegistry.Pulled.selector);
        (uint256 k,, uint256 index,) = abi.decode(last.data, (uint256, uint256, uint256, uint256));
        assertEq(k, 0);
        assertEq(index, 0);
        assertEq(last.data.length, 4 * 32, "k, receipt leaf, index, root: no amount, no recipient");
    }

    function test_receiptsVerifyForTheChosenVerifierOnly() public {
        _ready();
        _runPull(6);
        _runPull(7);
        _runPull(8);
        MandateRegistry.ReceiptProof memory r = _receipt(12);
        assertTrue(r.discloseAmount && r.amount == 80e6 && !r.discloseOwner && r.owner == 0);
        assertTrue(registry.verifyReceipt(r));
        MandateRegistry.ReceiptProof memory hidden = _receipt(13);
        assertEq(hidden.amount, 0, "undisclosed amount is absent");
        assertEq(hidden.owner, 0, "undisclosed recipient is absent");
        assertTrue(registry.verifyReceipt(hidden));
        r.verifier = 0xbad; // replayed to someone else
        try registry.verifyReceipt(r) returns (bool ok) {
            assertFalse(ok);
        } catch {}
        r = _receipt(12);
        r.amount = 90e6; // a disclosed amount that was not paid
        try registry.verifyReceipt(r) returns (bool ok) {
            assertFalse(ok);
        } catch {}
        r = _receipt(12);
        r.receiptRoot ^= 1;
        vm.expectRevert(MandateRegistry.UnknownReceiptRoot.selector);
        registry.verifyReceipt(r);
    }
}
