// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVerifier} from "./verifiers/LedgerVerifier.sol";
import {ZKDeskPool} from "./ZKDeskPool.sol";
import {Marker} from "./Marker.sol";

/// @notice Confidential business treasuries. A ledger's notes live in the shielded pool under the
/// ledger's own owner domain and move only through LedgerProofs: the acting member proves a role in
/// the hidden role set (OWNER / TREASURER / PAYER; AUDITOR can only read) and compliance with the
/// hidden policy (allocation cap, dual-control threshold). On-chain per ledger: a roles commitment,
/// a policy hash and an attestation epoch counter. No balances, members or amounts.
///
/// Governance (RoleAuthProof, OWNER only): create, rotate roles, set policy, approve a transfer above
/// the dual-control threshold, set the outflow limit. Key shares (the ledger secret, encrypted to
/// each member) and the config (encrypted to the ledger key) are posted as events and bound into the
/// proof. An approval belongs to one ledger and is used once (audit M-4).
/// Outflow limit (audit M-4): the Owner may cap how many transfers leave the ledger without the
/// Owner's approval per period. Each such transfer is below the dual-control threshold, so the cap
/// bounds the cumulative outflow (count x threshold) without revealing any amount.
/// Treasury statements (AttestProof): unspent ledger notes at contract prices cover declared
/// liabilities; only the statement is published.
contract TreasuryLedger is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint8 public constant ALLOCATE = 0;
    uint8 public constant DEALLOCATE = 1;
    uint8 public constant TRANSFER_OUT = 2;
    uint8 public constant CREATE = 0;
    uint8 public constant ROTATE = 1;
    uint8 public constant SET_POLICY = 2;
    uint8 public constant APPROVE = 3;
    uint8 public constant SET_LIMIT = 4; // newValue = maxTransfers | period << 64 (0 = no limit)
    uint256 public constant ATTEST_NOTES = 8; // circuits/treasury_attest K
    uint256 public constant ATTEST_ASSETS = 6; // circuits/treasury_attest A

    struct Ledger {
        uint256 rolesCommit;
        uint256 policyHash;
        uint64 epoch;
    }

    struct LedgerProof {
        bytes proof;
        uint256 root;
        uint256 ledgerId;
        uint8 action;
        address asset;
        address outAsset;
        uint256 publicAmount;
        uint256 publicAmountOut;
        uint256 extDataHash;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
        uint256 cosignIntent;
    }

    /// Field order must match src/lib/zk/ledger.js LEDGER_EXT.
    struct LedgerExt {
        address recipient;
        int256 extAmount;
        bytes encryptedOutput1;
        bytes encryptedOutput2;
    }

    struct AuthProof {
        bytes proof;
        uint256 ledgerId;
        uint256 rolesCommit;
        uint256 policyHash;
        uint8 action;
        uint256 newValue;
    }

    struct AttestProof {
        bytes proof;
        uint256 root;
        uint256 ledgerId;
        uint256 liabilities;
        uint256[ATTEST_NOTES] nullifiers;
    }

    IVerifier public immutable ledgerVerifier;
    IVerifier public immutable authVerifier;
    IVerifier public immutable attestVerifier;
    ZKDeskPool public immutable pool;
    Marker public immutable marker;
    IERC4626 public immutable vault;
    IERC20 public immutable usdg;
    address[4] internal stocks;

    struct Limit {
        uint64 maxTransfers; // transfers without the Owner's approval per period; 0 = no limit
        uint64 period; // seconds
        uint64 windowStart;
        uint64 used;
    }

    mapping(uint256 id => Ledger) public ledgers;
    mapping(uint256 id => mapping(uint256 intent => bool)) public approved;
    mapping(uint256 id => Limit) public limits;

    event LedgerCreated(uint256 indexed id, uint256 rolesCommit, uint256 policyHash);
    event RolesRotated(uint256 indexed id, uint256 rolesCommit);
    event PolicySet(uint256 indexed id, uint256 policyHash);
    event IntentApproved(uint256 indexed id, uint256 intent);
    event LimitSet(uint256 indexed id, uint64 maxTransfers, uint64 period);
    event KeyShare(uint256 indexed id, bytes share);
    event LedgerConfig(uint256 indexed id, bytes config);
    event LedgerAction(uint256 indexed id, uint8 action);
    event TreasuryAttested(uint256 indexed id, uint64 epoch, uint256 liabilities);

    error UnknownLedger();
    error LedgerExists();
    error StaleRoles();
    error BadAction();
    error BadAsset();
    error NotApproved();
    error ExtDataHashMismatch();
    error PublicAmountMismatch();
    error Slippage();
    error NoteSpent();
    error UnknownRoot();
    error InvalidProof();
    error LimitReached();

    /// verifiers: [ledger, role_auth, treasury_attest]
    constructor(IVerifier[3] memory verifiers, ZKDeskPool pool_, Marker marker_, IERC4626 vault_, address[4] memory stocks_) {
        (ledgerVerifier, authVerifier, attestVerifier) = (verifiers[0], verifiers[1], verifiers[2]);
        pool = pool_;
        marker = marker_;
        vault = vault_;
        usdg = IERC20(vault_.asset());
        stocks = stocks_;
    }

    // ---- Governance ----

    function authorize(AuthProof calldata p, bytes[] calldata shares, bytes calldata config) external {
        Ledger storage l = ledgers[p.ledgerId];
        if (p.action == CREATE) {
            if (l.rolesCommit != 0) revert LedgerExists();
        } else if (l.rolesCommit == 0) {
            revert UnknownLedger();
        } else if (p.rolesCommit != l.rolesCommit || p.policyHash != l.policyHash) {
            revert StaleRoles();
        }
        if (p.action > SET_LIMIT) revert BadAction();
        bytes32[] memory x = new bytes32[](6);
        x[0] = bytes32(p.ledgerId);
        x[1] = bytes32(p.rolesCommit);
        x[2] = bytes32(p.policyHash);
        x[3] = bytes32(uint256(p.action));
        x[4] = bytes32(p.newValue);
        x[5] = bytes32(uint256(keccak256(abi.encode(shares, config))) % FIELD);
        if (!authVerifier.verify(p.proof, x)) revert InvalidProof();

        if (p.action == CREATE) {
            (l.rolesCommit, l.policyHash) = (p.rolesCommit, p.policyHash);
            emit LedgerCreated(p.ledgerId, p.rolesCommit, p.policyHash);
        } else if (p.action == ROTATE) {
            l.rolesCommit = p.newValue;
            emit RolesRotated(p.ledgerId, p.newValue);
        } else if (p.action == SET_POLICY) {
            l.policyHash = p.newValue;
            emit PolicySet(p.ledgerId, p.newValue);
        } else if (p.action == APPROVE) {
            approved[p.ledgerId][p.newValue] = true;
            emit IntentApproved(p.ledgerId, p.newValue);
        } else {
            (uint64 maxTransfers, uint64 period) = (uint64(p.newValue), uint64(p.newValue >> 64));
            if (maxTransfers != 0 && period == 0) revert BadAction();
            limits[p.ledgerId] = Limit(maxTransfers, period, uint64(block.timestamp), 0);
            emit LimitSet(p.ledgerId, maxTransfers, period);
        }
        for (uint256 i; i < shares.length; ++i) emit KeyShare(p.ledgerId, shares[i]);
        if (config.length > 0) emit LedgerConfig(p.ledgerId, config);
    }

    // ---- Actions ----

    function act(LedgerProof calldata p, LedgerExt calldata e) external nonReentrant {
        Ledger storage l = ledgers[p.ledgerId];
        if (l.rolesCommit == 0) revert UnknownLedger();
        if (p.extDataHash != uint256(keccak256(abi.encode(e))) % FIELD) revert ExtDataHashMismatch();
        if (p.publicAmount != pool.publicAmountOf(e.extAmount, 0) || e.extAmount > 0) revert PublicAmountMismatch();
        if (p.cosignIntent != 0) {
            if (!approved[p.ledgerId][p.cosignIntent]) revert NotApproved();
            delete approved[p.ledgerId][p.cosignIntent];
        } else if (p.action == TRANSFER_OUT) {
            _countTransfer(p.ledgerId);
        }
        uint256 amount = uint256(-e.extAmount);
        if (p.action == ALLOCATE || p.action == DEALLOCATE) {
            (address from, address to) = p.action == ALLOCATE ? (address(usdg), address(vault)) : (address(vault), address(usdg));
            if (p.asset != from || p.outAsset != to || e.recipient != address(0) || amount == 0) revert BadAsset();
        } else if (p.action == TRANSFER_OUT) {
            if (p.asset != p.outAsset || !pool.gate().isAllowed(p.asset) || (amount > 0) != (e.recipient != address(0))) revert BadAsset();
        } else {
            revert BadAction();
        }
        if (!ledgerVerifier.verify(p.proof, _ledgerInputs(p, l))) revert InvalidProof();

        pool.moduleSpend(p.root, p.inputNullifiers);
        pool.moduleInsert(p.outputCommitments[0], e.encryptedOutput1);
        if (p.action == TRANSFER_OUT) {
            if (amount > 0) pool.moduleTake(p.asset, amount, e.recipient);
        } else {
            pool.moduleTake(p.asset, amount, address(this));
            uint256 out;
            if (p.action == ALLOCATE) {
                usdg.forceApprove(address(vault), amount);
                out = vault.deposit(amount, address(this));
            } else {
                out = vault.redeem(amount, address(this), address(this));
            }
            if (out < p.publicAmountOut) revert Slippage();
            IERC20(p.outAsset).forceApprove(address(pool), out);
            pool.moduleGive(p.outAsset, out); // any surplus over the proven note stays in the pool
        }
        pool.moduleInsert(p.outputCommitments[1], e.encryptedOutput2);
        emit LedgerAction(p.ledgerId, p.action);
    }

    function _countTransfer(uint256 id) internal {
        Limit storage lim = limits[id];
        if (lim.maxTransfers == 0) return;
        if (block.timestamp >= lim.windowStart + lim.period) (lim.windowStart, lim.used) = (uint64(block.timestamp), 0);
        if (++lim.used > lim.maxTransfers) revert LimitReached();
    }

    // ---- Statements ----

    function attest(AttestProof calldata p) external {
        Ledger storage l = ledgers[p.ledgerId];
        if (l.rolesCommit == 0) revert UnknownLedger();
        if (!pool.isKnownRoot(p.root)) revert UnknownRoot();
        bytes32[] memory x = new bytes32[](3 + 2 * ATTEST_ASSETS + ATTEST_NOTES);
        x[0] = bytes32(p.root);
        x[1] = bytes32(p.ledgerId);
        x[2] = bytes32(p.liabilities);
        (address[ATTEST_ASSETS] memory assets, uint256[ATTEST_ASSETS] memory prices) = attestPrices();
        for (uint256 a; a < ATTEST_ASSETS; ++a) {
            x[3 + a] = bytes32(uint256(uint160(assets[a])));
            x[3 + ATTEST_ASSETS + a] = bytes32(prices[a]);
        }
        for (uint256 i; i < ATTEST_NOTES; ++i) {
            if (pool.nullifierSpent(p.nullifiers[i])) revert NoteSpent();
            x[3 + 2 * ATTEST_ASSETS + i] = bytes32(p.nullifiers[i]);
        }
        if (!attestVerifier.verify(p.proof, x)) revert InvalidProof();
        emit TreasuryAttested(p.ledgerId, ++l.epoch, p.liabilities);
    }

    /// @notice Assets a statement can count and their USDG (6 dp) value per 1e18 base units. Stock
    /// tokens count at usable pinned marks only (0 while stale or paused: conservative).
    function attestPrices() public view returns (address[ATTEST_ASSETS] memory assets, uint256[ATTEST_ASSETS] memory prices) {
        assets[0] = address(usdg);
        prices[0] = 1e18;
        assets[1] = address(vault);
        prices[1] = vault.convertToAssets(1e18);
        for (uint256 i; i < 4; ++i) {
            assets[2 + i] = stocks[i];
            (uint64 mark,,) = marker.current(stocks[i]);
            prices[2 + i] = marker.usable(stocks[i], mark) ? uint256(mark) / 100 : 0;
        }
    }

    /// Order must match the `pub` parameters of circuits/ledger/src/main.nr.
    function _ledgerInputs(LedgerProof calldata p, Ledger storage l) internal view returns (bytes32[] memory x) {
        x = new bytes32[](15);
        x[0] = bytes32(p.root);
        x[1] = bytes32(p.ledgerId);
        x[2] = bytes32(l.rolesCommit);
        x[3] = bytes32(l.policyHash);
        x[4] = bytes32(uint256(p.action));
        x[5] = bytes32(uint256(uint160(p.asset)));
        x[6] = bytes32(uint256(uint160(p.outAsset)));
        x[7] = bytes32(p.publicAmount);
        x[8] = bytes32(p.publicAmountOut);
        x[9] = bytes32(p.extDataHash);
        x[10] = bytes32(p.inputNullifiers[0]);
        x[11] = bytes32(p.inputNullifiers[1]);
        x[12] = bytes32(p.outputCommitments[0]);
        x[13] = bytes32(p.outputCommitments[1]);
        x[14] = bytes32(p.cosignIntent);
    }
}
