// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    CabalReviewFixture,
    ReviewAssertions,
    ReviewAsset,
    ReviewIntake,
    LaunchToken,
    CabalFundingHook,
    PoolManager,
    PoolSwapTest,
    PoolKey,
    SwapParams,
    BalanceDelta,
    Currency,
    TickMath,
    PoolId
} from "./helpers/CabalReviewFixture.sol";

contract CabalFundingHandler is ReviewAssertions {
    CabalFundingHook public immutable hook;
    PoolManager public immutable manager;
    ReviewAsset public immutable imd;
    LaunchToken public immutable token;
    ReviewIntake public immutable intake;
    PoolSwapTest public immutable router;
    PoolKey private key;
    address[3] public actors;
    address private immutable owner;
    uint256 public ghostFees;
    uint256 public ghostHarvested;
    uint256 public ghostDeposited;
    uint256 public ghostUnbooked;
    uint256 public ghostSpent;
    uint256 public ghostTreasuryPaid;
    uint256 public ghostDay;
    uint256 public ghostDaySpent;
    uint256 public nextKey;
    bytes32[] private paidKeys;
    mapping(bytes32 => bytes32) public expectedIds;
    mapping(bytes32 => bytes32) public expectedBodies;
    uint256[12] public successes;
    uint256 public rejectedCalls;

    constructor(
        CabalFundingHook h,
        PoolManager m,
        ReviewAsset asset,
        LaunchToken t,
        ReviewIntake i,
        PoolSwapTest r,
        PoolKey memory k,
        address[3] memory a
    ) {
        hook = h;
        manager = m;
        imd = asset;
        token = t;
        intake = i;
        router = r;
        key = k;
        actors = a;
        owner = h.owner();
        for (uint256 j; j < a.length; j++) {
            vm.startPrank(a[j]);
            imd.approve(address(hook), type(uint256).max);
            imd.approve(address(router), type(uint256).max);
            token.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function swap(uint256 raw, uint8 mode, uint8 who) public {
        bool buy = (mode & 1) == 0;
        bool exactInput = (mode & 2) == 0;
        uint256 amount = bound(raw, 1e9, 100 ether);
        address actor = actors[who % actors.length];
        bool zeroForOne = buy == (address(imd) < address(token));
        uint256 beforeFees = hook.totalFees();
        uint256 beforeImd = imd.balanceOf(actor);
        uint256 beforeToken = token.balanceOf(actor);
        vm.prank(actor);
        BalanceDelta delta = router.swap(
            key,
            SwapParams(
                zeroForOne,
                exactInput ? -int256(amount) : int256(amount),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        int256 imdDelta = address(imd) < address(token) ? int256(delta.amount0()) : int256(delta.amount1());
        int256 tokenDelta = address(imd) < address(token) ? int256(delta.amount1()) : int256(delta.amount0());
        require(int256(imd.balanceOf(actor)) - int256(beforeImd) == imdDelta, "router IMD delta not settled");
        require(int256(token.balanceOf(actor)) - int256(beforeToken) == tokenDelta, "router CABAL delta not settled");
        if (exactInput) require((buy ? -imdDelta : -tokenDelta) == int256(amount), "unexpected partial input fill");
        else require((buy ? tokenDelta : imdDelta) == int256(amount), "exact output not delivered");
        uint256 fee = hook.totalFees() - beforeFees;
        uint256 base = buy ? uint256(-imdDelta) : uint256(imdDelta);
        if (exactInput) {
            if (!buy) base += fee;
            require(25 * fee <= base && base - 25 * fee < 25, "gross fee is not floor 4 percent");
        } else {
            if (buy) base -= fee;
            require(fee > 0 && 24 * (fee - 1) < base && base <= 24 * fee, "net fee is not minimal gross-up");
        }
        ghostFees += fee;
        successes[0]++;
    }

    function deposit(uint256 raw, uint8 who) public {
        uint256 amount = bound(raw, 1, 10 ether);
        address actor = actors[who % actors.length];
        uint256 before = imd.balanceOf(actor);
        vm.prank(actor);
        hook.deposit(amount);
        eq(before - imd.balanceOf(actor), amount, "deposit debit differs");
        ghostDeposited += amount;
        successes[1]++;
    }

    function donate(uint256 raw, uint8 who) public {
        uint256 amount = bound(raw, 1, 10 ether);
        vm.prank(actors[who % actors.length]);
        imd.transfer(address(hook), amount);
        ghostUnbooked += amount;
        successes[2]++;
    }

    function sync(uint8 who) public {
        vm.prank(actors[who % actors.length]);
        hook.syncDonations();
        ghostDeposited += ghostUnbooked;
        ghostUnbooked = 0;
        successes[3]++;
    }

    function harvest(uint256 raw, uint8 who) public {
        uint256 pending = hook.pendingFees();
        if (pending == 0) return;
        // Include both dust and complete redemptions frequently.
        uint256 amount = raw % 3 == 0 ? pending : raw % 3 == 1 ? 1 : bound(raw, 1, pending);
        vm.prank(actors[who % actors.length]);
        hook.harvest(amount);
        ghostHarvested += amount;
        successes[4]++;
    }

    function treasury(uint256 raw, uint8 who) public {
        uint256 balance = hook.treasuryBalance();
        if (balance == 0) return;
        uint256 amount = raw % 3 == 0 ? balance : bound(raw, 1, balance);
        vm.prank(actors[who % actors.length]);
        hook.payTreasury(amount);
        ghostTreasuryPaid += amount;
        successes[5]++;
    }

    function configure(uint8 who, uint8 cap, bool enabled) public {
        vm.prank(owner);
        hook.configureWorker(actors[who % actors.length], 0.5 ether, (uint256(cap) % 20 + 1) * 0.5 ether, enabled);
        successes[6]++;
    }

    function advanceTime(uint256 raw) public {
        vm.warp(block.timestamp + bound(raw, 1, 2 days));
        successes[7]++;
    }

    function pay(uint256 salt) public {
        bytes32 requestKey = keccak256(abi.encode(++nextKey, salt));
        bytes memory body = abi.encode(requestKey, salt);
        uint256 today = block.timestamp / 1 days;
        uint256 todaySpend = ghostDay == today ? ghostDaySpent : 0;
        bytes4 failure;
        if (!hook.paymentsEnabled()) failure = CabalFundingHook.PaymentsDisabled.selector;
        else if (hook.requestBalance() < 0.5 ether) failure = CabalFundingHook.InsufficientFunding.selector;
        else if (todaySpend + 0.5 ether > hook.dailyLimit()) failure = CabalFundingHook.LimitExceeded.selector;
        vm.prank(hook.worker());
        if (failure != bytes4(0)) vm.expectRevert(failure);
        bytes32 id = hook.payRequest(requestKey, body, 0.5 ether, block.timestamp);
        if (failure != bytes4(0)) {
            eq(hook.paidRequests(requestKey), bytes32(0), "rejected payment took key");
            eq(hook.paidBodyHashes(requestKey), bytes32(0), "rejected payment took body");
            rejectedCalls++;
        } else {
            require(id != bytes32(0), "zero paid id");
            ghostDay = today;
            ghostDaySpent = todaySpend + 0.5 ether;
            ghostSpent += 0.5 ether;
            paidKeys.push(requestKey);
            expectedIds[requestKey] = id;
            expectedBodies[requestKey] = keccak256(body);
            successes[8]++;
        }
    }

    function replay(uint256 raw) public {
        if (paidKeys.length == 0) return;
        bytes32 requestKey = paidKeys[raw % paidKeys.length];
        bytes4 expectedError = hook.paymentsEnabled()
            ? CabalFundingHook.DuplicateRequest.selector
            : CabalFundingHook.PaymentsDisabled.selector;
        vm.prank(hook.worker());
        vm.expectRevert(expectedError);
        hook.payRequest(requestKey, hex"ffff", 0.5 ether, block.timestamp + 1);
        rejectedCalls++;
    }

    function failedIntakePayment(uint8 raw) public {
        if (!hook.paymentsEnabled() || hook.requestBalance() < 0.5 ether) return;
        uint256 spent = block.timestamp / 1 days == ghostDay ? ghostDaySpent : 0;
        if (spent + 0.5 ether > hook.dailyLimit()) return;
        bytes32 requestKey = keccak256(abi.encode(++nextKey, raw));
        intake.setMode(ReviewIntake.Mode(uint256(raw) % 4 + 1));
        vm.prank(hook.worker());
        vm.expectRevert();
        hook.payRequest(requestKey, hex"01", 0.5 ether, block.timestamp);
        intake.setMode(ReviewIntake.Mode.Normal);
        eq(hook.paidRequests(requestKey), bytes32(0), "Intake failure took key");
        eq(hook.paidBodyHashes(requestKey), bytes32(0), "Intake failure took body");
        successes[9]++;
        rejectedCalls++;
    }

    function unauthorized(uint8 who) public {
        address actor = actors[who % actors.length];
        vm.prank(actor);
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.configureWorker(actor, 1, 1, true);
        address wrongWorker =
            actor == hook.worker() ? actors[(uint256(who) % actors.length + 1) % actors.length] : actor;
        vm.prank(wrongWorker);
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.payRequest(bytes32(uint256(99)), hex"01", 0.5 ether, block.timestamp);
        successes[10]++;
        rejectedCalls += 2;
    }

    function roundTrip(uint256 raw, uint8 who) public {
        address actor = actors[who % actors.length];
        uint256 beforeImd = imd.balanceOf(actor);
        uint256 beforeToken = token.balanceOf(actor);
        uint256 amount = bound(raw, 1e9, 100 ether);
        swap(amount, 0, who);
        uint256 bought = token.balanceOf(actor) - beforeToken;
        // Exact-input sell of exactly what the preceding buy produced.
        bool zeroForOne = address(token) < address(imd);
        uint256 beforeFees = hook.totalFees();
        vm.prank(actor);
        router.swap(
            key,
            SwapParams(
                zeroForOne, -int256(bought), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        ghostFees += hook.totalFees() - beforeFees;
        eq(token.balanceOf(actor), beforeToken, "round trip retained free CABAL");
        require(imd.balanceOf(actor) < beforeImd, "round trip created IMD profit");
        successes[11]++;
    }

    function assertPaidMappings() external view {
        eq(paidKeys.length, successes[8], "paid count mismatch");
        for (uint256 i; i < paidKeys.length; i++) {
            bytes32 k = paidKeys[i];
            eq(hook.paidRequests(k), expectedIds[k], "paid id changed");
            eq(hook.paidBodyHashes(k), expectedBodies[k], "paid body changed");
        }
    }
}

/// @dev Both concrete suites use the same properties and opposite token orderings.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
abstract contract CabalFundingInvariantBase is CabalReviewFixture {
    CabalFundingHandler internal handler;

    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    function _setupInvariant(bool imdFirst) internal {
        _deploy(imdFirst, false);
        address[3] memory actors = [ALICE, BOB, WORKER];
        for (uint256 i; i < actors.length; i++) {
            imd.transfer(actors[i], 100_000 ether);
            token.transfer(actors[i], 100_000 ether);
        }
        handler = new CabalFundingHandler(hook, manager, imd, token, intake, router, key, actors);
        _configure(WORKER, 0.5 ether, 10 ether, true);
        // Nonzero initial state makes spend, redemption, and payout paths reachable
        // immediately. These funds go through the same handlers and ghost ledger.
        handler.deposit(10 ether, 0);
        handler.swap(100 ether, 0, 0);
        handler.harvest(type(uint256).max, 1);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = handler.swap.selector;
        selectors[1] = handler.deposit.selector;
        selectors[2] = handler.donate.selector;
        selectors[3] = handler.sync.selector;
        selectors[4] = handler.harvest.selector;
        selectors[5] = handler.treasury.selector;
        selectors[6] = handler.configure.selector;
        selectors[7] = handler.advanceTime.selector;
        selectors[8] = handler.pay.selector;
        selectors[9] = handler.replay.selector;
        selectors[10] = handler.failedIntakePayment.selector;
        selectors[11] = handler.unauthorized.selector;
        selectors[12] = handler.roundTrip.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantClaimsCashAndEveryLedgerMatchIndependentFlows() public view {
        uint256 fees = handler.ghostFees();
        uint256 harvested = handler.ghostHarvested();
        uint256 requests = harvested * 7 / 10;
        uint256 treasuryShare = harvested - requests;
        eq(hook.totalFees(), fees, "fees differ from swaps");
        eq(hook.totalHarvested(), harvested, "harvest differs from redemptions");
        eq(hook.pendingFees(), fees - harvested, "pending differs from unredeemed fees");
        eq(manager.balanceOf(address(hook), uint256(uint160(address(imd)))), fees - harvested, "6909 backing mismatch");
        eq(hook.totalRequestAllocation(), requests, "request split drift");
        eq(hook.totalTreasuryAllocation(), treasuryShare, "treasury split drift");
        eq(hook.totalDeposited(), handler.ghostDeposited(), "deposits differ from donor flows");
        eq(hook.totalSpent(), handler.ghostSpent(), "spend differs from paid decisions");
        eq(hook.totalTreasuryPaid(), handler.ghostTreasuryPaid(), "payout differs from transfers");
        eq(hook.requestBalance(), requests + handler.ghostDeposited() - handler.ghostSpent(), "request fund insolvency");
        eq(hook.treasuryBalance(), treasuryShare - handler.ghostTreasuryPaid(), "treasury fund insolvency");
        eq(
            imd.balanceOf(address(hook)),
            hook.requestBalance() + hook.treasuryBalance() + handler.ghostUnbooked(),
            "cash backing mismatch"
        );
        eq(imd.balanceOf(OWNER), handler.ghostTreasuryPaid(), "treasury recipient mismatch");
        eq(imd.balanceOf(address(intake)), handler.ghostSpent(), "Intake received wrong amount");
    }

    function invariantPaidDecisionsAndDailySpendingNeverResetOrReplay() public view {
        handler.assertPaidMappings();
        eq(hook.spentDay(), handler.ghostDay(), "day changed without successful payment");
        eq(hook.spentToday(), handler.ghostDaySpent(), "daily spend mismatch");
        eq(intake.calls() * 0.5 ether, handler.ghostSpent(), "duplicate or untracked payment");
        eq(imd.allowance(address(hook), address(intake)), 0, "persistent intake approval");
        eq(hook.owner(), OWNER, "owner changed");
        eq(hook.treasury(), OWNER, "treasury changed");
        eq(PoolId.unwrap(hook.boundPool()), keccak256(abi.encode(key)), "pool rebound");
    }

    function invariantFixedTokenSupplyAndPvpViewsTrackRealHoldings() public view {
        address[5] memory holders = [address(this), address(manager), ALICE, BOB, WORKER];
        uint256 sum;
        for (uint256 i; i < holders.length; i++) {
            uint256 balance = token.balanceOf(holders[i]);
            sum += balance;
            require(token.isPvpEligible(holders[i]) == (balance >= 50_000 ether), "stale PvP eligibility");
        }
        eq(sum, 1_000_000_000 ether, "CABAL supply leaked or inflated");
        eq(token.totalSupply(), sum, "CABAL total supply mismatch");
        eq(token.balanceOf(address(hook)), 0, "custom tax collected CABAL");
    }

    function afterInvariant() public {
        handler.sync(0);
        handler.harvest(type(uint256).max, 0);
        // type(uint256).max is divisible by three, selecting the full amount.
        handler.treasury(type(uint256).max, 0);
        eq(hook.pendingFees(), 0, "claims cannot be fully redeemed");
        eq(hook.treasuryBalance(), 0, "treasury cannot be fully paid");
        invariantClaimsCashAndEveryLedgerMatchIndependentFlows();
        invariantPaidDecisionsAndDailySpendingNeverResetOrReplay();
        invariantFixedTokenSupplyAndPvpViewsTrackRealHoldings();
    }

    function testHandlerExercisesSuccessAndFailureTransitions() public {
        handler.configure(2, 19, true);
        handler.pay(1);
        handler.failedIntakePayment(3);
        handler.replay(0);
        handler.donate(1, 1);
        handler.sync(1);
        handler.swap(1 ether, 1, 1);
        handler.swap(1 ether, 2, 1);
        handler.swap(1 ether, 3, 1);
        handler.treasury(type(uint256).max, 1);
        handler.advanceTime(1 days);
        handler.unauthorized(0);
        handler.roundTrip(1 ether, 0);
        for (uint256 i; i < 12; i++) {
            require(handler.successes(i) > 0, "vacuous handler path");
        }
        require(handler.rejectedCalls() >= 4, "failure paths not reached");
        afterInvariant();
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract CabalFundingImdFirstInvariantTest is CabalFundingInvariantBase {
    function setUp() public {
        _setupInvariant(true);
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract CabalFundingImdSecondInvariantTest is CabalFundingInvariantBase {
    function setUp() public {
        _setupInvariant(false);
    }
}
