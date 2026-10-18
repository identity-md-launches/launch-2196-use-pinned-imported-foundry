// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LaunchToken} from "../src/LaunchToken.sol";
import {ReviewAssertions} from "./helpers/CabalReviewFixture.sol";

contract LaunchTokenHandler is ReviewAssertions {
    LaunchToken public immutable token;
    address[4] public actors;
    uint256[4] public expectedBalance;
    uint256[4][4] public expectedAllowance;
    uint256 public transfers;
    uint256 public approvals;
    uint256 public rejected;

    constructor() {
        token = new LaunchToken();
        eq(token.balanceOf(address(this)), 1_000_000_000 ether, "factory did not receive entire initial supply");
        for (uint256 i; i < 4; i++) {
            actors[i] = address(uint160(uint256(keccak256(abi.encode("local CABAL invariant actor", i)))));
            expectedBalance[i] = 250_000_000 ether;
            token.transfer(actors[i], expectedBalance[i]);
        }
    }

    function transfer(uint8 fromRaw, uint8 toRaw, uint256 raw) public {
        uint256 from = fromRaw % 4;
        uint256 to = toRaw % 4;
        uint256 amount = bound(raw, 0, expectedBalance[from]);
        vm.prank(actors[from]);
        require(token.transfer(actors[to], amount), "plain transfer returned false");
        expectedBalance[from] -= amount;
        expectedBalance[to] += amount;
        transfers++;
    }

    function approve(uint8 fromRaw, uint8 spenderRaw, uint256 raw, bool infinite) public {
        uint256 from = fromRaw % 4;
        uint256 spender = spenderRaw % 4;
        uint256 amount = infinite ? type(uint256).max : bound(raw, 0, 1_000_000_000 ether);
        vm.prank(actors[from]);
        require(token.approve(actors[spender], amount), "plain approval returned false");
        expectedAllowance[from][spender] = amount;
        approvals++;
    }

    function transferFrom(uint8 fromRaw, uint8 toRaw, uint8 spenderRaw, uint256 raw) public {
        uint256 from = fromRaw % 4;
        uint256 to = toRaw % 4;
        uint256 spender = spenderRaw % 4;
        uint256 allowance = expectedAllowance[from][spender];
        uint256 maximum = allowance < expectedBalance[from] ? allowance : expectedBalance[from];
        uint256 amount = bound(raw, 0, maximum);
        vm.prank(actors[spender]);
        require(token.transferFrom(actors[from], actors[to], amount), "delegated transfer returned false");
        expectedBalance[from] -= amount;
        expectedBalance[to] += amount;
        if (allowance != type(uint256).max) expectedAllowance[from][spender] -= amount;
        transfers++;
    }

    function overdraw(uint8 fromRaw, uint8 toRaw) public {
        uint256 from = fromRaw % 4;
        uint256 to = toRaw % 4;
        vm.prank(actors[from]);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC20InsufficientBalance(address,uint256,uint256)",
                actors[from],
                expectedBalance[from],
                expectedBalance[from] + 1
            )
        );
        token.transfer(actors[to], expectedBalance[from] + 1);
        rejected++;
    }

    function revokeAndAttemptSpend(uint8 fromRaw, uint8 spenderRaw) public {
        uint256 from = fromRaw % 4;
        uint256 spender = spenderRaw % 4;
        approve(fromRaw, spenderRaw, 0, false);
        vm.prank(actors[spender]);
        vm.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", actors[spender], 0, 1)
        );
        token.transferFrom(actors[from], actors[(from + 1) % 4], 1);
        rejected++;
    }

    function crossPvpBoundary(uint8 who, uint8 side) public {
        uint256 target = who % 4;
        uint256 desired = 50_000 ether + (side % 3) - 1;
        if (expectedBalance[target] > desired) {
            transfer(uint8(target), uint8((target + 1) % 4), expectedBalance[target] - desired);
        } else {
            for (uint256 i; i < 4 && expectedBalance[target] < desired; i++) {
                if (i == target) continue;
                uint256 need = desired - expectedBalance[target];
                uint256 amount = need < expectedBalance[i] ? need : expectedBalance[i];
                transfer(uint8(i), uint8(target), amount);
            }
        }
        eq(token.balanceOf(actors[target]), desired, "could not reach threshold boundary");
        require(token.isPvpEligible(actors[target]) == (side % 3 != 0), "PvP boundary is not inclusive");
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract LaunchTokenStatefulInvariantTest is ReviewAssertions {
    LaunchTokenHandler internal handler;
    LaunchToken internal token;

    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    function setUp() public {
        handler = new LaunchTokenHandler();
        token = handler.token();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.transfer.selector;
        selectors[1] = handler.approve.selector;
        selectors[2] = handler.transferFrom.selector;
        selectors[3] = handler.overdraw.selector;
        selectors[4] = handler.revokeAndAttemptSpend.selector;
        selectors[5] = handler.crossPvpBoundary.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantSupplyTransfersAllowancesAndEligibilityStayConsistent() public view {
        uint256 sum;
        for (uint256 i; i < 4; i++) {
            address holder = handler.actors(i);
            uint256 actual = token.balanceOf(holder);
            eq(actual, handler.expectedBalance(i), "transfer taxed, minted, or burned");
            require(
                token.isPvpEligible(holder) == (actual >= 50_000 ether), "PvP view does not reflect current balance"
            );
            sum += actual;
            for (uint256 j; j < 4; j++) {
                eq(
                    token.allowance(holder, handler.actors(j)),
                    handler.expectedAllowance(i, j),
                    "allowance accounting changed"
                );
            }
        }
        eq(sum, 1_000_000_000 ether, "supply not conserved");
        eq(token.totalSupply(), sum, "fixed supply changed");
        eq(token.balanceOf(address(handler)), 0, "factory minted again");
        eq(token.balanceOf(address(0)), 0, "supply burned to zero");
        require(!token.isPvpEligible(address(0)), "zero address eligible");
        eq(token.PVP_MINIMUM_HOLDING(), 50_000 ether, "threshold changed");
    }

    function testAllTokenHandlerBranchesIncludingFullBalanceAndThresholds() public {
        handler.transfer(0, 0, type(uint256).max);
        handler.transfer(0, 1, 250_000_000 ether);
        handler.approve(1, 2, 10, false);
        handler.transferFrom(1, 3, 2, 10);
        handler.approve(1, 2, 0, true);
        handler.transferFrom(1, 3, 2, 1 ether);
        handler.overdraw(0, 1);
        handler.revokeAndAttemptSpend(1, 2);
        for (uint8 i; i < 3; i++) {
            handler.crossPvpBoundary(0, i);
        }
        invariantSupplyTransfersAllowancesAndEligibilityStayConsistent();
        require(handler.transfers() > 0 && handler.approvals() > 0 && handler.rejected() > 0, "no meaningful actions");
    }
}
