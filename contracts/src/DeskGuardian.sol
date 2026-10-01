// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditDesk} from "./CreditDesk.sol";

/// @notice Owner of the CreditDesk. The guardian can pause new risk (draws, collateral withdrawals)
/// at once; repay, add collateral and close are never paused by the desk. Unpausing and every other
/// owner call (classes, venue, ownership) go through the timelock.
contract DeskGuardian {
    CreditDesk public immutable desk;
    address public immutable timelock;
    address public guardian;

    event GuardianSet(address guardian);

    error NotAllowed();
    error CallFailed(bytes reason);

    constructor(CreditDesk desk_, address timelock_, address guardian_) {
        desk = desk_;
        timelock = timelock_;
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function pause() external {
        if (msg.sender != guardian && msg.sender != timelock) revert NotAllowed();
        desk.setPaused(true);
    }

    /// @notice Timelock only: any desk owner call, e.g. setPaused(false) or setClass.
    function execute(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != timelock) revert NotAllowed();
        (bool ok, bytes memory ret) = address(desk).call(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    function setGuardian(address guardian_) external {
        if (msg.sender != timelock) revert NotAllowed();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }
}
