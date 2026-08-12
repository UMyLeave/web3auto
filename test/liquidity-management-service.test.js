import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  encodeDecreasePosition,
  encodeIncreasePosition,
  managementActionBlocksExecution,
  managementActionRecord,
  managementExecutionFingerprint,
  managementFeeGrowthInside,
  managementOperationUsesAutoSwap,
  managementPriceRange,
  managementPositionTicks,
  managementPrincipalAmounts,
  minimumRemovalAmounts,
  normalizeManagementInput,
  removalLiquidityForOperation,
  updateManagementActionHistory,
  managementUncollectedFees
} from '../liquidity-management-service.js';
import { validateManagementSwapResponse } from '../liquidity-management-swap-service.js';
import {
  nextLiquidityThemeBoundary,
  scheduledLiquidityTheme
} from '../public/liquidity-theme.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN0 = '0x1111111111111111111111111111111111111111';
const TOKEN1 = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const Q96 = 1n << 96n;
const config = { maxStableBudget: 1000 };
const poolKey = {
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 3000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress
};

function uint24(value) {
  return BigInt(value) & 0xffffffn;
}

test('management position decoding retains signed lower and upper ticks', () => {
  const info = (uint24(-600) << 8n) | (uint24(1200) << 32n);
  assert.deepEqual(managementPositionTicks(info), {
    tickLower: -600,
    tickUpper: 1200
  });
});

test('management principal calculation follows the active position range', () => {
  const inRange = managementPrincipalAmounts(1_000_000n, Q96, -600, 600);
  assert.ok(inRange.amount0 > 0n);
  assert.ok(inRange.amount1 > 0n);

  const belowRange = managementPrincipalAmounts(1_000_000n, Q96, 600, 1200);
  assert.ok(belowRange.amount0 > 0n);
  assert.equal(belowRange.amount1, 0n);

  const aboveRange = managementPrincipalAmounts(1_000_000n, Q96, -1200, -600);
  assert.equal(aboveRange.amount0, 0n);
  assert.ok(aboveRange.amount1 > 0n);
});

test('management price range derives ordered prices and grid position in both token directions', () => {
  const direct = managementPriceRange({
    tickLower: -600,
    tickUpper: 600,
    currentTick: 0,
    tickSpacing: 60,
    tradeDecimals: 18,
    stableDecimals: 18,
    tradeIsCurrency0: true,
    activePrice: '1'
  });
  assert.equal(direct.gridCount, 20);
  assert.equal(direct.currentGrid, 10);
  assert.equal(direct.positionPercent, 50);
  assert.ok(Number(direct.lowerPrice) < 1);
  assert.ok(Number(direct.upperPrice) > 1);

  const inverse = managementPriceRange({
    tickLower: -600,
    tickUpper: 600,
    currentTick: -300,
    tickSpacing: 60,
    tradeDecimals: 18,
    stableDecimals: 18,
    tradeIsCurrency0: false,
    activePrice: '1.0304529883759128'
  });
  assert.equal(inverse.gridCount, 20);
  assert.equal(inverse.currentGrid, 15);
  assert.equal(inverse.positionPercent, 75);
  assert.ok(Number(inverse.lowerPrice) < Number(inverse.upperPrice));
});

test('management fee growth calculates in-range and outside-range accrued fees', () => {
  const inside = managementFeeGrowthInside({
    currentTick: 0,
    tickLower: -60,
    tickUpper: 60,
    feeGrowthGlobal0X128: 1000n,
    feeGrowthGlobal1X128: 2000n,
    lowerFeeGrowthOutside0X128: 100n,
    lowerFeeGrowthOutside1X128: 200n,
    upperFeeGrowthOutside0X128: 300n,
    upperFeeGrowthOutside1X128: 400n
  });
  assert.deepEqual(inside, {
    feeGrowthInside0X128: 600n,
    feeGrowthInside1X128: 1400n
  });
  assert.deepEqual(managementFeeGrowthInside({
    currentTick: 100,
    tickLower: -60,
    tickUpper: 60,
    feeGrowthGlobal0X128: 1000n,
    feeGrowthGlobal1X128: 2000n,
    lowerFeeGrowthOutside0X128: 100n,
    lowerFeeGrowthOutside1X128: 200n,
    upperFeeGrowthOutside0X128: 300n,
    upperFeeGrowthOutside1X128: 400n
  }), {
    feeGrowthInside0X128: 200n,
    feeGrowthInside1X128: 200n
  });
});

test('management uncollected fees converts Q128 fee growth into token amounts', () => {
  const q128 = 1n << 128n;
  assert.deepEqual(managementUncollectedFees({
    liquidity: 25n,
    feeGrowthInside0X128: 3n * q128,
    feeGrowthInside1X128: 5n * q128,
    feeGrowthInside0LastX128: q128,
    feeGrowthInside1LastX128: 2n * q128
  }), {
    amount0: 50n,
    amount1: 75n
  });
});

test('withdraw and emergency are fixed at 100 percent while reduce stays within 1-99 percent', () => {
  assert.equal(removalLiquidityForOperation(10_000n, 'withdraw'), 10_000n);
  assert.equal(removalLiquidityForOperation(10_000n, 'emergency'), 10_000n);
  assert.equal(removalLiquidityForOperation(10_000n, 'reduce', 2500), 2500n);
  assert.throws(() => removalLiquidityForOperation(10_000n, 'reduce', 99), /1% 到 99%/);
  assert.throws(() => removalLiquidityForOperation(10_000n, 'reduce', 10_000), /1% 到 99%/);
});

test('only increase and emergency use automatic swaps', () => {
  assert.equal(managementOperationUsesAutoSwap('increase'), true);
  assert.equal(managementOperationUsesAutoSwap('emergency'), true);
  assert.equal(managementOperationUsesAutoSwap('reduce'), false);
  assert.equal(managementOperationUsesAutoSwap('withdraw'), false);
});

test('every non-terminal management action blocks other execution flows', () => {
  assert.equal(managementActionBlocksExecution(null), false);
  assert.equal(managementActionBlocksExecution({ stage: 'completed' }), false);
  assert.equal(managementActionBlocksExecution({ stage: 'failed' }), false);
  assert.equal(managementActionBlocksExecution({ stage: 'failed', cleanupContext: {} }), true);
  assert.equal(managementActionBlocksExecution({ stage: 'needs_attention' }), true);
  assert.equal(managementActionBlocksExecution({ stage: 'zap_out_swap_retry' }), true);
  assert.equal(managementActionBlocksExecution({ stage: 'cleaning_swap_approval' }), true);
});

test('management action history keeps only the compact latest result for each operation', () => {
  const completed = {
    id: 'action-1',
    operation: 'emergency',
    nftId: '42',
    stage: 'completed',
    startedAt: '2026-08-09T16:36:58.736Z',
    completedAt: '2026-08-09T16:37:22.560Z',
    finalLiquidity: '0',
    transactions: [{ hash: '0x1234' }]
  };
  assert.deepEqual(managementActionRecord(completed), {
    id: 'action-1',
    operation: 'emergency',
    nftId: '42',
    stage: 'completed',
    startedAt: '2026-08-09T16:36:58.736Z',
    completedAt: '2026-08-09T16:37:22.560Z',
    failedAt: null,
    finalLiquidity: '0',
    error: null
  });
  const updated = updateManagementActionHistory([
    { id: 'action-1', stage: 'needs_attention' },
    { id: 'action-0', operation: 'increase' }
  ], completed);
  assert.equal(updated.length, 2);
  assert.deepEqual(updated[0], managementActionRecord(completed));
  assert.equal(updated[1].id, 'action-0');
});

test('withdraw minimums apply the configured liquidity slippage to both currencies', () => {
  assert.deepEqual(minimumRemovalAmounts(10_000n, 20_000n, 100), {
    amount0Min: 9_900n,
    amount1Min: 19_800n
  });
  assert.throws(() => minimumRemovalAmounts(1n, 1n, 5001), /滑点配置无效/);
});

test('increase payload uses INCREASE_LIQUIDITY plus SETTLE_PAIR', () => {
  const encoded = encodeIncreasePosition(123n, 456n, 789n, 999n, poolKey);
  const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes', 'bytes[]'], encoded);
  assert.equal(actions, '0x000d');
  assert.equal(params.length, 2);
  const increase = ethers.AbiCoder.defaultAbiCoder().decode(
    ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
    params[0]
  );
  assert.equal(increase[0], 123n);
  assert.equal(increase[1], 456n);
  assert.equal(increase[2], 789n);
  assert.equal(increase[3], 999n);
  const pair = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address'], params[1]);
  assert.equal(pair[0], TOKEN0);
  assert.equal(pair[1], TOKEN1);
});

test('withdraw payload uses DECREASE_LIQUIDITY plus TAKE_PAIR and keeps the NFT', () => {
  const encoded = encodeDecreasePosition(123n, 456n, 400n, 500n, poolKey, OWNER);
  const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes', 'bytes[]'], encoded);
  assert.equal(actions, '0x0111');
  assert.equal(params.length, 2);
  const decrease = ethers.AbiCoder.defaultAbiCoder().decode(
    ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
    params[0]
  );
  assert.equal(decrease[0], 123n);
  assert.equal(decrease[1], 456n);
  assert.equal(decrease[2], 400n);
  assert.equal(decrease[3], 500n);
  const takePair = ethers.AbiCoder.defaultAbiCoder().decode(
    ['address', 'address', 'address'],
    params[1]
  );
  assert.equal(takePair[2], OWNER);
});

test('management input has operation-specific fields and exact confirmation fingerprints', () => {
  const increase = normalizeManagementInput({ operation: 'increase', nftId: '42', budget: '20.50' }, config);
  assert.deepEqual(increase, { operation: 'increase', nftId: '42', budget: '20.50', percentBps: null });

  const reduce = normalizeManagementInput({ operation: 'reduce', nftId: '42', percent: '25' }, config);
  assert.deepEqual(reduce, { operation: 'reduce', nftId: '42', budget: null, percentBps: 2500 });
  assert.notEqual(managementExecutionFingerprint(increase), managementExecutionFingerprint(reduce));
  assert.throws(
    () => normalizeManagementInput({ operation: 'increase', nftId: '42', budget: '1001' }, config),
    /安全上限/
  );
  assert.throws(
    () => normalizeManagementInput({ operation: 'withdraw', nftId: 'abc' }, config),
    /NFT ID 必须是数字/
  );
});

function swapResponse(from, to, amountIn = '1000', amountOut = '950') {
  return {
    routerResult: {
      fromToken: {
        tokenContractAddress: from,
        decimal: '18',
        tokenUnitPrice: '1',
        taxRate: '0'
      },
      toToken: {
        tokenContractAddress: to,
        decimal: '18',
        tokenUnitPrice: '1',
        taxRate: '0',
        isHoneyPot: false
      },
      fromTokenAmount: amountIn,
      toTokenAmount: amountOut
    }
  };
}

test('management swap validation supports exact input in both zap directions', () => {
  const zapIn = validateManagementSwapResponse(
    swapResponse(TOKEN0, TOKEN1),
    TOKEN0,
    TOKEN1,
    1000n,
    OWNER,
    { maxSwapValueLossPercent: 6 }
  );
  assert.equal(zapIn.amountOut, 950n);

  const zapOut = validateManagementSwapResponse(
    swapResponse(TOKEN1, TOKEN0),
    TOKEN1,
    TOKEN0,
    1000n,
    OWNER,
    { maxSwapValueLossPercent: 6 }
  );
  assert.equal(zapOut.amountOut, 950n);
  assert.throws(
    () => validateManagementSwapResponse(
      swapResponse(TOKEN0, TOKEN1),
      TOKEN1,
      TOKEN0,
      1000n,
      OWNER,
      { maxSwapValueLossPercent: 6 }
    ),
    /输入代币不一致/
  );
});

test('management UI is isolated in its own tab, script and stylesheet', async () => {
  const [html, managementScript, managementStyles, legacyScript, themeScript, themeStyles, serverSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'public/liquidity.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/liquidity-management.js'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/liquidity-management.css'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/liquidity.js'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/liquidity-theme.js'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/liquidity-theme.css'), 'utf8'),
    fs.readFile(path.join(ROOT, 'server.js'), 'utf8')
  ]);
  assert.match(html, /data-liquidity-tab="create"/);
  assert.match(html, /data-liquidity-tab="manage"/);
  assert.match(html, /src="\/liquidity\.js"/);
  assert.match(html, /src="\/liquidity-management\.js"/);
  assert.match(html, /href="\/liquidity-management\.css"/);
  assert.match(html, /src="\/liquidity-theme\.js"/);
  assert.match(html, /href="\/liquidity-theme\.css"/);
  assert.match(html, /id="liquidityThemeToggle"/);
  assert.match(managementScript, /\/api\/liquidity-management/);
  assert.match(managementScript, /return \['increase', 'emergency'\]/);
  assert.match(managementScript, /\/retry-cleanup/);
  assert.match(managementScript, /data-lm-open-operation="increase"/);
  assert.match(managementScript, /data-lm-open-operation="reduce"/);
  assert.match(managementScript, /data-lm-open-operation="withdraw"/);
  assert.match(managementScript, /data-lm-open-operation="emergency"/);
  assert.match(managementScript, /data-lm-open-records/);
  assert.match(managementScript, /操作行为/);
  assert.match(managementScript, /操作结果/);
  assert.match(managementScript, /操作时间/);
  assert.match(managementScript, /isEmergencyRetired/);
  assert.match(managementScript, /confirmAction/);
  assert.doesNotMatch(managementScript, /window\.confirm/);
  assert.doesNotMatch(managementScript, /执行状态/);
  assert.match(managementScript, /策略仓位/);
  assert.match(managementScript, /价格区间/);
  assert.match(managementScript, /range\.currentGrid/);
  assert.match(managementScript, /position\.priceRange \|\| fallbackPriceRange\(position\)/);
  assert.match(managementScript, /范围 Tick/);
  assert.doesNotMatch(managementScript, /lm-operation-tabs/);
  assert.doesNotMatch(managementScript, /减仓仅兑换/);
  assert.match(managementStyles, /\.lm-strategy-position/);
  assert.match(managementStyles, /\.lm-position-actions/);
  assert.match(managementStyles, /\.lm-price-track/);
  assert.match(managementStyles, /\.lm-range-status/);
  assert.match(managementStyles, /\.lm-modal-card/);
  assert.match(managementStyles, /\.lm-record-item/);
  assert.match(managementStyles, /button\[data-tooltip\]::after/);
  assert.match(managementStyles, /width: min\(820px, 100%\)/);
  assert.doesNotMatch(managementStyles, /\.lm-operation-tab/);
  assert.match(themeScript, /scheduledLiquidityTheme/);
  assert.match(themeStyles, /data-theme="light"/);
  assert.doesNotMatch(legacyScript, /liquidity-management/);
  assert.doesNotMatch(legacyScript, /liquidityThemeToggle/);
  assert.match(serverSource, /liquidityManagementRouter\.hasBlockingAction\(\)/);
});

test('management retry acquires its lock before the first asynchronous setup step', async () => {
  const source = await fs.readFile(path.join(ROOT, 'liquidity-management-service.js'), 'utf8');
  const routeStart = source.indexOf("router.post('/retry-swap'");
  const routeEnd = source.indexOf("router.post('/retry-cleanup'", routeStart);
  const retryRoute = source.slice(routeStart, routeEnd);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.ok(retryRoute.indexOf('inFlight = true') < retryRoute.indexOf('await readJson(configPath)'));
  assert.match(retryRoute, /if \(lockAcquired\) inFlight = false/);
  assert.match(retryRoute, /lastAction\.stage = 'needs_attention'/);
});

test('liquidity theme follows 06:00-18:00 and schedules the next boundary', () => {
  const localTime = (hour, minute = 0) => new Date(2026, 7, 9, hour, minute, 0, 0);
  assert.equal(scheduledLiquidityTheme(localTime(5, 59)), 'dark');
  assert.equal(scheduledLiquidityTheme(localTime(6)), 'light');
  assert.equal(scheduledLiquidityTheme(localTime(17, 59)), 'light');
  assert.equal(scheduledLiquidityTheme(localTime(18)), 'dark');
  assert.equal(nextLiquidityThemeBoundary(localTime(5, 30)).getTime(), localTime(6).getTime());
  assert.equal(nextLiquidityThemeBoundary(localTime(9)).getTime(), localTime(18).getTime());
  assert.equal(
    nextLiquidityThemeBoundary(localTime(20)).getTime(),
    new Date(2026, 7, 10, 6, 0, 0, 0).getTime()
  );
});
