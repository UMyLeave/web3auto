import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  actionMayHaveMintedPosition,
  applyActionPositionReconciliation,
  assertExecutionPlanInvariant,
  assertLiquidityPreviewAuthorization,
  assertPoolAvailableForCreation,
  decimalFraction,
  encodeInitializePool,
  encodeLiquidityTransaction,
  encodeMintLiquidity,
  exactAllowanceActions,
  findActionTargetPoolPositions,
  integerSqrt,
  liquidityExecutionFingerprint,
  liquidityRangeTicks,
  normalizeLiquidityInput,
  optimizedStableSwapAmount,
  poolIdOf,
  priceToSqrtPriceX96,
  resolveLiquidityRangeTicks,
  sqrtPriceAtTick,
  stableBudgetAllocation,
  tickAtSqrtPrice
} from '../liquidity-service.js';
import {
  validateLiquiditySwapResponse,
  validateLiquidityTokenTaxes
} from '../liquidity-swap-service.js';
import { sqrtPriceAtTick as monitorSqrtPriceAtTick } from '../server.js';

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const TRADE = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x55d398326f99059fF775485246999027B3197955';
const OWNER = '0x2222222222222222222222222222222222222222';
const config = {
  maxStableBudget: 1000,
  maxFeePercent: 10,
  stablecoins: [{ symbol: 'USDT', address: QUOTE }]
};

test('TickMath matches official Uniswap v4 vectors and the monitor implementation', () => {
  for (const tick of [-887000, -10000, -4096, -128, -1, 0, 1, 128, 4096, 10000, 887000]) {
    assert.equal(sqrtPriceAtTick(tick), monitorSqrtPriceAtTick(tick));
  }
  assert.equal(sqrtPriceAtTick(0), Q96);
  assert.equal(sqrtPriceAtTick(-887272), 4295128739n);
  assert.equal(
    sqrtPriceAtTick(887272),
    1461446703485210103287273052203988822378723970342n
  );
  assert.equal(sqrtPriceAtTick(-1), 79224201403219477170569942574n);
  assert.equal(sqrtPriceAtTick(1), 79232123823359799118286999568n);
});

test('TickMath stays monotonic across multiplier boundaries and round-trips prices', () => {
  for (const boundary of [4096, 8192, 16384, 32768, 45056, 65536]) {
    assert.ok(sqrtPriceAtTick(boundary - 1) < sqrtPriceAtTick(boundary));
    assert.ok(sqrtPriceAtTick(boundary) < sqrtPriceAtTick(boundary + 1));
  }
  for (const tick of [-887271, -65536, -45056, -1, 0, 1, 45056, 65536, 887271]) {
    assert.equal(tickAtSqrtPrice(sqrtPriceAtTick(tick)), tick);
  }
});

test('custom human-price range produces the expected ordered ticks', () => {
  const currentSqrtPrice = priceToSqrtPriceX96('0.00356', 18, 18, false);
  const currentTick = tickAtSqrtPrice(currentSqrtPrice);
  const range = liquidityRangeTicks({
    rangeType: 'custom',
    lowerPrice: '0.0030',
    upperPrice: '0.0038',
    tickSpacing: 10
  }, currentTick, false, 18, 18);
  assert.equal(currentTick, 56382);
  assert.deepEqual(range, { tickLower: 55730, tickUpper: 58100 });
});

test('decimal helpers retain exact positive fractions', () => {
  assert.deepEqual(decimalFraction('12.3400'), {
    numerator: 123400n,
    denominator: 10000n,
    text: '12.3400'
  });
  assert.equal(integerSqrt(2n), 1n);
  assert.equal(integerSqrt(16n), 4n);
  assert.throws(() => decimalFraction('0'), /大于 0/);
});

test('price conversion handles unequal token decimals in both currency orders', () => {
  const tradeIsCurrency0 = priceToSqrtPriceX96('2', 18, 6, true);
  const expected0 = integerSqrt(2n * (10n ** 6n) * Q192 / (10n ** 18n));
  assert.equal(tradeIsCurrency0, expected0);

  const tradeIsCurrency1 = priceToSqrtPriceX96('2', 18, 6, false);
  const expected1 = integerSqrt((10n ** 18n) * Q192 / (2n * (10n ** 6n)));
  assert.equal(tradeIsCurrency1, expected1);
});

test('stable-only budget is allocated according to the selected liquidity range', () => {
  const allocation = stableBudgetAllocation(
    '100',
    '1',
    18,
    18,
    true,
    Q96,
    -600,
    600
  );
  assert.equal(allocation.stableBudget, 100n * (10n ** 18n));
  assert.equal(allocation.stableToSwap + allocation.quoteAmount, allocation.stableBudget);
  const half = allocation.stableBudget / 2n;
  const distance = allocation.stableToSwap > half
    ? allocation.stableToSwap - half
    : half - allocation.stableToSwap;
  assert.ok(distance < allocation.stableBudget / 1000n);
});

test('swap optimizer adapts the stable split to the real quote rate', () => {
  assert.equal(optimizedStableSwapAmount(100n, 50n, 50n, 10n, 10n), 50n);
  assert.equal(optimizedStableSwapAmount(100n, 50n, 50n, 10n, 5n), 66n);
  assert.equal(optimizedStableSwapAmount(100n, 0n, 100n, 10n, 10n), 0n);
  assert.equal(optimizedStableSwapAmount(100n, 100n, 0n, 10n, 10n), 100n);
});

test('liquidity swap validator accepts only the requested stable-to-trade route', () => {
  const response = {
    routerResult: {
      fromTokenAmount: '1000000000000000000',
      toTokenAmount: '990000000000000000',
      fromToken: {
        tokenContractAddress: QUOTE,
        decimal: '18',
        tokenUnitPrice: '1',
        taxRate: '0'
      },
      toToken: {
        tokenContractAddress: TRADE,
        decimal: '18',
        tokenUnitPrice: '1',
        isHoneyPot: false,
        taxRate: '0'
      }
    },
    tx: {
      from: OWNER,
      to: '0x3333333333333333333333333333333333333333',
      data: '0x1234',
      value: '0'
    }
  };
  const validated = validateLiquiditySwapResponse(
    response,
    QUOTE,
    TRADE,
    10n ** 18n,
    OWNER,
    { maxSwapValueLossPercent: 5 },
    true
  );
  assert.equal(validated.amountOut, 990000000000000000n);

  response.routerResult.toToken.tokenContractAddress = QUOTE;
  assert.throws(() => validateLiquiditySwapResponse(
    response,
    QUOTE,
    TRADE,
    10n ** 18n,
    OWNER,
    {},
    true
  ), /目标代币不一致/);
});

test('liquidity swap validator rejects partial or unidentified exact-input routes', () => {
  const response = {
    routerResult: {
      fromTokenAmount: '999',
      toTokenAmount: '900',
      fromToken: {
        tokenContractAddress: QUOTE,
        decimal: '18',
        tokenUnitPrice: '1',
        taxRate: '0'
      },
      toToken: {
        tokenContractAddress: TRADE,
        decimal: '18',
        tokenUnitPrice: '1',
        isHoneyPot: false,
        taxRate: '0'
      }
    }
  };
  assert.throws(() => validateLiquiditySwapResponse(
    response,
    QUOTE,
    TRADE,
    1000n,
    OWNER
  ), /精确兑换金额不一致/);

  response.routerResult.fromTokenAmount = '1000';
  delete response.routerResult.fromToken.tokenContractAddress;
  assert.throws(() => validateLiquiditySwapResponse(
    response,
    QUOTE,
    TRADE,
    1000n,
    OWNER
  ), /输入稳定币不一致/);
});

test('liquidity quote rejects taxed and unknown-tax tokens before swapping', () => {
  const route = {
    fromToken: { taxRate: '0' },
    toToken: { taxRate: '0.03' }
  };
  assert.throws(() => validateLiquidityTokenTaxes(route), /3%.*已在兑换前停止/);
  assert.throws(() => validateLiquidityTokenTaxes({
    fromToken: { taxRate: '0' },
    toToken: {}
  }), /未返回目标代币税率/);
});

test('creation-only preflight rejects an already initialized exact PoolKey', () => {
  assert.doesNotThrow(() => assertPoolAvailableForCreation({ initialized: false }));
  assert.throws(
    () => assertPoolAvailableForCreation({ initialized: true }),
    /精确|相同交易代币.*池子已存在/
  );
});

test('failed liquidity execution releases the task when no target-pool NFT exists', () => {
  const action = {
    stage: 'needs_attention',
    poolId: `0x${'12'.repeat(32)}`,
    currentTx: { kind: 'permit2_position_manager', hash: `0x${'34'.repeat(32)}` },
    error: 'timeout'
  };
  applyActionPositionReconciliation(action, [], {
    checkedAt: '2026-08-01T07:00:00.000Z'
  });
  assert.equal(action.stage, 'failed');
  assert.equal(action.currentTx, null);
  assert.equal(action.positionReconciliation.found, false);
  assert.match(action.error, /未发现本次目标池 NFT 仓位.*解除新任务阻塞/);
  assert.equal(action.unconfirmedTransactions[0].status, 'not_confirmed_before_position_check');
});

test('only a submitted mint transaction requires NFT reconciliation', () => {
  assert.equal(actionMayHaveMintedPosition({
    currentTx: { kind: 'permit2_position_manager', hash: `0x${'12'.repeat(32)}` }
  }), false);
  assert.equal(actionMayHaveMintedPosition({
    currentTx: { kind: 'mint_liquidity', hash: `0x${'34'.repeat(32)}` }
  }), true);
  assert.equal(actionMayHaveMintedPosition({
    currentTx: null,
    liquidityTxHash: `0x${'56'.repeat(32)}`
  }), true);
});

test('failed liquidity execution records a detected target-pool NFT', () => {
  const action = {
    stage: 'needs_attention',
    poolId: `0x${'56'.repeat(32)}`,
    currentTx: { kind: 'mint_liquidity', hash: `0x${'78'.repeat(32)}` },
    error: 'timeout'
  };
  applyActionPositionReconciliation(action, [{ nftId: '1234', liquidity: '99' }], {
    checkedAt: '2026-08-01T07:00:00.000Z'
  });
  assert.equal(action.stage, 'completed');
  assert.equal(action.currentTx, null);
  assert.equal(action.nftId, '1234');
  assert.deepEqual(action.nftIds, ['1234']);
  assert.equal(action.positionReconciliation.found, true);
  assert.equal(action.error, null);
});

test('position reconciliation accepts only an owned active NFT from the target pool', async () => {
  const positionManager = '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b';
  const targetPoolKey = {
    currency0: TRADE,
    currency1: QUOTE,
    fee: 1489,
    tickSpacing: 10,
    hooks: ethers.ZeroAddress
  };
  const managerInterface = new ethers.Interface([
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
    'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256 info)'
  ]);
  const nftId = 1234n;
  const fakeProvider = {
    getBlockNumber: async () => 120,
    getLogs: async () => [{
      address: positionManager,
      topics: [
        ethers.id('Transfer(address,address,uint256)'),
        ethers.zeroPadValue(ethers.ZeroAddress, 32),
        ethers.zeroPadValue(OWNER, 32),
        ethers.toBeHex(nftId, 32)
      ],
      data: '0x'
    }],
    call: async (transaction) => {
      const selector = transaction.data.slice(0, 10);
      if (selector === managerInterface.getFunction('ownerOf').selector) {
        return managerInterface.encodeFunctionResult('ownerOf', [OWNER]);
      }
      if (selector === managerInterface.getFunction('getPositionLiquidity').selector) {
        return managerInterface.encodeFunctionResult('getPositionLiquidity', [99n]);
      }
      if (selector === managerInterface.getFunction('getPoolAndPositionInfo').selector) {
        return managerInterface.encodeFunctionResult(
          'getPoolAndPositionInfo',
          [targetPoolKey, 0n]
        );
      }
      throw new Error(`unexpected selector ${selector}`);
    }
  };
  const positions = await findActionTargetPoolPositions(fakeProvider, {
    positionManager
  }, {
    wallet: OWNER,
    poolId: poolIdOf(targetPoolKey),
    startedBlockNumber: 100,
    transactions: []
  });
  assert.deepEqual(positions, [{ nftId: '1234', liquidity: '99' }]);
});

test('execution requires a fresh preview for the exact normalized request and wallet', () => {
  const input = normalizeLiquidityInput({
    tradeToken: TRADE,
    quoteToken: QUOTE,
    price: '1',
    budget: '20',
    feePercent: '0.3',
    tickSpacing: '60',
    rangeType: 'percent',
    rangePercent: '90',
    hooks: ethers.ZeroAddress
  }, config);
  const fingerprint = liquidityExecutionFingerprint(input);
  const authorization = {
    id: 'preview-1',
    owner: OWNER,
    fingerprint,
    expiresAt: 10_000
  };
  assert.doesNotThrow(() => assertLiquidityPreviewAuthorization(authorization, {
    previewId: 'preview-1',
    fingerprint,
    owner: OWNER,
    now: 9_000
  }));
  assert.throws(() => assertLiquidityPreviewAuthorization(authorization, {
    previewId: 'preview-1',
    fingerprint: liquidityExecutionFingerprint({ ...input, budget: '21' }),
    owner: OWNER,
    now: 9_000
  }), /参数.*不一致/);
  assert.throws(() => assertLiquidityPreviewAuthorization(authorization, {
    previewId: 'preview-1',
    fingerprint,
    owner: OWNER,
    now: 10_001
  }), /过期/);
});

test('execution keeps previewed ticks fixed and stops when price leaves the locked range', () => {
  const input = {
    rangeType: 'percent',
    rangePercent: '50',
    tickSpacing: 60
  };
  const fixed = { tickLower: -600, tickUpper: 600 };
  assert.deepEqual(
    resolveLiquidityRangeTicks(input, 120, true, 18, 18, fixed),
    fixed
  );
  assert.throws(
    () => resolveLiquidityRangeTicks(input, 600, true, 18, 18, fixed),
    /离开预检时锁定/
  );
});

test('execution invariant requires the previewed pool, price, ticks and initialized state', () => {
  const poolId = `0x${'11'.repeat(32)}`;
  const authorization = {
    poolId,
    requestedSqrtPriceX96: Q96.toString(),
    tickLower: -600,
    tickUpper: 600
  };
  const plan = {
    pool: { poolId, initialized: true },
    requestedSqrtPriceX96: Q96,
    tickLower: -600,
    tickUpper: 600
  };
  assert.doesNotThrow(() => assertExecutionPlanInvariant(plan, authorization, true));
  assert.throws(
    () => assertExecutionPlanInvariant({
      ...plan,
      pool: { ...plan.pool, initialized: false }
    }, authorization, true),
    /未读取到目标池初始化状态/
  );
  assert.throws(
    () => assertExecutionPlanInvariant({ ...plan, tickUpper: 660 }, authorization, true),
    /流动性区间.*不一致/
  );
});

test('token approvals are reduced to the exact operation amount', () => {
  assert.deepEqual(exactAllowanceActions(10n, 10n), []);
  assert.deepEqual(exactAllowanceActions(0n, 10n), ['approve']);
  assert.deepEqual(exactAllowanceActions(20n, 10n), ['reset', 'approve']);
  assert.deepEqual(exactAllowanceActions(10n, 0n), ['reset']);
});

test('changing the stablecoin creates a different v4 PoolKey identity', () => {
  const baseKey = {
    currency0: TRADE,
    currency1: QUOTE,
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress
  };
  assert.equal(poolIdOf(baseKey), poolIdOf({ ...baseKey }));
  assert.notEqual(
    poolIdOf(baseKey),
    poolIdOf({
      ...baseKey,
      currency1: '0x4444444444444444444444444444444444444444'
    })
  );
});

test('percentage range aligns to tick spacing and contains current tick', () => {
  const range = liquidityRangeTicks({
    rangeType: 'percent',
    rangePercent: '50',
    tickSpacing: 60
  }, 0, true, 18, 18);
  assert.equal(Math.abs(range.tickLower % 60), 0);
  assert.equal(Math.abs(range.tickUpper % 60), 0);
  assert.ok(range.tickLower <= 0);
  assert.ok(range.tickUpper > 0);
});

test('liquidity input enforces quote whitelist and stable-input safety cap', () => {
  const normalized = normalizeLiquidityInput({
    tradeToken: TRADE,
    quoteToken: QUOTE,
    price: '1',
    budget: '20',
    feePercent: '0.3',
    tickSpacing: '60',
    rangeType: 'percent',
    rangePercent: '90',
    hooks: ethers.ZeroAddress
  }, config);
  assert.equal(normalized.fee, 3000);
  assert.equal(normalized.budget, '20');
  assert.equal(normalized.quoteSymbol, 'USDT');

  for (const [feePercent, expectedFee] of [['0.1489', 1489], ['0.1488', 1488]]) {
    const preciseFee = normalizeLiquidityInput({
      tradeToken: TRADE,
      quoteToken: QUOTE,
      price: '1',
      budget: '20',
      feePercent,
      tickSpacing: '1',
      rangeType: 'percent',
      rangePercent: '90',
      hooks: ethers.ZeroAddress
    }, config);
    assert.equal(preciseFee.fee, expectedFee);
    assert.equal(preciseFee.feePercent, Number(feePercent));
  }

  assert.throws(() => normalizeLiquidityInput({
    tradeToken: TRADE,
    quoteToken: QUOTE,
    price: '1',
    budget: '20',
    feePercent: '0.14891',
    tickSpacing: '1'
  }, config), /最多支持 4 位小数/);

  assert.throws(() => normalizeLiquidityInput({
    tradeToken: TRADE,
    quoteToken: QUOTE,
    price: '1',
    budget: '1000.01',
    feePercent: '0.3',
    tickSpacing: '60'
  }, config), /安全上限/);

  assert.throws(() => normalizeLiquidityInput({
    tradeToken: TRADE,
    quoteToken: OWNER,
    price: '1',
    budget: '10',
    feePercent: '0.3',
    tickSpacing: '60'
  }, config), /白名单/);
});

test('mint payload uses MINT_POSITION followed by SETTLE_PAIR', () => {
  const poolKey = {
    currency0: TRADE,
    currency1: QUOTE,
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress
  };
  const encoded = encodeMintLiquidity(poolKey, -600, 600, 123n, 456n, 789n, OWNER);
  const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(
    ['bytes', 'bytes[]'],
    encoded
  );
  assert.equal(actions, '0x020d');
  assert.equal(params.length, 2);

  const decodedMint = ethers.AbiCoder.defaultAbiCoder().decode([
    'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',
    'int24',
    'int24',
    'uint256',
    'uint128',
    'uint128',
    'address',
    'bytes'
  ], params[0]);
  assert.equal(decodedMint[1], -600n);
  assert.equal(decodedMint[2], 600n);
  assert.equal(decodedMint[3], 123n);
  assert.equal(decodedMint[4], 456n);
  assert.equal(decodedMint[5], 789n);
  assert.equal(decodedMint[6], OWNER);
});

test('pool initialization and liquidity mint are encoded as separate transactions', () => {
  const poolKey = {
    currency0: TRADE,
    currency1: QUOTE,
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress
  };
  const positionInterface = new ethers.Interface([
    'function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) payable returns (int24)',
    'function modifyLiquidities(bytes unlockData,uint256 deadline) payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)'
  ]);
  const initializeData = encodeInitializePool(poolKey, Q96);
  const decodedInitialize = positionInterface.decodeFunctionData('initializePool', initializeData);
  assert.equal(decodedInitialize[0].fee, 3000n);
  assert.equal(decodedInitialize[1], Q96);

  const mintData = encodeLiquidityTransaction({
    poolKey,
    tickLower: -600,
    tickUpper: 600,
    liquidity: 123n,
    amount0Max: 456n,
    amount1Max: 789n
  }, OWNER, 1234567890);
  const [calls] = positionInterface.decodeFunctionData('multicall', mintData);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slice(0, 10), positionInterface.getFunction('modifyLiquidities').selector);
  assert.notEqual(calls[0].slice(0, 10), positionInterface.getFunction('initializePool').selector);
});
