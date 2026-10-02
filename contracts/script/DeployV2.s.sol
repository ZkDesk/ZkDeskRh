// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker} from "../src/Marker.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {DeskGuardian} from "../src/DeskGuardian.sol";
import {UniswapV3Venue, ISwapRouter02} from "../src/UniswapV3Venue.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {PositionVerifier, IVerifier} from "../src/verifiers/PositionVerifier.sol";
import {HealthEpochVerifier} from "../src/verifiers/HealthEpochVerifier.sol";
import {LiquidateVerifier} from "../src/verifiers/LiquidateVerifier.sol";
import {EvictVerifier} from "../src/verifiers/EvictVerifier.sol";
import {LedgerVerifier, IVerifier as ILedgerVerifier} from "../src/verifiers/LedgerVerifier.sol";
import {RoleAuthVerifier} from "../src/verifiers/RoleAuthVerifier.sol";
import {TreasuryAttestVerifier} from "../src/verifiers/TreasuryAttestVerifier.sol";
import {MandateAuthVerifier} from "../src/verifiers/MandateAuthVerifier.sol";
import {MandatePullVerifier, IVerifier as IMandateVerifier} from "../src/verifiers/MandatePullVerifier.sol";
import {ReceiptVerifier} from "../src/verifiers/ReceiptVerifier.sol";

interface IFeeOf {
    function feeOf(address token) external view returns (uint24);
}

/// v2 of the protocol (audit fixes H-1, M-1 to M-5, M-7) beside v1, on testnet (46630) or mainnet (4663).
/// Reuses from src/lib/chain/deployments/<chainId>.json what did not change: USDG, the stock tokens
/// and feeds, the Marker (and its pinner), the yield vault, the Safe and the timelock. Deploys a new
/// gate, pool (module set fixed here), lending pool, desk, venue, treasury ledgers and mandates; the
/// timelock owns them all, through a new DeskGuardian for the desk. v1 stays deployed for exits.
/// Also deploys later releases the same way (v3: audit fix-to-8 Parts A and C), beside the current one.
/// Writes deployments/<chainId>.<RELEASE>.json; scripts/ops/merge-v2.mjs folds it into the deployment file.
/// Env: DEPLOYER_PRIVATE_KEY (MAINNET_ on mainnet), DESK_OPERATOR_PK_X / _Y, GUARDIAN, SCREENER,
/// RELEASE (default v2).
contract DeployV2 is Script {
    uint64 constant STANDBY = 60;
    uint128 constant MAX_COLLATERAL = 100_000e18; // per class, in stock tokens
    uint256 constant MIN_POSITION_USD = 25e8; // smallest position, 8 dp USD (audit H-1)
    uint128 constant MIN_DEBT = 5e6; // 5 USDG: debt is zero or at least this (audit H-1)
    ISwapRouter02 constant ROUTER = ISwapRouter02(0xCaf681a66D020601342297493863E78C959E5cb2); // mainnet
    uint256 constant TESTNET_SEED_LIQUIDITY = 50_000e6;

    struct Old {
        address usdg;
        address marker;
        address vault;
        address safe;
        address timelock;
        address venue; // mainnet: UniswapV3Venue (fee tiers); testnet: MockAMM, reused
        address bonusSink; // mainnet: the Safe; testnet: ZKDStaking
        address[4] tokens;
        uint16[4] ltv;
        uint16[4] liq;
    }

    struct New {
        AssetGate gate;
        ZKDeskPool pool;
        LendingPoolUSDG lending;
        CreditDesk desk;
        address venue;
        TreasuryLedger ledger;
        MandateRegistry mandates;
        DeskGuardian guardian;
    }

    function _old(string memory json, bool mainnet) internal view returns (Old memory o) {
        o.usdg = vm.parseJsonAddress(json, ".usdg");
        o.marker = vm.parseJsonAddress(json, ".marker");
        o.vault = vm.parseJsonAddress(json, ".vault");
        o.safe = vm.parseJsonAddress(json, ".safe");
        o.timelock = vm.parseJsonAddress(json, ".timelock");
        o.venue = vm.parseJsonAddress(json, mainnet ? ".venue" : ".amm");
        o.bonusSink = mainnet ? o.safe : vm.parseJsonAddress(json, ".staking");
        string[4] memory symbols = mainnet ? ["SPY", "QQQ", "NVDA", "TSLA"] : ["tSPY", "tQQQ", "tNVDA", "tTSLA"];
        for (uint256 i; i < 4; ++i) {
            string memory k = string.concat(".stocks.", symbols[i]);
            o.tokens[i] = vm.parseJsonAddress(json, string.concat(k, ".token"));
            o.ltv[i] = uint16(vm.parseJsonUint(json, string.concat(k, ".ltvBps")));
            o.liq[i] = uint16(vm.parseJsonUint(json, string.concat(k, ".liqBps")));
        }
    }

    function _core(Old memory o, address deployer, bool mainnet) internal returns (New memory n) {
        n.gate = new AssetGate(deployer, vm.envAddress("SCREENER"));
        n.pool = new ZKDeskPool(new TransactVerifier(), n.gate, STANDBY);
        n.lending = new LendingPoolUSDG(IERC20(o.usdg), deployer);
        n.desk = new CreditDesk(
            [IVerifier(address(new PositionVerifier())), IVerifier(address(new HealthEpochVerifier())), IVerifier(address(new LiquidateVerifier())), IVerifier(address(new EvictVerifier()))],
            n.pool, Marker(o.marker), n.lending, [vm.envUint("DESK_OPERATOR_PK_X"), vm.envUint("DESK_OPERATOR_PK_Y")], deployer
        );
        n.venue = mainnet ? address(new UniswapV3Venue(ROUTER, IERC20(o.usdg), deployer)) : o.venue;
        n.lending.setDesk(IDeskDebt(address(n.desk)));
        n.ledger = new TreasuryLedger(
            [ILedgerVerifier(address(new LedgerVerifier())), ILedgerVerifier(address(new RoleAuthVerifier())), ILedgerVerifier(address(new TreasuryAttestVerifier()))],
            n.pool, Marker(o.marker), IERC4626(o.vault), o.tokens
        );
        n.mandates = new MandateRegistry(
            [IMandateVerifier(address(new MandateAuthVerifier())), IMandateVerifier(address(new MandatePullVerifier())), IMandateVerifier(address(new ReceiptVerifier()))],
            n.pool, n.ledger, Marker(o.marker)
        );
    }

    function _wire(Old memory o, New memory n, bool mainnet) internal {
        address[] memory modules = new address[](3);
        (modules[0], modules[1], modules[2]) = (address(n.desk), address(n.ledger), address(n.mandates));
        n.pool.setModules(modules);
        n.gate.setAsset(o.usdg, true);
        n.gate.setAsset(address(n.lending), true);
        n.gate.setConverter(address(n.lending), true);
        n.gate.setAsset(o.vault, true);
        for (uint256 i; i < 4; ++i) {
            n.gate.setAsset(o.tokens[i], true);
            (uint64 price,,) = Marker(o.marker).current(o.tokens[i]);
            uint128 minColl = uint128(MIN_POSITION_USD * 1e18 / price); // price: 8 dp USD per 1e18 base units
            n.desk.setClass(o.tokens[i], o.ltv[i], o.liq[i], MAX_COLLATERAL, minColl, MIN_DEBT, true);
            if (mainnet) UniswapV3Venue(n.venue).setPool(o.tokens[i], IFeeOf(o.venue).feeOf(o.tokens[i]));
        }
        n.desk.setVenue(ISaleVenue(n.venue), o.bonusSink);
    }

    function _govern(Old memory o, New memory n, bool mainnet) internal {
        n.guardian = new DeskGuardian(n.desk, o.timelock, vm.envAddress("GUARDIAN"));
        n.desk.transferOwnership(address(n.guardian));
        n.gate.transferOwnership(o.timelock);
        n.lending.transferOwnership(o.timelock);
        if (mainnet) UniswapV3Venue(n.venue).transferOwnership(o.timelock);
    }

    function run() external {
        bool mainnet = block.chainid == 4663;
        require(mainnet || block.chainid == 46630, "4663 or 46630");
        uint256 key = vm.envUint(mainnet ? "MAINNET_DEPLOYER_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        string memory path = string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid));
        Old memory o = _old(vm.readFile(string.concat(path, ".json")), mainnet);

        vm.startBroadcast(key);
        New memory n = _core(o, deployer, mainnet);
        _wire(o, n, mainnet);
        if (!mainnet) {
            MockUSDG(o.usdg).faucet(TESTNET_SEED_LIQUIDITY);
            IERC20(o.usdg).approve(address(n.lending), TESTNET_SEED_LIQUIDITY);
            n.lending.deposit(TESTNET_SEED_LIQUIDITY, deployer);
        }
        _govern(o, n, mainnet);
        vm.stopBroadcast();

        string memory w = vm.envOr("RELEASE", string("v2"));
        vm.serializeUint(w, "deployBlock", block.number); // parent-chain block on Arbitrum chains; merge-v2.mjs replaces it
        vm.serializeUint(w, "deployedAt", block.timestamp);
        vm.serializeAddress(w, "assetGate", address(n.gate));
        vm.serializeAddress(w, "lending", address(n.lending));
        vm.serializeAddress(w, "desk", address(n.desk));
        vm.serializeAddress(w, "deskGuardian", address(n.guardian));
        vm.serializeAddress(w, mainnet ? "venue" : "amm", n.venue);
        vm.serializeAddress(w, "ledger", address(n.ledger));
        vm.serializeAddress(w, "mandates", address(n.mandates));
        string memory out = vm.serializeAddress(w, "pool", address(n.pool));
        vm.writeJson(out, string.concat(path, ".", w, ".json"));
    }
}
