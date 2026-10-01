// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker, IAggregatorV3} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {PositionVerifier, IVerifier} from "../src/verifiers/PositionVerifier.sol";
import {HealthEpochVerifier} from "../src/verifiers/HealthEpochVerifier.sol";
import {LiquidateVerifier} from "../src/verifiers/LiquidateVerifier.sol";
import {MockAMM} from "../src/mocks/MockAMM.sol";

/// Fresh testnet deployment (pool + credit + health/liquidation). The live 46630 deployment was
/// upgraded in place instead: DeployKeeper.s.sol, then DeployM3.s.sol. Writes src/lib/chain/deployments/<chainId>.json.
/// Env: DEPLOYER_PRIVATE_KEY, RELAYER_ADDRESS (feed updater + mark pinner run by the cron),
/// DESK_OPERATOR_PK_X / _Y (Grumpkin public key of DESK_OPERATOR_SK).
/// ponytail: governance/screener are the deployer EOA until the Safe + timelock move (plan M6).
contract Deploy is Script {
    uint64 constant STANDBY = 60; // screening standby; mainnet uses the same 60 s
    uint64 constant MARK_MAX_AGE = 10 minutes;
    uint256 constant SEED_LIQUIDITY = 50_000e6;

    struct Stock {
        string name;
        string symbol;
        int256 price; // 8 decimals, sample testnet value
        uint16 ltvBps;
        uint16 liqBps;
    }

    address internal amm;

    function _desk(ZKDeskPool pool, Marker marker, LendingPoolUSDG lending, MockUSDG usdg, address deployer) internal returns (CreditDesk desk) {
        desk = new CreditDesk(
            [IVerifier(address(new PositionVerifier())), IVerifier(address(new HealthEpochVerifier())), IVerifier(address(new LiquidateVerifier()))],
            pool, marker, lending, [vm.envUint("DESK_OPERATOR_PK_X"), vm.envUint("DESK_OPERATOR_PK_Y")], deployer
        );
        amm = address(new MockAMM(marker, usdg));
        lending.setDesk(IDeskDebt(address(desk)));
        desk.setVenue(ISaleVenue(amm), deployer);
    }

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        Stock[4] memory stocks = [
            Stock("SPDR S&P 500 (test)", "tSPY", 500e8, 6000, 7000),
            Stock("Invesco QQQ (test)", "tQQQ", 430e8, 6000, 7000),
            Stock("NVIDIA (test)", "tNVDA", 120e8, 4500, 5500),
            Stock("Tesla (test)", "tTSLA", 250e8, 4500, 5500)
        ];

        vm.startBroadcast(key);
        MockUSDG usdg = new MockUSDG();
        AssetGate gate = new AssetGate(deployer, deployer);
        ZKDeskPool pool = new ZKDeskPool(new TransactVerifier(), gate, STANDBY);
        LendingPoolUSDG lending = new LendingPoolUSDG(usdg, deployer);
        Marker marker = new Marker(deployer, relayer, MARK_MAX_AGE);
        CreditDesk desk = _desk(pool, marker, lending, usdg, deployer);
        gate.setAsset(address(usdg), true);
        gate.setAsset(address(lending), true);
        gate.setConverter(address(lending), true);
        gate.setModule(address(desk), true);

        address[4] memory tokens;
        address[4] memory feeds;
        for (uint256 i; i < 4; ++i) {
            MockStockToken token = new MockStockToken(stocks[i].name, stocks[i].symbol, deployer);
            MockAggregatorV3 feed = new MockAggregatorV3(string.concat(stocks[i].symbol, " / USD"), deployer, relayer);
            feed.setAnswer(stocks[i].price);
            marker.setFeed(address(token), IAggregatorV3(address(feed)));
            marker.pin(address(token));
            gate.setAsset(address(token), true);
            desk.setClass(address(token), stocks[i].ltvBps, stocks[i].liqBps, 100_000e18, true);
            tokens[i] = address(token);
            feeds[i] = address(feed);
        }

        usdg.faucet(SEED_LIQUIDITY);
        usdg.approve(address(lending), SEED_LIQUIDITY);
        lending.deposit(SEED_LIQUIDITY, deployer);
        vm.stopBroadcast();

        string memory a = "assets";
        for (uint256 i; i < 4; ++i) {
            string memory s = stocks[i].symbol;
            vm.serializeAddress(s, "token", tokens[i]);
            vm.serializeUint(s, "ltvBps", stocks[i].ltvBps);
            vm.serializeUint(s, "liqBps", stocks[i].liqBps);
            string memory entry = vm.serializeAddress(s, "feed", feeds[i]);
            a = vm.serializeString("assets", s, entry);
        }
        string memory o = "deployment";
        vm.serializeString(o, "stocks", a);
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "deployedAt", block.timestamp);
        vm.serializeUint(o, "standbySeconds", STANDBY);
        vm.serializeUint(o, "markMaxAge", MARK_MAX_AGE);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "relayer", relayer);
        vm.serializeAddress(o, "usdg", address(usdg));
        vm.serializeAddress(o, "assetGate", address(gate));
        vm.serializeAddress(o, "lending", address(lending));
        vm.serializeAddress(o, "marker", address(marker));
        vm.serializeAddress(o, "desk", address(desk));
        vm.serializeAddress(o, "amm", amm);
        string memory json = vm.serializeAddress(o, "pool", address(pool));
        vm.writeJson(json, string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json"));
    }
}
