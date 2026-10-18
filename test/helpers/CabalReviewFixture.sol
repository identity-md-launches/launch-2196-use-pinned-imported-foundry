// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CabalFundingHook, IOracleIntake} from "../../src/CabalFundingHook.sol";
import {LaunchToken} from "../../src/LaunchToken.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

// The repository intentionally does not depend on forge-std. This is the small
// cheatcode interface needed by these offline tests, not a production dependency.
interface ReviewVm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function warp(uint256) external;
    function expectEmit(bool, bool, bool, bool, address) external;
}

abstract contract ReviewAssertions {
    ReviewVm internal constant vm = ReviewVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function bound(uint256 value, uint256 low, uint256 high) internal pure returns (uint256) {
        require(low <= high, "invalid test bounds");
        if (value >= low && value <= high) return value;
        return low + value % (high - low + 1);
    }

    function eq(uint256 a, uint256 b, string memory reason) internal pure {
        require(a == b, reason);
    }

    function eq(address a, address b, string memory reason) internal pure {
        require(a == b, reason);
    }

    function eq(bytes32 a, bytes32 b, string memory reason) internal pure {
        require(a == b, reason);
    }
}

/// @dev Behaviors are opt-in, and are never used to simulate the CABAL token.
contract ReviewAsset is ERC20 {
    address public blockedRecipient;
    bool public transferTax;
    bool public rejectApproval;
    bool public rejectClear;

    constructor() ERC20("Review IMD fixture", "IMD") {
        _mint(msg.sender, 1e34);
    }

    function setBlockedRecipient(address value) external {
        blockedRecipient = value;
    }

    function setTransferTax(bool value) external {
        transferTax = value;
    }

    function setApprovalFailure(bool nonzero, bool clear) external {
        rejectApproval = nonzero;
        rejectClear = clear;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        require(!(value == 0 ? rejectClear : rejectApproval), "approval refused");
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(blockedRecipient == address(0) || to != blockedRecipient, "recipient blocked");
        if (transferTax && from != address(0) && to != address(0) && amount != 0) {
            super._update(from, address(0), 1);
            super._update(from, to, amount - 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

contract ReviewIntake is IOracleIntake {
    enum Mode {
        Normal,
        RevertRequest,
        Undercharge,
        Overcharge,
        ZeroId,
        Reenter
    }
    Mode public mode;
    uint256 public price = 0.5 ether;
    uint256 public calls;
    uint256 public observedAllowance;
    bytes32 public lastBodyHash;
    bytes32 public lastAction;
    address public lastAsset;
    address public lastPayer;
    address public lastCallback;
    bytes4 public lastSelector;
    bool public failPrice;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;

    function setMode(Mode value) external {
        mode = value;
    }

    function setPrice(uint256 value, bool fail) external {
        price = value;
        failPrice = fail;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
        mode = Mode.Reenter;
    }

    function priceOf(bytes32 action, address) external view returns (uint256) {
        require(!failPrice && price != 0 && action == bytes32("oracle.request@oracle-1"), "ActionNotSold");
        return price;
    }

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        returns (bytes32)
    {
        require(mode != Mode.RevertRequest, "request unavailable");
        require(action == bytes32("oracle.request@oracle-1"), "unexpected action");
        require(callback.target == address(0) && callback.selector == bytes4(0), "unexpected callback");
        require(amount == price, "unexpected price");
        observedAllowance = IERC20(asset).allowance(msg.sender, address(this));
        require(observedAllowance == amount, "approval is not exact");
        uint256 debit = mode == Mode.Undercharge ? amount - 1 : mode == Mode.Overcharge ? amount + 1 : amount;
        IERC20(asset).transferFrom(msg.sender, address(this), debit);
        if (mode == Mode.Reenter) (reentrySucceeded,) = reentryTarget.call(reentryData);
        calls++;
        lastBodyHash = keccak256(body);
        lastAction = action;
        lastAsset = asset;
        lastPayer = msg.sender;
        lastCallback = callback.target;
        lastSelector = callback.selector;
        return mode == Mode.ZeroId ? bytes32(0) : keccak256(abi.encode(msg.sender, calls, body));
    }
}

/// @dev All constructors and initialization execute inside one setup transaction.
abstract contract CabalReviewFixture is ReviewAssertions {
    using PoolIdLibrary for PoolKey;
    address internal constant OWNER = 0x4251627B712762B6e81799698a05c6C9DfF35C5d;
    // These contracts/actors are exclusively local fixtures, never deployment inputs.
    address internal constant ALICE = address(uint160(uint256(keccak256("review actor A"))));
    address internal constant BOB = address(uint160(uint256(keccak256("review actor B"))));
    address internal constant WORKER = address(uint160(uint256(keccak256("review worker"))));
    PoolManager internal manager;
    ReviewAsset internal imd;
    LaunchToken internal token;
    ReviewIntake internal intake;
    CabalFundingHook internal hook;
    PoolSwapTest internal router;
    PoolModifyLiquidityTest internal lp;
    PoolKey internal key;

    function _deploy(bool imdFirst, bool singleSided) internal {
        manager = new PoolManager(address(this));
        token = new LaunchToken();
        bytes32 assetHash = keccak256(type(ReviewAsset).creationCode);
        uint256 assetSalt;
        for (;; assetSalt++) {
            address candidate = address(
                uint160(
                    uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(assetSalt), assetHash)))
                )
            );
            if ((candidate < address(token)) == imdFirst) break;
        }
        imd = new ReviewAsset{salt: bytes32(assetSalt)}();
        intake = new ReviewIntake();
        hook = _newHook(address(manager), address(this), address(imd), address(intake), OWNER, OWNER);
        router = new PoolSwapTest(manager);
        lp = new PoolModifyLiquidityTest(manager);
        key = PoolKey(
            Currency.wrap(imdFirst ? address(imd) : address(token)),
            Currency.wrap(imdFirst ? address(token) : address(imd)),
            12500,
            60,
            IHooks(address(hook))
        );
        manager.initialize(key, uint160(1 << 96));
        imd.approve(address(lp), type(uint256).max);
        token.approve(address(lp), type(uint256).max);
        imd.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        imd.approve(address(hook), type(uint256).max);
        int24 lower = singleSided && !imdFirst ? int24(60) : int24(-600);
        int24 upper = singleSided && imdFirst ? int24(-60) : int24(600);
        lp.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(1e25), bytes32(0)), "");
    }

    function _newHook(address m, address f, address asset, address door, address owner_, address treasury_)
        internal
        returns (CabalFundingHook result)
    {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(CabalFundingHook).creationCode, abi.encode(m, f, asset, door, owner_, treasury_))
        );
        uint256 salt;
        for (;; salt++) {
            address candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), initHash))))
            );
            if ((uint160(candidate) & 0x3fff) == 0x20cc && candidate.code.length == 0) break;
        }
        result = new CabalFundingHook{salt: bytes32(salt)}(
            IPoolManager(m), f, IERC20(asset), IOracleIntake(door), owner_, treasury_
        );
    }

    function _configure(address worker_, uint256 perRequest, uint256 perDay, bool enabled) internal {
        vm.prank(OWNER);
        hook.configureWorker(worker_, perRequest, perDay, enabled);
    }

    function _swap(bool buy, bool exactInput, uint256 amount) internal returns (BalanceDelta result) {
        bool zeroForOne = buy == (address(imd) < address(token));
        return router.swap(
            key,
            SwapParams(
                zeroForOne,
                exactInput ? -int256(amount) : int256(amount),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _imdDelta(BalanceDelta delta) internal view returns (int256) {
        return address(imd) < address(token) ? int256(delta.amount0()) : int256(delta.amount1());
    }

    function _assertLedgers() internal view {
        eq(hook.totalFees(), hook.totalHarvested() + hook.pendingFees(), "fees not conserved");
        eq(manager.balanceOf(address(hook), uint256(uint160(address(imd)))), hook.pendingFees(), "unbacked 6909 claims");
        eq(hook.totalHarvested(), hook.totalRequestAllocation() + hook.totalTreasuryAllocation(), "split not conserved");
        eq(hook.totalRequestAllocation(), hook.totalHarvested() * 7 / 10, "cumulative rounding");
        eq(
            hook.totalRequestAllocation() + hook.totalDeposited(),
            hook.requestBalance() + hook.totalSpent(),
            "request conservation"
        );
        eq(hook.totalTreasuryAllocation(), hook.treasuryBalance() + hook.totalTreasuryPaid(), "treasury conservation");
        eq(imd.balanceOf(address(hook)), hook.requestBalance() + hook.treasuryBalance(), "insolvent ledger");
        eq(imd.allowance(address(hook), address(intake)), 0, "residual approval");
    }
}
