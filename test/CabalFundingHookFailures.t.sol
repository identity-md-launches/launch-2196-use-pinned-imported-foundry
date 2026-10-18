// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    CabalReviewFixture,
    ReviewIntake,
    CabalFundingHook,
    IOracleIntake,
    IPoolManager,
    IERC20,
    IHooks,
    PoolKey,
    PoolId,
    Currency,
    SwapParams,
    BalanceDelta,
    BeforeSwapDelta,
    toBalanceDelta,
    Hooks,
    TickMath,
    PoolSwapTest
} from "./helpers/CabalReviewFixture.sol";

contract CabalFundingHookFailuresTest is CabalReviewFixture {
    function setUp() public {
        _deploy(true, false);
    }

    function testDeploymentHasOnlyRequiredPermissionsAndDisabledPayments() public view {
        eq(address(hook.manager()), address(manager), "manager constructor order");
        eq(hook.factory(), address(this), "factory constructor order");
        eq(address(hook.imd()), address(imd), "asset constructor order");
        eq(address(hook.intake()), address(intake), "intake constructor order");
        eq(hook.owner(), OWNER, "owner is not deployer");
        eq(hook.treasury(), OWNER, "immutable project treasury");
        eq(uint160(address(hook)) & 0x3fff, 0x20cc, "permission address mask");
        Hooks.Permissions memory p = hook.getHookPermissions();
        require(
            p.beforeInitialize && p.beforeSwap && p.afterSwap && p.beforeSwapReturnDelta && p.afterSwapReturnDelta,
            "missing flag"
        );
        require(
            !p.afterInitialize && !p.beforeAddLiquidity && !p.afterAddLiquidity && !p.beforeRemoveLiquidity
                && !p.afterRemoveLiquidity && !p.beforeDonate && !p.afterDonate && !p.afterAddLiquidityReturnDelta
                && !p.afterRemoveLiquidityReturnDelta,
            "extra flag"
        );
        require(hook.initialized() && !hook.paymentsEnabled(), "deployment state");
        eq(hook.worker(), address(0), "worker must be unset");
        eq(hook.maxRequestAmount(), 0, "per-request cap starts unset");
        eq(hook.dailyLimit(), 0, "daily cap starts unset");
        eq(PoolId.unwrap(hook.boundPool()), keccak256(abi.encode(key)), "bound pool id");
        eq(hook.TAX_BPS(), 400, "tax changed");
        eq(hook.REQUEST_SHARE_BPS(), 7000, "split changed");
    }

    function testConstructorRejectsEveryMissingRole() public {
        address[6] memory args = [address(manager), address(this), address(imd), address(intake), OWNER, OWNER];
        for (uint256 i; i < args.length; i++) {
            address saved = args[i];
            args[i] = address(0);
            vm.expectRevert(CabalFundingHook.BadConfiguration.selector);
            new CabalFundingHook(
                IPoolManager(args[0]), args[1], IERC20(args[2]), IOracleIntake(args[3]), args[4], args[5]
            );
            args[i] = saved;
        }
    }

    function testConstructorRejectsAnUnminedPermissionMask() public {
        bytes32 initHash = keccak256(
            abi.encodePacked(
                type(CabalFundingHook).creationCode, abi.encode(manager, address(this), imd, intake, OWNER, OWNER)
            )
        );
        uint256 salt;
        address candidate;
        for (;; salt++) {
            candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), initHash))))
            );
            if ((uint160(candidate) & 0x3fff) != 0x20cc) break;
        }
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, candidate));
        new CabalFundingHook{salt: bytes32(salt)}(manager, address(this), imd, intake, OWNER, OWNER);
        eq(candidate.code.length, 0, "invalid hook deployment left code");
    }

    function testConstructorDoesNotCallExternalDependencies() public {
        // Code-free local addresses deliberately stand for dependencies that
        // would fail an external constructor call; they are not launch inputs.
        require(ALICE.code.length == 0 && BOB.code.length == 0 && WORKER.code.length == 0, "fixture has code");
        CabalFundingHook fresh = _newHook(ALICE, address(this), BOB, WORKER, OWNER, OWNER);
        require(!fresh.initialized() && !fresh.paymentsEnabled(), "constructor enabled operations");
        eq(fresh.worker(), address(0), "constructor configured a worker");
    }

    function testFreshHookRejectsBadBindingThenAcceptsFactoryExactlyOnce() public {
        CabalFundingHook fresh = _newHook(address(manager), address(this), address(imd), address(intake), OWNER, OWNER);
        PoolKey memory proposed = key;
        proposed.hooks = IHooks(address(fresh));
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        fresh.beforeInitialize(address(this), proposed, uint160(1 << 96));
        vm.startPrank(address(manager));
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.beforeInitialize(ALICE, proposed, uint160(1 << 96));
        proposed.fee = 3000;
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.beforeInitialize(address(this), proposed, uint160(1 << 96));
        proposed.fee = 12500;
        proposed.hooks = IHooks(address(hook));
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.beforeInitialize(address(this), proposed, uint160(1 << 96));
        proposed.hooks = IHooks(address(fresh));
        proposed.currency0 = Currency.wrap(BOB);
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.beforeInitialize(address(this), proposed, uint160(1 << 96));
        proposed.currency0 = key.currency0;
        require(!fresh.initialized(), "failed binding mutated state");
        require(
            fresh.beforeInitialize(address(this), proposed, uint160(1 << 96)) == IHooks.beforeInitialize.selector,
            "selector"
        );
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.beforeInitialize(address(this), proposed, uint160(1 << 96));
        vm.stopPrank();
    }

    function testEveryCallbackRejectsNonManagerIncludingOwner() public {
        vm.startPrank(OWNER);
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.beforeInitialize(address(this), key, uint160(1 << 96));
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.beforeSwap(OWNER, key, SwapParams(true, -100, 1), "");
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.afterSwap(OWNER, key, SwapParams(true, -100, 1), toBalanceDelta(-96, 90), "");
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.unlockCallback(abi.encode(1));
        vm.stopPrank();
    }

    function testBothSwapCallbacksRejectUnboundAndDifferentPools() public {
        CabalFundingHook fresh = _newHook(address(manager), address(this), address(imd), address(intake), OWNER, OWNER);
        PoolKey memory other = key;
        vm.startPrank(address(manager));
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.beforeSwap(ALICE, key, SwapParams(true, -100, 1), "");
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        fresh.afterSwap(ALICE, key, SwapParams(true, -100, 1), toBalanceDelta(-96, 90), "");
        other.tickSpacing = 120;
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        hook.beforeSwap(ALICE, other, SwapParams(true, -100, 1), "");
        vm.expectRevert(CabalFundingHook.WrongPool.selector);
        hook.afterSwap(ALICE, other, SwapParams(true, -100, 1), toBalanceDelta(-96, 90), "");
        vm.stopPrank();
        _assertLedgers();
    }

    function testOwnerHasNoEconomicOrSweepSwitches() public {
        bytes[8] memory calls = [
            abi.encodeWithSignature("setTax(uint256)", 0),
            abi.encodeWithSignature("setTreasury(address)", ALICE),
            abi.encodeWithSignature("setIntake(address)", ALICE),
            abi.encodeWithSignature("setRequestShare(uint256)", 10000),
            abi.encodeWithSignature("sweep(address,address,uint256)", address(imd), ALICE, 1),
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("upgradeTo(address)", ALICE),
            abi.encodeWithSignature("transferOwnership(address)", ALICE)
        ];
        hook.deposit(1 ether);
        vm.startPrank(OWNER);
        for (uint256 i; i < calls.length; i++) {
            (bool ok,) = address(hook).call(calls[i]);
            require(!ok, "unexpected privileged surface");
        }
        vm.stopPrank();
        eq(hook.requestBalance(), 1 ether, "owner drained request reserve");
        _assertLedgers();
    }

    function testWorkerConfigurationRejectsInvalidParametersAndNonOwner() public {
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.configureWorker(WORKER, 1, 1, true);
        vm.startPrank(OWNER);
        vm.expectRevert(CabalFundingHook.BadConfiguration.selector);
        hook.configureWorker(address(0), 1, 1, false);
        vm.expectRevert(CabalFundingHook.BadConfiguration.selector);
        hook.configureWorker(WORKER, 0, 1, false);
        vm.expectRevert(CabalFundingHook.BadConfiguration.selector);
        hook.configureWorker(WORKER, 2, 1, false);
        vm.stopPrank();
        require(!hook.paymentsEnabled() && hook.worker() == address(0), "bad config mutated state");
    }

    function testWorkerRotationRevokesOldWorkerAndDoesNotResetSpentBudget() public {
        hook.deposit(2 ether);
        _configure(WORKER, 0.5 ether, 0.5 ether, true);
        vm.prank(WORKER);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
        _configure(BOB, 0.5 ether, 0.5 ether, true);
        vm.prank(WORKER);
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.payRequest(bytes32(uint256(2)), hex"01", 0.5 ether, block.timestamp);
        vm.prank(BOB);
        vm.expectRevert(CabalFundingHook.LimitExceeded.selector);
        hook.payRequest(bytes32(uint256(2)), hex"01", 0.5 ether, block.timestamp);
        _configure(BOB, 0.5 ether, 0.5 ether, false);
        vm.prank(BOB);
        vm.expectRevert(CabalFundingHook.PaymentsDisabled.selector);
        hook.payRequest(bytes32(uint256(2)), hex"01", 0.5 ether, block.timestamp);
        eq(hook.spentToday(), 0.5 ether, "rotation reset the cap");
        _assertLedgers();
    }

    function testUTCAndDeadlineBoundariesAndReplaySurviveDayChange() public {
        uint256 beforeMidnight = 8 days - 1;
        uint256 midnight = 8 days;
        vm.warp(beforeMidnight);
        hook.deposit(2 ether);
        _configure(WORKER, 0.5 ether, 0.5 ether, true);
        vm.prank(WORKER);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, beforeMidnight);
        eq(hook.spentDay(), 7, "UTC day before boundary");
        vm.prank(WORKER);
        vm.expectRevert(CabalFundingHook.LimitExceeded.selector);
        hook.payRequest(bytes32(uint256(2)), hex"02", 0.5 ether, beforeMidnight);
        vm.warp(midnight);
        vm.prank(WORKER);
        vm.expectRevert(CabalFundingHook.Expired.selector);
        hook.payRequest(bytes32(uint256(2)), hex"02", 0.5 ether, midnight - 1);
        vm.prank(WORKER);
        hook.payRequest(bytes32(uint256(2)), hex"02", 0.5 ether, midnight);
        eq(hook.spentDay(), 8, "UTC rollover");
        eq(hook.spentToday(), 0.5 ether, "new day spend");
        vm.prank(WORKER);
        vm.expectRevert(CabalFundingHook.DuplicateRequest.selector);
        hook.payRequest(bytes32(uint256(1)), hex"03", 0.5 ether, midnight);
        eq(hook.paidBodyHashes(bytes32(uint256(1))), keccak256(hex"01"), "replay changed original body");
        _assertLedgers();
    }

    function testRequestInputBoundsAreAtomicAndMaximumBodyIsAccepted() public {
        hook.deposit(2 ether);
        _configure(WORKER, 0.5 ether, 1 ether, true);
        vm.startPrank(WORKER);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payRequest(bytes32(0), hex"01", 0.5 ether, block.timestamp);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payRequest(bytes32(uint256(1)), "", 0.5 ether, block.timestamp);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0, block.timestamp);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payRequest(bytes32(uint256(1)), new bytes(16385), 0.5 ether, block.timestamp);
        bytes memory maximumBody = new bytes(16384);
        bytes32 id = hook.payRequest(bytes32(uint256(1)), maximumBody, 0.5 ether, block.timestamp);
        vm.stopPrank();
        require(id != bytes32(0), "missing intake id");
        eq(hook.paidBodyHashes(bytes32(uint256(1))), keccak256(maximumBody), "body not bound");
        eq(intake.observedAllowance(), 0.5 ether, "not exact approval");
        eq(intake.lastAction(), bytes32("oracle.request@oracle-1"), "wrong action encoding");
        eq(intake.lastAsset(), address(imd), "wrong asset");
        eq(intake.lastPayer(), address(hook), "wrong payer");
        eq(intake.lastCallback(), address(0), "callback unexpectedly enabled");
        require(intake.lastSelector() == bytes4(0), "callback selector unexpectedly enabled");
        _assertLedgers();
    }

    function _assertFailedPaymentClean() internal view {
        eq(hook.requestBalance(), 2 ether, "failed payment consumed reserve");
        eq(hook.totalSpent(), 0, "failed payment booked spending");
        eq(hook.spentToday(), 0, "failed payment consumed cap");
        eq(hook.paidRequests(bytes32(uint256(1))), bytes32(0), "failed payment consumed key");
        eq(hook.paidBodyHashes(bytes32(uint256(1))), bytes32(0), "failed payment saved body");
        eq(imd.balanceOf(address(intake)), 0, "failed payment transferred funds");
        eq(intake.calls(), 0, "failed payment persisted intake state");
        _assertLedgers();
    }

    function testEveryIntakeFailureRollsBackApprovalKeyBalancesAndDailyCap() public {
        hook.deposit(2 ether);
        _configure(WORKER, 0.5 ether, 1 ether, true);
        for (uint256 mode = 1; mode <= 4; mode++) {
            intake.setMode(ReviewIntake.Mode(mode));
            vm.prank(WORKER);
            vm.expectRevert();
            hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
            _assertFailedPaymentClean();
        }
        intake.setMode(ReviewIntake.Mode.Normal);
        vm.prank(WORKER);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
        eq(hook.totalSpent(), 0.5 ether, "key not reusable after rollback");
        _assertLedgers();
    }

    function testApprovalAndAllowanceClearFailuresRollBackTheWholePayment() public {
        hook.deposit(2 ether);
        _configure(WORKER, 0.5 ether, 1 ether, true);
        for (uint256 i; i < 2; i++) {
            imd.setApprovalFailure(i == 0, i == 1);
            vm.prank(WORKER);
            vm.expectRevert();
            hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
            _assertFailedPaymentClean();
        }
        imd.setApprovalFailure(false, false);
        vm.prank(WORKER);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
        _assertLedgers();
    }

    function testFeeOnTransferDepositAndHarvestAreRejectedAtomically() public {
        imd.setTransferTax(true);
        uint256 before = imd.balanceOf(address(this));
        vm.expectRevert(CabalFundingHook.BadTokenAccounting.selector);
        hook.deposit(1 ether);
        eq(imd.balanceOf(address(this)), before, "deposit took funds");
        eq(hook.totalDeposited(), 0, "deposit booked phantom funds");
        imd.setTransferTax(false);
        _swap(true, true, 1000 ether);
        imd.setTransferTax(true);
        uint256 managerBefore = imd.balanceOf(address(manager));
        vm.expectRevert(CabalFundingHook.BadTokenAccounting.selector);
        hook.harvest(40 ether);
        eq(hook.pendingFees(), 40 ether, "failed harvest lost claims");
        eq(hook.totalHarvested(), 0, "failed harvest allocated fees");
        eq(imd.balanceOf(address(manager)), managerBefore, "failed harvest took manager funds");
        _assertLedgers();
        imd.setTransferTax(false);
        hook.harvest(40 ether);
        _assertLedgers();
    }

    function testZeroAndExcessSettlementCannotTouchRequestPrefunding() public {
        hook.deposit(4 ether);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.deposit(0);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.harvest(0);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.harvest(1);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payTreasury(0);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payTreasury(1);
        _swap(true, true, 1000 ether);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.harvest(40 ether + 1);
        hook.harvest(40 ether);
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.payTreasury(12 ether + 1);
        vm.prank(ALICE);
        hook.payTreasury(12 ether);
        eq(imd.balanceOf(OWNER), 12 ether, "payout was redirected");
        eq(imd.balanceOf(ALICE), 0, "caller captured payout");
        eq(hook.requestBalance(), 32 ether, "treasury took prefunding");
        _assertLedgers();
    }

    function testIntakeReentryCannotHarvestDonatePayTreasuryOrPayAgain() public {
        hook.deposit(2 ether);
        _swap(true, true, 1000 ether);
        hook.harvest(20 ether);
        _configure(address(intake), 0.5 ether, 10 ether, true);
        bytes[5] memory attempts = [
            abi.encodeCall(hook.syncDonations, ()),
            abi.encodeCall(hook.harvest, (1)),
            abi.encodeCall(hook.payTreasury, (1)),
            abi.encodeCall(hook.deposit, (1)),
            abi.encodeCall(hook.payRequest, (bytes32(uint256(100)), hex"01", 0.5 ether, block.timestamp))
        ];
        for (uint256 i; i < attempts.length; i++) {
            intake.setReentry(address(hook), attempts[i]);
            vm.prank(address(intake));
            hook.payRequest(bytes32(i + 1), hex"01", 0.5 ether, block.timestamp);
            require(!intake.reentrySucceeded(), "reentrant accounting call succeeded");
            _assertLedgers();
        }
        eq(hook.totalSpent(), 2.5 ether, "reentry spent extra");
        eq(hook.pendingFees(), 20 ether, "reentry harvested");
        eq(hook.totalTreasuryPaid(), 0, "reentry paid treasury");
    }

    function testUnsyncedDonationCannotBeSpentUntilExplicitlyBooked() public {
        imd.transfer(address(hook), 4 ether);
        _configure(WORKER, 0.5 ether, 1 ether, true);
        vm.prank(WORKER);
        vm.expectRevert(CabalFundingHook.InsufficientFunding.selector);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
        vm.prank(ALICE);
        hook.syncDonations();
        hook.syncDonations();
        eq(hook.totalDeposited(), 4 ether, "sync counted donation twice");
        eq(hook.treasuryBalance(), 0, "donation was split");
        vm.prank(WORKER);
        hook.payRequest(bytes32(uint256(1)), hex"01", 0.5 ether, block.timestamp);
        _assertLedgers();
    }

    function testSwapsAndHarvestRemainLiveWithUnavailableIntakeAndBlockedTreasury() public {
        intake.setPrice(0, true);
        imd.setBlockedRecipient(OWNER);
        _swap(true, true, 1000 ether);
        hook.harvest(40 ether);
        vm.expectRevert();
        hook.payTreasury(12 ether);
        _swap(false, true, 100 ether);
        _swap(true, false, 100 ether);
        _swap(false, false, 1 ether);
        hook.harvest(hook.pendingFees());
        require(hook.requestBalance() >= 28 ether, "trading stopped funding requests");
        require(!hook.paymentsEnabled(), "trading enabled worker");
        _assertLedgers();
    }
    event TaxAccrued(bytes32 indexed pool, uint256 amount);
    event FeesAllocated(uint256 amount, uint256 requests, uint256 treasuryAmount);
    event TreasuryPaid(address indexed recipient, uint256 amount);
    event RequestPaid(bytes32 indexed key, bytes32 indexed requestId, bytes32 bodyHash, uint256 amount);

    function testReconciliationEventsBindTheActualPoolRecipientBodyAndAmount() public {
        vm.expectEmit(true, false, false, true, address(hook));
        emit TaxAccrued(PoolId.unwrap(hook.boundPool()), 40 ether);
        _swap(true, true, 1000 ether);
        vm.expectEmit(false, false, false, true, address(hook));
        emit FeesAllocated(40 ether, 28 ether, 12 ether);
        hook.harvest(40 ether);
        vm.expectEmit(true, false, false, true, address(hook));
        emit TreasuryPaid(OWNER, 12 ether);
        vm.prank(ALICE);
        hook.payTreasury(12 ether);
        _configure(WORKER, 0.5 ether, 1 ether, true);
        bytes memory body = hex"010203";
        bytes32 expectedId = keccak256(abi.encode(address(hook), uint256(1), body));
        vm.expectEmit(true, true, false, true, address(hook));
        emit RequestPaid(bytes32(uint256(1)), expectedId, keccak256(body), 0.5 ether);
        vm.prank(WORKER);
        bytes32 returned = hook.payRequest(bytes32(uint256(1)), body, 0.5 ether, block.timestamp);
        eq(returned, expectedId, "returned id differs from receipt");
        eq(hook.paidRequests(bytes32(uint256(1))), expectedId, "journal id differs from receipt");
        _assertLedgers();
    }
}
