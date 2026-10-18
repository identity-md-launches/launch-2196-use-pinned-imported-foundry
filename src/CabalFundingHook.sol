// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOracleIntake {
    struct Callback {
        address target;
        bytes4 selector;
    }
    function priceOf(bytes32 action, address asset) external view returns (uint256);
    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        returns (bytes32);
}

/// @notice One immutable 4/4 pool hook, a 70/30 fee ledger and a restricted oracle payer.
/// @dev No deployments are configured by this source. Hook address permissions must be mined.
contract CabalFundingHook is ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;
    uint256 public constant TAX_BPS = 400;
    uint256 public constant REQUEST_SHARE_BPS = 7000;
    bytes32 public constant ORACLE_ACTION = bytes32("oracle.request@oracle-1");
    IPoolManager public immutable manager;
    address public immutable factory;
    IERC20 public immutable imd;
    IOracleIntake public immutable intake;
    address public immutable owner;
    address public immutable treasury;
    PoolId public boundPool;
    bool public initialized;
    bool public paymentsEnabled;
    address public worker;
    uint256 public maxRequestAmount;
    uint256 public dailyLimit;
    uint256 public spentDay;
    uint256 public spentToday;
    uint256 public pendingFees;
    uint256 public totalFees;
    uint256 public totalHarvested;
    uint256 public totalRequestAllocation;
    uint256 public totalTreasuryAllocation;
    uint256 public totalDeposited;
    uint256 public totalSpent;
    uint256 public totalTreasuryPaid;
    uint256 public requestBalance;
    uint256 public treasuryBalance;
    mapping(bytes32 => bytes32) public paidRequests;
    mapping(bytes32 => bytes32) public paidBodyHashes;

    error Unauthorized();
    error BadConfiguration();
    error WrongPool();
    error InvalidAmount();
    error PartialFill();
    error DuplicateRequest();
    error PaymentsDisabled();
    error LimitExceeded();
    error InsufficientFunding();
    error Expired();
    error BadTokenAccounting();
    error RequestPriceChanged();
    event TaxAccrued(bytes32 indexed pool, uint256 amount);
    event FeesAllocated(uint256 amount, uint256 requests, uint256 treasuryAmount);
    event PreFunded(address indexed sender, uint256 amount);
    event TreasuryPaid(address indexed recipient, uint256 amount);
    event RequestPaid(bytes32 indexed key, bytes32 indexed requestId, bytes32 bodyHash, uint256 amount);
    event WorkerConfigured(address indexed worker, uint256 maxRequestAmount, uint256 dailyLimit, bool enabled);

    constructor(
        IPoolManager manager_,
        address factory_,
        IERC20 imd_,
        IOracleIntake intake_,
        address owner_,
        address treasury_
    ) {
        if (
            address(manager_) == address(0) || factory_ == address(0) || address(imd_) == address(0)
                || address(intake_) == address(0) || owner_ == address(0) || treasury_ == address(0)
        ) revert BadConfiguration();
        manager = manager_;
        factory = factory_;
        imd = imd_;
        intake = intake_;
        owner = owner_;
        treasury = treasury_;
        // Pure address-bit validation: no external constructor calls (IMD factory requirement).
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }
    modifier onlyManager() {
        if (msg.sender != address(manager)) revert Unauthorized();
        _;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external onlyManager returns (bytes4) {
        if (
            sender != factory || initialized || address(key.hooks) != address(this) || key.fee != 12500
                || (Currency.unwrap(key.currency0) != address(imd) && Currency.unwrap(key.currency1) != address(imd))
        ) revert WrongPool();
        boundPool = key.toId();
        initialized = true;
        return IHooks.beforeInitialize.selector;
    }

    function _checkPool(PoolKey calldata key) private view {
        if (!initialized || PoolId.unwrap(key.toId()) != PoolId.unwrap(boundPool)) revert WrongPool();
    }

    function _bounded(uint256 n) private pure returns (int128) {
        if (n > uint256(uint128(type(int128).max))) revert InvalidAmount();
        return int128(uint128(n));
    }

    /// @dev Fee from a pre-hook gross amount: floor(gross/25).
    function feeFromGross(uint256 gross) public pure returns (uint256) {
        return gross / 25;
    }

    /// @dev Fee added to an amount net of the hook fee: ceil(net/24), overflow-safe.
    function feeFromNet(uint256 net) public pure returns (uint256) {
        return net / 24 + (net % 24 == 0 ? 0 : 1);
    }

    function _accrue(uint256 fee) private {
        if (fee == 0) return;
        // Claim tokens avoid withdrawing IMD before the router settles its input (first-buy safe).
        manager.mint(address(this), uint256(uint160(address(imd))), fee);
        pendingFees += fee;
        totalFees += fee;
        emit TaxAccrued(PoolId.unwrap(boundPool), fee);
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _checkPool(key);
        bool buy = params.zeroForOne == (Currency.unwrap(key.currency0) == address(imd));
        bool exactInput = params.amountSpecified < 0;
        uint256 fee;
        if (buy == exactInput) {
            if (params.amountSpecified == type(int256).min) revert InvalidAmount();
            uint256 specified = uint256(exactInput ? -params.amountSpecified : params.amountSpecified);
            _bounded(specified);
            fee = exactInput ? feeFromGross(specified) : feeFromNet(specified);
            _bounded(specified + fee);
            _accrue(fee);
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(_bounded(fee), 0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        _checkPool(key);
        bool imd0 = Currency.unwrap(key.currency0) == address(imd);
        bool buy = params.zeroForOne == imd0;
        bool exactInput = params.amountSpecified < 0;
        int128 imdDelta = imd0 ? delta.amount0() : delta.amount1();
        if (buy == exactInput) {
            // Pre-charged IMD fees require full fills; never retain a fee on unused input.
            uint256 specified = uint256(exactInput ? -params.amountSpecified : params.amountSpecified);
            uint256 specifiedFee = exactInput ? feeFromGross(specified) : feeFromNet(specified);
            int256 expected = exactInput ? -int256(specified - specifiedFee) : int256(specified + specifiedFee);
            if (int256(imdDelta) != expected) revert PartialFill();
            return (IHooks.afterSwap.selector, 0);
        }
        if ((buy && imdDelta > 0) || (!buy && imdDelta < 0)) revert InvalidAmount();
        uint256 base = uint256(buy ? -int256(imdDelta) : int256(imdDelta));
        uint256 fee = buy ? feeFromNet(base) : feeFromGross(base);
        _accrue(fee);
        return (IHooks.afterSwap.selector, _bounded(fee));
    }

    /// @notice Anyone may redeem accrued fees; destinations and allocation cannot be changed.
    function harvest(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > pendingFees) revert InvalidAmount();
        uint256 beforeBalance = imd.balanceOf(address(this));
        manager.unlock(abi.encode(amount));
        if (imd.balanceOf(address(this)) - beforeBalance != amount) revert BadTokenAccounting();
        pendingFees -= amount;
        totalHarvested += amount;
        // Allocate cumulatively: rounding each tiny harvest cannot redirect the request share.
        uint256 cumulativeRequest = (totalHarvested / 10) * 7 + (totalHarvested % 10) * 7 / 10;
        uint256 requests = cumulativeRequest - totalRequestAllocation;
        uint256 treasuryAmount = amount - requests;
        totalRequestAllocation += requests;
        totalTreasuryAllocation += treasuryAmount;
        requestBalance += requests;
        treasuryBalance += treasuryAmount;
        emit FeesAllocated(amount, requests, treasuryAmount);
    }

    function unlockCallback(bytes calldata data) external onlyManager returns (bytes memory) {
        // No externally callable function invokes unlock with arbitrary callback data.
        uint256 amount = abi.decode(data, (uint256));
        if (amount == 0 || amount > pendingFees) revert InvalidAmount();
        manager.burn(address(this), uint256(uint160(address(imd))), amount);
        manager.take(Currency.wrap(address(imd)), address(this), amount);
        return "";
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = imd.balanceOf(address(this));
        imd.safeTransferFrom(msg.sender, address(this), amount);
        if (imd.balanceOf(address(this)) - beforeBalance != amount) revert BadTokenAccounting();
        requestBalance += amount;
        totalDeposited += amount;
        emit PreFunded(msg.sender, amount);
    }

    /// @notice Direct IMD transfers are donations to requests, never taxed or split a second time.
    function syncDonations() external nonReentrant {
        uint256 booked = requestBalance + treasuryBalance;
        uint256 balance = imd.balanceOf(address(this));
        if (balance < booked) revert BadTokenAccounting();
        uint256 extra = balance - booked;
        requestBalance += extra;
        totalDeposited += extra;
        if (extra > 0) emit PreFunded(address(0), extra);
    }

    function payTreasury(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > treasuryBalance) revert InvalidAmount();
        treasuryBalance -= amount;
        totalTreasuryPaid += amount;
        imd.safeTransfer(treasury, amount);
        emit TreasuryPaid(treasury, amount);
    }

    function configureWorker(address worker_, uint256 perRequest_, uint256 perDay_, bool enabled_) external onlyOwner {
        if (worker_ == address(0) || perRequest_ == 0 || perDay_ < perRequest_) revert BadConfiguration();
        worker = worker_;
        maxRequestAmount = perRequest_;
        dailyLimit = perDay_;
        paymentsEnabled = enabled_;
        emit WorkerConfigured(worker_, perRequest_, perDay_, enabled_);
    }

    function payRequest(bytes32 key, bytes calldata body, uint256 amount, uint256 deadline)
        external
        nonReentrant
        returns (bytes32 requestId)
    {
        if (msg.sender != worker) revert Unauthorized();
        if (!paymentsEnabled) revert PaymentsDisabled();
        if (block.timestamp > deadline) revert Expired();
        if (key == bytes32(0) || body.length == 0 || body.length > 16384 || amount == 0) revert InvalidAmount();
        if (paidRequests[key] != bytes32(0)) revert DuplicateRequest();
        if (amount > maxRequestAmount) revert LimitExceeded();
        if (amount > requestBalance) revert InsufficientFunding();
        // Intake forwards the entire amount, including overpayment. Check at payment time;
        // swaps remain independent of Intake pricing and service availability.
        if (amount != intake.priceOf(ORACLE_ACTION, address(imd))) revert RequestPriceChanged();
        uint256 today = block.timestamp / 1 days;
        if (spentDay != today) {
            spentDay = today;
            spentToday = 0;
        }
        if (spentToday + amount > dailyLimit) revert LimitExceeded();
        requestBalance -= amount;
        spentToday += amount;
        totalSpent += amount;
        bytes32 bodyHash = keccak256(body);
        paidBodyHashes[key] = bodyHash;
        uint256 beforeBalance = imd.balanceOf(address(this));
        imd.forceApprove(address(intake), amount);
        requestId =
            intake.request(ORACLE_ACTION, body, IOracleIntake.Callback(address(0), bytes4(0)), address(imd), amount);
        imd.forceApprove(address(intake), 0);
        if (requestId == bytes32(0) || beforeBalance - imd.balanceOf(address(this)) != amount) {
            revert BadTokenAccounting();
        }
        paidRequests[key] = requestId;
        emit RequestPaid(key, requestId, bodyHash, amount);
    }
}
