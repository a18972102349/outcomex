// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OutcomeXSettlement, IERC20} from "../src/OutcomeXSettlement.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

/// @dev Small in-test token so the suite has no external forge-std dependency.
contract MockUSDC is IERC20 {
    string public constant name = "Mock USD Coin";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "balance");
        uint256 approved = allowance[from][msg.sender];
        require(approved >= value, "allowance");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract OutcomeXSettlementTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSDC private token;
    OutcomeXSettlement private settlement;
    address private buyer = address(0xB0B);
    address private provider = address(0xC0C);
    address private verifier = address(0xD0D);
    address private rewardPool = address(0xE0E);
    address private treasury = address(0xF0F);

    function setUp() public {
        token = new MockUSDC();
        settlement = new OutcomeXSettlement(IERC20(address(token)), verifier, rewardPool, treasury);
        token.mint(buyer, 1_000_000_000);
    }

    function testCreateSubmitAndSettle() public {
        uint256 amount = 100_000_000; // 100 mUSDC: exact 98/1/1 split
        bytes32 orderId = _createOrder(amount, uint64(block.timestamp + 1 days));

        vm.prank(provider);
        settlement.submitResult(orderId, keccak256("result"), hex"1234");

        vm.prank(verifier);
        settlement.settle(orderId, provider);

        _assertEq(token.balanceOf(provider), 98_000_000);
        _assertEq(token.balanceOf(rewardPool), 1_000_000);
        _assertEq(token.balanceOf(treasury), 1_000_000);
        _assertEq(uint256(settlement.getOrderStatus(orderId)), uint256(OutcomeXSettlement.OrderStatus.Settled));
    }

    function testBuyerCanRefundAfterExpiry() public {
        uint256 amount = 50_000_000;
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 orderId = _createOrder(amount, expiry);

        vm.warp(uint256(expiry) + 1);
        vm.prank(buyer);
        settlement.refund(orderId);

        _assertEq(token.balanceOf(buyer), 1_000_000_000);
        _assertEq(uint256(settlement.getOrderStatus(orderId)), uint256(OutcomeXSettlement.OrderStatus.Refunded));
    }

    function testOnlyVerifierCanSettle() public {
        bytes32 orderId = _createOrder(100_000_000, uint64(block.timestamp + 1 days));
        vm.prank(provider);
        settlement.submitResult(orderId, keccak256("result"), hex"01");

        vm.expectRevert(OutcomeXSettlement.NotOrderVerifier.selector);
        vm.prank(provider);
        settlement.settle(orderId, provider);
    }

    function testUnknownProviderCannotSubmitResult() public {
        bytes32 orderId = _createOrder(100_000_000, uint64(block.timestamp + 1 days));
        address stranger = address(0xBAD);
        vm.expectRevert(OutcomeXSettlement.UnauthorizedProvider.selector);
        vm.prank(stranger);
        settlement.submitResult(orderId, keccak256("result"), hex"01");
    }

    function testOrderKeepsVerifierAndRecipientsAfterGlobalConfigChanges() public {
        bytes32 orderId = _createOrder(100_000_000, uint64(block.timestamp + 1 days));
        address newVerifier = address(0xD1D);
        address newRewardPool = address(0xE1E);
        address newTreasury = address(0xF1F);
        settlement.setVerifier(newVerifier);
        settlement.setRewardPool(newRewardPool);
        settlement.setTreasury(newTreasury);

        vm.prank(provider);
        settlement.submitResult(orderId, keccak256("result"), hex"01");
        vm.prank(verifier);
        settlement.settle(orderId, provider);

        _assertEq(token.balanceOf(rewardPool), 1_000_000);
        _assertEq(token.balanceOf(treasury), 1_000_000);
        _assertEq(token.balanceOf(newRewardPool), 0);
        _assertEq(token.balanceOf(newTreasury), 0);
    }

    function _createOrder(uint256 amount, uint64 expiry) private returns (bytes32 orderId) {
        vm.prank(buyer);
        token.approve(address(settlement), amount);
        vm.prank(buyer);
        orderId = settlement.createOrder(bytes32("wallet_snapshot"), keccak256("request"), provider, amount, expiry);
    }

    function _assertEq(uint256 a, uint256 b) private pure {
        require(a == b, "assertEq(uint256)");
    }
}
