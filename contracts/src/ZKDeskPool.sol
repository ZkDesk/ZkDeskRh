// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {InternalLeanIMT, LeanIMTData} from "./vendor/lean-imt/InternalLeanIMT.sol";
import {IVerifier} from "./verifiers/TransactVerifier.sol";
import {AssetGate} from "./AssetGate.sol";
import {IConverter} from "./interfaces/IConverter.sol";

/// @notice Immutable multi-asset shielded pool. No owner, no pause: exits are never gated.
/// Notes are Poseidon commitments in one LeanIMT; spends reveal only nullifiers.
/// Deposits wait `standby` seconds (screening window) before their notes enter the tree,
/// and the depositor can always take a pending deposit back to its origin.
/// Private converts swap one pool asset for another through a gate-approved converter.
/// Gate-approved modules (the credit desk) spend and create notes under their own proofs.
contract ZKDeskPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using InternalLeanIMT for LeanIMTData;

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_AMOUNT = 2 ** 100; // matches the circuit range check
    uint256 public constant MAX_LEAVES = 2 ** 20; // circuit MAX_DEPTH = 20
    uint256 public constant ROOT_HISTORY = 64;

    /// Field order must match src/lib/zk/transact.js EXT_DATA.
    struct ExtData {
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        address converter;
        bytes encryptedOutput1;
        bytes encryptedOutput2;
    }

    struct Proof {
        bytes proof;
        uint256 root;
        uint256 publicAmount;
        uint256 extDataHash;
        address asset;
        address outAsset;
        uint256 publicAmountOut;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    struct PendingDeposit {
        address depositor;
        address asset;
        uint128 amount;
        uint64 clearAfter;
        bool flagged;
        uint256[2] commitments;
    }

    IVerifier public immutable verifier;
    AssetGate public immutable gate;
    uint64 public immutable standby;

    LeanIMTData internal tree;
    uint256[ROOT_HISTORY] public roots;
    uint256 public rootIndex;
    mapping(uint256 nullifier => bool) public nullifierSpent;
    PendingDeposit[] public deposits;
    /// Tokens held for notes in the tree / for pending deposits. Solvency: balance >= both summed.
    mapping(address asset => uint256) public shieldedSupply;
    mapping(address asset => uint256) public pendingSupply;

    event NewCommitment(uint256 indexed commitment, uint256 index);
    event EncryptedNote(uint256 indexed commitment, bytes ciphertext);
    event NewNullifier(uint256 indexed nullifier);
    event DepositPending(uint256 indexed id, address indexed depositor, address indexed asset, uint256 amount, uint64 clearAfter);
    event DepositCleared(uint256 indexed id);
    event DepositFlagged(uint256 indexed id);
    event DepositRefunded(uint256 indexed id);
    event Converted(address indexed assetIn, uint256 amountIn, address indexed assetOut, uint256 amountOut);

    error AssetNotAllowed();
    error UnknownRoot();
    error NullifierSpent();
    error ExtDataHashMismatch();
    error PublicAmountMismatch();
    error InvalidProof();
    error InvalidAmount();
    error DepositMustBeSelfSubmitted();
    error MissingRecipient();
    error BadConvert();
    error TreeFull();
    error NotPending();
    error StandbyActive();
    error StandbyOver();
    error Flagged();
    error NotAuthorized();

    modifier onlyModule() {
        if (!gate.isModule(msg.sender)) revert NotAuthorized();
        _;
    }

    constructor(IVerifier verifier_, AssetGate gate_, uint64 standby_) {
        verifier = verifier_;
        gate = gate_;
        standby = standby_;
    }

    function transact(Proof calldata p, ExtData calldata ext) external nonReentrant {
        if (!gate.isAllowed(p.asset) || !gate.isAllowed(p.outAsset)) revert AssetNotAllowed();
        if (p.extDataHash != uint256(keccak256(abi.encode(ext))) % FIELD) revert ExtDataHashMismatch();
        if (p.publicAmount != publicAmountOf(ext.extAmount, ext.fee)) revert PublicAmountMismatch();
        _spend(p.root, p.inputNullifiers);
        if (!verifier.verify(p.proof, _publicInputs(p))) revert InvalidProof();
        emit EncryptedNote(p.outputCommitments[0], ext.encryptedOutput1);
        emit EncryptedNote(p.outputCommitments[1], ext.encryptedOutput2);

        IERC20 token = IERC20(p.asset);
        if (ext.extAmount > 0) {
            // Deposits come straight from the owner of the funds so refunds can go back to origin.
            if (ext.fee != 0 || ext.relayer != address(0) || p.outAsset != p.asset) revert DepositMustBeSelfSubmitted();
            uint256 amount = uint256(ext.extAmount);
            token.safeTransferFrom(msg.sender, address(this), amount);
            uint64 clearAfter = uint64(block.timestamp) + standby;
            deposits.push(PendingDeposit(msg.sender, p.asset, uint128(amount), clearAfter, false, p.outputCommitments));
            pendingSupply[p.asset] += amount;
            emit DepositPending(deposits.length - 1, msg.sender, p.asset, amount, clearAfter);
            return;
        }

        _insert(p.outputCommitments[0]);
        _insert(p.outputCommitments[1]);
        if (p.outAsset != p.asset) {
            // Private convert: -extAmount of `asset` goes through the converter, which must return
            // at least publicAmountOut of `outAsset` (the proven output note). Surplus stays in the pool.
            if (ext.extAmount >= 0 || ext.recipient != address(0) || !gate.isConverter(ext.converter)) revert BadConvert();
            uint256 amountIn = uint256(-ext.extAmount);
            shieldedSupply[p.asset] -= amountIn;
            token.forceApprove(ext.converter, amountIn);
            uint256 before = IERC20(p.outAsset).balanceOf(address(this));
            IConverter(ext.converter).convert(p.asset, amountIn, p.outAsset, p.publicAmountOut);
            uint256 received = IERC20(p.outAsset).balanceOf(address(this)) - before;
            if (received < p.publicAmountOut) revert BadConvert();
            shieldedSupply[p.outAsset] += p.publicAmountOut;
            emit Converted(p.asset, amountIn, p.outAsset, received);
        } else if (ext.extAmount < 0) {
            if (ext.recipient == address(0)) revert MissingRecipient();
            uint256 amount = uint256(-ext.extAmount);
            shieldedSupply[p.asset] -= amount;
            token.safeTransfer(ext.recipient, amount);
        }
        if (ext.fee > 0) {
            shieldedSupply[p.asset] -= ext.fee;
            token.safeTransfer(ext.relayer, ext.fee);
        }
    }

    /// @notice Moves a deposit's notes into the tree after standby. Callable by anyone (the cron does it).
    function clear(uint256 id) external nonReentrant {
        PendingDeposit storage d = _pending(id);
        if (d.flagged) revert Flagged();
        if (block.timestamp < d.clearAfter) revert StandbyActive();
        (address asset, uint256 amount) = (d.asset, d.amount);
        uint256[2] memory commitments = d.commitments;
        delete deposits[id];
        pendingSupply[asset] -= amount;
        shieldedSupply[asset] += amount;
        _insert(commitments[0]);
        _insert(commitments[1]);
        emit DepositCleared(id);
    }

    /// @notice Screener may hold a deposit during standby; it can then only be refunded to origin.
    function flag(uint256 id) external {
        if (msg.sender != gate.screener()) revert NotAuthorized();
        PendingDeposit storage d = _pending(id);
        if (block.timestamp >= d.clearAfter) revert StandbyOver();
        d.flagged = true;
        emit DepositFlagged(id);
    }

    /// @notice Always available for a pending deposit: the depositor (or anyone, once flagged)
    /// returns the funds to the address they came from.
    function refundToOrigin(uint256 id) external nonReentrant {
        PendingDeposit storage d = _pending(id);
        if (msg.sender != d.depositor && !d.flagged) revert NotAuthorized();
        (address depositor, address asset, uint256 amount) = (d.depositor, d.asset, d.amount);
        delete deposits[id];
        pendingSupply[asset] -= amount;
        IERC20(asset).safeTransfer(depositor, amount);
        emit DepositRefunded(id);
    }

    // ---- Module hooks (credit desk). Modules verify their own proofs before calling these. ----

    function moduleSpend(uint256 root_, uint256[2] calldata nullifiers) external onlyModule {
        _spend(root_, nullifiers);
    }

    function moduleInsert(uint256 commitment, bytes calldata ciphertext) external onlyModule {
        emit EncryptedNote(commitment, ciphertext);
        _insert(commitment);
    }

    /// @notice Tokens backing spent notes leave note form (e.g. collateral into the desk).
    function moduleTake(address asset, uint256 amount, address to) external onlyModule {
        shieldedSupply[asset] -= amount;
        IERC20(asset).safeTransfer(to, amount);
    }

    /// @notice Tokens enter note form from the module (e.g. drawn USDG or released collateral).
    function moduleGive(address asset, uint256 amount) external onlyModule {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        shieldedSupply[asset] += amount;
    }

    // ---- Views ----

    function publicAmountOf(int256 extAmount, uint256 fee) public pure returns (uint256) {
        if (fee >= MAX_AMOUNT || extAmount <= -int256(MAX_AMOUNT) || extAmount >= int256(MAX_AMOUNT)) {
            revert InvalidAmount();
        }
        int256 value = extAmount - int256(fee);
        return value >= 0 ? uint256(value) : FIELD - uint256(-value);
    }

    function isKnownRoot(uint256 root_) public view returns (bool) {
        for (uint256 i; i < ROOT_HISTORY; ++i) {
            if (roots[i] == root_) return true;
        }
        return false;
    }

    function root() external view returns (uint256) {
        return tree._root();
    }

    function size() external view returns (uint256) {
        return tree.size;
    }

    function depositCount() external view returns (uint256) {
        return deposits.length;
    }

    // ---- Internal ----

    function _spend(uint256 root_, uint256[2] calldata nullifiers) internal {
        if (!isKnownRoot(root_)) revert UnknownRoot();
        for (uint256 i; i < 2; ++i) {
            if (nullifierSpent[nullifiers[i]]) revert NullifierSpent();
            nullifierSpent[nullifiers[i]] = true;
            emit NewNullifier(nullifiers[i]);
        }
    }

    function _insert(uint256 commitment) internal {
        if (tree.size >= MAX_LEAVES) revert TreeFull();
        uint256 index = tree.size;
        uint256 newRoot = tree._insert(commitment);
        rootIndex = (rootIndex + 1) % ROOT_HISTORY;
        roots[rootIndex] = newRoot;
        emit NewCommitment(commitment, index);
    }

    function _pending(uint256 id) internal view returns (PendingDeposit storage d) {
        if (id >= deposits.length) revert NotPending();
        d = deposits[id];
        if (d.depositor == address(0)) revert NotPending();
    }

    /// Order must match the `pub` parameters of circuits/transact/src/main.nr.
    function _publicInputs(Proof calldata p) internal pure returns (bytes32[] memory inputs) {
        inputs = new bytes32[](10);
        inputs[0] = bytes32(p.root);
        inputs[1] = bytes32(p.publicAmount);
        inputs[2] = bytes32(p.extDataHash);
        inputs[3] = bytes32(uint256(uint160(p.asset)));
        inputs[4] = bytes32(uint256(uint160(p.outAsset)));
        inputs[5] = bytes32(p.publicAmountOut);
        inputs[6] = bytes32(p.inputNullifiers[0]);
        inputs[7] = bytes32(p.inputNullifiers[1]);
        inputs[8] = bytes32(p.outputCommitments[0]);
        inputs[9] = bytes32(p.outputCommitments[1]);
    }
}
