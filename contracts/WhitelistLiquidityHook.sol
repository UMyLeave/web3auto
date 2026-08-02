// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface ITrustedPositionManager {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Restricts new and increased liquidity to a fixed wallet whitelist.
/// @dev The trusted PositionManager must own the callback path, while the final
///      position NFT owner must be whitelisted. Removal is deliberately unrestricted.
contract WhitelistLiquidityHook {
    uint160 public constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 public constant BEFORE_ADD_LIQUIDITY_FLAG = 1 << 11;
    uint256 public constant policyVersion = 2;

    address public immutable poolManager;
    address public immutable positionManager;
    uint256 public immutable whitelistSize;
    mapping(address wallet => bool allowed) public isWhitelisted;

    error CallerIsNotPoolManager(address caller);
    error InvalidHookAddress(address hook);
    error InvalidPoolManager();
    error InvalidPositionManager();
    error InvalidPositionManagerCaller(address caller);
    error WalletIsNotWhitelisted(address wallet);
    error WhitelistIsEmpty();
    error WhitelistContainsZeroAddress();

    constructor(address poolManager_, address positionManager_, address[] memory allowedWallets) {
        if (poolManager_ == address(0)) revert InvalidPoolManager();
        if (positionManager_ == address(0)) revert InvalidPositionManager();
        if (allowedWallets.length == 0) revert WhitelistIsEmpty();
        if ((uint160(address(this)) & ALL_HOOK_MASK) != BEFORE_ADD_LIQUIDITY_FLAG) {
            revert InvalidHookAddress(address(this));
        }

        poolManager = poolManager_;
        positionManager = positionManager_;

        uint256 uniqueWallets;
        for (uint256 index; index < allowedWallets.length; index++) {
            address wallet = allowedWallets[index];
            if (wallet == address(0)) revert WhitelistContainsZeroAddress();
            if (!isWhitelisted[wallet]) {
                isWhitelisted[wallet] = true;
                uniqueWallets++;
            }
        }
        whitelistSize = uniqueWallets;
    }

    function beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        ModifyLiquidityParams calldata params,
        bytes calldata
    ) external view returns (bytes4) {
        if (msg.sender != poolManager) revert CallerIsNotPoolManager(msg.sender);
        if (sender != positionManager) revert InvalidPositionManagerCaller(sender);

        address positionOwner =
            ITrustedPositionManager(positionManager).ownerOf(uint256(params.salt));
        if (!isWhitelisted[positionOwner]) revert WalletIsNotWhitelisted(positionOwner);

        return this.beforeAddLiquidity.selector;
    }
}
