// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of ERC-20 used by OutcomeX.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title OutcomeXSettlement
/// @notice USDC order holding and settlement for verifiable, pay-per-request services.
///
/// The v0.1 flow is deliberately small:
/// 1. A buyer locks USDC with createOrder.
/// 2. A provider commits a result hash with submitResult.
/// 3. The configured verifier calls settle, which pays the provider, verifier
///    reward pool, and protocol treasury.
/// 4. If no result is settled before expiry, the buyer can reclaim the escrow.
///
/// This contract stores hashes rather than arbitrary result/proof data. The
/// gateway can publish the full response off-chain and use the emitted hashes
/// as its on-chain receipt.
contract OutcomeXSettlement {
    enum OrderStatus {
        None,
        Open,
        ResultSubmitted,
        Settled,
        Refunded
    }

    struct Order {
        address buyer;
        bytes32 serviceId;
        bytes32 requestHash;
        uint256 amount;
        uint64 expiry;
        // The expected provider and all settlement recipients are snapshotted
        // at creation. Global configuration changes cannot redirect an old order.
        address provider;
        address verifier;
        address rewardPool;
        address treasury;
        bytes32 resultHash;
        bytes32 proofHash;
        OrderStatus status;
    }

    // Basis-point allocations follow the OutcomeX v0.1 product specification:
    // provider 98%, verifier reward pool 1%, protocol treasury 1%.
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant PROVIDER_BPS = 9_800;
    uint256 public constant VERIFIER_REWARD_BPS = 100;
    uint256 public constant TREASURY_BPS = 100;

    IERC20 public immutable paymentToken;
    address public owner;
    address public verifier;
    address public rewardPool;
    address public treasury;
    uint256 public orderNonce;
    uint256 private _reentrancyLock = 1;

    mapping(bytes32 => Order) public orders;

    function getOrderStatus(bytes32 orderId) external view returns (OrderStatus) {
        return orders[orderId].status;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event RewardPoolUpdated(address indexed previousRewardPool, address indexed newRewardPool);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed buyer,
        bytes32 indexed serviceId,
        bytes32 requestHash,
        uint256 amount,
        uint64 expiry,
        address provider
    );
    event ResultSubmitted(
        bytes32 indexed orderId,
        address indexed provider,
        bytes32 resultHash,
        bytes32 proofHash
    );
    event OrderSettled(
        bytes32 indexed orderId,
        address indexed provider,
        uint256 providerAmount,
        uint256 verifierReward,
        uint256 treasuryAmount
    );
    event OrderRefunded(bytes32 indexed orderId, address indexed buyer, uint256 amount);

    error NotOwner();
    error NotVerifier();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidExpiry();
    error InvalidResultHash();
    error InvalidPaymentToken();
    error InvalidRecipient();
    error OrderAlreadyExists();
    error OrderNotFound();
    error InvalidOrderStatus();
    error Unauthorized();
    error OrderExpired();
    error OrderNotExpired();
    error ProviderMismatch();
    error UnauthorizedProvider();
    error NotOrderVerifier();
    error TokenTransferFailed();
    error NonExactTokenTransfer();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotVerifier();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert Reentrancy();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    constructor(IERC20 paymentToken_, address verifier_, address rewardPool_, address treasury_) {
        if (address(paymentToken_).code.length == 0) revert InvalidPaymentToken();
        paymentToken = paymentToken_;
        _validateRecipient(verifier_);
        _validateRecipient(rewardPool_);
        _validateRecipient(treasury_);
        if (verifier_ == rewardPool_ || verifier_ == treasury_ || rewardPool_ == treasury_) {
            revert InvalidRecipient();
        }

        owner = msg.sender;
        verifier = verifier_;
        rewardPool = rewardPool_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Lock payment for one service request.
    /// @dev The buyer must approve this contract for `amount` first.
    function createOrder(
        bytes32 serviceId,
        bytes32 requestHash,
        address expectedProvider,
        uint256 amount,
        uint64 expiry
    ) external nonReentrant returns (bytes32 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        _validateRecipient(expectedProvider);

        orderId = keccak256(abi.encodePacked(address(this), msg.sender, orderNonce++));
        if (orders[orderId].status != OrderStatus.None) revert OrderAlreadyExists();

        _safeTransferFrom(msg.sender, address(this), amount);
        orders[orderId] = Order({
            buyer: msg.sender,
            serviceId: serviceId,
            requestHash: requestHash,
            amount: amount,
            expiry: expiry,
            provider: expectedProvider,
            verifier: verifier,
            rewardPool: rewardPool,
            treasury: treasury,
            resultHash: bytes32(0),
            proofHash: bytes32(0),
            status: OrderStatus.Open
        });

        emit OrderCreated(orderId, msg.sender, serviceId, requestHash, amount, expiry, expectedProvider);
    }

    /// @notice Commit the provider's result hash and a hash of its proof bytes.
    /// @dev A provider can only submit once. Full result/proof payloads remain off-chain.
    function submitResult(
        bytes32 orderId,
        bytes32 resultHash,
        bytes calldata proof
    ) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status == OrderStatus.None) revert OrderNotFound();
        if (order.status != OrderStatus.Open) revert InvalidOrderStatus();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (resultHash == bytes32(0)) revert InvalidResultHash();
        if (msg.sender != order.provider) revert UnauthorizedProvider();

        order.resultHash = resultHash;
        order.proofHash = keccak256(proof);
        order.status = OrderStatus.ResultSubmitted;

        emit ResultSubmitted(orderId, msg.sender, resultHash, order.proofHash);
    }

    /// @notice Release a successfully verified order according to the v0.1 split.
    /// @param provider Must match the provider that submitted the result.
    function settle(bytes32 orderId, address provider) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status == OrderStatus.None) revert OrderNotFound();
        if (order.status != OrderStatus.ResultSubmitted) revert InvalidOrderStatus();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (msg.sender != order.verifier) revert NotOrderVerifier();
        if (provider == address(0) || provider != order.provider) revert ProviderMismatch();

        // Mark the order before doing external token calls.
        order.status = OrderStatus.Settled;

        uint256 providerAmount = (order.amount * PROVIDER_BPS) / BASIS_POINTS;
        uint256 verifierReward = (order.amount * VERIFIER_REWARD_BPS) / BASIS_POINTS;
        // Assign the remainder to treasury so integer rounding never leaves dust locked.
        uint256 treasuryAmount = order.amount - providerAmount - verifierReward;

        _safeTransfer(provider, providerAmount);
        _safeTransfer(order.rewardPool, verifierReward);
        _safeTransfer(order.treasury, treasuryAmount);

        emit OrderSettled(orderId, provider, providerAmount, verifierReward, treasuryAmount);
    }

    /// @notice Reclaim an order whose expiry has passed without settlement.
    /// @dev Refunds are buyer-only and cover both an unsubmitted and an unresolved result.
    function refund(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status == OrderStatus.None) revert OrderNotFound();
        if (msg.sender != order.buyer) revert Unauthorized();
        if (block.timestamp <= order.expiry) revert OrderNotExpired();
        if (order.status != OrderStatus.Open && order.status != OrderStatus.ResultSubmitted) {
            revert InvalidOrderStatus();
        }

        order.status = OrderStatus.Refunded;
        _safeTransfer(order.buyer, order.amount);
        emit OrderRefunded(orderId, order.buyer, order.amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setVerifier(address newVerifier) external onlyOwner {
        _validateRecipient(newVerifier);
        if (newVerifier == rewardPool || newVerifier == treasury) revert InvalidRecipient();
        emit VerifierUpdated(verifier, newVerifier);
        verifier = newVerifier;
    }

    function setRewardPool(address newRewardPool) external onlyOwner {
        _validateRecipient(newRewardPool);
        if (newRewardPool == verifier || newRewardPool == treasury) revert InvalidRecipient();
        emit RewardPoolUpdated(rewardPool, newRewardPool);
        rewardPool = newRewardPool;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        _validateRecipient(newTreasury);
        if (newTreasury == verifier || newTreasury == rewardPool) revert InvalidRecipient();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function _validateRecipient(address recipient) private view {
        if (
            recipient == address(0) ||
            recipient == address(this) ||
            recipient == address(paymentToken)
        ) revert InvalidRecipient();
    }

    function _balanceOf(address account) private view returns (uint256 balance) {
        (bool ok, bytes memory data) = address(paymentToken).staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector, account)
        );
        if (!ok || data.length != 32) revert TokenTransferFailed();
        balance = abi.decode(data, (uint256));
    }

    function _safeTransfer(address to, uint256 value) private {
        uint256 beforeBalance = _balanceOf(to);
        (bool ok, bytes memory data) = address(paymentToken).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TokenTransferFailed();
        }
        uint256 afterBalance = _balanceOf(to);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != value) {
            revert NonExactTokenTransfer();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 value) private {
        uint256 beforeBalance = _balanceOf(to);
        (bool ok, bytes memory data) = address(paymentToken).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TokenTransferFailed();
        }
        uint256 afterBalance = _balanceOf(to);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != value) {
            revert NonExactTokenTransfer();
        }
    }
}
