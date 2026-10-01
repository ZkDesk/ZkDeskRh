// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {Marker} from "../src/Marker.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAMM} from "../src/mocks/MockAMM.sol";
import {PositionVerifier, IVerifier} from "../src/verifiers/PositionVerifier.sol";
import {HealthEpochVerifier} from "../src/verifiers/HealthEpochVerifier.sol";
import {LiquidateVerifier} from "../src/verifiers/LiquidateVerifier.sol";

/// M3 on top of the live M2 deployment: the pool, gate, marker, feeds and tokens stay (private
/// balances carry over). A new CreditDesk (operator-encrypted positions, epochs, liquidation) needs a
/// new LendingPoolUSDG because the lending pool's desk is set once. The old desk module is retired.
/// Env: DEPLOYER_PRIVATE_KEY, DESK_OPERATOR_PK_X, DESK_OPERATOR_PK_Y (Grumpkin, from DESK_OPERATOR_SK).
contract DeployM3 is Script {
    using stdJson for string;

    uint256 constant SEED_LIQUIDITY = 50_000e6;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        string memory path = string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        AssetGate gate = AssetGate(json.readAddress(".assetGate"));
        MockUSDG usdg = MockUSDG(json.readAddress(".usdg"));
        Marker marker = Marker(json.readAddress(".marker"));
        string[4] memory symbols = ["tSPY", "tQQQ", "tNVDA", "tTSLA"];

        vm.startBroadcast(key);
        LendingPoolUSDG lending = new LendingPoolUSDG(usdg, deployer);
        CreditDesk desk = new CreditDesk(
            [IVerifier(address(new PositionVerifier())), IVerifier(address(new HealthEpochVerifier())), IVerifier(address(new LiquidateVerifier()))],
            ZKDeskPool(json.readAddress(".pool")),
            marker,
            lending,
            [vm.envUint("DESK_OPERATOR_PK_X"), vm.envUint("DESK_OPERATOR_PK_Y")],
            deployer
        );
        MockAMM amm = new MockAMM(marker, usdg);
        lending.setDesk(IDeskDebt(address(desk)));
        desk.setVenue(ISaleVenue(address(amm)), deployer); // ponytail: bonus to the deployer until the M6 bond pool
        for (uint256 i; i < 4; ++i) {
            string memory s = string.concat(".stocks.", symbols[i]);
            desk.setClass(json.readAddress(string.concat(s, ".token")), uint16(json.readUint(string.concat(s, ".ltvBps"))), uint16(json.readUint(string.concat(s, ".liqBps"))), 100_000e18, true);
        }
        gate.setModule(json.readAddress(".desk"), false);
        gate.setModule(address(desk), true);
        gate.setAsset(address(lending), true);
        gate.setConverter(address(lending), true);
        usdg.faucet(SEED_LIQUIDITY);
        usdg.approve(address(lending), SEED_LIQUIDITY);
        lending.deposit(SEED_LIQUIDITY, deployer);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(desk)), path, ".desk");
        vm.writeJson(vm.toString(address(lending)), path, ".lending");
        vm.writeJson(vm.toString(address(amm)), path, ".amm");
    }
}
