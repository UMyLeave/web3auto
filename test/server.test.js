import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import {
  blockStreamCanBeReused,
  cachedApprovalForAmount,
  closeWebSocketWithoutDestroy,
  compatibleMonitoredPair,
  completeActionMetrics,
  consumeSwapPreload,
  describeNetworkError,
  erc20ReceivedAmounts,
  encodeUnlimitedApproval,
  guardRawWebSocketErrors,
  minePositionIssue,
  normalizeTargetNftIds,
  poolFingerprint,
  positionTicks,
  prepareQuotedTransaction,
  prepareTransaction,
  preparedSwapMatches,
  principalAmounts,
  publishStreamBlock,
  RpcPool,
  sameTokenPair,
  singleSwapCandidate,
  sqrtPriceAtTick,
  targetLiquidityDecreases,
  transactionConfirmations,
  validateSwapResponse
} from '../server.js';

const TOKEN_IN = '0x1111111111111111111111111111111111111111';
const TOKEN_OUT = '0x55d398326f99059fF775485246999027B3197955';
const ALT_STABLE = '0xcE24439F2D9C6a2289F741120FE202248B666666';
const WALLET = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';

function validSwap() {
  return {
    routerResult: {
      fromTokenAmount: '1000000000000000000',
      toTokenAmount: '995000000000000000',
      fromToken: {
        tokenContractAddress: TOKEN_IN,
        decimal: '18',
        tokenUnitPrice: '1'
      },
      toToken: {
        tokenContractAddress: TOKEN_OUT,
        decimal: '18',
        tokenUnitPrice: '1'
      }
    },
    tx: {
      from: WALLET,
      to: ROUTER,
      data: '0x1234',
      value: '0'
    }
  };
}

test('accepts a consistent ERC-20 OKX swap response', () => {
  assert.doesNotThrow(() => validateSwapResponse(
    validSwap(),
    TOKEN_IN,
    TOKEN_OUT,
    1000000000000000000n,
    WALLET,
    { maxQuoteValueLossPercent: 5 }
  ));
});

test('rejects an OKX response that changes the output token', () => {
  const swap = validSwap();
  swap.routerResult.toToken.tokenContractAddress = TOKEN_IN;
  assert.throws(() => validateSwapResponse(
    swap,
    TOKEN_IN,
    TOKEN_OUT,
    1000000000000000000n,
    WALLET
  ), /目标币种不一致/);
});

test('rejects a quote whose value loss exceeds the configured limit', () => {
  const swap = validSwap();
  swap.routerResult.toTokenAmount = '800000000000000000';
  assert.throws(() => validateSwapResponse(
    swap,
    TOKEN_IN,
    TOKEN_OUT,
    1000000000000000000n,
    WALLET,
    { maxQuoteValueLossPercent: 5 }
  ), /价值损失/);
});

test('pool fingerprint includes both currencies and pool parameters', () => {
  const fingerprint = poolFingerprint({
    currency0: TOKEN_IN,
    currency1: TOKEN_OUT,
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000'
  });
  assert.match(fingerprint, /3000:60/);
  assert.match(fingerprint, new RegExp(TOKEN_IN.slice(2), 'i'));
  assert.match(fingerprint, new RegExp(TOKEN_OUT.slice(2), 'i'));
});

test('normalizes multiple target NFT IDs from common separators and removes duplicates', () => {
  assert.deepEqual(
    normalizeTargetNftIds('935235, 935236\n935237，935235'),
    ['935235', '935236', '935237']
  );
  assert.deepEqual(normalizeTargetNftIds(['1', '2 3']), ['1', '2', '3']);
  assert.throws(() => normalizeTargetNftIds('1, abc'), /必须是数字/);
});

test('detects any target liquidity decrease against the last consensus reference', () => {
  const decreases = targetLiquidityDecreases([
    { nftId: '10', liquidityText: '120' },
    { nftId: '11', liquidityText: '99' },
    { nftId: '12', liquidityText: '0' }
  ], {
    10: '100',
    11: '100',
    12: '50'
  });
  assert.deepEqual(decreases, [
    {
      targetNftId: '11',
      previousLiquidity: '100',
      currentLiquidity: '99',
      decreasedBy: '1'
    },
    {
      targetNftId: '12',
      previousLiquidity: '50',
      currentLiquidity: '0',
      decreasedBy: '50'
    }
  ]);
});

test('does not trigger when target liquidity is unchanged or increased', () => {
  assert.deepEqual(targetLiquidityDecreases([
    { nftId: '10', liquidityText: '100' },
    { nftId: '11', liquidityText: '101' }
  ], {
    10: '100',
    11: '100'
  }), []);
});

test('accepts the same token pair across different fee pools', () => {
  const targetPool = {
    currency0: TOKEN_IN,
    currency1: TOKEN_OUT,
    fee: 5000,
    tickSpacing: 100,
    hooks: '0x0000000000000000000000000000000000000000'
  };
  const minePool = {
    currency0: TOKEN_OUT,
    currency1: TOKEN_IN,
    fee: 4000,
    tickSpacing: 80,
    hooks: '0x4444444444444444444444444444444444444444'
  };
  assert.equal(sameTokenPair(targetPool, minePool), true);
});

test('rejects positions with different token pairs even when pool parameters match', () => {
  const firstPool = {
    currency0: TOKEN_IN,
    currency1: TOKEN_OUT,
    fee: 5000,
    tickSpacing: 100,
    hooks: '0x0000000000000000000000000000000000000000'
  };
  const secondPool = {
    ...firstPool,
    currency1: '0x4444444444444444444444444444444444444444'
  };
  assert.equal(sameTokenPair(firstPool, secondPool), false);
});

test('allows different whitelisted stablecoins when the monitored asset is identical', () => {
  const config = {
    stablecoin: { symbol: 'USDT', address: TOKEN_OUT },
    stablecoins: [
      { symbol: 'USDT', address: TOKEN_OUT },
      { symbol: 'U', address: ALT_STABLE }
    ]
  };
  const targetPool = {
    currency0: TOKEN_OUT,
    currency1: TOKEN_IN
  };
  const minePool = {
    currency0: ALT_STABLE,
    currency1: TOKEN_IN
  };
  assert.equal(sameTokenPair(targetPool, minePool), false);
  assert.equal(compatibleMonitoredPair(targetPool, minePool, config), true);
});

test('rejects different monitored assets even when both pools use whitelisted stablecoins', () => {
  const config = {
    stablecoins: [
      { symbol: 'USDT', address: TOKEN_OUT },
      { symbol: 'U', address: ALT_STABLE }
    ]
  };
  const targetPool = {
    currency0: TOKEN_OUT,
    currency1: TOKEN_IN
  };
  const minePool = {
    currency0: ALT_STABLE,
    currency1: ROUTER
  };
  assert.equal(compatibleMonitoredPair(targetPool, minePool, config), false);
});

test('detects an externally emptied or transferred armed position', () => {
  const baseline = { pool: 'pool-a' };
  const healthy = {
    mine: {
      pool: 'pool-a',
      owner: WALLET,
      liquidity: 100n
    }
  };
  assert.equal(minePositionIssue(healthy, baseline, WALLET), null);
  assert.equal(
    minePositionIssue({ mine: { ...healthy.mine, liquidity: 0n } }, baseline, WALLET).code,
    'liquidity_zero'
  );
  assert.equal(
    minePositionIssue({
      mine: {
        ...healthy.mine,
        owner: '0x4444444444444444444444444444444444444444'
      }
    }, baseline, WALLET).code,
    'owner_changed'
  );
  assert.equal(
    minePositionIssue({ mine: { ...healthy.mine, pool: 'pool-b' } }, baseline, WALLET).code,
    'pool_changed'
  );
});

test('decodes signed v4 position ticks', () => {
  const lower = -120;
  const upper = 240;
  const encode24 = (value) => BigInt(value < 0 ? value + 0x1000000 : value);
  const info = (encode24(lower) << 8n) | (encode24(upper) << 32n);
  assert.deepEqual(positionTicks(info), { tickLower: lower, tickUpper: upper });
});

test('calculates the correct token side outside a position range', () => {
  const liquidity = 1_000_000_000_000_000_000n;
  const lower = -100;
  const upper = 100;
  const below = principalAmounts(liquidity, sqrtPriceAtTick(-200), lower, upper);
  const above = principalAmounts(liquidity, sqrtPriceAtTick(200), lower, upper);
  assert.ok(below.amount0 > 0n);
  assert.equal(below.amount1, 0n);
  assert.equal(above.amount0, 0n);
  assert.ok(above.amount1 > 0n);
});

test('surfaces the underlying OKX connection failure code', () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  });
  assert.match(describeNetworkError(error), /连接超时/);
  assert.match(describeNetworkError(error), /UND_ERR_CONNECT_TIMEOUT/);
});

test('excludes confirmation and post-trade verification from critical timings', () => {
  const action = {
    detectedAt: '2026-07-24T00:00:00.000Z',
    withdrawIncludedAt: '2026-07-24T00:00:01.000Z',
    withdrawConfirmedAt: '2026-07-24T00:00:01.500Z',
    withdrawConfirmationWaitMs: 500,
    completedAt: '2026-07-24T00:00:05.000Z',
    poolStablecoin: TOKEN_OUT,
    results: [
      {
        tokenIn: TOKEN_IN,
        status: 'confirmed',
        durationMs: 2000,
        confirmationWaitMs: 600,
        verificationDurationMs: 100,
        actualReceived: '995000000000000000'
      }
    ]
  };

  completeActionMetrics(action);

  assert.equal(action.timingVersion, 4);
  assert.equal(action.withdrawDurationMs, 1000);
  assert.equal(action.swapDurationMs, 2000);
  assert.equal(action.confirmationWaitMs, 1100);
  assert.equal(action.verificationDurationMs, 100);
  assert.equal(action.nonCriticalDurationMs, 1200);
  assert.equal(action.processDurationMs, 5000);
  assert.equal(action.totalDurationMs, 3800);
});

test('preloads only when exactly one non-stable token needs a swap', () => {
  const stableBefore = {
    [TOKEN_IN]: 0n,
    [TOKEN_OUT]: 10n
  };
  const stableAfter = {
    [TOKEN_IN]: 100n,
    [TOKEN_OUT]: 60n
  };
  assert.deepEqual(
    singleSwapCandidate([TOKEN_IN, TOKEN_OUT], stableAfter, stableBefore, TOKEN_OUT),
    { token: TOKEN_IN, amount: 100n }
  );

  const fallbackStable = '0x4444444444444444444444444444444444444444';
  assert.equal(
    singleSwapCandidate([TOKEN_IN, TOKEN_OUT], stableAfter, stableBefore, fallbackStable),
    null
  );
});

test('derives exact withdrawn ERC-20 amounts from receipt transfer logs', () => {
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const recipientTopic = ethers.zeroPadValue(WALLET, 32);
  const senderTopic = ethers.zeroPadValue(ROUTER, 32);
  const received = erc20ReceivedAmounts({
    logs: [
      {
        address: TOKEN_IN,
        topics: [transferTopic, senderTopic, recipientTopic],
        data: ethers.zeroPadValue(ethers.toBeHex(123n), 32)
      },
      {
        address: TOKEN_IN,
        topics: [transferTopic, senderTopic, recipientTopic],
        data: ethers.zeroPadValue(ethers.toBeHex(7n), 32)
      },
      {
        address: TOKEN_OUT,
        topics: [transferTopic, senderTopic, recipientTopic],
        data: ethers.zeroPadValue(ethers.toBeHex(50n), 32)
      }
    ]
  }, [TOKEN_IN, TOKEN_OUT], WALLET);

  assert.deepEqual(received, {
    [ethers.getAddress(TOKEN_IN)]: 130n,
    [ethers.getAddress(TOKEN_OUT)]: 50n
  });
});

test('falls back to balance deltas when withdrawal logs cannot prove received amounts', () => {
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const recipientTopic = ethers.zeroPadValue(WALLET, 32);
  const senderTopic = ethers.zeroPadValue(ROUTER, 32);
  assert.equal(erc20ReceivedAmounts({ logs: [] }, [TOKEN_IN, TOKEN_OUT], WALLET), null);
  assert.equal(erc20ReceivedAmounts(
    { logs: [{ address: TOKEN_IN, topics: [], data: '0x' }] },
    [TOKEN_IN, TOKEN_OUT],
    WALLET
  ), null);
  assert.equal(erc20ReceivedAmounts({
    logs: [{
      address: TOKEN_IN,
      topics: [transferTopic, senderTopic, recipientTopic],
      data: ethers.zeroPadValue(ethers.toBeHex(123n), 32)
    }]
  }, [TOKEN_IN, TOKEN_OUT], WALLET), null);
});

test('reuses a prepared swap only for the exact fresh token, amount and stablecoin', () => {
  const now = Date.parse('2026-07-25T00:00:02.000Z');
  const preloaded = {
    status: 'ready',
    tokenIn: TOKEN_IN,
    amountIn: '100',
    toToken: TOKEN_OUT,
    quoteReceivedAt: '2026-07-25T00:00:00.000Z',
    preparedTransaction: { nonce: 7 }
  };

  assert.equal(preparedSwapMatches(preloaded, TOKEN_IN, 100n, TOKEN_OUT, 5000, now), true);
  assert.equal(preparedSwapMatches(preloaded, TOKEN_IN, 101n, TOKEN_OUT, 5000, now), false);
  assert.equal(preparedSwapMatches(preloaded, TOKEN_IN, 100n, TOKEN_OUT, 1000, now), false);
});

test('directly reuses an exact fresh prepared swap without another RPC round trip', async () => {
  const handle = {
    settled: true,
    value: {
      status: 'ready',
      tokenIn: '0x0000000000000000000000000000000000000000',
      amountIn: '100',
      toToken: '0x0000000000000000000000000000000000000000',
      quoteReceivedAt: new Date().toISOString(),
      stableBalanceBefore: '1',
      preparedTransaction: { nonce: 7 }
    }
  };
  const runtime = {
    config: { swapPreloadMaxAgeMs: 5000 },
    wallet: { address: WALLET },
    pool: {
      call: async () => { throw new Error('prepared swap should not perform another RPC check'); }
    }
  };

  const reusable = await consumeSwapPreload(
    handle,
    runtime,
    '0x0000000000000000000000000000000000000000',
    100n,
    '0x0000000000000000000000000000000000000000'
  );
  assert.equal(reusable.stableBalanceBefore, '1');
});

test('uses a cached approval only when its allowance covers the exact amount', () => {
  const baseline = {
    swapApprovals: {
      [TOKEN_IN.toLowerCase()]: {
        spender: ROUTER,
        allowance: '1000',
        cachedAt: '2026-07-25T00:00:00.000Z'
      }
    }
  };
  assert.equal(cachedApprovalForAmount(baseline, TOKEN_IN, 1000n).spender, ROUTER);
  assert.equal(cachedApprovalForAmount(baseline, TOKEN_IN, 1001n), null);
});

test('encodes an unlimited approval for the exact OKX spender', () => {
  const data = encodeUnlimitedApproval(ROUTER);
  assert.equal(data.slice(0, 10), '0x095ea7b3');
  assert.match(data, new RegExp(ROUTER.slice(2).toLowerCase()));
  assert.ok(data.endsWith('f'.repeat(64)));
});

test('uses separate confirmation policies for withdrawal, swap and approval', () => {
  const config = {
    withdrawConfirmations: 1,
    swapConfirmations: 2,
    approvalConfirmations: 1
  };
  assert.equal(transactionConfirmations(config, 'withdraw'), 1);
  assert.equal(transactionConfirmations(config, 'swap'), 2);
  assert.equal(transactionConfirmations(config, 'approval'), 1);
});

test('transaction preparation relies on estimateGas without a duplicate eth_call', async () => {
  let estimateCalls = 0;
  const runtime = {
    config: { maxGasPriceGwei: 5, maxGasLimit: 3_000_000 },
    wallet: {
      address: WALLET,
      signTransaction: async () => '0x1234'
    },
    pool: {
      call: (fn) => fn({
        call: async () => { throw new Error('duplicate eth_call should not run'); },
        getTransactionCount: async () => 7,
        estimateGas: async () => {
          estimateCalls += 1;
          return 100_000n;
        },
        getFeeData: async () => ({ gasPrice: 50_000_000n })
      })
    }
  };
  const prepared = await prepareTransaction(runtime, {
    to: ROUTER,
    data: '0x1234',
    value: 0n
  });
  assert.equal(estimateCalls, 1);
  assert.equal(prepared.nonce, 7);
  assert.equal(prepared.gasLimit, 120_000n);
  assert.equal(prepared.gasPrice, 100_000_000n);
});

test('signs a quorum-prepared withdrawal without a second RPC preparation pass', async () => {
  const wallet = ethers.Wallet.createRandom();
  let poolCalls = 0;
  const prepared = await prepareTransaction({
    wallet,
    config: {
      minGasPriceGwei: 0.1,
      maxGasPriceGwei: 5,
      maxGasLimit: 3_000_000
    },
    pool: {
      call: async () => {
        poolCalls += 1;
        throw new Error('preflight fields should be reused');
      }
    }
  }, {
    to: ROUTER,
    data: '0x1234',
    value: 0n
  }, {
    nonce: 12,
    estimatedGas: 200_000n,
    gasPrice: ethers.parseUnits('0.1', 'gwei')
  });

  assert.equal(poolCalls, 0);
  assert.equal(prepared.nonce, 12);
  assert.equal(prepared.gasLimit, 240_000n);
  assert.equal(ethers.Transaction.from(prepared.signed).nonce, 12);
});

test('prepares an OKX quoted transaction without another RPC estimation round trip', async () => {
  const wallet = ethers.Wallet.createRandom();
  let poolCalls = 0;
  const prepared = await prepareQuotedTransaction({
    wallet,
    config: {
      minGasPriceGwei: 0.1,
      maxGasPriceGwei: 5,
      maxGasLimit: 3_000_000
    },
    pool: {
      call: async () => {
        poolCalls += 1;
        throw new Error('nonce RPC should be skipped when a concurrent hint is supplied');
      }
    }
  }, {
    to: ROUTER,
    data: '0x1234',
    value: 0n,
    gas: 200_000n,
    gasPrice: ethers.parseUnits('0.12', 'gwei')
  }, 9);

  assert.equal(poolCalls, 0);
  assert.equal(prepared.nonce, 9);
  assert.equal(prepared.gasLimit, 300_000n);
  assert.equal(prepared.gasPrice, ethers.parseUnits('0.12', 'gwei'));
  assert.equal(prepared.preparationSource, 'okx_quote');
  assert.equal(ethers.Transaction.from(prepared.signed).nonce, 9);
});

test('honors a safe OKX fast gas suggestion above the configured floor', async () => {
  const runtime = {
    config: { minGasPriceGwei: 0.1, maxGasPriceGwei: 5, maxGasLimit: 3_000_000 },
    wallet: {
      address: WALLET,
      signTransaction: async () => '0x1234'
    },
    pool: {
      call: (fn) => fn({
        getTransactionCount: async () => 7,
        estimateGas: async () => 100_000n,
        getFeeData: async () => ({ gasPrice: 50_000_000n })
      })
    }
  };
  const prepared = await prepareTransaction(runtime, {
    to: ROUTER,
    data: '0x1234',
    value: 0n,
    gasPrice: 200_000_000n
  });
  assert.equal(prepared.gasPrice, 200_000_000n);
});

test('uses the WSS-observed block time as transaction inclusion time', async () => {
  publishStreamBlock(100);
  const observedAt = new Date().toISOString();
  publishStreamBlock(101);
  const pool = Object.create(RpcPool.prototype);
  pool.firstReceipt = async () => ({ status: 1, blockNumber: 100, hash: '0xabc' });
  pool.call = async () => {
    throw new Error('WSS head already has enough confirmations');
  };

  const result = await pool.waitForReceipt('0xabc', 2, 1000, 10);
  assert.ok(Date.parse(result.includedAt) <= Date.parse(observedAt));
  assert.ok(result.receiptDetectionLagMs >= 0);
  assert.ok(result.confirmationWaitMs >= result.receiptDetectionLagMs);
});

test('reuses an open WSS connection only for the same URL', () => {
  const provider = {
    destroyed: false,
    websocket: { readyState: 1 }
  };
  assert.equal(blockStreamCanBeReused(provider, 'wss://node-a', 'wss://node-a'), true);
  assert.equal(blockStreamCanBeReused(provider, 'wss://node-a', 'wss://node-b'), false);
  provider.websocket.readyState = 3;
  assert.equal(blockStreamCanBeReused(provider, 'wss://node-a', 'wss://node-a'), false);
});

test('closes the raw WSS socket without unsubscribing or destroying ethers provider', () => {
  let closed = 0;
  let destroyed = 0;
  let unsubscribed = 0;
  const provider = {
    websocket: {
      close: () => { closed += 1; }
    },
    destroy: () => { destroyed += 1; },
    off: () => { unsubscribed += 1; }
  };
  closeWebSocketWithoutDestroy(provider);
  assert.equal(closed, 1);
  assert.equal(destroyed, 0);
  assert.equal(unsubscribed, 0);
});

test('guards raw WebSocket errors before ethers provider listeners are ready', () => {
  const socket = new EventEmitter();
  const provider = { websocket: socket };
  guardRawWebSocketErrors(provider);
  assert.doesNotThrow(() => socket.emit('error', new Error('TLS reset')));
});
