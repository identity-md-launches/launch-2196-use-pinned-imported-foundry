// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CabalReviewFixture, ReviewIntake, CabalFundingHook} from "./helpers/CabalReviewFixture.sol";

/// @notice The worker admits a BO5 only when eight paid decisions fit the hook's remaining UTC-day
/// cap, computed off chain from the public `dailyLimit`, `spentDay` and `spentToday` views
/// (`worker/day-cap.mjs`). These tests pin the contract behaviour that arithmetic relies on and
/// check that the worker's headroom never promises a payment `payRequest` then rejects.
contract CabalFundingHookDayCapTest is CabalReviewFixture {
    uint256 internal constant PRICE = 0.5 ether;
    /// Mirrors `CLOCK_SKEW_MS` in worker/day-cap.mjs, in seconds.
    uint256 internal constant WORKER_CLOCK_SKEW = 300;
    uint256 internal nextKey = 1;

    function setUp() public {
        _deploy(true, false);
    }

    /// Independent copy of the worker's `dayCapHeadroom`, evaluated at the worker's own clock.
    function _workerHeadroom(uint256 workerNow) internal view returns (uint256) {
        uint256 limit = hook.dailyLimit();
        uint256 effective = hook.spentDay() >= (workerNow - WORKER_CLOCK_SKEW) / 1 days ? hook.spentToday() : 0;
        return effective >= limit ? 0 : limit - effective;
    }

    function _pay() internal returns (bool) {
        bytes32 k = bytes32(nextKey++);
        vm.prank(WORKER);
        try hook.payRequest(k, hex"7b7d", PRICE, block.timestamp) {
            return true;
        } catch (bytes memory reason) {
            require(bytes4(reason) == CabalFundingHook.LimitExceeded.selector, "unexpected payment failure");
            return false;
        }
    }

    function _payUntilCapped(uint256 max) internal returns (uint256 accepted) {
        while (accepted < max && _pay()) accepted++;
    }

    function testStaleDayViewsStillAllowAFullNewDayCap() public {
        vm.warp(20 days + 12 hours);
        hook.deposit(10 ether);
        _configure(WORKER, PRICE, 4 ether, true);
        eq(_payUntilCapped(20), 8, "one BO5 fits a 4 IMD cap");
        eq(_workerHeadroom(block.timestamp), 0, "worker sees no headroom");

        vm.warp(21 days + 1 hours);
        // Nothing has been paid on the new day: the public views still describe day 20.
        eq(hook.spentDay(), 20, "recorded day advanced without payment");
        eq(hook.spentToday(), 4 ether, "spent reset without payment");
        eq(_workerHeadroom(block.timestamp), 4 ether, "worker must treat a stale day as unspent");
        eq(_payUntilCapped(20), 8, "contract allows a full cap on the new day");
        eq(hook.spentDay(), 21, "first payment records the new day");
        eq(hook.spentToday(), 4 ether, "new-day spend");
        _assertLedgers();
    }

    function testRevertedPaymentOnANewDayLeavesTheStaleDayRecorded() public {
        vm.warp(30 days + 1);
        hook.deposit(10 ether);
        _configure(WORKER, PRICE, 1 ether, true);
        eq(_payUntilCapped(5), 2, "cap of two decisions");
        // Past the worker's five-minute skew window, so its headroom is the full new-day cap.
        vm.warp(31 days + 1 hours);
        intake.setMode(ReviewIntake.Mode.RevertRequest);
        vm.prank(WORKER);
        vm.expectRevert();
        hook.payRequest(bytes32(nextKey++), hex"7b7d", PRICE, block.timestamp);
        eq(hook.spentDay(), 30, "reverted payment rolled the day");
        eq(hook.spentToday(), 1 ether, "reverted payment reset the spend");
        intake.setMode(ReviewIntake.Mode.Normal);
        eq(_workerHeadroom(block.timestamp), 1 ether, "worker headroom after revert");
        eq(_payUntilCapped(5), 2, "new-day cap intact after revert");
        _assertLedgers();
    }

    function testLoweringTheCapBelowTodaysSpendLeavesZeroHeadroomWithoutReset() public {
        vm.warp(40 days + 6 hours);
        hook.deposit(10 ether);
        _configure(WORKER, PRICE, 4 ether, true);
        eq(_payUntilCapped(4), 4, "spend 2 IMD");
        _configure(WORKER, PRICE, 1 ether, true);
        eq(hook.spentToday(), 2 ether, "reconfiguration reset spend");
        eq(_workerHeadroom(block.timestamp), 0, "spend above a lowered cap is zero headroom, not underflow");
        require(!_pay(), "payment above a lowered cap");
        _configure(WORKER, PRICE, 4 ether, true);
        eq(_workerHeadroom(block.timestamp), 2 ether, "raised cap headroom");
        eq(_payUntilCapped(20), 4, "raised cap pays exactly the headroom");
        _assertLedgers();
    }

    function testCapThatIsNotAMultipleOfThePriceRoundsDown() public {
        vm.warp(50 days);
        hook.deposit(10 ether);
        _configure(WORKER, PRICE, 4 ether - 1, true);
        eq(_payUntilCapped(20), 7, "one wei short of a BO5 pays only seven decisions");
        eq(_workerHeadroom(block.timestamp), PRICE - 1, "worker headroom below one decision");
        _assertLedgers();
    }

    function testSixteenReservedBo5sNeedA64ImdDailyCap() public {
        vm.warp(60 days + 3 hours);
        hook.deposit(130 ether);
        _configure(WORKER, PRICE, 64 ether - PRICE, true);
        eq(_payUntilCapped(200), 127, "63.5 IMD cannot fund 16 BO5s");
        vm.warp(61 days + 3 hours);
        _configure(WORKER, PRICE, 64 ether, true);
        eq(_workerHeadroom(block.timestamp), 64 ether, "worker headroom for sixteen BO5s");
        eq(_payUntilCapped(200), 128, "64 IMD funds 16 x 8 decisions in one UTC day");
        eq(hook.requestBalance(), 130 ether - 63.5 ether - 64 ether, "request fund debited per payment");
        _assertLedgers();
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzzWorkerHeadroomNeverExceedsWhatTheContractPays(
        uint256 limitSeed,
        uint256 dustSeed,
        uint256 startSeed,
        uint256 priorSeed,
        uint256 elapsedSeed,
        uint256 skewSeed
    ) public {
        uint256 limit = bound(limitSeed, 1, 16) * PRICE + bound(dustSeed, 0, PRICE - 1);
        uint256 start = bound(startSeed, 10 days, 1000 days);
        uint256 prior = bound(priorSeed, 0, limit / PRICE);
        uint256 elapsed = bound(elapsedSeed, 0, 3 days);
        // Worker clock from one hour behind the chain to the five-minute tolerance ahead of it.
        uint256 workerNow = start + elapsed + bound(skewSeed, 0, 3600 + WORKER_CLOCK_SKEW) - 3600;

        vm.warp(start);
        hook.deposit(40 ether);
        _configure(WORKER, PRICE, limit, true);
        eq(_payUntilCapped(prior), prior, "prior spend within cap");
        vm.warp(start + elapsed);

        uint256 promised = _workerHeadroom(workerNow) / PRICE;
        uint256 accepted = _payUntilCapped(40);
        require(accepted >= promised, "worker headroom promised a payment the contract rejects");
        bool chainNearMidnight = (block.timestamp - WORKER_CLOCK_SKEW) / 1 days != block.timestamp / 1 days;
        if (workerNow == block.timestamp && !chainNearMidnight) {
            eq(accepted, promised, "worker headroom is not exact away from the skew window");
        }
        _assertLedgers();
    }
}
