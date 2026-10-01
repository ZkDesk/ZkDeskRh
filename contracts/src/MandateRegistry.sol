// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {InternalLeanIMT, LeanIMTData} from "./vendor/lean-imt/InternalLeanIMT.sol";
import {IVerifier} from "./verifiers/MandatePullVerifier.sol";
import {ZKDeskPool} from "./ZKDeskPool.sol";
import {TreasuryLedger} from "./TreasuryLedger.sol";
import {Marker} from "./Marker.sol";

/// @notice Payment mandates for treasury ledgers, and the receipt root.
/// A mandate is a hidden commitment (recipient, cap, period, expiry, asset, invoice reference)
/// registered under its ledger by a MandateAuthProof (Owner / Treasurer / Payer; a cap above the
/// ledger's dual-control threshold needs the Owner). Each pull is a MandatePullProof: at most the
/// cap, only once per period (pull nullifier), within the mandate's dates, from the ledger's notes
/// to the recipient. Every pull appends a receipt leaf; recipients prove payments against any
/// recorded receipt root (verifyReceipt, a free view call) to a verifier of their choice.
/// Public: mandate commitments, their status, period indexes, receipt leaves. Private: recipient,
/// amounts, caps, schedules.
contract MandateRegistry is ReentrancyGuard {
    using InternalLeanIMT for LeanIMTData;

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint8 public constant COMMIT = 0;
    uint8 public constant REVOKE = 1;
    uint8 public constant PAUSE = 2;
    uint8 public constant RESUME = 3;
    uint8 public constant ACTIVE = 1;
    uint8 public constant PAUSED = 2;
    uint8 public constant REVOKED = 3;
    uint64 public constant MAX_PROOF_AGE = 1 hours; // the pull's time `t` may lag the block by this much

    struct Mandate {
        uint256 ledgerId;
        uint8 status;
    }

    struct AuthProof {
        bytes proof;
        uint256 ledgerId;
        uint8 action;
        uint256 mandateCommit;
    }

    struct PullProof {
        bytes proof;
        uint256 root;
        uint256 ledgerId;
        uint256 mandateCommit;
        address asset;
        uint256 mark;
        uint256 k;
        uint256 t;
        uint256 pullNullifier;
        uint256 receiptLeaf;
        uint256 extDataHash;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    /// Field order must match src/lib/zk/mandate.js PULL_EXT.
    struct PullExt {
        bytes encryptedOutput1;
        bytes encryptedOutput2;
    }

    struct ReceiptProof {
        bytes proof;
        uint256 receiptRoot;
        uint256 ledgerId;
        uint256 k;
        address asset;
        uint256 verifier;
        bool discloseAmount;
        uint256 amount;
        bool discloseOwner;
        uint256 owner;
    }

    IVerifier public immutable authVerifier;
    IVerifier public immutable pullVerifier;
    IVerifier public immutable receiptVerifier;
    ZKDeskPool public immutable pool;
    TreasuryLedger public immutable ledgers;
    Marker public immutable marker;
    address public immutable usdg;

    mapping(uint256 commit => Mandate) public mandates;
    mapping(uint256 pullNullifier => bool) public pulled;
    LeanIMTData internal receipts;
    mapping(uint256 root => bool) public receiptRoots;

    event MandateCommitted(uint256 indexed ledgerId, uint256 indexed commit, bytes ciphertext);
    event MandateStatus(uint256 indexed ledgerId, uint256 indexed commit, uint8 status);
    event Pulled(uint256 indexed ledgerId, uint256 indexed commit, uint256 k, uint256 receiptLeaf, uint256 receiptIndex, uint256 receiptRoot);

    error UnknownLedger();
    error BadMandate();
    error NotActive();
    error AlreadyPaid();
    error StaleTime();
    error BadAsset();
    error MarkUnusable();
    error ExtDataHashMismatch();
    error UnknownReceiptRoot();
    error InvalidProof();

    /// verifiers: [mandate_auth, mandate_pull, receipt]
    constructor(IVerifier[3] memory verifiers, ZKDeskPool pool_, TreasuryLedger ledgers_, Marker marker_) {
        (authVerifier, pullVerifier, receiptVerifier) = (verifiers[0], verifiers[1], verifiers[2]);
        pool = pool_;
        ledgers = ledgers_;
        marker = marker_;
        usdg = address(ledgers_.usdg());
    }

    function manage(AuthProof calldata p, bytes calldata ciphertext) external {
        (uint256 roles, uint256 policy,) = ledgers.ledgers(p.ledgerId);
        if (roles == 0) revert UnknownLedger();
        Mandate storage m = mandates[p.mandateCommit];
        if (p.action == COMMIT) {
            if (m.status != 0) revert BadMandate();
        } else if (m.ledgerId != p.ledgerId || m.status == REVOKED || p.action > RESUME) {
            revert BadMandate();
        } else if ((p.action == PAUSE && m.status != ACTIVE) || (p.action == RESUME && m.status != PAUSED)) {
            revert BadMandate();
        }
        bytes32[] memory x = new bytes32[](6);
        x[0] = bytes32(p.ledgerId);
        x[1] = bytes32(roles);
        x[2] = bytes32(policy);
        x[3] = bytes32(uint256(p.action));
        x[4] = bytes32(p.mandateCommit);
        x[5] = bytes32(uint256(keccak256(abi.encode(ciphertext))) % FIELD);
        if (!authVerifier.verify(p.proof, x)) revert InvalidProof();

        if (p.action == COMMIT) {
            (m.ledgerId, m.status) = (p.ledgerId, ACTIVE);
            emit MandateCommitted(p.ledgerId, p.mandateCommit, ciphertext);
        } else {
            m.status = p.action == REVOKE ? REVOKED : p.action == PAUSE ? PAUSED : ACTIVE;
        }
        emit MandateStatus(p.ledgerId, p.mandateCommit, m.status);
    }

    function pull(PullProof calldata p, PullExt calldata e) external nonReentrant {
        Mandate storage m = mandates[p.mandateCommit];
        if (m.status != ACTIVE || m.ledgerId != p.ledgerId) revert NotActive();
        if (pulled[p.pullNullifier]) revert AlreadyPaid();
        if (p.t > block.timestamp || p.t + MAX_PROOF_AGE < block.timestamp) revert StaleTime();
        if (!pool.gate().isAllowed(p.asset)) revert BadAsset();
        if (p.asset == usdg) {
            if (p.mark != 0) revert BadAsset();
        } else if (!marker.usable(p.asset, p.mark)) {
            revert MarkUnusable();
        }
        if (p.extDataHash != uint256(keccak256(abi.encode(e))) % FIELD) revert ExtDataHashMismatch();
        (uint256 roles,,) = ledgers.ledgers(p.ledgerId);
        if (!pullVerifier.verify(p.proof, _pullInputs(p, roles))) revert InvalidProof();

        pulled[p.pullNullifier] = true;
        pool.moduleSpend(p.root, p.inputNullifiers);
        pool.moduleInsert(p.outputCommitments[0], e.encryptedOutput1);
        pool.moduleInsert(p.outputCommitments[1], e.encryptedOutput2);
        uint256 index = receipts.size;
        uint256 root = receipts._insert(p.receiptLeaf);
        receiptRoots[root] = true;
        emit Pulled(p.ledgerId, p.mandateCommit, p.k, p.receiptLeaf, index, root);
    }

    /// @notice True if the receipt proof holds against a recorded root (nothing is stored).
    function verifyReceipt(ReceiptProof calldata r) external view returns (bool) {
        if (!receiptRoots[r.receiptRoot]) revert UnknownReceiptRoot();
        bytes32[] memory x = new bytes32[](9);
        x[0] = bytes32(r.receiptRoot);
        x[1] = bytes32(r.ledgerId);
        x[2] = bytes32(r.k);
        x[3] = bytes32(uint256(uint160(r.asset)));
        x[4] = bytes32(r.verifier);
        x[5] = bytes32(uint256(r.discloseAmount ? 1 : 0));
        x[6] = bytes32(r.amount);
        x[7] = bytes32(uint256(r.discloseOwner ? 1 : 0));
        x[8] = bytes32(r.owner);
        return receiptVerifier.verify(r.proof, x);
    }

    function receiptRoot() external view returns (uint256) {
        return receipts._root();
    }

    /// Order must match the `pub` parameters of circuits/mandate_pull/src/main.nr.
    function _pullInputs(PullProof calldata p, uint256 roles) internal pure returns (bytes32[] memory x) {
        x = new bytes32[](15);
        x[0] = bytes32(p.root);
        x[1] = bytes32(p.ledgerId);
        x[2] = bytes32(roles);
        x[3] = bytes32(p.mandateCommit);
        x[4] = bytes32(uint256(uint160(p.asset)));
        x[5] = bytes32(p.mark);
        x[6] = bytes32(p.k);
        x[7] = bytes32(p.t);
        x[8] = bytes32(p.pullNullifier);
        x[9] = bytes32(p.receiptLeaf);
        x[10] = bytes32(p.extDataHash);
        x[11] = bytes32(p.inputNullifiers[0]);
        x[12] = bytes32(p.inputNullifiers[1]);
        x[13] = bytes32(p.outputCommitments[0]);
        x[14] = bytes32(p.outputCommitments[1]);
    }
}
