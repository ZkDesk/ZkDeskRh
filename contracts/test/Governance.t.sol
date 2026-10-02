// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ZKDStaking} from "../src/ZKDStaking.sol";
import {DeskGuardian} from "../src/DeskGuardian.sol";
import {AssetGate} from "../src/AssetGate.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {ZKDeskPool} from "../src/ZKDeskPool.sol";
import {Marker} from "../src/Marker.sol";
import {LendingPoolUSDG, IDeskDebt} from "../src/LendingPoolUSDG.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockZKD} from "../src/mocks/MockZKD.sol";
import {TransactVerifier} from "../src/verifiers/TransactVerifier.sol";
import {PositionVerifier, IVerifier} from "../src/verifiers/PositionVerifier.sol";

/// M6: $ZKD staking (60/40 fee split, insurance), and governance (timelock + desk guardian).
contract GovernanceTest is Test {
    MockUSDG usdg;
    MockZKD zkd;
    ZKDStaking staking;
    TimelockController timelock;
    address safe = makeAddr("safe"); // proposer/executor (a Safe on testnet)
    address guardianKey = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdg = new MockUSDG();
        zkd = new MockZKD();
        address[] memory roles = new address[](1);
        roles[0] = safe;
        timelock = new TimelockController(300, roles, roles, address(0));
        staking = new ZKDStaking(zkd, usdg, address(timelock));
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            vm.startPrank(who);
            zkd.faucet(1_000e18);
            zkd.approve(address(staking), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _fee(uint256 amount) internal {
        usdg.faucet(amount);
        usdg.transfer(address(staking), amount); // e.g. a liquidation bonus arriving
    }

    function test_feesSplit60To40AndProRata() public {
        vm.prank(alice);
        staking.stake(300e18);
        vm.prank(bob);
        staking.stake(100e18);
        _fee(1_000e6);
        staking.sync();
        assertEq(staking.insurance(), 400e6, "40% to insurance");
        assertEq(staking.claimable(alice), 450e6, "3/4 of the 60%");
        assertEq(staking.claimable(bob), 150e6);
        vm.prank(alice);
        assertEq(staking.claim(), 450e6);
        assertEq(usdg.balanceOf(alice), 450e6);
        vm.prank(bob);
        staking.unstake(100e18);
        assertEq(zkd.balanceOf(bob), 1_000e18);
        assertEq(staking.claimable(bob), 150e6, "unstaking keeps earned fees");
    }

    function test_feesBeforeAnyStakeWaitForTheFirstStaker() public {
        _fee(100e6);
        staking.sync();
        assertEq(staking.carry(), 60e6);
        vm.prank(alice);
        staking.stake(1e18);
        staking.sync();
        assertEq(staking.claimable(alice), 60e6);
    }

    function test_lateStakersDoNotShareEarlierFees() public {
        vm.prank(alice);
        staking.stake(100e18);
        _fee(100e6);
        vm.prank(bob);
        staking.stake(100e18); // syncs first: the earlier fee is alice's
        assertEq(staking.claimable(alice), 60e6);
        assertEq(staking.claimable(bob), 0);
    }

    function test_insuranceOnlyThroughTheTimelock() public {
        _fee(1_000e6);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        staking.coverShortfall(address(this), 1, "not governance");
        bytes memory call = abi.encodeCall(ZKDStaking.coverShortfall, (bob, 100e6, "bad debt drill"));
        vm.prank(safe);
        timelock.schedule(address(staking), 0, call, 0, 0, 300);
        vm.prank(safe);
        vm.expectRevert(); // before the delay
        timelock.execute(address(staking), 0, call, 0, 0);
        vm.warp(block.timestamp + 300);
        vm.prank(safe);
        timelock.execute(address(staking), 0, call, 0, 0);
        assertEq(usdg.balanceOf(bob), 100e6);
        assertEq(staking.insurance(), 300e6);
        bytes memory tooMuch = abi.encodeCall(ZKDStaking.coverShortfall, (bob, 301e6, "more than insurance"));
        vm.prank(safe);
        timelock.schedule(address(staking), 0, tooMuch, 0, bytes32(uint256(1)), 300);
        vm.warp(block.timestamp + 300);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(staking), 0, tooMuch, 0, bytes32(uint256(1)));
    }

    function test_guardianPausesAtOnceOnlyTimelockUnpauses() public {
        AssetGate gate = new AssetGate(address(this), address(this));
        ZKDeskPool pool = new ZKDeskPool(new TransactVerifier(), gate, 60);
        LendingPoolUSDG lending = new LendingPoolUSDG(usdg, address(this));
        Marker marker = new Marker(address(this), address(this), 1 hours);
        IVerifier v = IVerifier(address(new PositionVerifier()));
        CreditDesk desk = new CreditDesk([v, v, v, v], pool, marker, lending, [uint256(1), 2], address(this));
        DeskGuardian guard = new DeskGuardian(desk, address(timelock), guardianKey);
        desk.transferOwnership(address(guard));

        vm.expectRevert(DeskGuardian.NotAllowed.selector);
        guard.pause();
        vm.prank(guardianKey);
        guard.pause();
        assertTrue(desk.paused());
        vm.prank(guardianKey);
        vm.expectRevert(DeskGuardian.NotAllowed.selector);
        guard.execute(abi.encodeCall(CreditDesk.setPaused, (false)));

        bytes memory unpause = abi.encodeCall(DeskGuardian.execute, (abi.encodeCall(CreditDesk.setPaused, (false))));
        vm.startPrank(safe);
        timelock.schedule(address(guard), 0, unpause, 0, 0, 300);
        vm.warp(block.timestamp + 300);
        timelock.execute(address(guard), 0, unpause, 0, 0);
        vm.stopPrank();
        assertFalse(desk.paused());
    }
}
