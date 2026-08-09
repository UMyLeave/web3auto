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
  managementExecutionFingerprint,
  managementOperationUsesAutoSwap,
  managementPositionTicks,
  managementPrincipalAmounts,
  minimumRemovalAmounts,
  normalizeManagementInput,
  removalLiquidityForOperation
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
  const [html, managementScript, legacyScript, themeScript, themeStyles, serverSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'public/liquidity.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/liquidity-management.js'), 'utf8'),
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
  assert.doesNotMatch(managementScript, /减仓仅兑换/);
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
