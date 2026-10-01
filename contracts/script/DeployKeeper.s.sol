// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Marker} from "../src/Marker.sol";
import {FeedKeeper} from "../src/mocks/FeedKeeper.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";

/// Adds the testnet FeedKeeper to an existing M2 deployment: feeds are updated through it, and
/// marks stay usable for 1 hour (the cron refreshes every 25 minutes to save test gas).
contract DeployKeeper is Script {
    using stdJson for string;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        Marker marker = Marker(json.readAddress(".marker"));
        string[4] memory symbols = ["tSPY", "tQQQ", "tNVDA", "tTSLA"];

        vm.startBroadcast(key);
        FeedKeeper keeper = new FeedKeeper(marker, vm.addr(key), vm.envAddress("RELAYER_ADDRESS"));
        for (uint256 i; i < 4; ++i) {
            MockAggregatorV3(json.readAddress(string.concat(".stocks.", symbols[i], ".feed"))).setUpdater(address(keeper));
        }
        marker.setMaxAge(1 hours);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(keeper)), path, ".feedKeeper");
        vm.writeJson(vm.toString(uint256(1 hours)), path, ".markMaxAge");
    }
}
