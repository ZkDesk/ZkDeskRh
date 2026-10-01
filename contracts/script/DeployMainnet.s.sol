// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {DeskGuardian} from "../src/DeskGuardian.sol";
import {UniswapV3Venue, ISwapRouter02} from "../src/UniswapV3Venue.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {PositionVerifier, IVerifier} from "../src/verifiers/PositionVerifier.sol";
import {HealthEpochVerifier} from "../src/verifiers/HealthEpochVerifier.sol";
import {LiquidateVerifier} from "../src/verifiers/LiquidateVerifier.sol";
import {LedgerVerifier, IVerifier as ILedgerVerifier} from "../src/verifiers/LedgerVerifier.sol";
import {RoleAuthVerifier} from "../src/verifiers/RoleAuthVerifier.sol";
import {TreasuryAttestVerifier} from "../src/verifiers/TreasuryAttestVerifier.sol";
import {MandateAuthVerifier} from "../src/verifiers/MandateAuthVerifier.sol";
import {MandatePullVerifier, IVerifier as IMandateVerifier} from "../src/verifiers/MandatePullVerifier.sol";
import {ReceiptVerifier} from "../src/verifiers/ReceiptVerifier.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}

interface ISafe {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external;
}

/// Robinhood Chain mainnet (4663): the whole protocol in one run, on the real USDG, Stock Tokens,
/// Chainlink feeds, Uniswap v3 and the Morpho "Steakhouse USDG" vault (docs/mainnet-facts.md).
/// No mocks and no $ZKD staking: the desk bonus goes to the Safe. Governance per the owner's
/// choice (2026-09-29): Safe 1-of-1 (the deployer) → 24 h timelock owns the gate, marker, lending
/// and venue; DeskGuardian owns the desk (the deployer may pause new risk at once).
/// Writes src/lib/chain/deployments/4663.json. Env: MAINNET_DEPLOYER_PRIVATE_KEY,
/// MAINNET_RELAYER_ADDRESS (mark pinner), DESK_OPERATOR_PK_X / _Y.
contract DeployMainnet is Script {
    uint64 constant STANDBY = 60;
    uint64 constant MARK_MAX_AGE = 25 hours; // Chainlink stock feeds: 24 h heartbeat or a 0.5% move
    uint256 constant MIN_DELAY = 24 hours;
    uint128 constant MAX_COLLATERAL = 100_000e18; // per class, in stock tokens

    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IERC4626 constant MORPHO_USDG = IERC4626(0xBeEff033F34C046626B8D0A041844C5d1A5409dd);
    ISwapRouter02 constant ROUTER = ISwapRouter02(0xCaf681a66D020601342297493863E78C959E5cb2);
    address constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    ISafeProxyFactory constant SAFE_FACTORY = ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);

    struct Stock {
        string symbol;
        address token;
        address feed;
        uint24 fee; // deepest USDG pool at probe time
        uint16 ltvBps;
        uint16 liqBps;
    }

    struct Core {
        AssetGate gate;
        ZKDeskPool pool;
        LendingPoolUSDG lending;
        Marker marker;
        CreditDesk desk;
        UniswapV3Venue venue;
        TreasuryLedger ledger;
        MandateRegistry mandates;
    }

    function stocks() internal pure returns (Stock[4] memory) {
        return [
            Stock("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 0x319724394D3A0e3669269846abE664Cd621f9f6A, 500, 6000, 7000),
            Stock("QQQ", 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 0x80901d846d5D7B030F26B480776EE3b29374C2ae, 500, 6000, 7000),
            Stock("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15, 500, 4500, 5500),
            Stock("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 0x4A1166a659A55625345e9515b32adECea5547C38, 3000, 4500, 5500)
        ];
    }

    function _credit(Core memory c, address deployer, address relayer) internal {
        c.gate = new AssetGate(deployer, deployer);
        c.pool = new ZKDeskPool(new TransactVerifier(), c.gate, STANDBY);
        c.lending = new LendingPoolUSDG(USDG, deployer);
        c.marker = new Marker(deployer, relayer, MARK_MAX_AGE);
        c.desk = new CreditDesk(
            [IVerifier(address(new PositionVerifier())), IVerifier(address(new HealthEpochVerifier())), IVerifier(address(new LiquidateVerifier()))],
            c.pool, c.marker, c.lending, [vm.envUint("DESK_OPERATOR_PK_X"), vm.envUint("DESK_OPERATOR_PK_Y")], deployer
        );
        c.venue = new UniswapV3Venue(ROUTER, USDG, deployer);
        c.lending.setDesk(IDeskDebt(address(c.desk)));
    }

    function _modules(Core memory c) internal {
        Stock[4] memory s = stocks();
        address[4] memory tokens = [s[0].token, s[1].token, s[2].token, s[3].token];
        c.ledger = new TreasuryLedger(
            [ILedgerVerifier(address(new LedgerVerifier())), ILedgerVerifier(address(new RoleAuthVerifier())), ILedgerVerifier(address(new TreasuryAttestVerifier()))],
            c.pool, c.marker, MORPHO_USDG, tokens
        );
        c.mandates = new MandateRegistry(
            [IMandateVerifier(address(new MandateAuthVerifier())), IMandateVerifier(address(new MandatePullVerifier())), IMandateVerifier(address(new ReceiptVerifier()))],
            c.pool, c.ledger, c.marker
        );
    }

    function _wire(Core memory c) internal {
        Stock[4] memory s = stocks();
        c.gate.setAsset(address(USDG), true);
        c.gate.setAsset(address(c.lending), true);
        c.gate.setConverter(address(c.lending), true);
        c.gate.setAsset(address(MORPHO_USDG), true);
        c.gate.setModule(address(c.desk), true);
        c.gate.setModule(address(c.ledger), true);
        c.gate.setModule(address(c.mandates), true);
        for (uint256 i; i < 4; ++i) {
            c.marker.setFeed(s[i].token, IAggregatorV3(s[i].feed));
            c.marker.pin(s[i].token);
            c.gate.setAsset(s[i].token, true);
            c.desk.setClass(s[i].token, s[i].ltvBps, s[i].liqBps, MAX_COLLATERAL, true);
            c.venue.setPool(s[i].token, s[i].fee);
        }
    }

    function _govern(Core memory c, address deployer) internal returns (address safe, TimelockController timelock, DeskGuardian guardian) {
        address[] memory owners = new address[](1);
        owners[0] = deployer;
        safe = SAFE_FACTORY.createProxyWithNonce(
            SAFE_L2, abi.encodeCall(ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))), block.timestamp
        );
        address[] memory roles = new address[](1);
        roles[0] = safe;
        timelock = new TimelockController(MIN_DELAY, roles, roles, address(0));
        guardian = new DeskGuardian(c.desk, address(timelock), deployer);
        c.desk.setVenue(ISaleVenue(address(c.venue)), safe);
        c.desk.transferOwnership(address(guardian));
        c.gate.transferOwnership(address(timelock));
        c.marker.transferOwnership(address(timelock));
        c.lending.transferOwnership(address(timelock));
        c.venue.transferOwnership(address(timelock));
    }

    function run() external {
        uint256 key = vm.envUint("MAINNET_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address relayer = vm.envAddress("MAINNET_RELAYER_ADDRESS");
        require(block.chainid == 4663, "mainnet only");
        Core memory c;

        vm.startBroadcast(key);
        _credit(c, deployer, relayer);
        _modules(c);
        _wire(c);
        (address safe, TimelockController timelock, DeskGuardian guardian) = _govern(c, deployer);
        vm.stopBroadcast();

        _write(c, deployer, relayer, safe, address(timelock), address(guardian));
    }

    function _write(Core memory c, address deployer, address relayer, address safe, address timelock, address guardian) internal {
        Stock[4] memory s = stocks();
        string memory a = "assets";
        for (uint256 i; i < 4; ++i) {
            vm.serializeAddress(s[i].symbol, "token", s[i].token);
            vm.serializeUint(s[i].symbol, "ltvBps", s[i].ltvBps);
            vm.serializeUint(s[i].symbol, "liqBps", s[i].liqBps);
            a = vm.serializeString("assets", s[i].symbol, vm.serializeAddress(s[i].symbol, "feed", s[i].feed));
        }
        string memory o = "deployment";
        vm.serializeString(o, "stocks", a);
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "deployedAt", block.timestamp);
        vm.serializeUint(o, "standbySeconds", STANDBY);
        vm.serializeUint(o, "markMaxAge", MARK_MAX_AGE);
        vm.serializeUint(o, "timelockDelay", MIN_DELAY);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "relayer", relayer);
        vm.serializeAddress(o, "usdg", address(USDG));
        vm.serializeAddress(o, "assetGate", address(c.gate));
        vm.serializeAddress(o, "lending", address(c.lending));
        vm.serializeAddress(o, "marker", address(c.marker));
        vm.serializeAddress(o, "desk", address(c.desk));
        vm.serializeAddress(o, "venue", address(c.venue));
        vm.serializeAddress(o, "ledger", address(c.ledger));
        vm.serializeAddress(o, "vault", address(MORPHO_USDG));
        vm.serializeAddress(o, "mandates", address(c.mandates));
        vm.serializeAddress(o, "safe", safe);
        vm.serializeAddress(o, "timelock", timelock);
        vm.serializeAddress(o, "deskGuardian", guardian);
        string memory json = vm.serializeAddress(o, "pool", address(c.pool));
        vm.writeJson(json, string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json"));
    }
}
