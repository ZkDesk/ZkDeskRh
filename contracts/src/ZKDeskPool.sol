// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {InternalLeanIMT, LeanIMTData} from "./vendor/lean-imt/InternalLeanIMT.sol";
import {IVerifier} from "./verifiers/TransactVerifier.sol";
import {AssetGate} from "./AssetGate.sol";
import {IConverter} from "./interfaces/IConverter.sol";

/// @notice Immutable multi-asset shielded pool. No owner, no pause: exits are never gated. The asset
/// gate only governs deposits; converts need a gate-approved converter; transfers and withdrawals of
/// a note never consult either (audit M-3).
/// Notes are Poseidon commitments in one LeanIMT of depth 32; spends reveal only nullifiers.
/// Deposits wait `standby` seconds (screening window) before their notes enter the tree,
/// and the depositor can always take a pending deposit back to its origin.
/// Private converts swap one pool asset for another through a gate-approved converter.
/// Modules (credit desk, treasury ledgers, mandates) spend and create notes under their own proofs.
/// The module set is fixed once, by the deployer, right after deployment (audit M-7): governance
/// cannot add a module later, so no new contract can ever take the pool's tokens.
contract ZKDeskPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using InternalLeanIMT for LeanIMTData;

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_AMOUNT = 2 ** 100; // matches the circuit range check
    uint256 public constant MAX_LEAVES = 2 ** 32; // circuit MAX_DEPTH = 32
    uint256 public constant ROOT_HISTORY = 1024; // proofs may use any of the last 1024 roots

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
    address internal immutable deployer;

    LeanIMTData internal tree;
    /// Insertion number of each root (1-based); a root is known while within the last ROOT_HISTORY.
    mapping(uint256 root => uint256 seq) public rootSeq;
    uint256 public rootCount;
    mapping(address module => bool) public isModule;
    bool public modulesSet;
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
    event ModuleSet(address indexed module);

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
        if (!isModule[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor(IVerifier verifier_, AssetGate gate_, uint64 standby_) {
        verifier = verifier_;
        gate = gate_;
        standby = standby_;
        deployer = msg.sender;
    }

    /// @notice One-time: the deployer names the modules, then the set is fixed forever.
    function setModules(address[] calldata modules) external {
        if (msg.sender != deployer || modulesSet) revert NotAuthorized();
        modulesSet = true;
        for (uint256 i; i < modules.length; ++i) {
            isModule[modules[i]] = true;
            emit ModuleSet(modules[i]);
        }
    }

    function transact(Proof calldata p, ExtData calldata ext) external nonReentrant {
        // Only deposits are gated by the asset listing. Converts are governed by the converter list
        // (a redeem into a de-listed asset still works, audit M-3); transfers and withdrawals never are.
        if (ext.extAmount > 0 && !gate.isAllowed(p.asset)) revert AssetNotAllowed();
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
            // Private convert: -extAmount of `asset` goes through the converter, which must deliver
            // at least publicAmountOut of `outAsset` (the proven output note). Surplus stays in the pool.
            // Checked as solvency after the call, not as a balance difference around it.
            if (ext.extAmount >= 0 || ext.recipient != address(0) || !gate.isConverter(ext.converter)) revert BadConvert();
            uint256 amountIn = uint256(-ext.extAmount);
            shieldedSupply[p.asset] -= amountIn;
            token.forceApprove(ext.converter, amountIn);
            shieldedSupply[p.outAsset] += p.publicAmountOut;
            IConverter(ext.converter).convert(p.asset, amountIn, p.outAsset, p.publicAmountOut);
            if (IERC20(p.outAsset).balanceOf(address(this)) < shieldedSupply[p.outAsset] + pendingSupply[p.outAsset]) revert BadConvert();
            emit Converted(p.asset, amountIn, p.outAsset, p.publicAmountOut);
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

    // ---- Module hooks. Modules verify their own proofs before calling these. The hooks share the
    // pool's reentrancy lock, so nothing reached during a transact (a converter) can move notes. ----

    function moduleSpend(uint256 root_, uint256[2] calldata nullifiers) external onlyModule nonReentrant {
        _spend(root_, nullifiers);
    }

    function moduleInsert(uint256 commitment, bytes calldata ciphertext) external onlyModule nonReentrant {
        emit EncryptedNote(commitment, ciphertext);
        _insert(commitment);
    }

    /// @notice Tokens backing spent notes leave note form (e.g. collateral into the desk).
    function moduleTake(address asset, uint256 amount, address to) external onlyModule nonReentrant {
        shieldedSupply[asset] -= amount;
        IERC20(asset).safeTransfer(to, amount);
    }

    /// @notice Tokens enter note form from the module (e.g. drawn USDG or released collateral).
    function moduleGive(address asset, uint256 amount) external onlyModule nonReentrant {
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

    /// @notice A root of the last ROOT_HISTORY insertions. The empty root 0 only while the tree is
    /// empty (the first deposit's dummy inputs); a real note can never be proven against it.
    function isKnownRoot(uint256 root_) public view returns (bool) {
        if (root_ == 0) return rootCount == 0;
        uint256 seq = rootSeq[root_];
        return seq != 0 && seq + ROOT_HISTORY > rootCount;
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
        rootSeq[newRoot] = ++rootCount;
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
