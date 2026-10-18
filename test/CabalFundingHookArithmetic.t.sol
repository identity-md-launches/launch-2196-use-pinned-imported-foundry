// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    CabalReviewFixture,
    CabalFundingHook,
    IHooks,
    PoolKey,
    Currency,
    SwapParams,
    BalanceDelta,
    toBalanceDelta,
    PoolSwapTest,
    TickMath,
    ModifyLiquidityParams
} from "./helpers/CabalReviewFixture.sol";

contract CabalFundingHookArithmeticTest is CabalReviewFixture {
    function setUp() public {
        _deploy(true, false);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzzFeeBoundsAcrossFullUint256Domain(uint256 amount) public view {
        uint256 grossFee = hook.feeFromGross(amount);
        // Quotient/remainder inequalities characterize the required rounding,
        // including uint256.max, without an overflowing amount * 400 expression.
        require(grossFee * 25 <= amount, "gross fee rounds up");
        require(amount - grossFee * 25 < 25, "gross fee rounds down too far");
        uint256 netFee = hook.feeFromNet(amount);
        if (amount == 0) {
            eq(netFee, 0, "zero amount charged");
        } else {
            require(netFee > 0, "nonzero exact output is free");
            uint256 below = (netFee - 1) * 24;
            require(below < amount && amount - below <= 24, "net fee is not least covering gross-up");
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzzGrossToNetToGrossHasAtMostOneAtomicUnitRounding(uint256 gross) public view {
        uint256 fee = hook.feeFromGross(gross);
        uint256 net = gross - fee;
        uint256 grossUpFee = hook.feeFromNet(net);
        require(grossUpFee >= fee && grossUpFee - fee <= 1, "roundtrip rounding exceeds one unit");
    }

    function testPinnedZeroOneDivisorAndMaximumFeeEdges() public view {
        uint256[9] memory inputs = [uint256(0), 1, 23, 24, 25, 26, 48, 49, type(uint256).max];
        uint256[9] memory fromGross = [uint256(0), 0, 0, 0, 1, 1, 1, 1, type(uint256).max / 25];
        uint256[9] memory fromNet = [uint256(0), 1, 1, 1, 2, 2, 2, 3, type(uint256).max / 24 + 1];
        for (uint256 i; i < inputs.length; i++) {
            eq(hook.feeFromGross(inputs[i]), fromGross[i], "gross edge");
            eq(hook.feeFromNet(inputs[i]), fromNet[i], "net edge");
        }
    }

    function testPrechargedFeesRejectUnrepresentableSignedAmounts() public {
        int256 maximum = int256(type(int128).max);
        vm.startPrank(address(manager));
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.beforeSwap(ALICE, key, SwapParams(true, type(int256).min, 1), "");
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.beforeSwap(ALICE, key, SwapParams(true, -maximum - 1, 1), "");
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.beforeSwap(ALICE, key, SwapParams(false, maximum + 1, 1), "");
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.beforeSwap(ALICE, key, SwapParams(false, maximum, 1), "");
        vm.stopPrank();
        eq(hook.totalFees(), 0, "invalid amount accrued fees");
    }

    function testAfterSwapRejectsWrongIMDDirectionAndIncompletePrechargedFills() public {
        vm.startPrank(address(manager));
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.afterSwap(ALICE, key, SwapParams(true, 100, 1), toBalanceDelta(1, 100), "");
        vm.expectRevert(CabalFundingHook.InvalidAmount.selector);
        hook.afterSwap(ALICE, key, SwapParams(false, -100, 1), toBalanceDelta(-1, -100), "");
        vm.expectRevert(CabalFundingHook.PartialFill.selector);
        hook.afterSwap(ALICE, key, SwapParams(true, -1000, 1), toBalanceDelta(-959, 900), "");
        vm.expectRevert(CabalFundingHook.PartialFill.selector);
        hook.afterSwap(ALICE, key, SwapParams(false, 1000, 1), toBalanceDelta(1041, -1100), "");
        vm.stopPrank();
        _assertLedgers();
    }

    function testAtomicUnitsChargeOnlyIMDInAllFourSwapModes() public {
        uint256[5] memory amounts = [uint256(1), 24, 25, 26, 49];
        for (uint256 mode; mode < 4; mode++) {
            bool buy = mode % 2 == 0;
            bool exactInput = mode < 2;
            for (uint256 i; i < amounts.length; i++) {
                uint256 beforeFee = hook.totalFees();
                BalanceDelta delta = _swap(buy, exactInput, amounts[i]);
                uint256 fee = hook.totalFees() - beforeFee;
                int256 net = _imdDelta(delta);
                if (buy && exactInput) {
                    require(net == -int256(amounts[i]), "gross atomic debit");
                    eq(fee, amounts[i] / 25, "gross atomic fee");
                } else if (!buy && !exactInput) {
                    require(net == int256(amounts[i]), "net atomic credit");
                    eq(fee, (amounts[i] + 23) / 24, "net atomic fee");
                } else if (buy) {
                    uint256 requiredPoolInput = uint256(-net) - fee;
                    eq(fee, (requiredPoolInput + 23) / 24, "exact-output buy rounding");
                } else {
                    eq(fee, (uint256(net) + fee) / 25, "exact-input sell rounding");
                }
                eq(token.balanceOf(address(hook)), 0, "hook taxed CABAL");
            }
        }
        hook.harvest(hook.pendingFees());
        _assertLedgers();
    }

    function testTenOneWeiHarvestsMatchSingleCumulativeAllocation() public {
        _swap(true, true, 250);
        eq(hook.pendingFees(), 10, "fixture tax");
        uint256[10] memory requestCumulative = [uint256(0), 1, 2, 2, 3, 4, 4, 5, 6, 7];
        for (uint256 i; i < 10; i++) {
            hook.harvest(1);
            eq(hook.totalRequestAllocation(), requestCumulative[i], "dust split lost request share");
            // Drain each treasury accrual to ensure rounding does not borrow paid funds.
            if (hook.treasuryBalance() != 0) hook.payTreasury(hook.treasuryBalance());
            _assertLedgers();
        }
        eq(hook.requestBalance(), 7, "request 70 percent");
        eq(imd.balanceOf(OWNER), 3, "treasury 30 percent");
    }

    function testFirstBuyWorksWithZeroIMDSeedInEitherCurrencyOrdering() public {
        // The initial fixture's state is irrelevant; each ordering gets a fresh
        // manager with CABAL-only liquidity and a genuinely empty IMD balance.
        for (uint256 order; order < 2; order++) {
            _deploy(order == 0, true);
            eq(imd.balanceOf(address(manager)), 0, "pool was prefunded with IMD");
            _swap(true, true, 1000 ether);
            eq(hook.pendingFees(), 40 ether, "first buy tax");
            eq(imd.balanceOf(address(hook)), 0, "swap transferred fees instead of minting claims");
            hook.harvest(40 ether);
            eq(hook.requestBalance(), 28 ether, "first buy request funding");
            eq(hook.treasuryBalance(), 12 ether, "first buy treasury");
            _assertLedgers();
        }
    }

    function testUnrelatedPoolAndWalletTransfersAccrueNoCustomFee() public {
        PoolKey memory unrelated = key;
        unrelated.hooks = IHooks(address(0));
        manager.initialize(unrelated, uint160(1 << 96));
        lp.modifyLiquidity(unrelated, ModifyLiquidityParams(-600, 600, int256(1e25), bytes32(0)), "");
        uint256 before = token.balanceOf(address(this));
        router.swap(
            unrelated,
            SwapParams(true, -int256(1000 ether), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        require(token.balanceOf(address(this)) > before, "unrelated swap did not execute");
        token.transfer(ALICE, 50_000 ether);
        vm.prank(ALICE);
        token.transfer(BOB, 1);
        require(!token.isPvpEligible(ALICE), "eligibility constrained transfer");
        eq(token.balanceOf(BOB), 1, "wallet transfer taxed");
        eq(hook.totalFees(), 0, "unrelated activity accrued custom tax");
    }
}
