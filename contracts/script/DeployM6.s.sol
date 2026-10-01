// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk, ISaleVenue} from "../src/CreditDesk.sol";
import {Marker} from "../src/Marker.sol";
import {LendingPoolUSDG} from "../src/LendingPoolUSDG.sol";
import {ZKDStaking} from "../src/ZKDStaking.sol";
import {DeskGuardian} from "../src/DeskGuardian.sol";
import {MockZKD} from "../src/mocks/MockZKD.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}

interface ISafe {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external;
}

/// M6 on the live deployment: $ZKD staking (liquidation bonuses flow there; 60/40 stakers/insurance)
/// and governance. A Safe (testnet: 1-of-1, the deployer; mainnet: see DeployMainnet, currently 1-of-1)
/// is the only proposer/executor of a 300 s TimelockController, which owns the gate, marker and
/// lending pool, and the desk through DeskGuardian (the guardian key may pause new risk at once).
/// Test mocks (tokens, feeds, FeedKeeper) stay with the deployer for testnet operations.
/// Env: DEPLOYER_PRIVATE_KEY.
contract DeployM6 is Script {
    using stdJson for string;

    // Safe 1.4.1 on Robinhood Chain testnet (docs/testnet-facts.md).
    address constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    ISafeProxyFactory constant SAFE_FACTORY = ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);
    uint256 constant MIN_DELAY = 300;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        string memory path = string.concat("../src/lib/chain/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        CreditDesk desk = CreditDesk(json.readAddress(".desk"));

        vm.startBroadcast(key);
        MockZKD zkd = new MockZKD();
        address[] memory owners = new address[](1);
        owners[0] = deployer;
        address safe = SAFE_FACTORY.createProxyWithNonce(
            SAFE_L2, abi.encodeCall(ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))), block.timestamp
        );
        address[] memory roles = new address[](1);
        roles[0] = safe;
        TimelockController timelock = new TimelockController(MIN_DELAY, roles, roles, address(0));
        ZKDStaking staking = new ZKDStaking(zkd, IERC20(json.readAddress(".usdg")), address(timelock));
        DeskGuardian guardian = new DeskGuardian(desk, address(timelock), deployer);

        desk.setVenue(ISaleVenue(json.readAddress(".amm")), address(staking)); // bonus + surplus to stakers/insurance
        desk.transferOwnership(address(guardian));
        AssetGate(json.readAddress(".assetGate")).transferOwnership(address(timelock));
        Marker(json.readAddress(".marker")).transferOwnership(address(timelock));
        LendingPoolUSDG(json.readAddress(".lending")).transferOwnership(address(timelock));
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(zkd)), path, ".zkd");
        vm.writeJson(vm.toString(address(staking)), path, ".staking");
        vm.writeJson(vm.toString(safe), path, ".safe");
        vm.writeJson(vm.toString(address(timelock)), path, ".timelock");
        vm.writeJson(vm.toString(address(guardian)), path, ".deskGuardian");
    }
}
