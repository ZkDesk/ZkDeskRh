// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVerifier} from "./verifiers/PositionVerifier.sol";
import {ZKDeskPool} from "./ZKDeskPool.sol";
import {Marker} from "./Marker.sol";
import {LendingPoolUSDG} from "./LendingPoolUSDG.sol";

/// @notice Venue that sells a sealed liquidation batch (mainnet: UniswapV3Venue; testnet: MockAMM).
interface ISaleVenue {
    function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 out);
}

/// @notice Private credit desk. Each position is a hidden commitment in one of SLOTS slots; every
/// step is a PositionProof. Public: per-step aggregate flows (collateral in/out, USDG drawn/repaid),
/// class parameters, the rate index and total debt. Private from the public: owner, position size,
/// debt and LTV. The desk operator can read every position's contents (not the owner's identity).
///
/// Oracle fail-closed for new risk: draws and collateral withdrawals need a fresh, unpaused pinned
/// mark and an unpaused desk. Repay, add collateral and close always work, also for a class that
/// governance disabled (audit M-3): disabling a class stops only new risk.
/// Slots (audit H-1): opening or withdrawing must leave at least the class's minimum collateral, debt
/// is zero or at least the class's minimum debt, and a position without debt that nobody touched for
/// EVICT_AFTER can be evicted: its collateral goes back to the owner as a note (circuits/evict).
/// Steps (audit N-1): every step moves something and leaves its position healthy at the liquidation
/// threshold (a breached position can only be cured, closed or liquidated); a slot takes at most one
/// step per STEP_INTERVAL; closing and risk-reducing steps (add collateral, repay) are exempt, so an
/// owner can always defend a position (audit L-b). Marks are the current pin (the previous one only within
/// ATTEST_GRACE of a new round); a step that adds risk also needs it fresh and unpaused.
/// Rates follow a public utilization curve; the index is checkpointed by accrue() (the hourly
/// rate-publisher) and proofs may use the latest or previous checkpoint.
///
/// Health: every position is also provably encrypted to the desk operator's Grumpkin key. Each
/// epoch the operator proves the desk totals over all SLOTS leaves plus a commitment to the breached
/// set (attest). If no epoch lands for 3 epoch lengths, new draws halt. Breached positions are
/// liquidated in sealed batches at one uniform price within a band of the pinned mark (liquidate);
/// the proof enforces the close factor, bonus and the off-hours 95% floor. An epoch proves against a
/// snapshot of the slots (snapshot()), which no later step can invalidate; the proof binds the
/// snapshot id, so it is single-use (audit N-1, M-1). Marks and index are the current ones (previous
/// only briefly). A batch whose positions changed after the snapshot is skipped, not reverted: by the
/// step rule, a changed position is healthy.
contract CreditDesk is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant SLOTS = 64; // bounded so the epoch health proof covers every slot
    uint256 public constant WAD = 1e18;
    uint256 public constant SPREAD_BPS = 1_000; // 10% of interest stays in the lending pool as reserves
    uint64 public constant MIN_ACCRUAL_INTERVAL = 10 minutes;
    // Public utilization curve (APR bps): 2% base, 10% at the 80% kink, 60% at 100%.
    uint256 public constant BASE_BPS = 200;
    uint256 public constant KINK_BPS = 8_000;
    uint256 public constant KINK_RATE_BPS = 1_000;
    uint256 public constant MAX_RATE_BPS = 6_000;
    uint256 public constant CLASSES = 4; // circuits/health_epoch CLASSES
    uint64 public constant EPOCH = 15 minutes; // market hours
    uint64 public constant OFF_HOURS_EPOCH = 1 hours;
    uint256 public constant BAND_BPS = 200; // batch price vs pinned mark, market hours
    uint256 public constant OFF_HOURS_BAND_BPS = 500;
    /// How long a superseded mark or index stays usable for an epoch proof already being made.
    uint64 public constant ATTEST_GRACE = 10 minutes;
    /// A position without debt that no step touched for this long can be evicted.
    uint64 public constant EVICT_AFTER = 1 days;
    /// At most one step per slot in this interval, closing excepted (audit N-1 backstop).
    uint64 public constant STEP_INTERVAL = 10 minutes;
    /// An epoch must be proven against a snapshot at most this old.
    uint64 public constant SNAPSHOT_TTL = 30 minutes;

    struct Class {
        uint16 ltvBps;
        uint16 liqThresholdBps;
        bool enabled;
        uint128 maxCollateral; // exposure cap in base units
        uint128 minCollateral; // smallest position after an open or a withdrawal, in base units
        uint128 minDebt; // smallest non-zero debt, USDG base units
    }

    struct Snapshot {
        bytes32 leavesHash;
        uint64 takenAt;
    }

    struct PositionProof {
        bytes proof;
        uint8 slot;
        uint256 root;
        uint256 extDataHash;
        address collAsset;
        address inAsset;
        uint256 mark;
        uint256 rateIndex;
        uint256 oldLeaf;
        uint256 newLeaf;
        uint256 collIn;
        uint256 collOut;
        uint256 draw;
        uint256 repay;
        uint256 drawScaled;
        uint256 repayScaled;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
        uint256[2] operatorEph;
        uint256[4] operatorCipher;
    }

    struct HealthProof {
        bytes proof;
        uint256 snapshotId;
        uint256[SLOTS] leaves; // the slots at the snapshot
        uint256[CLASSES] marks;
        uint256 rateIndex;
        uint256 sumValue;
        uint256 sumDebt;
        uint256 breachCommit;
    }

    struct LiquidationProof {
        bytes proof;
        address collAsset;
        uint256 mark;
        uint256 price;
        uint256 rateIndex;
        uint8[4] slots;
        uint256[4] oldLeaves;
        uint256[4] newLeaves;
        uint256[4] encSold;
        uint256[4] encRepaid;
        uint256 totalSold;
        uint256 totalValue;
        uint256 totalRepay;
        uint256 totalRepaidScaled;
        uint256 totalWrittenOff;
    }

    struct EvictProof {
        bytes proof;
        uint8 slot;
        address asset;
        uint256 collateral;
        uint256 commitment;
    }

    /// Field order must match src/lib/zk/position.js POSITION_EXT.
    struct PositionExt {
        address relayer;
        uint256 fee;
        bytes encryptedOutput1;
        bytes encryptedOutput2;
        bytes encryptedPosition;
    }

    IVerifier public immutable verifier;
    IVerifier public immutable healthVerifier;
    IVerifier public immutable liquidationVerifier;
    IVerifier public immutable evictVerifier;
    ZKDeskPool public immutable pool;
    Marker public immutable marker;
    LendingPoolUSDG public immutable lending;
    IERC20 public immutable usdg;

    mapping(address asset => Class) public classes;
    address[] public classList; // health proof class order
    uint256[2] public operatorPk; // desk operator Grumpkin key: it can read every position's contents
    ISaleVenue public venue;
    address public bonusSink; // liquidation bonus + sale surplus (the governance Safe on mainnet)
    uint64 public epoch;
    uint64 public lastAttestedAt;
    uint256 public breachCommit;
    mapping(address asset => uint256) public totalCollateral;
    uint256[SLOTS] public slots;
    uint64[SLOTS] public touchedAt; // last step or liquidation (the step interval)
    /// Last activity that keeps a position from eviction: opening, debt moves, and collateral moves of
    /// at least the class minimum. A tiny top-up does not count (audit H-1 residual).
    uint64[SLOTS] public activeAt;
    mapping(uint256 id => Snapshot) public snapshots;
    uint256 public snapshotCount;
    uint256 public attestedSnapshot; // the snapshot the current breach set was proven against
    uint256 public totalDebtScaled;
    uint256 public index = WAD;
    uint256 public prevIndex = WAD;
    uint256 public ratePerSecond; // WAD
    uint64 public lastAccrual;
    bool public paused; // guardian pause: new risk only

    event ClassSet(address indexed asset, uint16 ltvBps, uint16 liqThresholdBps, uint128 maxCollateral, uint128 minCollateral, uint128 minDebt, bool enabled);
    event SnapshotTaken(uint256 indexed id, bytes32 leavesHash);
    event BatchSkipped(address indexed asset, uint8[4] slots);
    event Evicted(uint8 indexed slot, address indexed asset, uint256 collateral, uint256 commitment);
    event PositionUpdated(uint8 indexed slot, uint256 leaf, bytes ciphertext);
    event CreditFlow(address indexed asset, uint256 collIn, uint256 collOut, uint256 draw, uint256 repay);
    event Accrued(uint256 index, uint256 ratePerSecond, uint256 interest);
    event Paused(bool paused);
    event OperatorNote(uint8 indexed slot, address asset, uint256[2] eph, uint256[4] cipher);
    event Attested(uint64 indexed epoch, uint256 sumValue, uint256 sumDebt, uint256 breachCommit);
    event Liquidated(address indexed asset, uint256 positions, uint256 collSold, uint256 proceeds, uint256 repaid, uint256 price, uint256 writtenOffScaled);
    event VenueSet(address venue, address bonusSink);

    error ClassDisabled();
    error BadAsset();
    error SlotMismatch();
    error StaleIndex();
    error MarkUnusable();
    error DeskPaused();
    error ExposureCap();
    error ExtDataHashMismatch();
    error FeeNotSupported();
    error InvalidProof();
    error HealthStale();
    error TooManyClasses();
    error PriceOutOfBand();
    error EmptyBatch();
    error NotIdle();
    error EmptyStep();
    error TooSoon();
    error StaleSnapshot();

    /// verifiers: [position, health_epoch, liquidate, evict]
    constructor(IVerifier[4] memory verifiers, ZKDeskPool pool_, Marker marker_, LendingPoolUSDG lending_, uint256[2] memory operatorPk_, address owner_) Ownable(owner_) {
        (verifier, healthVerifier, liquidationVerifier, evictVerifier) = (verifiers[0], verifiers[1], verifiers[2], verifiers[3]);
        operatorPk = operatorPk_;
        lastAttestedAt = uint64(block.timestamp); // grace until the first epoch
        pool = pool_;
        marker = marker_;
        lending = lending_;
        usdg = IERC20(lending_.asset());
        lastAccrual = uint64(block.timestamp);
        ratePerSecond = _ratePerSecond(0);
    }

    // ---- Governance ----

    function setClass(address asset, uint16 ltvBps, uint16 liqThresholdBps, uint128 maxCollateral, uint128 minCollateral, uint128 minDebt, bool enabled) external onlyOwner {
        if (asset == address(usdg) || asset == address(0) || ltvBps >= liqThresholdBps || liqThresholdBps >= 10_000) revert BadAsset();
        if (classes[asset].liqThresholdBps == 0) {
            if (classList.length == CLASSES) revert TooManyClasses();
            classList.push(asset);
        }
        classes[asset] = Class(ltvBps, liqThresholdBps, enabled, maxCollateral, minCollateral, minDebt);
        emit ClassSet(asset, ltvBps, liqThresholdBps, maxCollateral, minCollateral, minDebt, enabled);
    }

    function setVenue(ISaleVenue venue_, address bonusSink_) external onlyOwner {
        venue = venue_;
        bonusSink = bonusSink_;
        emit VenueSet(address(venue_), bonusSink_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    // ---- Rates ----

    /// @notice Checkpoints the rate index (rate-publisher, hourly). At most every 10 minutes so
    /// proofs in flight against the latest/previous checkpoint stay valid.
    function accrue() public {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt < MIN_ACCRUAL_INTERVAL) return;
        uint256 newIndex = index + index * ratePerSecond * dt / WAD;
        uint256 interest = totalDebtScaled * (newIndex - index) / WAD;
        uint256 reserves = totalDebtScaled * (newIndex - index) * SPREAD_BPS / (WAD * 10_000);
        prevIndex = index;
        index = newIndex;
        lastAccrual = uint64(block.timestamp);
        if (reserves > 0) lending.addReserves(reserves);
        ratePerSecond = _ratePerSecond(lending.utilizationBps());
        emit Accrued(newIndex, ratePerSecond, interest);
    }

    /// @notice Live index (for NAV); positions settle against checkpoints.
    function currentIndex() public view returns (uint256) {
        return index + index * ratePerSecond * (block.timestamp - lastAccrual) / WAD;
    }

    function totalDebt() external view returns (uint256) {
        return totalDebtScaled * currentIndex() / WAD;
    }

    function aprBps(uint256 utilizationBps) public pure returns (uint256) {
        if (utilizationBps <= KINK_BPS) return BASE_BPS + (KINK_RATE_BPS - BASE_BPS) * utilizationBps / KINK_BPS;
        return KINK_RATE_BPS + (MAX_RATE_BPS - KINK_RATE_BPS) * (utilizationBps - KINK_BPS) / (10_000 - KINK_BPS);
    }

    function _ratePerSecond(uint256 utilizationBps) internal pure returns (uint256) {
        return aprBps(utilizationBps) * WAD / 10_000 / 365 days;
    }

    // ---- Positions ----

    function act(PositionProof calldata p, PositionExt calldata ext) external nonReentrant {
        Class memory c = classes[p.collAsset];
        if (c.liqThresholdBps == 0) revert BadAsset();
        // A disabled class stops new risk only: opening, drawing, withdrawing from a live position.
        if (!c.enabled && (p.oldLeaf == 0 || p.draw > 0 || (p.collOut > 0 && p.newLeaf != 0))) revert ClassDisabled();
        if (p.inAsset != p.collAsset && p.inAsset != address(usdg)) revert BadAsset();
        if (p.collIn == 0 && p.collOut == 0 && p.draw == 0 && p.repay == 0) revert EmptyStep();
        if (slots[p.slot] != p.oldLeaf) revert SlotMismatch();
        bool reducesRisk = p.draw == 0 && p.collOut == 0; // adds collateral or repays
        if (p.oldLeaf != 0 && p.newLeaf != 0 && !reducesRisk && block.timestamp < touchedAt[p.slot] + STEP_INTERVAL) revert TooSoon();
        // A position that remains is proven healthy at the current index: the previous one understates
        // debt, so a breached position could still step and change its leaf (audit V39 N-A). accrue()
        // is permissionless, so no grace window for the previous index would hold. Closing may use it.
        if (p.rateIndex != index && (p.newLeaf != 0 || p.rateIndex != prevIndex)) revert StaleIndex();
        // A position that remains is proven healthy at this mark, so it must be the latest pin (or the
        // previous one just after a new round). New risk also needs it fresh and unpaused. Closing
        // needs no mark: exits never wait on the oracle.
        if (p.newLeaf != 0 && !_stepMark(p.collAsset, p.mark)) revert MarkUnusable();
        if (p.draw > 0 || (p.collOut > 0 && p.newLeaf != 0)) {
            if (paused) revert DeskPaused();
            if (!marker.usable(p.collAsset, p.mark)) revert MarkUnusable();
        }
        if (p.draw > 0 && !healthy()) revert HealthStale();
        if (p.extDataHash != uint256(keccak256(abi.encode(ext))) % FIELD) revert ExtDataHashMismatch();
        if (ext.fee != 0) revert FeeNotSupported(); // the relayer charges credit steps off-chain (a prepaid voucher)
        if (p.collIn > 0 && totalCollateral[p.collAsset] + p.collIn > c.maxCollateral) revert ExposureCap();
        if (!verifier.verify(p.proof, _publicInputs(p, c))) revert InvalidProof();

        pool.moduleSpend(p.root, p.inputNullifiers);
        if (p.collIn > 0) {
            pool.moduleTake(p.collAsset, p.collIn, address(this));
            totalCollateral[p.collAsset] += p.collIn;
        }
        if (p.repay > 0) pool.moduleTake(address(usdg), p.repay, address(lending));
        if (p.draw > 0) {
            lending.borrow(p.draw, address(this));
            usdg.forceApprove(address(pool), p.draw);
            pool.moduleGive(address(usdg), p.draw);
        }
        if (p.collOut > 0) {
            totalCollateral[p.collAsset] -= p.collOut;
            IERC20(p.collAsset).forceApprove(address(pool), p.collOut);
            pool.moduleGive(p.collAsset, p.collOut);
        }
        totalDebtScaled = totalDebtScaled + p.drawScaled - p.repayScaled;
        pool.moduleInsert(p.outputCommitments[0], ext.encryptedOutput1);
        pool.moduleInsert(p.outputCommitments[1], ext.encryptedOutput2);
        slots[p.slot] = p.newLeaf;
        touchedAt[p.slot] = uint64(block.timestamp);
        // Activity for eviction: opening, or moving at least a class minimum of debt or collateral (a
        // draw and repay of dust no longer keeps an idle position, V39 H-1r residual).
        if (p.oldLeaf == 0 || (p.draw > 0 && p.draw >= c.minDebt) || (p.repay > 0 && p.repay >= c.minDebt) || p.collIn >= c.minCollateral || p.collOut >= c.minCollateral) activeAt[p.slot] = uint64(block.timestamp);
        emit OperatorNote(p.slot, p.collAsset, p.operatorEph, p.operatorCipher);
        emit PositionUpdated(p.slot, p.newLeaf, ext.encryptedPosition);
        emit CreditFlow(p.collAsset, p.collIn, p.collOut, p.draw, p.repay);
    }

    // ---- Health ----

    /// @notice False once two epochs were missed: new draws halt, everything else continues.
    function healthy() public view returns (bool) {
        return block.timestamp <= lastAttestedAt + 3 * (marker.marketOpen() ? EPOCH : OFF_HOURS_EPOCH);
    }

    /// @notice Records the 64 slot leaves under a new id for an epoch proof. Permissionless: a
    /// snapshot never replaces another, so taking one cannot invalidate a proof in flight.
    function snapshot() external returns (uint256 id) {
        id = ++snapshotCount;
        bytes32 h = keccak256(abi.encode(slots));
        snapshots[id] = Snapshot(h, uint64(block.timestamp));
        emit SnapshotTaken(id, h);
    }

    /// @notice Epoch health proof over every slot of a recent snapshot at the current pinned marks.
    /// Permissionless: only the desk operator can open the positions.
    function attest(HealthProof calldata h) external {
        _attest(h);
    }

    /// @notice The operator's epoch: attest, then liquidate the breached set it just committed to, in
    /// one transaction, so nothing can replace the breached set in between (audit M-1).
    function attestAndLiquidate(HealthProof calldata h, LiquidationProof[] calldata batches) external nonReentrant {
        // attest() is permissionless: if someone sent this same epoch proof first (audit V39 N-3), the
        // committed breached set is already this proof's, so its batches still go instead of reverting.
        if (h.snapshotId != attestedSnapshot || h.breachCommit != breachCommit) _attest(h);
        for (uint256 i; i < batches.length; ++i) _liquidate(batches[i]);
    }

    function _attest(HealthProof calldata h) internal {
        // A newer snapshot than the last epoch's, recent, and exactly the leaves it recorded.
        Snapshot memory s = snapshots[h.snapshotId];
        if (h.snapshotId <= attestedSnapshot || s.takenAt == 0 || block.timestamp > s.takenAt + SNAPSHOT_TTL) revert StaleSnapshot();
        if (keccak256(abi.encode(h.leaves)) != s.leavesHash) revert SlotMismatch();
        // The current index, or the previous one just after a checkpoint (a proof in flight).
        if (h.rateIndex != index && (h.rateIndex != prevIndex || block.timestamp > lastAccrual + ATTEST_GRACE)) revert StaleIndex();
        bytes32[] memory x = new bytes32[](SLOTS + 3 * CLASSES + 5);
        for (uint256 i; i < SLOTS; ++i) x[i] = bytes32(h.leaves[i]);
        for (uint256 k; k < CLASSES; ++k) {
            address asset = k < classList.length ? classList[k] : address(0);
            if (asset != address(0)) {
                if (!marker.usable(asset, h.marks[k])) revert MarkUnusable();
                // The current pin, or the previous one within ATTEST_GRACE of the current round (audit M-1).
                (uint64 current, uint64 updatedAt,) = marker.current(asset);
                if (h.marks[k] != current && block.timestamp > updatedAt + ATTEST_GRACE) revert MarkUnusable();
            }
            x[SLOTS + k] = bytes32(uint256(uint160(asset)));
            x[SLOTS + CLASSES + k] = bytes32(h.marks[k]);
            x[SLOTS + 2 * CLASSES + k] = bytes32(uint256(classes[asset].liqThresholdBps));
        }
        x[SLOTS + 3 * CLASSES] = bytes32(h.rateIndex);
        x[SLOTS + 3 * CLASSES + 1] = bytes32(h.sumValue);
        x[SLOTS + 3 * CLASSES + 2] = bytes32(h.sumDebt);
        x[SLOTS + 3 * CLASSES + 3] = bytes32(h.breachCommit);
        x[SLOTS + 3 * CLASSES + 4] = bytes32(h.snapshotId); // single use: no replay to mask an outage
        if (!healthVerifier.verify(h.proof, x)) revert InvalidProof();
        attestedSnapshot = h.snapshotId;
        epoch++;
        lastAttestedAt = uint64(block.timestamp);
        breachCommit = h.breachCommit;
        emit Attested(epoch, h.sumValue, h.sumDebt, h.breachCommit);
    }

    /// @notice Sealed batch: sells breached positions' collateral at one uniform price (within the
    /// band of the pinned mark) through the venue, repays lenders, sends the bonus to the bond pool.
    /// Unsold collateral stays in each position; owners follow it from the masked amounts.
    function liquidate(LiquidationProof calldata p) external nonReentrant {
        _liquidate(p);
    }

    function _liquidate(LiquidationProof calldata p) internal {
        uint16 liqBps = classes[p.collAsset].liqThresholdBps;
        if (liqBps == 0) revert BadAsset();
        if (p.rateIndex != index && p.rateIndex != prevIndex) revert StaleIndex();
        if (!marker.usable(p.collAsset, p.mark)) revert MarkUnusable();
        bool open = marker.marketOpen();
        uint256 band = open ? BAND_BPS : OFF_HOURS_BAND_BPS;
        if (p.price * 10_000 < p.mark * (10_000 - band) || p.price * 10_000 > p.mark * (10_000 + band)) revert PriceOutOfBand();

        uint256 n = 0;
        bool changed;
        for (uint256 i; i < 4; ++i) {
            if (p.oldLeaves[i] == 0) continue;
            // Used entries come first, in strictly increasing slot order: no slot twice in a batch.
            if (i != n || (n > 0 && p.slots[i] <= p.slots[i - 1])) revert SlotMismatch();
            if (slots[p.slots[i]] != p.oldLeaves[i]) changed = true;
            n++;
        }
        if (n == 0) revert EmptyBatch();
        if (!liquidationVerifier.verify(p.proof, _liquidationInputs(p, liqBps, open, classes[p.collAsset].minDebt))) revert InvalidProof();
        // A position stepped after the snapshot is healthy by the step rule: the batch is stale. Skip
        // it (the next epoch re-plans) instead of reverting the whole call (audit N-1). Only a valid
        // batch is reported as skipped.
        if (changed) {
            emit BatchSkipped(p.collAsset, p.slots);
            return;
        }

        for (uint256 i; i < n; ++i) {
            slots[p.slots[i]] = p.newLeaves[i];
            touchedAt[p.slots[i]] = uint64(block.timestamp);
            activeAt[p.slots[i]] = uint64(block.timestamp);
            emit PositionUpdated(p.slots[i], p.newLeaves[i], abi.encode(p.encSold[i], p.encRepaid[i]));
        }
        totalCollateral[p.collAsset] -= p.totalSold;
        totalDebtScaled -= p.totalRepaidScaled + p.totalWrittenOff;
        if (p.totalWrittenOff > 0) lending.coverLoss(p.totalWrittenOff * p.rateIndex / WAD); // reserves absorb bad debt first
        IERC20(p.collAsset).forceApprove(address(venue), p.totalSold);
        uint256 proceeds = venue.swap(p.collAsset, p.totalSold, p.totalValue);
        usdg.safeTransfer(address(lending), p.totalRepay);
        usdg.safeTransfer(bonusSink, proceeds - p.totalRepay);
        emit Liquidated(p.collAsset, n, p.totalSold, proceeds, p.totalRepay, p.price, p.totalWrittenOff);
    }

    /// @notice Frees the slot of a position without debt and without activity (activeAt) for
    /// EVICT_AFTER (audit H-1). The proof (circuits/evict) shows the slot holds `collateral` and no debt, and that
    /// `commitment` is a note of that collateral for the same owner; the pool receives both.
    function evict(EvictProof calldata e) external nonReentrant {
        uint256 leaf = slots[e.slot];
        if (leaf == 0) revert SlotMismatch();
        if (block.timestamp < activeAt[e.slot] + EVICT_AFTER) revert NotIdle();
        if (classes[e.asset].liqThresholdBps == 0) revert BadAsset();
        bytes32[] memory x = new bytes32[](4);
        x[0] = bytes32(leaf);
        x[1] = bytes32(uint256(uint160(e.asset)));
        x[2] = bytes32(e.collateral);
        x[3] = bytes32(e.commitment);
        if (!evictVerifier.verify(e.proof, x)) revert InvalidProof();
        slots[e.slot] = 0;
        touchedAt[e.slot] = uint64(block.timestamp);
        activeAt[e.slot] = uint64(block.timestamp);
        totalCollateral[e.asset] -= e.collateral;
        IERC20(e.asset).forceApprove(address(pool), e.collateral);
        pool.moduleGive(e.asset, e.collateral);
        pool.moduleInsert(e.commitment, "");
        emit Evicted(e.slot, e.asset, e.collateral, e.commitment);
        emit PositionUpdated(e.slot, 0, "");
    }

    function allSlots() external view returns (uint256[SLOTS] memory) {
        return slots;
    }

    /// Order must match the `pub` parameters of circuits/position/src/main.nr.
    function _publicInputs(PositionProof calldata p, Class memory c) internal view returns (bytes32[] memory x) {
        x = new bytes32[](31);
        x[0] = bytes32(p.root);
        x[1] = bytes32(p.extDataHash);
        x[2] = bytes32(uint256(uint160(p.collAsset)));
        x[3] = bytes32(uint256(uint160(address(usdg))));
        x[4] = bytes32(uint256(uint160(p.inAsset)));
        x[5] = bytes32(p.mark);
        x[6] = bytes32(uint256(c.ltvBps));
        x[7] = bytes32(p.rateIndex);
        x[8] = bytes32(p.oldLeaf);
        x[9] = bytes32(p.newLeaf);
        x[10] = bytes32(p.collIn);
        x[11] = bytes32(p.collOut);
        x[12] = bytes32(p.draw);
        x[13] = bytes32(p.repay);
        x[14] = bytes32(p.drawScaled);
        x[15] = bytes32(p.repayScaled);
        x[16] = bytes32(p.inputNullifiers[0]);
        x[17] = bytes32(p.inputNullifiers[1]);
        x[18] = bytes32(p.outputCommitments[0]);
        x[19] = bytes32(p.outputCommitments[1]);
        x[20] = bytes32(operatorPk[0]);
        x[21] = bytes32(operatorPk[1]);
        x[22] = bytes32(p.operatorEph[0]);
        x[23] = bytes32(p.operatorEph[1]);
        for (uint256 i; i < 4; ++i) x[24 + i] = bytes32(p.operatorCipher[i]);
        x[28] = bytes32(uint256(c.minCollateral));
        x[29] = bytes32(uint256(c.liqThresholdBps));
        x[30] = bytes32(uint256(c.minDebt));
    }

    /// Order must match the `pub` parameters of circuits/liquidate/src/main.nr.
    function _liquidationInputs(LiquidationProof calldata p, uint16 liqBps, bool open, uint128 minDebt) internal view returns (bytes32[] memory x) {
        x = new bytes32[](33);
        x[0] = bytes32(breachCommit);
        x[1] = bytes32(uint256(uint160(p.collAsset)));
        x[2] = bytes32(p.mark);
        x[3] = bytes32(p.price);
        x[4] = bytes32(uint256(liqBps));
        x[5] = bytes32(p.rateIndex);
        x[6] = bytes32(uint256(open ? 1 : 0));
        for (uint256 i; i < 4; ++i) {
            x[7 + i] = bytes32(uint256(p.slots[i]));
            x[11 + i] = bytes32(p.oldLeaves[i]);
            x[15 + i] = bytes32(p.newLeaves[i]);
            x[19 + i] = bytes32(p.encSold[i]);
            x[23 + i] = bytes32(p.encRepaid[i]);
        }
        x[27] = bytes32(p.totalSold);
        x[28] = bytes32(p.totalValue);
        x[29] = bytes32(p.totalRepay);
        x[30] = bytes32(p.totalRepaidScaled);
        x[31] = bytes32(p.totalWrittenOff);
        x[32] = bytes32(uint256(minDebt));
    }

    /// A step's mark: the latest pin, or the previous one within ATTEST_GRACE of the latest round only
    /// if it is not higher (a proof in flight may be conservative, never optimistic: audit L-a, a
    /// breached position cannot "cure" at the old, higher price).
    function _stepMark(address asset, uint256 mark) internal view returns (bool) {
        (uint64 current, uint64 updatedAt,) = marker.current(asset);
        if (mark == current) return true;
        (uint64 previous,,) = marker.previous(asset);
        return mark == previous && previous <= current && block.timestamp <= updatedAt + ATTEST_GRACE;
    }
}
