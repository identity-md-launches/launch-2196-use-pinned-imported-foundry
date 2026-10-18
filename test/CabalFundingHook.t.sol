// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CabalFundingHook, IOracleIntake} from "../src/CabalFundingHook.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface Vm {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
}

contract Token is ERC20 {
    address public blocked;

    constructor() ERC20("Local fixture", "TEST") {
        _mint(msg.sender, 1e35);
    }

    function blockRecipient(address recipient) external {
        blocked = recipient;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(to != blocked || blocked == address(0), "blocked");
        super._update(from, to, amount);
    }
}

contract IntakeMock is IOracleIntake {
    uint256 public price = 0.5 ether;

    function setPrice(uint256 value) external {
        price = value;
    }

    function priceOf(bytes32 action, address) external view returns (uint256) {
        require(!fail && price != 0 && action == bytes32("oracle.request@oracle-1"), "ActionNotSold");
        return price;
    }
    uint256 public count;
    bool public fail;
    bool public undercharge;
    address public reenterTarget;
    bool public reenterSucceeded;

    function setFail(bool value) external {
        fail = value;
    }

    function setUndercharge(bool value) external {
        undercharge = value;
    }

    function setReenter(address target) external {
        reenterTarget = target;
    }

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        returns (bytes32)
    {
        require(!fail, "offline");
        require(action == bytes32("oracle.request@oracle-1"), "action");
        require(amount >= price && price != 0, "PriceNotMet");
        require(callback.target == address(0) && callback.selector == bytes4(0), "callback");
        IERC20(asset).transferFrom(msg.sender, address(this), undercharge ? amount - 1 : amount);
        if (reenterTarget != address(0)) {
            (reenterSucceeded,) = reenterTarget.call(abi.encodeWithSignature("syncDonations()"));
        }
        count++;
        return keccak256(abi.encode(msg.sender, body, count));
    }
}

contract FundingHookTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PoolManager manager;
    Token imd;
    Token cabal;
    IntakeMock intake;
    CabalFundingHook hook;
    PoolSwapTest router;
    PoolModifyLiquidityTest lp;
    PoolKey key;
    address constant treasury = address(0xBEEF);
    address constant stranger = address(0xBAD);

    function setUp() public {
        _setup(false, false);
    }

    function _setup(bool reverse, bool singleSided) internal {
        manager = new PoolManager(address(this));
        Token a = new Token();
        Token b = new Token();
        (Token low, Token high) = address(a) < address(b) ? (a, b) : (b, a);
        imd = reverse ? high : low;
        cabal = reverse ? low : high;
        intake = new IntakeMock();
        bytes memory code = abi.encodePacked(
            type(CabalFundingHook).creationCode,
            abi.encode(manager, address(this), imd, intake, address(this), treasury)
        );
        bytes32 codeHash = keccak256(code);
        uint256 salt;
        while (true) {
            address candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), codeHash))))
            );
            if (uint160(candidate) & 0x3fff == 0x20cc) break;
            salt++;
        }
        hook = new CabalFundingHook{salt: bytes32(salt)}(manager, address(this), imd, intake, address(this), treasury);
        router = new PoolSwapTest(manager);
        lp = new PoolModifyLiquidityTest(manager);
        imd.approve(address(router), type(uint256).max);
        cabal.approve(address(router), type(uint256).max);
        imd.approve(address(lp), type(uint256).max);
        cabal.approve(address(lp), type(uint256).max);
        imd.approve(address(hook), type(uint256).max);
        key = PoolKey(Currency.wrap(address(low)), Currency.wrap(address(high)), 12500, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(1 << 96));
        if (singleSided) {
            // IMD=currency0: range below price contains only CABAL currency1, no IMD inventory.
            lp.modifyLiquidity(key, ModifyLiquidityParams(-600, -60, int256(1e25), bytes32(0)), "");
        } else {
            lp.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, int256(1e25), bytes32(0)), "");
        }
    }

    function swap(bool buy, bool exactInput, uint256 amount) internal returns (BalanceDelta result, uint256 fee) {
        bool zeroForOne = buy == (address(imd) < address(cabal));
        uint256 beforeFees = hook.totalFees();
        result = router.swap(
            key,
            SwapParams(
                zeroForOne,
                exactInput ? -int256(amount) : int256(amount),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        fee = hook.totalFees() - beforeFees;
    }

    function imdDelta(BalanceDelta delta) internal view returns (int256) {
        return address(imd) < address(cabal) ? int256(delta.amount0()) : int256(delta.amount1());
    }

    function checkConservation() internal view {
        require(hook.totalFees() == hook.totalHarvested() + hook.pendingFees(), "pending conservation");
        require(
            hook.totalHarvested() == hook.totalRequestAllocation() + hook.totalTreasuryAllocation(),
            "split conservation"
        );
        require(
            hook.totalRequestAllocation() + hook.totalDeposited() == hook.requestBalance() + hook.totalSpent(),
            "fund conservation"
        );
        require(
            hook.totalTreasuryAllocation() == hook.treasuryBalance() + hook.totalTreasuryPaid(), "treasury conservation"
        );
        require(imd.balanceOf(address(hook)) == hook.requestBalance() + hook.treasuryBalance(), "solvency");
    }

    function testAllSwapModesAndOrderings() public {
        for (uint256 order; order < 2; order++) {
            if (order == 1) _setup(true, false);
            (BalanceDelta d, uint256 fee) = swap(true, true, 1000 ether);
            require(imdDelta(d) == -1000 ether && fee == 40 ether, "buy exact in");
            (d, fee) = swap(false, true, 1000 ether);
            require(fee == hook.feeFromGross(uint256(imdDelta(d)) + fee), "sell exact in");
            (d, fee) = swap(true, false, 1000 ether);
            require(fee == hook.feeFromNet(uint256(-imdDelta(d)) - fee), "buy exact out");
            (d, fee) = swap(false, false, 1000 ether);
            require(imdDelta(d) == 1000 ether && fee == hook.feeFromNet(1000 ether), "sell exact out");
            hook.harvest(hook.pendingFees());
            checkConservation();
        }
    }

    function testFirstBuyIntoSingleSidedPool() public {
        _setup(false, true);
        require(imd.balanceOf(address(manager)) == 0, "fixture must start with no IMD");
        swap(true, true, 1000 ether);
        require(hook.pendingFees() == 40 ether, "fee");
        hook.harvest(40 ether);
        require(hook.requestBalance() == 28 ether && hook.treasuryBalance() == 12 ether, "70/30");
        hook.payTreasury(12 ether);
        require(imd.balanceOf(treasury) == 12 ether, "treasury received");
        checkConservation();
    }

    function testFuzzSplitAndChunkIndependence(uint96 rawAmount, uint8 pieces) public {
        uint256 amount = uint256(rawAmount) % 1e20 + 1000;
        swap(true, true, amount);
        uint256 total = hook.pendingFees();
        uint256 n = uint256(pieces) % 25 + 1;
        for (uint256 i; i < n && hook.pendingFees() > 1; i++) {
            hook.harvest(1);
        }
        if (hook.pendingFees() > 0) hook.harvest(hook.pendingFees());
        require(
            hook.requestBalance() == total * 7 / 10 && hook.treasuryBalance() == total - total * 7 / 10,
            "chunk-independent split"
        );
        checkConservation();
    }

    function testPrefundingAndDirectDonationsAreNotTaxed() public {
        hook.deposit(10 ether);
        imd.transfer(address(hook), 5 ether);
        hook.syncDonations();
        hook.syncDonations();
        require(
            hook.requestBalance() == 15 ether && hook.treasuryBalance() == 0 && hook.totalFees() == 0,
            "donation accounting"
        );
        checkConservation();
    }

    function testPlainCabalTransfersUntaxed() public {
        cabal.transfer(stranger, 10 ether);
        require(cabal.balanceOf(stranger) == 10 ether && hook.totalFees() == 0, "plain transfer");
    }

    function testTreasuryFailureAndPaymentOutageDoNotBlockSwaps() public {
        swap(true, true, 1000 ether);
        hook.harvest(40 ether);
        imd.blockRecipient(treasury);
        vm.expectRevert();
        hook.payTreasury(12 ether);
        require(hook.treasuryBalance() == 12 ether, "keep claim");
        intake.setFail(true);
        hook.configureWorker(address(this), 0.5 ether, 10 ether, true);
        vm.expectRevert();
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 10);
        require(hook.requestBalance() == 28 ether && hook.totalSpent() == 0, "atomic failure");
        swap(true, true, 1000 ether);
        checkConservation();
    }

    function testPaidRequestsDeduplicateAndEnforceCaps() public {
        hook.deposit(10 ether);
        hook.configureWorker(address(this), 0.5 ether, 1 ether, true);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 10);
        require(imd.allowance(address(hook), address(intake)) == 0 && intake.count() == 1, "allowance cleared");
        vm.expectRevert(CabalFundingHook.DuplicateRequest.selector);
        hook.payRequest(bytes32(uint256(1)), "changed", 0.5 ether, block.timestamp + 10);
        vm.expectRevert(CabalFundingHook.LimitExceeded.selector);
        hook.payRequest(bytes32(uint256(2)), "{}", 1 ether, block.timestamp + 10);
        hook.payRequest(bytes32(uint256(2)), "{}", 0.5 ether, block.timestamp + 10);
        vm.expectRevert(CabalFundingHook.LimitExceeded.selector);
        hook.payRequest(bytes32(uint256(3)), "{}", 0.5 ether, block.timestamp + 10);
        vm.warp(block.timestamp + 1 days);
        hook.payRequest(bytes32(uint256(3)), "{}", 0.5 ether, block.timestamp + 10);
        checkConservation();
    }

    function testUnauthorizedDisabledExpiredAndEmptyFund() public {
        vm.prank(stranger);
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.configureWorker(stranger, 1, 1, true);
        hook.configureWorker(address(this), 0.5 ether, 1 ether, false);
        vm.expectRevert(CabalFundingHook.PaymentsDisabled.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 10);
        hook.configureWorker(address(this), 0.5 ether, 1 ether, true);
        vm.prank(stranger);
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 10);
        vm.expectRevert(CabalFundingHook.InsufficientFunding.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 10);
        hook.deposit(1 ether);
        vm.warp(100);
        vm.expectRevert(CabalFundingHook.Expired.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, 99);
    }

    function testIntakeUnderchargeRollsEverythingBack() public {
        hook.deposit(1 ether);
        hook.configureWorker(address(this), 0.5 ether, 1 ether, true);
        intake.setUndercharge(true);
        vm.expectRevert(CabalFundingHook.BadTokenAccounting.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 10);
        require(
            intake.count() == 0 && hook.requestBalance() == 1 ether
                && hook.paidRequests(bytes32(uint256(1))) == bytes32(0),
            "rollback"
        );
        checkConservation();
    }

    function testPaymentMustEqualCurrentIntakePriceEvenWithHigherOwnerCap() public {
        hook.deposit(2 ether);
        hook.configureWorker(address(this), 1 ether, 10 ether, true);
        vm.expectRevert(CabalFundingHook.RequestPriceChanged.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 1 ether, block.timestamp + 1800);
        require(hook.requestBalance() == 2 ether && hook.totalSpent() == 0 && intake.count() == 0, "overpayment spent");
        require(imd.allowance(address(hook), address(intake)) == 0, "overpayment approval");
        intake.setPrice(0.6 ether);
        vm.expectRevert(CabalFundingHook.RequestPriceChanged.selector);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 1800);
        require(
            hook.paidRequests(bytes32(uint256(1))) == bytes32(0) && hook.spentToday() == 0,
            "price change consumed key/cap"
        );
        intake.setPrice(0.5 ether);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 1800);
        checkConservation();
    }

    function testRetiredActionCannotSpendReserveAndDoesNotBlockTrading() public {
        hook.deposit(4 ether);
        hook.configureWorker(address(this), 0.5 ether, 10 ether, true);
        intake.setPrice(0);
        vm.expectRevert();
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, block.timestamp + 1800);
        require(hook.requestBalance() == 4 ether && hook.totalSpent() == 0, "retired action spent");
        swap(true, true, 1000 ether);
        hook.harvest(40 ether);
        hook.payTreasury(12 ether);
        require(hook.requestBalance() == 32 ether, "reserve must stay restricted");
        checkConservation();
    }

    function testLongerDeadlineAllowsDelayedInclusionButStillExpires() public {
        hook.deposit(2 ether);
        hook.configureWorker(address(this), 0.5 ether, 10 ether, true);
        uint256 deadline = block.timestamp + 1800;
        vm.warp(block.timestamp + 301);
        hook.payRequest(bytes32(uint256(1)), "{}", 0.5 ether, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(CabalFundingHook.Expired.selector);
        hook.payRequest(bytes32(uint256(2)), "{}", 0.5 ether, deadline);
        require(hook.totalSpent() == 0.5 ether, "expired spend");
        checkConservation();
    }

    function testCannotCallCallbacksOrBindAnotherPool() public {
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.beforeSwap(address(this), key, SwapParams(true, -1 ether, 1), "");
        vm.expectRevert(CabalFundingHook.Unauthorized.selector);
        hook.unlockCallback(abi.encode(1));
        PoolKey memory other = key;
        other.tickSpacing = 120;
        vm.expectRevert();
        manager.initialize(other, uint160(1 << 96));
    }

    function testPartialFillRevertsWithoutKeepingTax() public {
        uint256 beforeBalance = imd.balanceOf(address(this));
        vm.expectRevert();
        router.swap(
            key, SwapParams(true, -int256(1e30), uint160((1 << 96) - 1)), PoolSwapTest.TestSettings(false, false), ""
        );
        require(imd.balanceOf(address(this)) == beforeBalance && hook.totalFees() == 0, "atomic partial-fill rollback");
    }

    function testEndToEndSwapTreasuryAndOraclePayment() public {
        swap(true, true, 1000 ether);
        hook.harvest(40 ether);
        hook.payTreasury(12 ether);
        hook.configureWorker(address(this), 0.5 ether, 10 ether, true);
        for (uint256 i = 1; i <= 8; i++) {
            hook.payRequest(bytes32(i), abi.encode(i), 0.5 ether, block.timestamp + 60);
        }
        require(
            hook.requestBalance() == 24 ether && imd.balanceOf(treasury) == 12 ether
                && imd.balanceOf(address(intake)) == 4 ether,
            "end-to-end balances"
        );
        checkConservation();
    }

    function testIntakeCannotReenterFundingAccounting() public {
        hook.deposit(1 ether);
        hook.configureWorker(address(this), 0.5 ether, 1 ether, true);
        intake.setReenter(address(hook));
        hook.payRequest(bytes32(uint256(9)), "{}", 0.5 ether, block.timestamp + 60);
        require(!intake.reenterSucceeded() && hook.requestBalance() == 0.5 ether, "reentrancy blocked");
        checkConservation();
    }

    function testFuzzActualSwapFeeMath(uint64 rawAmount, uint8 mode) public {
        uint256 amount = uint256(rawAmount) + 1000;
        bool buy = (mode & 1) == 0;
        bool exactInput = (mode & 2) == 0;
        (BalanceDelta delta, uint256 fee) = swap(buy, exactInput, amount);
        if (buy && exactInput) {
            require(-imdDelta(delta) == int256(amount) && fee == amount / 25, "gross buy tax");
        } else if (buy) {
            uint256 net = uint256(-imdDelta(delta)) - fee;
            require(fee == (net + 23) / 24, "net buy gross-up");
        } else if (exactInput) {
            require(fee == (uint256(imdDelta(delta)) + fee) / 25, "gross sell tax");
        } else {
            require(imdDelta(delta) == int256(amount) && fee == (amount + 23) / 24, "net sell gross-up");
        }
        if (hook.pendingFees() > 0) hook.harvest(hook.pendingFees());
        checkConservation();
    }

    function testUnauthorizedInitializationIsRejected() public {
        PoolKey memory other = key;
        other.tickSpacing = 120;
        vm.prank(stranger);
        vm.expectRevert();
        manager.initialize(other, uint160(1 << 96));
    }

    function testUninitializedHookCannotBeClaimedByAnOutsider() public {
        bytes memory code = abi.encodePacked(
            type(CabalFundingHook).creationCode,
            abi.encode(manager, address(this), imd, intake, address(this), treasury)
        );
        uint256 salt = 1000000;
        bytes32 hash = keccak256(code);
        while (
            uint160(
                        address(
                            uint160(
                                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), hash)))
                            )
                        )
                    ) & 0x3fff != 0x20cc
        ) salt++;
        CabalFundingHook fresh =
            new CabalFundingHook{salt: bytes32(salt)}(manager, address(this), imd, intake, address(this), treasury);
        PoolKey memory target = key;
        target.hooks = IHooks(address(fresh));
        vm.prank(stranger);
        vm.expectRevert();
        manager.initialize(target, uint160(1 << 96));
        require(!fresh.initialized(), "outsider bound the hook");
        manager.initialize(target, uint160(1 << 96));
        require(fresh.initialized(), "factory cannot initialize");
    }

    function testFuzzMixedOperationsPreserveAllLedgers(uint256 seed) public {
        hook.configureWorker(address(this), 0.5 ether, 100 ether, true);
        for (uint256 i; i < 40; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = seed % 7;
            uint256 amount = (seed >> 8) % 1e19 + 1;
            if (op == 0 || op == 1) {
                swap(op == 0, true, amount);
            } else if (op == 2 && hook.pendingFees() > 0) {
                vm.prank(stranger);
                hook.harvest(amount % hook.pendingFees() + 1);
            } else if (op == 3 && hook.treasuryBalance() > 0) {
                vm.prank(stranger);
                hook.payTreasury(amount % hook.treasuryBalance() + 1);
            } else if (op == 4) {
                hook.deposit(amount);
            } else if (op == 5) {
                imd.transfer(address(hook), amount);
                vm.prank(stranger);
                hook.syncDonations();
            } else if (op == 6 && hook.requestBalance() >= 0.5 ether) {
                hook.payRequest(bytes32(i + 1), abi.encode(seed), 0.5 ether, block.timestamp + 60);
            }
            checkConservation();
            require(
                manager.balanceOf(address(hook), uint256(uint160(address(imd)))) == hook.pendingFees(), "claim backing"
            );
            require(hook.totalRequestAllocation() == hook.totalHarvested() * 7 / 10, "cumulative split");
            require(imd.allowance(address(hook), address(intake)) == 0, "approval outstanding");
        }
    }
}
