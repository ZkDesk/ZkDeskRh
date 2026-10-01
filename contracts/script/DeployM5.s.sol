// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {Marker} from "../src/Marker.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MandateAuthVerifier} from "../src/verifiers/MandateAuthVerifier.sol";
import {MandatePullVerifier, IVerifier} from "../src/verifiers/MandatePullVerifier.sol";
import {ReceiptVerifier} from "../src/verifiers/ReceiptVerifier.sol";

/// M5 on top of the live deployment: MandateRegistry (a pool module) for treasury payment mandates
/// and receipts. Nothing existing is redeployed. Env: DEPLOYER_PRIVATE_KEY. Set `mandatesBlock`
/// from the broadcast receipts afterwards.
contract DeployM5 is Script {
    using stdJson for string;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        vm.startBroadcast(key);
        MandateRegistry registry = new MandateRegistry(
            [IVerifier(address(new MandateAuthVerifier())), IVerifier(address(new MandatePullVerifier())), IVerifier(address(new ReceiptVerifier()))],
            ZKDeskPool(json.readAddress(".pool")),
            TreasuryLedger(json.readAddress(".ledger")),
            Marker(json.readAddress(".marker"))
        );
        AssetGate(json.readAddress(".assetGate")).setModule(address(registry), true);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(registry)), path, ".mandates");
    }
}
