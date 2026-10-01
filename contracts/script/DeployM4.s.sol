// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {Marker} from "../src/Marker.sol";
import {TreasuryLedger} from "../src/TreasuryLedger.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockERC4626} from "../src/mocks/MockERC4626.sol";
import {LedgerVerifier, IVerifier} from "../src/verifiers/LedgerVerifier.sol";
import {RoleAuthVerifier} from "../src/verifiers/RoleAuthVerifier.sol";
import {TreasuryAttestVerifier} from "../src/verifiers/TreasuryAttestVerifier.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// M4 on top of the live deployment: TreasuryLedger (a pool module) and the testnet yield vault
/// (MockERC4626, stand-in for the Morpho USDG vault). Nothing existing is redeployed.
/// Env: DEPLOYER_PRIVATE_KEY. Set `ledgerBlock` from the broadcast receipts afterwards.
contract DeployM4 is Script {
    using stdJson for string;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        AssetGate gate = AssetGate(json.readAddress(".assetGate"));
        string[4] memory symbols = ["tSPY", "tQQQ", "tNVDA", "tTSLA"];
        address[4] memory stocks;
        for (uint256 i; i < 4; ++i) stocks[i] = json.readAddress(string.concat(".stocks.", symbols[i], ".token"));

        vm.startBroadcast(key);
        MockERC4626 vault = new MockERC4626(MockUSDG(json.readAddress(".usdg")));
        TreasuryLedger ledger = new TreasuryLedger(
            [IVerifier(address(new LedgerVerifier())), IVerifier(address(new RoleAuthVerifier())), IVerifier(address(new TreasuryAttestVerifier()))],
            ZKDeskPool(json.readAddress(".pool")),
            Marker(json.readAddress(".marker")),
            IERC4626(address(vault)),
            stocks
        );
        gate.setAsset(address(vault), true);
        gate.setModule(address(ledger), true);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(ledger)), path, ".ledger");
        vm.writeJson(vm.toString(address(vault)), path, ".vault");
    }
}
