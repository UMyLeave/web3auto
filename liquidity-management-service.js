import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import { ethers } from 'ethers';
import {
  decimalFraction,
  liquidityForAmounts,
  optimizedStableSwapAmount,
  poolIdOf,
  reusableAllowanceActions,
  reusablePermit2ApprovalRequired,
  sqrtPriceAtTick,
  stableBudgetAllocation
} from './liquidity-service.js';
import { okxCredentialsConfigured } from './liquidity-swap-service.js';
import {
  managementSwapApprovalSpender,
  prepareManagementSwap,
  quoteManagementSwap
} from './liquidity-management-swap-service.js';
import { verifyConfiguredWhitelistHook } from './liquidity-hook-service.js';

const CHAIN_ID = 56n;
const ZERO = ethers.ZeroAddress;
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const UINT24_MASK = 0xffffffn;
const UINT160_MASK = (1n << 160n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const TERMINAL_STAGES = new Set(['completed', 'failed', 'cancelled']);
const OPERATIONS = new Set(['increase', 'withdraw', 'reduce', 'emergency']);

const POSITION_ABI = [
  'function poolManager() view returns (address)',
  'function permit2() view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256 info)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable'
];
const ERC20_ABI = [
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];
const POOL_MANAGER_ABI = ['function extsload(bytes32 slot) view returns (bytes32)'];
const PERMIT2_ABI = [
  'function allowance(address user,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)'
];
const POSITION_INTERFACE = new ethers.Interface(POSITION_ABI);
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const PERMIT2_INTERFACE = new ethers.Interface(PERMIT2_ABI);

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, path);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function openProvider(config) {
  const timeoutMs = Math.max(1000, Number(config.rpcTimeoutMs) || 5000);
  const errors = [];
  for (const url of config.rpcUrls || []) {
    const provider = new ethers.JsonRpcProvider(url, Number(CHAIN_ID), {
      batchMaxCount: 1,
      staticNetwork: true
    });
    try {
      const network = await withTimeout(provider.getNetwork(), timeoutMs, `RPC 连接超时：${url}`);
      if (network.chainId !== CHAIN_ID) throw new Error(`RPC chainId 不是 56：${url}`);
      return provider;
    } catch (error) {
      errors.push(error.message);
      provider.destroy();
    }
  }
  throw new Error(`没有可用的 BSC RPC：${errors.at(-1) || '未配置 rpcUrls'}`);
}

function normalizeStablecoins(config) {
  const seen = new Set();
  return (config.stablecoins || []).map((entry) => ({
    symbol: String(entry.symbol || '').trim(),
    address: ethers.getAddress(entry.address)
  })).filter((entry) => {
    const key = entry.address.toLowerCase();
    if (!entry.symbol || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function signed24(value) {
  const raw = BigInt(value) & UINT24_MASK;
  return Number(raw >= 0x800000n ? raw - 0x1000000n : raw);
}

export function managementPositionTicks(info) {
  return {
    tickLower: signed24(BigInt(info) >> 8n),
    tickUpper: signed24(BigInt(info) >> 32n)
  };
}

export function managementPrincipalAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  const activeLiquidity = BigInt(liquidity);
  const sqrtPrice = BigInt(sqrtPriceX96);
  if (activeLiquidity === 0n) return { amount0: 0n, amount1: 0n };
  const sqrtLower = sqrtPriceAtTick(tickLower);
  const sqrtUpper = sqrtPriceAtTick(tickUpper);
  if (sqrtPrice <= sqrtLower) {
    return {
      amount0: activeLiquidity * (sqrtUpper - sqrtLower) * Q96 / (sqrtLower * sqrtUpper),
      amount1: 0n
    };
  }
  if (sqrtPrice < sqrtUpper) {
    return {
      amount0: activeLiquidity * (sqrtUpper - sqrtPrice) * Q96 / (sqrtPrice * sqrtUpper),
      amount1: activeLiquidity * (sqrtPrice - sqrtLower) / Q96
    };
  }
  return {
    amount0: 0n,
    amount1: activeLiquidity * (sqrtUpper - sqrtLower) / Q96
  };
}

export function removalLiquidityForOperation(liquidity, operation, percentBps = null) {
  const current = BigInt(liquidity);
  if (current <= 0n) throw new Error('当前 NFT 没有可撤出的流动性');
  if (operation === 'withdraw' || operation === 'emergency') return current;
  if (operation !== 'reduce') throw new Error('当前操作不需要计算撤出流动性');
  const bps = Number(percentBps);
  if (!Number.isInteger(bps) || bps < 100 || bps > 9900) {
    throw new Error('减仓比例必须在 1% 到 99% 之间');
  }
  const removal = current * BigInt(bps) / 10_000n;
  if (removal <= 0n || removal >= current) throw new Error('减仓比例对应的流动性数量无效');
  return removal;
}

export function managementOperationUsesAutoSwap(operation) {
  return operation === 'increase' || operation === 'emergency';
}

export function managementActionBlocksExecution(action) {
  return Boolean(action && (
    !TERMINAL_STAGES.has(action.stage)
    || action.currentTx?.hash
    || action.pendingSwap
    || action.cleanupContext
    || action.cleanupTx?.hash
  ));
}

export function minimumRemovalAmounts(amount0, amount1, slippageBps) {
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error('流动性滑点配置无效');
  const multiplier = BigInt(10_000 - bps);
  return {
    amount0Min: BigInt(amount0) * multiplier / 10_000n,
    amount1Min: BigInt(amount1) * multiplier / 10_000n
  };
}

export function encodeIncreasePosition(tokenId, liquidity, amount0Max, amount1Max, poolKey) {
  const actions = ethers.concat(['0x00', '0x0d']);
  const params = [
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
      [tokenId, liquidity, amount0Max, amount1Max, '0x']
    ),
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address'],
      [poolKey.currency0, poolKey.currency1]
    )
  ];
  return ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes[]'], [actions, params]);
}

export function encodeDecreasePosition(
  tokenId,
  liquidity,
  amount0Min,
  amount1Min,
  poolKey,
  recipient
) {
  const actions = ethers.concat(['0x01', '0x11']);
  const params = [
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
      [tokenId, liquidity, amount0Min, amount1Min, '0x']
    ),
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'address'],
      [poolKey.currency0, poolKey.currency1, recipient]
    )
  ];
  return ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes[]'], [actions, params]);
}

function tokenValueInStablecoin(amount0, amount1, sqrtPriceX96, stablecoinIndex) {
  const sqrtPrice = BigInt(sqrtPriceX96);
  if (sqrtPrice <= 0n) return null;
  if (stablecoinIndex === 0) {
    return BigInt(amount0) + BigInt(amount1) * Q192 / (sqrtPrice * sqrtPrice);
  }
  if (stablecoinIndex === 1) {
    return BigInt(amount1) + BigInt(amount0) * sqrtPrice * sqrtPrice / Q192;
  }
  return null;
}

function sqrtPriceToHumanPrice(sqrtPriceX96, tradeDecimals, quoteDecimals, tradeIsCurrency0) {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = ratio * ratio;
  const scale = 10 ** (tradeDecimals - quoteDecimals);
  const price = tradeIsCurrency0 ? rawPrice * scale : scale / rawPrice;
  if (!Number.isFinite(price) || price <= 0 || price >= 1e21 || price < 1e-24) {
    throw new Error('池子当前价格超出页面可安全显示的范围');
  }
  return price.toFixed(24).replace(/0+$/, '').replace(/\.$/, '');
}

async function strictTokenMetadata(provider, token) {
  const address = ethers.getAddress(token);
  const code = await provider.getCode(address);
  if (!code || code === '0x') throw new Error(`代币合约不存在：${address}`);
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  let symbol;
  let decimals;
  try {
    [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals().then(Number)]);
  } catch (error) {
    throw new Error(`代币合约无法读取 symbol/decimals：${address}；${error.message}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`代币 decimals 超出支持范围：${decimals}`);
  }
  return { address, symbol: String(symbol).slice(0, 32), decimals };
}

async function poolState(provider, poolManagerAddress, poolKey) {
  const poolId = poolIdOf(poolKey);
  const poolsSlot = ethers.zeroPadValue(ethers.toBeHex(6), 32);
  const stateSlot = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [poolId, poolsSlot]));
  const manager = new ethers.Contract(poolManagerAddress, POOL_MANAGER_ABI, provider);
  const slot0 = BigInt(await manager.extsload(stateSlot));
  const sqrtPriceX96 = slot0 & UINT160_MASK;
  if (sqrtPriceX96 === 0n) throw new Error('NFT 对应的池子尚未初始化');
  return {
    poolId,
    sqrtPriceX96,
    currentTick: signed24(slot0 >> 160n)
  };
}

async function readPosition(provider, config, nftId, requiredOwner = null) {
  const positionManagerAddress = ethers.getAddress(config.positionManager);
  const manager = new ethers.Contract(positionManagerAddress, POSITION_ABI, provider);
  let liquidity;
  let details;
  let owner;
  try {
    [liquidity, details, owner] = await Promise.all([
      manager.getPositionLiquidity(nftId),
      manager.getPoolAndPositionInfo(nftId),
      manager.ownerOf(nftId)
    ]);
  } catch (error) {
    throw new Error(`无法读取 NFT #${nftId}：${error.message}`);
  }
  const normalizedOwner = ethers.getAddress(owner);
  if (requiredOwner && normalizedOwner !== ethers.getAddress(requiredOwner)) {
    throw new Error(`NFT #${nftId} 不属于当前执行钱包`);
  }
  const poolKey = {
    currency0: ethers.getAddress(details[0].currency0),
    currency1: ethers.getAddress(details[0].currency1),
    fee: Number(details[0].fee),
    tickSpacing: Number(details[0].tickSpacing),
    hooks: ethers.getAddress(details[0].hooks)
  };
  const [poolManagerAddress, permit2Address, token0, token1] = await Promise.all([
    manager.poolManager(),
    manager.permit2(),
    strictTokenMetadata(provider, poolKey.currency0),
    strictTokenMetadata(provider, poolKey.currency1)
  ]);
  const pool = await poolState(provider, ethers.getAddress(poolManagerAddress), poolKey);
  const { tickLower, tickUpper } = managementPositionTicks(details[1]);
  const principal = managementPrincipalAmounts(
    liquidity,
    pool.sqrtPriceX96,
    tickLower,
    tickUpper
  );
  const stablecoins = normalizeStablecoins(config);
  const stable0 = stablecoins.find((entry) => entry.address === token0.address) || null;
  const stable1 = stablecoins.find((entry) => entry.address === token1.address) || null;
  const stablecoinIndex = Boolean(stable0) === Boolean(stable1) ? null : stable0 ? 0 : 1;
  const stablecoin = stablecoinIndex === 0
    ? { ...token0, configuredSymbol: stable0.symbol }
    : stablecoinIndex === 1 ? { ...token1, configuredSymbol: stable1.symbol } : null;
  const tradeToken = stablecoinIndex === 0 ? token1 : stablecoinIndex === 1 ? token0 : null;
  const tradeIsCurrency0 = tradeToken?.address === poolKey.currency0;
  const valueRaw = stablecoinIndex === null ? null : tokenValueInStablecoin(
    principal.amount0,
    principal.amount1,
    pool.sqrtPriceX96,
    stablecoinIndex
  );
  const walletBalances = requiredOwner ? await Promise.all([
    new ethers.Contract(token0.address, ERC20_ABI, provider).balanceOf(requiredOwner),
    new ethers.Contract(token1.address, ERC20_ABI, provider).balanceOf(requiredOwner)
  ]) : [null, null];
  return {
    nftId: String(nftId),
    owner: normalizedOwner,
    liquidity: BigInt(liquidity),
    positionInfo: BigInt(details[1]),
    positionManagerAddress,
    poolManagerAddress: ethers.getAddress(poolManagerAddress),
    permit2Address: ethers.getAddress(permit2Address),
    poolKey,
    pool,
    tickLower,
    tickUpper,
    token0,
    token1,
    amount0: principal.amount0,
    amount1: principal.amount1,
    stablecoinIndex,
    stablecoin,
    tradeToken,
    tradeIsCurrency0,
    activePrice: stablecoin && tradeToken
      ? sqrtPriceToHumanPrice(
        pool.sqrtPriceX96,
        tradeToken.decimals,
        stablecoin.decimals,
        tradeIsCurrency0
      )
      : null,
    valueRaw,
    balance0: walletBalances[0],
    balance1: walletBalances[1]
  };
}

function formatted(value, decimals) {
  return ethers.formatUnits(value, decimals);
}

function publicPosition(position) {
  const inRange = position.pool.currentTick >= position.tickLower
    && position.pool.currentTick < position.tickUpper;
  return {
    nftId: position.nftId,
    owner: position.owner,
    poolId: position.pool.poolId,
    poolKey: position.poolKey,
    currentTick: position.pool.currentTick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    inRange,
    liquidity: position.liquidity.toString(),
    activePrice: position.activePrice,
    supported: position.stablecoinIndex !== null,
    unsupportedReason: position.stablecoinIndex === null
      ? '仓位必须包含且只包含一个流动性模块白名单稳定币'
      : null,
    token0: {
      ...position.token0,
      amount: formatted(position.amount0, position.token0.decimals),
      balance: position.balance0 === null ? null : formatted(position.balance0, position.token0.decimals),
      isStablecoin: position.stablecoinIndex === 0
    },
    token1: {
      ...position.token1,
      amount: formatted(position.amount1, position.token1.decimals),
      balance: position.balance1 === null ? null : formatted(position.balance1, position.token1.decimals),
      isStablecoin: position.stablecoinIndex === 1
    },
    stablecoin: position.stablecoin ? {
      address: position.stablecoin.address,
      symbol: position.stablecoin.configuredSymbol || position.stablecoin.symbol,
      decimals: position.stablecoin.decimals
    } : null,
    tradeToken: position.tradeToken,
    valueInStablecoin: position.valueRaw === null ? null : {
      raw: position.valueRaw.toString(),
      formatted: formatted(position.valueRaw, position.stablecoin.decimals),
      symbol: position.stablecoin.configuredSymbol || position.stablecoin.symbol
    },
    hooksWarning: position.poolKey.hooks === ZERO
      ? null
      : '该仓位包含 Hooks；本次操作会执行池子的外部 Hooks 逻辑'
  };
}

export function normalizeManagementInput(body, config) {
  const operation = String(body.operation || '').trim();
  if (!OPERATIONS.has(operation)) throw new Error('无法识别仓位操作');
  const nftId = String(body.nftId || '').trim();
  if (!/^\d+$/.test(nftId)) throw new Error('NFT ID 必须是数字');
  let budget = null;
  let percentBps = null;
  if (operation === 'increase') {
    budget = decimalFraction(body.budget, '补仓稳定币金额').text;
    const maximum = decimalFraction(config.maxStableBudget ?? 1000, '稳定币投入安全上限');
    const requested = decimalFraction(budget);
    if (requested.numerator * maximum.denominator > maximum.numerator * requested.denominator) {
      throw new Error(`补仓金额超过安全上限 ${config.maxStableBudget ?? 1000} U`);
    }
  }
  if (operation === 'reduce') {
    const percent = Number(body.percent);
    percentBps = Math.round(percent * 100);
    if (!Number.isFinite(percent) || percentBps < 100 || percentBps > 9900) {
      throw new Error('减仓比例必须在 1% 到 99% 之间');
    }
  }
  return { operation, nftId, budget, percentBps };
}

export function managementExecutionFingerprint(input) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    operation: input.operation,
    nftId: input.nftId,
    budget: input.budget,
    percentBps: input.percentBps
  })));
}

function amountCapsFromTradeStable(position, tradeAmount, stableAmount) {
  return position.tradeIsCurrency0
    ? { amount0Max: BigInt(tradeAmount), amount1Max: BigInt(stableAmount) }
    : { amount0Max: BigInt(stableAmount), amount1Max: BigInt(tradeAmount) };
}

async function buildIncreaseAllocation(provider, config, environment, position, input, owner) {
  const allocation = stableBudgetAllocation(
    input.budget,
    position.activePrice,
    position.tradeToken.decimals,
    position.stablecoin.decimals,
    position.tradeIsCurrency0,
    position.pool.sqrtPriceX96,
    position.tickLower,
    position.tickUpper
  );
  if (allocation.stableToSwap === 0n) {
    const caps = amountCapsFromTradeStable(position, 0n, allocation.stableBudget);
    return {
      stableInput: allocation.stableBudget,
      stableToSwap: 0n,
      stableForLiquidity: allocation.stableBudget,
      quotedTradeAmount: 0n,
      amountCaps: caps,
      liquidityDelta: liquidityForAmounts(
        caps.amount0Max,
        caps.amount1Max,
        position.pool.sqrtPriceX96,
        position.tickLower,
        position.tickUpper
      )
    };
  }
  const firstQuote = await quoteManagementSwap({
    tokenIn: position.stablecoin.address,
    tokenOut: position.tradeToken.address,
    amountIn: allocation.stableToSwap,
    walletAddress: owner,
    config,
    environment
  });
  const optimizedAmount = optimizedStableSwapAmount(
    allocation.stableBudget,
    allocation.tradeAmount,
    allocation.quoteAmount,
    firstQuote.amountIn,
    firstQuote.amountOut
  );
  const difference = optimizedAmount > allocation.stableToSwap
    ? optimizedAmount - allocation.stableToSwap
    : allocation.stableToSwap - optimizedAmount;
  const threshold = allocation.stableToSwap / 1000n;
  const finalQuote = difference > (threshold > 0n ? threshold : 1n)
    ? await quoteManagementSwap({
      tokenIn: position.stablecoin.address,
      tokenOut: position.tradeToken.address,
      amountIn: optimizedAmount,
      walletAddress: owner,
      config,
      environment
    })
    : firstQuote;
  const stableForLiquidity = allocation.stableBudget - finalQuote.amountIn;
  const caps = amountCapsFromTradeStable(position, finalQuote.amountOut, stableForLiquidity);
  const liquidityDelta = liquidityForAmounts(
    caps.amount0Max,
    caps.amount1Max,
    position.pool.sqrtPriceX96,
    position.tickLower,
    position.tickUpper
  );
  if (liquidityDelta > MAX_UINT128) throw new Error('补仓流动性超过 uint128 上限');
  return {
    stableInput: allocation.stableBudget,
    stableToSwap: finalQuote.amountIn,
    stableForLiquidity,
    quotedTradeAmount: finalQuote.amountOut,
    amountCaps: caps,
    liquidityDelta
  };
}

async function buildManagementPlan(provider, config, environment, input, owner) {
  const position = await readPosition(provider, config, input.nftId, owner);
  if (position.stablecoinIndex === null) {
    throw new Error('当前 NFT 未识别到唯一的白名单稳定币，不能使用仓位管理功能');
  }
  if (position.poolKey.hooks !== ZERO && input.operation === 'increase') {
    await verifyConfiguredWhitelistHook({
      provider,
      config,
      selectedHook: position.poolKey.hooks,
      walletAddress: owner,
      positionManager: position.positionManagerAddress,
      poolManager: position.poolManagerAddress
    });
  }
  if (input.operation === 'increase') {
    const allocation = await buildIncreaseAllocation(provider, config, environment, position, input, owner);
    const stableBalance = position.stablecoinIndex === 0 ? position.balance0 : position.balance1;
    if (stableBalance < allocation.stableInput) {
      throw new Error(`钱包 ${position.stablecoin.configuredSymbol || position.stablecoin.symbol} 余额不足`);
    }
    const estimated = managementPrincipalAmounts(
      allocation.liquidityDelta,
      position.pool.sqrtPriceX96,
      position.tickLower,
      position.tickUpper
    );
    return { input, position, allocation, estimated };
  }

  const removalLiquidity = removalLiquidityForOperation(
    position.liquidity,
    input.operation,
    input.percentBps
  );
  const estimated = managementPrincipalAmounts(
    removalLiquidity,
    position.pool.sqrtPriceX96,
    position.tickLower,
    position.tickUpper
  );
  const slippageBps = Math.max(0, Math.min(
    5000,
    Number(config.liquiditySlippageBps ?? config.swapSlippageBps ?? 100)
  ));
  const minimums = minimumRemovalAmounts(estimated.amount0, estimated.amount1, slippageBps);
  const remainingLiquidity = position.liquidity - removalLiquidity;
  let zapQuote = null;
  if (managementOperationUsesAutoSwap(input.operation)) {
    const tradeAmount = position.tradeIsCurrency0 ? estimated.amount0 : estimated.amount1;
    if (tradeAmount > 0n) {
      zapQuote = await quoteManagementSwap({
        tokenIn: position.tradeToken.address,
        tokenOut: position.stablecoin.address,
        amountIn: tradeAmount,
        walletAddress: owner,
        config,
        environment
      });
    }
  }
  const deadline = Math.floor(Date.now() / 1000)
    + Math.max(60, Number(config.transactionDeadlineSeconds) || 180);
  const unlockData = encodeDecreasePosition(
    position.nftId,
    removalLiquidity,
    minimums.amount0Min,
    minimums.amount1Min,
    position.poolKey,
    owner
  );
  const calldata = POSITION_INTERFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
  let estimatedGas;
  try {
    estimatedGas = await provider.estimateGas({
      from: owner,
      to: position.positionManagerAddress,
      data: calldata,
      value: 0n
    });
  } catch (error) {
    throw new Error(`撤出流动性模拟失败：${error.message}`);
  }
  return {
    input,
    position,
    removalLiquidity,
    remainingLiquidity,
    estimated,
    minimums,
    slippageBps,
    zapQuote,
    calldata,
    estimatedGas
  };
}

function publicManagementPlan(plan, authorizationId, expiresAt) {
  const position = plan.position;
  const output = {
    authorizationId,
    expiresAt: new Date(expiresAt).toISOString(),
    operation: plan.input.operation,
    position: publicPosition(position),
    estimatedGas: plan.estimatedGas?.toString() || null
  };
  if (plan.input.operation === 'increase') {
    return {
      ...output,
      budget: plan.input.budget,
      stableInput: formatted(plan.allocation.stableInput, position.stablecoin.decimals),
      stableToSwap: formatted(plan.allocation.stableToSwap, position.stablecoin.decimals),
      stableForLiquidity: formatted(plan.allocation.stableForLiquidity, position.stablecoin.decimals),
      quotedTradeAmount: formatted(plan.allocation.quotedTradeAmount, position.tradeToken.decimals),
      liquidityDelta: plan.allocation.liquidityDelta.toString(),
      expectedAmount0: formatted(plan.estimated.amount0, position.token0.decimals),
      expectedAmount1: formatted(plan.estimated.amount1, position.token1.decimals)
    };
  }
  const tradeAmount = position.tradeIsCurrency0 ? plan.estimated.amount0 : plan.estimated.amount1;
  const stableAmount = position.tradeIsCurrency0 ? plan.estimated.amount1 : plan.estimated.amount0;
  const withdrawalPlan = {
    ...output,
    percent: plan.input.operation === 'reduce' ? plan.input.percentBps / 100 : 100,
    removalLiquidity: plan.removalLiquidity.toString(),
    remainingLiquidity: plan.remainingLiquidity.toString(),
    expectedAmount0: formatted(plan.estimated.amount0, position.token0.decimals),
    expectedAmount1: formatted(plan.estimated.amount1, position.token1.decimals),
    minimumAmount0: formatted(plan.minimums.amount0Min, position.token0.decimals),
    minimumAmount1: formatted(plan.minimums.amount1Min, position.token1.decimals),
    liquiditySlippageBps: plan.slippageBps,
    expectedTradeDirect: formatted(tradeAmount, position.tradeToken.decimals),
    expectedStableDirect: formatted(stableAmount, position.stablecoin.decimals),
    outputMode: plan.input.operation === 'emergency' ? 'stablecoin' : 'dual_token'
  };
  if (plan.input.operation !== 'emergency') return withdrawalPlan;
  return {
    ...withdrawalPlan,
    expectedTradeToSwap: withdrawalPlan.expectedTradeDirect,
    quotedStableFromSwap: plan.zapQuote
      ? formatted(plan.zapQuote.amountOut, position.stablecoin.decimals)
      : '0'
  };
}

function transactionEntry(kind, hash, receipt = null) {
  return {
    kind,
    hash,
    status: receipt ? (Number(receipt.status) === 1 ? 'confirmed' : 'failed') : 'pending',
    blockNumber: receipt?.blockNumber ?? null,
    confirmedAt: receipt ? new Date().toISOString() : null
  };
}

async function sendTransaction(provider, wallet, config, request, onPrepared) {
  const [nonce, estimatedGas, feeData] = await Promise.all([
    provider.getTransactionCount(wallet.address, 'pending'),
    provider.estimateGas({ ...request, from: wallet.address }),
    provider.getFeeData()
  ]);
  if (!feeData.gasPrice) throw new Error('RPC 未返回 gasPrice');
  const minimumGasPrice = ethers.parseUnits(String(config.minGasPriceGwei ?? 0.1), 'gwei');
  const maximumGasPrice = ethers.parseUnits(String(config.maxGasPriceGwei ?? 5), 'gwei');
  const gasPrice = feeData.gasPrice > minimumGasPrice ? feeData.gasPrice : minimumGasPrice;
  if (gasPrice > maximumGasPrice) throw new Error(`当前 gasPrice 超过安全上限 ${config.maxGasPriceGwei ?? 5} Gwei`);
  const gasLimit = estimatedGas * 12n / 10n;
  const maximumGasLimit = BigInt(config.maxGasLimit ?? 3_000_000);
  if (gasLimit > maximumGasLimit) throw new Error(`预估 Gas ${gasLimit} 超过安全上限 ${maximumGasLimit}`);
  const signed = await wallet.signTransaction({
    chainId: CHAIN_ID,
    type: 0,
    nonce,
    to: request.to,
    data: request.data || '0x',
    value: request.value || 0n,
    gasLimit,
    gasPrice
  });
  const expectedHash = ethers.keccak256(signed);
  await onPrepared?.(expectedHash);
  const response = await provider.broadcastTransaction(signed);
  if (response.hash !== expectedHash) throw new Error('本地交易哈希与广播哈希不一致');
  const receipt = await provider.waitForTransaction(
    expectedHash,
    Math.max(1, Number(config.receiptConfirmations) || 1),
    Math.max(30_000, Number(config.transactionTimeoutMs) || 90_000)
  );
  if (!receipt) {
    const error = new Error(`等待交易确认超时：${expectedHash}`);
    error.transactionUncertain = true;
    throw error;
  }
  if (Number(receipt.status) !== 1) {
    const error = new Error(`链上交易执行失败：${expectedHash}`);
    error.transactionConfirmedFailed = true;
    error.transactionHash = expectedHash;
    throw error;
  }
  return receipt;
}

async function ensureTokenAllowance(provider, wallet, config, tokenAddress, spender, amount, action, persist, kind) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const required = BigInt(amount);
  let allowance = await token.allowance(wallet.address, spender);
  if (allowance === required) return;
  if (allowance > 0n) {
    const receipt = await sendTransaction(provider, wallet, config, {
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [spender, 0n]),
      value: 0n
    }, async (hash) => {
      action.currentTx = transactionEntry(`${kind}_reset`, hash);
      await persist(action);
    });
    action.transactions.push(transactionEntry(`${kind}_reset`, receipt.hash, receipt));
    action.currentTx = null;
    await persist(action);
  }
  if (required > 0n) {
    const receipt = await sendTransaction(provider, wallet, config, {
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [spender, required]),
      value: 0n
    }, async (hash) => {
      action.currentTx = transactionEntry(kind, hash);
      await persist(action);
    });
    action.transactions.push(transactionEntry(kind, receipt.hash, receipt));
    action.currentTx = null;
    await persist(action);
  }
  allowance = await token.allowance(wallet.address, spender);
  if (allowance !== required) throw new Error(`授权结果与本次精确金额不一致：${tokenAddress}`);
}

async function ensureReusablePositionAllowance(
  provider,
  wallet,
  config,
  tokenAddress,
  permit2Address,
  amount,
  action,
  persist
) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const required = BigInt(amount);
  let allowance = await token.allowance(wallet.address, permit2Address);
  const actions = reusableAllowanceActions(allowance, required);
  if (actions.includes('reset')) {
    const receipt = await sendTransaction(provider, wallet, config, {
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [permit2Address, 0n]),
      value: 0n
    }, async (hash) => {
      action.currentTx = transactionEntry('erc20_permit2_reset', hash);
      await persist(action);
    });
    action.transactions.push(transactionEntry('erc20_permit2_reset', receipt.hash, receipt));
    action.currentTx = null;
    await persist(action);
  }
  if (actions.includes('approve')) {
    const receipt = await sendTransaction(provider, wallet, config, {
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [permit2Address, ethers.MaxUint256]),
      value: 0n
    }, async (hash) => {
      action.currentTx = transactionEntry('erc20_permit2', hash);
      await persist(action);
    });
    action.transactions.push(transactionEntry('erc20_permit2', receipt.hash, receipt));
    action.currentTx = null;
    await persist(action);
  }
  allowance = await token.allowance(wallet.address, permit2Address);
  if (allowance < required) throw new Error(`Permit2 的 ERC20 可用授权不足：${tokenAddress}`);
}

async function ensurePositionApprovals(provider, wallet, config, position, caps, action, persist) {
  const expiry = Math.floor(Date.now() / 1000)
    + Math.max(600, Number(config.permit2ExpirationSeconds) || 3600);
  const currencies = [
    { address: position.poolKey.currency0, amount: caps.amount0Max },
    { address: position.poolKey.currency1, amount: caps.amount1Max }
  ];
  for (const currency of currencies) {
    if (currency.amount === 0n) continue;
    await ensureReusablePositionAllowance(
      provider,
      wallet,
      config,
      currency.address,
      position.permit2Address,
      currency.amount,
      action,
      persist
    );
    const permit2 = new ethers.Contract(position.permit2Address, PERMIT2_ABI, provider);
    const current = await permit2.allowance(wallet.address, currency.address, position.positionManagerAddress);
    const minimumExpiration = Math.floor(Date.now() / 1000) + 300;
    if (reusablePermit2ApprovalRequired(
      current.amount,
      currency.amount,
      current.expiration,
      minimumExpiration
    )) {
      const receipt = await sendTransaction(provider, wallet, config, {
        to: position.permit2Address,
        data: PERMIT2_INTERFACE.encodeFunctionData('approve', [
          currency.address,
          position.positionManagerAddress,
          UINT160_MASK,
          expiry
        ]),
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('permit2_position_manager', hash);
        await persist(action);
      });
      action.transactions.push(transactionEntry('permit2_position_manager', receipt.hash, receipt));
      action.currentTx = null;
      await persist(action);
    }
    const verified = await permit2.allowance(wallet.address, currency.address, position.positionManagerAddress);
    if (reusablePermit2ApprovalRequired(
      verified.amount,
      currency.amount,
      verified.expiration,
      minimumExpiration
    )) {
      throw new Error(`Permit2 仓位可用授权不足：${currency.address}`);
    }
  }
}

async function balanceSnapshot(provider, tokens, owner, blockTag = 'latest') {
  const balances = await Promise.all(tokens.map((token) => (
    new ethers.Contract(token, ERC20_ABI, provider).balanceOf(owner, { blockTag })
  )));
  return Object.fromEntries(tokens.map((token, index) => [ethers.getAddress(token), balances[index]]));
}

function receivedAmountsFromLogs(receipt, tokens, owner) {
  const wanted = new Set(tokens.map((token) => ethers.getAddress(token)));
  const recipient = ethers.getAddress(owner);
  const amounts = Object.fromEntries([...wanted].map((token) => [token, 0n]));
  const matched = new Set();
  for (const log of receipt.logs || []) {
    const address = ethers.getAddress(log.address);
    if (!wanted.has(address) || log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
    try {
      const parsed = ERC20_INTERFACE.parseLog(log);
      if (ethers.getAddress(parsed.args.to) !== recipient) continue;
      amounts[address] += BigInt(parsed.args.value);
      matched.add(address);
    } catch {
      // Ignore malformed or non-standard transfer logs and use the balance-delta fallback.
    }
  }
  return matched.size === wanted.size ? amounts : null;
}

async function executeExactSwap({
  provider,
  wallet,
  config,
  environment,
  tokenIn,
  tokenOut,
  amountIn,
  inputDecimals,
  outputDecimals,
  action,
  persist,
  kind
}) {
  const spender = await managementSwapApprovalSpender({ token: tokenIn, amount: amountIn, config, environment });
  await ensureTokenAllowance(provider, wallet, config, tokenIn, spender, amountIn, action, persist, `${kind}_okx`);
  const inputContract = new ethers.Contract(tokenIn, ERC20_ABI, provider);
  const outputContract = new ethers.Contract(tokenOut, ERC20_ABI, provider);
  const [inputBefore, outputBefore] = await Promise.all([
    inputContract.balanceOf(wallet.address),
    outputContract.balanceOf(wallet.address)
  ]);
  if (inputBefore < BigInt(amountIn)) throw new Error('钱包余额不足，无法执行本次精确兑换');
  const prepared = await prepareManagementSwap({
    tokenIn,
    tokenOut,
    amountIn,
    walletAddress: wallet.address,
    config,
    environment
  });
  action.stage = kind;
  action.swap = {
    status: 'prepared',
    tokenIn: ethers.getAddress(tokenIn),
    tokenOut: ethers.getAddress(tokenOut),
    amountIn: BigInt(amountIn).toString(),
    quotedAmountOut: prepared.amountOut.toString(),
    hash: null
  };
  await persist(action);
  const receipt = await sendTransaction(provider, wallet, config, {
    to: ethers.getAddress(prepared.response.tx.to),
    data: prepared.response.tx.data,
    value: BigInt(prepared.response.tx.value || 0)
  }, async (hash) => {
    action.currentTx = transactionEntry(kind, hash);
    action.swap.status = 'broadcast';
    action.swap.hash = hash;
    await persist(action);
  });
  const [inputAfter, outputAfter] = await Promise.all([
    inputContract.balanceOf(wallet.address),
    outputContract.balanceOf(wallet.address)
  ]);
  const spent = inputBefore - inputAfter;
  const received = outputAfter - outputBefore;
  const minimumReceived = prepared.amountOut
    * BigInt(Math.max(0, 10_000 - Number(config.swapSlippageBps ?? 100)))
    / 10_000n;
  if (spent !== BigInt(amountIn)) throw new Error('自动兑换实际扣除数量与本次精确金额不一致');
  if (received <= 0n || received < minimumReceived) throw new Error('自动兑换实际到账低于滑点保护值');
  action.transactions.push(transactionEntry(kind, receipt.hash, receipt));
  action.currentTx = null;
  action.swap = {
    ...action.swap,
    status: 'confirmed',
    hash: receipt.hash,
    amountSpent: spent.toString(),
    amountReceived: received.toString(),
    amountSpentFormatted: formatted(spent, inputDecimals),
    amountReceivedFormatted: formatted(received, outputDecimals),
    confirmedAt: new Date().toISOString()
  };
  await persist(action);
  try {
    await ensureTokenAllowance(provider, wallet, config, tokenIn, spender, 0n, action, persist, `${kind}_cleanup`);
  } catch (cleanupError) {
    action.cleanupContext = {
      swapKind: kind,
      tokenAddress: ethers.getAddress(tokenIn),
      spender: ethers.getAddress(spender),
      createdAt: new Date().toISOString()
    };
    action.cleanupWarning = `兑换已成功，但清理 OKX 授权未能确认：${cleanupError.message}`;
    await persist(action);
    const error = new Error(action.cleanupWarning);
    error.cleanupPending = true;
    throw error;
  }
  return { spent, received, receipt };
}

function assertAuthorization(authorization, input, owner) {
  if (!authorization) throw new Error('操作确认已过期，请重新点击操作按钮');
  if (Date.now() > authorization.expiresAt) throw new Error('操作确认已过期，请重新计算');
  if (authorization.owner !== ethers.getAddress(owner)) throw new Error('执行钱包与操作确认不一致');
  if (authorization.fingerprint !== managementExecutionFingerprint(input)) {
    throw new Error('操作参数已变化，请重新确认');
  }
}

function assertPositionInvariant(position, authorization) {
  if (position.pool.poolId !== authorization.poolId) throw new Error('NFT 对应池子已变化，已停止执行');
  if (position.liquidity.toString() !== authorization.baselineLiquidity) {
    throw new Error('NFT 流动性已被外部修改，请重新操作');
  }
  if (position.tickLower !== authorization.tickLower || position.tickUpper !== authorization.tickUpper) {
    throw new Error('NFT Tick 区间与确认时不一致，已停止执行');
  }
  const maximumTickDrift = Math.max(1, Number(position.poolKey.tickSpacing)) * 2;
  if (Math.abs(position.pool.currentTick - authorization.currentTick) > maximumTickDrift) {
    throw new Error('池价相对确认时变化超过两个 Tick Spacing，请重新操作');
  }
}

function publicAction(action) {
  return action;
}

function cleanupSwapKind(transactionKind = '') {
  if (String(transactionKind).startsWith('zap_out_swap_retry')) return 'zap_out_swap_retry';
  if (String(transactionKind).startsWith('zap_out_swap')) return 'zap_out_swap';
  if (String(transactionKind).startsWith('zap_in_swap')) return 'zap_in_swap';
  return null;
}

function cleanupTransactionPending(action, transaction = action?.currentTx) {
  return Boolean(action?.cleanupContext && transaction?.kind?.includes('_cleanup'));
}

function finalizeCleanupRecovery(action) {
  const context = action.cleanupContext;
  action.cleanupContext = null;
  action.cleanupWarning = null;
  action.currentTx = null;
  if (context?.swapKind === 'zap_in_swap' || action.operation === 'increase') {
    action.stage = 'failed';
    action.error = 'Zap In 兑换已确认且授权已清理，但补仓交易尚未执行；请核对钱包双币后重新操作';
    action.failedAt = new Date().toISOString();
    return;
  }
  const stableFromSwap = BigInt(action.swap?.amountReceived || 0);
  action.stableFromSwap = stableFromSwap.toString();
  action.finalStableReceived = (
    BigInt(action.stableDirect || 0) + stableFromSwap
  ).toString();
  action.pendingSwap = null;
  action.error = null;
  action.stage = 'completed';
  action.completedAt = new Date().toISOString();
}

export function createLiquidityManagementRouter({
  configPath,
  actionPath,
  environment = process.env,
  executionConflict = () => null
}) {
  const router = express.Router();
  let inFlight = false;
  let readySettled = false;
  let readyError = null;
  let lastAction = null;
  const authorizations = new Map();
  const ready = (async () => {
    try {
      lastAction = await readJson(actionPath);
      if (lastAction.cleanupTx?.hash) {
        lastAction.currentTx ||= lastAction.cleanupTx;
        lastAction.cleanupContext ||= {
          swapKind: cleanupSwapKind(lastAction.cleanupTx.kind) || (lastAction.operation === 'increase'
            ? 'zap_in_swap'
            : 'zap_out_swap'),
          tokenAddress: lastAction.swap?.tokenIn || lastAction.tradeToken?.address || null,
          spender: null,
          recoveredAt: new Date().toISOString()
        };
        delete lastAction.cleanupTx;
        lastAction.stage = 'needs_attention';
        lastAction.error ||= '授权清理交易仍待核对，请先处理后再继续';
      }
      const recoveryPending = lastAction.currentTx?.hash
        || lastAction.pendingSwap
        || lastAction.cleanupContext;
      if (recoveryPending) {
        lastAction.stage = 'needs_attention';
        lastAction.error ||= '服务曾在仓位操作中断，请先核对已广播交易或完成待处理恢复';
        await writeJsonAtomic(actionPath, lastAction);
      } else if (!TERMINAL_STAGES.has(lastAction.stage)) {
        lastAction.stage = 'failed';
        lastAction.error ||= '上次仓位操作未完成，系统不会自动续跑';
        lastAction.failedAt ||= new Date().toISOString();
        await writeJsonAtomic(actionPath, lastAction);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        readyError = error;
        throw error;
      }
    } finally {
      readySettled = true;
    }
  })();
  const persist = async (action) => {
    lastAction = action;
    await writeJsonAtomic(actionPath, action);
  };

  router.get('/options', async (_req, res) => {
    try {
      await ready;
      const config = await readJson(configPath);
      let walletAddress = null;
      try {
        walletAddress = environment.PRIVATE_KEY
          ? new ethers.Wallet(environment.PRIVATE_KEY).address
          : null;
      } catch {
        walletAddress = null;
      }
      res.json({
        chainId: Number(CHAIN_ID),
        walletAddress,
        privateKeyConfigured: Boolean(walletAddress),
        executionEnabled: environment.LIQUIDITY_EXECUTE === 'true',
        autoSwapConfigured: okxCredentialsConfigured(environment),
        maxStableBudget: Number(config.maxStableBudget ?? 1000),
        inFlight,
        lastAction: publicAction(lastAction)
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/status', async (_req, res) => {
    try {
      await ready;
      res.set('Cache-Control', 'no-store');
      res.json({ inFlight, lastAction: publicAction(lastAction) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/position', async (req, res) => {
    let provider;
    try {
      await ready;
      const nftId = String(req.body.nftId || '').trim();
      if (!/^\d+$/.test(nftId)) throw new Error('NFT ID 必须是数字');
      const config = await readJson(configPath);
      let owner = null;
      if (environment.PRIVATE_KEY) owner = new ethers.Wallet(environment.PRIVATE_KEY).address;
      provider = await openProvider(config);
      const position = await readPosition(provider, config, nftId, owner);
      res.json(publicPosition(position));
    } catch (error) {
      res.status(400).json({ error: error.message });
    } finally {
      provider?.destroy();
    }
  });

  router.post('/prepare', async (req, res) => {
    let provider;
    try {
      await ready;
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY，当前只能查看仓位');
      const config = await readJson(configPath);
      const input = normalizeManagementInput(req.body, config);
      const wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      provider = await openProvider(config);
      const plan = await buildManagementPlan(provider, config, environment, input, wallet.address);
      const id = crypto.randomUUID();
      const validitySeconds = Math.min(600, Math.max(30, Number(config.previewValiditySeconds) || 120));
      const expiresAt = Date.now() + validitySeconds * 1000;
      authorizations.set(id, {
        id,
        expiresAt,
        owner: wallet.address,
        fingerprint: managementExecutionFingerprint(input),
        poolId: plan.position.pool.poolId,
        baselineLiquidity: plan.position.liquidity.toString(),
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        currentTick: plan.position.pool.currentTick,
        removalLiquidity: plan.removalLiquidity?.toString() || null,
        amount0Min: plan.minimums?.amount0Min.toString() || null,
        amount1Min: plan.minimums?.amount1Min.toString() || null
      });
      for (const [key, authorization] of authorizations) {
        if (authorization.expiresAt < Date.now()) authorizations.delete(key);
      }
      res.json(publicManagementPlan(plan, id, expiresAt));
    } catch (error) {
      res.status(400).json({ error: error.message });
    } finally {
      provider?.destroy();
    }
  });

  router.post('/execute', async (req, res) => {
    let provider;
    let action;
    let lockAcquired = false;
    try {
      await ready;
      if (req.body.confirmed !== true) throw new Error('必须确认本次仓位操作');
      if (environment.LIQUIDITY_EXECUTE !== 'true') {
        throw new Error('LIQUIDITY_EXECUTE=false，请先开启流动性执行开关');
      }
      if (inFlight) throw new Error('已有仓位管理任务正在执行');
      if (managementActionBlocksExecution(lastAction)) throw new Error('上一次仓位任务仍待处理');
      const conflict = executionConflict();
      if (conflict) throw new Error(conflict);
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY');
      inFlight = true;
      lockAcquired = true;
      const config = await readJson(configPath);
      const wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      const input = normalizeManagementInput(req.body, config);
      const authorization = authorizations.get(String(req.body.authorizationId || ''));
      assertAuthorization(authorization, input, wallet.address);
      authorizations.delete(authorization.id);
      provider = await openProvider(config);
      const position = await readPosition(provider, config, input.nftId, wallet.address);
      assertPositionInvariant(position, authorization);
      if (position.poolKey.hooks !== ZERO && req.body.acknowledgeHooks !== true) {
        throw new Error('必须确认该仓位 Hooks 的外部合约执行风险');
      }
      action = {
        id: crypto.randomUUID(),
        operation: input.operation,
        nftId: input.nftId,
        wallet: wallet.address,
        stage: 'preparing',
        startedAt: new Date().toISOString(),
        poolId: position.pool.poolId,
        poolKey: position.poolKey,
        token0: position.token0,
        token1: position.token1,
        stablecoin: {
          address: position.stablecoin.address,
          symbol: position.stablecoin.configuredSymbol || position.stablecoin.symbol,
          decimals: position.stablecoin.decimals
        },
        tradeToken: position.tradeToken,
        baselineLiquidity: position.liquidity.toString(),
        requestedPercent: input.operation === 'reduce' ? input.percentBps / 100 : null,
        budget: input.budget,
        transactions: [],
        currentTx: null,
        error: null
      };
      await persist(action);

      if (input.operation === 'increase') {
        const refreshedPlan = await buildManagementPlan(
          provider,
          config,
          environment,
          input,
          wallet.address
        );
        assertPositionInvariant(refreshedPlan.position, authorization);
        let stableForLiquidity = refreshedPlan.allocation.stableInput;
        let tradeForLiquidity = 0n;
        if (refreshedPlan.allocation.stableToSwap > 0n) {
          action.stage = 'preparing_zap_in';
          await persist(action);
          const swapResult = await executeExactSwap({
            provider,
            wallet,
            config,
            environment,
            tokenIn: position.stablecoin.address,
            tokenOut: position.tradeToken.address,
            amountIn: refreshedPlan.allocation.stableToSwap,
            inputDecimals: position.stablecoin.decimals,
            outputDecimals: position.tradeToken.decimals,
            action,
            persist,
            kind: 'zap_in_swap'
          });
          stableForLiquidity = refreshedPlan.allocation.stableInput - swapResult.spent;
          tradeForLiquidity = swapResult.received;
        }
        const afterSwapPosition = await readPosition(provider, config, input.nftId, wallet.address);
        if (afterSwapPosition.pool.poolId !== position.pool.poolId
          || afterSwapPosition.liquidity !== position.liquidity) {
          throw new Error('Zap In 后 NFT 状态发生变化，已停止补仓');
        }
        const caps = amountCapsFromTradeStable(afterSwapPosition, tradeForLiquidity, stableForLiquidity);
        const liquidityDelta = liquidityForAmounts(
          caps.amount0Max,
          caps.amount1Max,
          afterSwapPosition.pool.sqrtPriceX96,
          afterSwapPosition.tickLower,
          afterSwapPosition.tickUpper
        );
        action.stage = 'approving_position';
        action.liquidityDelta = liquidityDelta.toString();
        action.amount0Max = caps.amount0Max.toString();
        action.amount1Max = caps.amount1Max.toString();
        await persist(action);
        await ensurePositionApprovals(provider, wallet, config, afterSwapPosition, caps, action, persist);
        const deadline = Math.floor(Date.now() / 1000)
          + Math.max(60, Number(config.transactionDeadlineSeconds) || 180);
        const unlockData = encodeIncreasePosition(
          input.nftId,
          liquidityDelta,
          caps.amount0Max,
          caps.amount1Max,
          afterSwapPosition.poolKey
        );
        const calldata = POSITION_INTERFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
        action.stage = 'increasing';
        await persist(action);
        const receipt = await sendTransaction(provider, wallet, config, {
          to: afterSwapPosition.positionManagerAddress,
          data: calldata,
          value: 0n
        }, async (hash) => {
          action.currentTx = transactionEntry('increase_liquidity', hash);
          action.liquidityTxHash = hash;
          await persist(action);
        });
        const completedPosition = await readPosition(provider, config, input.nftId, wallet.address);
        if (completedPosition.liquidity <= position.liquidity) {
          throw new Error('补仓交易已确认，但链上流动性没有增加，请人工核对');
        }
        action.transactions.push(transactionEntry('increase_liquidity', receipt.hash, receipt));
        action.currentTx = null;
        action.finalLiquidity = completedPosition.liquidity.toString();
        action.actualLiquidityDelta = (completedPosition.liquidity - position.liquidity).toString();
        action.stage = 'completed';
        action.completedAt = new Date().toISOString();
        await persist(action);
        return res.json(action);
      }

      const removalLiquidity = BigInt(authorization.removalLiquidity);
      const deadline = Math.floor(Date.now() / 1000)
        + Math.max(60, Number(config.transactionDeadlineSeconds) || 180);
      const unlockData = encodeDecreasePosition(
        input.nftId,
        removalLiquidity,
        BigInt(authorization.amount0Min),
        BigInt(authorization.amount1Min),
        position.poolKey,
        wallet.address
      );
      const calldata = POSITION_INTERFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
      const tokens = [position.token0.address, position.token1.address];
      const before = await balanceSnapshot(provider, tokens, wallet.address);
      action.stage = 'withdrawing';
      action.removalLiquidity = removalLiquidity.toString();
      action.minimumAmount0 = authorization.amount0Min;
      action.minimumAmount1 = authorization.amount1Min;
      action.beforeBalances = Object.fromEntries(
        Object.entries(before).map(([token, amount]) => [token, amount.toString()])
      );
      await persist(action);
      const receipt = await sendTransaction(provider, wallet, config, {
        to: position.positionManagerAddress,
        data: calldata,
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('decrease_liquidity', hash);
        action.liquidityTxHash = hash;
        await persist(action);
      });
      const logAmounts = receivedAmountsFromLogs(receipt, tokens, wallet.address);
      const after = logAmounts ? null : await balanceSnapshot(provider, tokens, wallet.address);
      const received = logAmounts || Object.fromEntries(tokens.map((token) => [
        token,
        after[token] - before[token]
      ]));
      action.receivedAmountSource = logAmounts ? 'receipt_transfer_logs' : 'balance_delta';
      action.receivedAmounts = Object.fromEntries(
        Object.entries(received).map(([token, amount]) => [token, amount.toString()])
      );
      const completedPosition = await readPosition(provider, config, input.nftId, wallet.address);
      const expectedLiquidity = position.liquidity - removalLiquidity;
      if (completedPosition.liquidity !== expectedLiquidity) {
        throw new Error('撤出交易已确认，但 NFT 剩余流动性与请求不一致，请人工核对');
      }
      action.transactions.push(transactionEntry('decrease_liquidity', receipt.hash, receipt));
      action.currentTx = null;
      action.finalLiquidity = completedPosition.liquidity.toString();
      action.stage = 'withdraw_confirmed';
      await persist(action);
      if (!managementOperationUsesAutoSwap(input.operation)) {
        action.stage = 'completed';
        action.completedAt = new Date().toISOString();
        await persist(action);
        return res.json(action);
      }

      const tradeAmount = received[position.tradeToken.address] || 0n;
      const stableDirect = received[position.stablecoin.address] || 0n;
      action.pendingSwap = tradeAmount > 0n ? {
        tokenIn: position.tradeToken.address,
        tokenOut: position.stablecoin.address,
        amountIn: tradeAmount.toString(),
        inputDecimals: position.tradeToken.decimals,
        outputDecimals: position.stablecoin.decimals
      } : null;
      action.stableDirect = stableDirect.toString();
      await persist(action);
      if (tradeAmount > 0n) {
        const swapResult = await executeExactSwap({
          provider,
          wallet,
          config,
          environment,
          tokenIn: position.tradeToken.address,
          tokenOut: position.stablecoin.address,
          amountIn: tradeAmount,
          inputDecimals: position.tradeToken.decimals,
          outputDecimals: position.stablecoin.decimals,
          action,
          persist,
          kind: 'zap_out_swap'
        });
        action.stableFromSwap = swapResult.received.toString();
      } else {
        action.stableFromSwap = '0';
      }
      action.pendingSwap = null;
      action.finalStableReceived = (stableDirect + BigInt(action.stableFromSwap)).toString();
      action.stage = 'completed';
      action.completedAt = new Date().toISOString();
      await persist(action);
      res.json(action);
    } catch (error) {
      if (action) {
        if (error.transactionConfirmedFailed && action.currentTx) {
          action.transactions.push({
            ...action.currentTx,
            status: 'failed',
            confirmedAt: new Date().toISOString()
          });
          action.currentTx = null;
        }
        const withdrawalConfirmed = action.transactions?.some((entry) => (
          entry.kind === 'decrease_liquidity' && entry.status === 'confirmed'
        ));
        const cleanupPending = Boolean(action.cleanupContext);
        action.stage = action.currentTx?.hash || cleanupPending || (withdrawalConfirmed && action.pendingSwap)
          ? 'needs_attention'
          : 'failed';
        action.error = cleanupPending
          ? action.cleanupWarning || error.message
          : withdrawalConfirmed && action.pendingSwap
            ? `流动性已撤出，稳定币兑换待处理：${error.message}`
            : error.message;
        action.failedAt = new Date().toISOString();
        await persist(action);
      }
      res.status(action?.stage === 'needs_attention' ? 409 : 400).json({
        error: action?.error || error.message,
        action: action || null
      });
    } finally {
      if (lockAcquired) inFlight = false;
      provider?.destroy();
    }
  });

  router.post('/retry-swap', async (req, res) => {
    let provider;
    let lockAcquired = false;
    try {
      await ready;
      if (req.body.confirmed !== true) throw new Error('必须确认重试待处理兑换');
      if (environment.LIQUIDITY_EXECUTE !== 'true') throw new Error('LIQUIDITY_EXECUTE=false，请先开启流动性执行开关');
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY');
      if (!okxCredentialsConfigured(environment)) throw new Error('稳定币自动兑换缺少 OKX API 配置');
      if (inFlight) throw new Error('已有仓位任务正在执行');
      if (lastAction?.stage !== 'needs_attention' || !lastAction.pendingSwap) {
        throw new Error('当前没有可重试的撤出后兑换');
      }
      if (lastAction.operation !== 'emergency') {
        throw new Error('当前版本仅紧急撤退支持自动兑换；减仓保持双币到账');
      }
      if (lastAction.currentTx?.hash) throw new Error('仍有待核对交易，不能重复兑换');
      const conflict = executionConflict();
      if (conflict) throw new Error(conflict);
      inFlight = true;
      lockAcquired = true;
      const config = await readJson(configPath);
      const wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      if (wallet.address !== lastAction.wallet) throw new Error('当前执行钱包与待处理任务不一致');
      provider = await openProvider(config);
      const pending = lastAction.pendingSwap;
      const currentBalance = await new ethers.Contract(pending.tokenIn, ERC20_ABI, provider)
        .balanceOf(wallet.address);
      if (currentBalance < BigInt(pending.amountIn)) throw new Error('待兑换代币余额已经不足');
      const result = await executeExactSwap({
        provider,
        wallet,
        config,
        environment,
        tokenIn: pending.tokenIn,
        tokenOut: pending.tokenOut,
        amountIn: BigInt(pending.amountIn),
        inputDecimals: pending.inputDecimals,
        outputDecimals: pending.outputDecimals,
        action: lastAction,
        persist,
        kind: 'zap_out_swap_retry'
      });
      lastAction.stableFromSwap = result.received.toString();
      lastAction.finalStableReceived = (
        BigInt(lastAction.stableDirect || 0) + result.received
      ).toString();
      lastAction.pendingSwap = null;
      lastAction.currentTx = null;
      lastAction.error = null;
      lastAction.stage = 'completed';
      lastAction.completedAt = new Date().toISOString();
      await persist(lastAction);
      res.json(lastAction);
    } catch (error) {
      if (lastAction?.pendingSwap || lastAction?.cleanupContext || lastAction?.currentTx?.hash) {
        lastAction.stage = 'needs_attention';
        lastAction.error = lastAction.cleanupContext
          ? lastAction.cleanupWarning || error.message
          : `流动性已撤出，稳定币兑换待处理：${error.message}`;
        await persist(lastAction);
      }
      res.status(lastAction?.stage === 'needs_attention' ? 409 : 400).json({
        error: lastAction?.error || error.message,
        action: lastAction
      });
    } finally {
      if (lockAcquired) inFlight = false;
      provider?.destroy();
    }
  });

  router.post('/retry-cleanup', async (req, res) => {
    let provider;
    let lockAcquired = false;
    try {
      await ready;
      if (req.body.confirmed !== true) throw new Error('必须确认重试授权清理');
      if (environment.LIQUIDITY_EXECUTE !== 'true') throw new Error('LIQUIDITY_EXECUTE=false，请先开启流动性执行开关');
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY');
      if (inFlight) throw new Error('已有仓位任务正在执行');
      if (lastAction?.stage !== 'needs_attention' || !lastAction.cleanupContext) {
        throw new Error('当前没有可重试的授权清理');
      }
      if (lastAction.currentTx?.hash) throw new Error('仍有待核对交易，不能重复清理授权');
      const conflict = executionConflict();
      if (conflict) throw new Error(conflict);
      inFlight = true;
      lockAcquired = true;
      const config = await readJson(configPath);
      const wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      if (wallet.address !== lastAction.wallet) throw new Error('当前执行钱包与待处理任务不一致');
      provider = await openProvider(config);
      const context = lastAction.cleanupContext;
      const tokenAddress = ethers.getAddress(context.tokenAddress || lastAction.swap?.tokenIn);
      const spender = context.spender
        ? ethers.getAddress(context.spender)
        : await managementSwapApprovalSpender({
          token: tokenAddress,
          amount: BigInt(lastAction.swap?.amountIn || 1),
          config,
          environment
        });
      context.tokenAddress = tokenAddress;
      context.spender = spender;
      lastAction.stage = 'cleaning_swap_approval';
      await persist(lastAction);
      await ensureTokenAllowance(
        provider,
        wallet,
        config,
        tokenAddress,
        spender,
        0n,
        lastAction,
        persist,
        `${context.swapKind || 'swap'}_cleanup_retry`
      );
      finalizeCleanupRecovery(lastAction);
      await persist(lastAction);
      res.json(lastAction);
    } catch (error) {
      if (lastAction?.cleanupContext) {
        lastAction.stage = 'needs_attention';
        lastAction.cleanupWarning = `OKX 授权清理仍待处理：${error.message}`;
        lastAction.error = lastAction.cleanupWarning;
        await persist(lastAction);
      }
      res.status(lastAction?.stage === 'needs_attention' ? 409 : 400).json({
        error: lastAction?.error || error.message,
        action: lastAction
      });
    } finally {
      if (lockAcquired) inFlight = false;
      provider?.destroy();
    }
  });

  router.post('/resolve', async (req, res) => {
    let provider;
    let lockAcquired = false;
    try {
      await ready;
      if (req.body.confirmed !== true) throw new Error('必须确认核对链上交易');
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY');
      if (inFlight) throw new Error('仓位任务执行中');
      if (lastAction?.stage !== 'needs_attention' || !lastAction.currentTx?.hash) {
        throw new Error('当前没有待核对交易');
      }
      inFlight = true;
      lockAcquired = true;
      const config = await readJson(configPath);
      provider = await openProvider(config);
      const receipt = await provider.getTransactionReceipt(lastAction.currentTx.hash);
      if (!receipt) throw new Error('交易尚未取得链上回执，请稍后重试');
      const pending = lastAction.currentTx;
      const resolvedTransaction = transactionEntry(pending.kind, pending.hash, receipt);
      const resolvingCleanup = cleanupTransactionPending(lastAction, pending);
      if (resolvingCleanup && (!lastAction.cleanupContext.spender || !lastAction.cleanupContext.tokenAddress)) {
        try {
          const transaction = await provider.getTransaction(pending.hash);
          const parsed = transaction?.data
            ? ERC20_INTERFACE.parseTransaction({ data: transaction.data, value: transaction.value })
            : null;
          if (parsed?.name === 'approve') {
            lastAction.cleanupContext.tokenAddress = ethers.getAddress(transaction.to);
            lastAction.cleanupContext.spender = ethers.getAddress(parsed.args.spender);
          }
        } catch {
          // A confirmed successful cleanup can still be finalized without reconstructing its calldata.
        }
      }
      if (Number(receipt.status) !== 1) {
        lastAction.transactions ||= [];
        lastAction.transactions.push(resolvedTransaction);
        lastAction.currentTx = null;
        if (resolvingCleanup) {
          lastAction.stage = 'needs_attention';
          lastAction.cleanupWarning = '授权清理交易链上执行失败，请重新清理授权';
          lastAction.error = lastAction.cleanupWarning;
        } else {
          lastAction.stage = lastAction.pendingSwap ? 'needs_attention' : 'failed';
          lastAction.error = lastAction.pendingSwap
            ? '上一笔兑换交易执行失败，可以安全重试兑换'
            : '上一笔仓位交易链上执行失败';
        }
        await persist(lastAction);
        return res.json(lastAction);
      }
      if (resolvingCleanup) {
        lastAction.transactions ||= [];
        lastAction.transactions.push(resolvedTransaction);
        lastAction.currentTx = null;
        finalizeCleanupRecovery(lastAction);
        await persist(lastAction);
        return res.json(lastAction);
      }
      const wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      const position = await readPosition(provider, config, lastAction.nftId, wallet.address);
      if (pending.kind === 'increase_liquidity') {
        if (position.liquidity <= BigInt(lastAction.baselineLiquidity)) {
          throw new Error('补仓交易成功，但链上流动性没有增加');
        }
        lastAction.finalLiquidity = position.liquidity.toString();
        lastAction.stage = 'completed';
        lastAction.error = null;
        lastAction.completedAt = new Date().toISOString();
      } else if (pending.kind === 'decrease_liquidity') {
        const expectedLiquidity = BigInt(lastAction.baselineLiquidity)
          - BigInt(lastAction.removalLiquidity);
        if (position.liquidity !== expectedLiquidity) {
          throw new Error('撤出交易已确认，但 NFT 剩余流动性与请求不一致');
        }
        const tokens = [lastAction.token0.address, lastAction.token1.address];
        let received = receivedAmountsFromLogs(receipt, tokens, wallet.address);
        let receivedAmountSource = 'receipt_transfer_logs';
        if (!received) {
          if (!Number.isInteger(receipt.blockNumber) || receipt.blockNumber <= 0) {
            throw new Error('撤出交易已确认，但无法确定用于恢复余额的区块');
          }
          const [before, after] = await Promise.all([
            balanceSnapshot(provider, tokens, wallet.address, receipt.blockNumber - 1),
            balanceSnapshot(provider, tokens, wallet.address, receipt.blockNumber)
          ]);
          received = Object.fromEntries(tokens.map((token) => {
            const address = ethers.getAddress(token);
            if (after[address] < before[address]) {
              throw new Error('撤出确认区块的余额变化异常，不能自动恢复到账数量');
            }
            return [address, after[address] - before[address]];
          }));
          receivedAmountSource = 'historical_balance_delta';
        }
        lastAction.receivedAmountSource = receivedAmountSource;
        lastAction.receivedAmounts = Object.fromEntries(
          Object.entries(received).map(([token, amount]) => [token, amount.toString()])
        );
        lastAction.finalLiquidity = position.liquidity.toString();
        if (managementOperationUsesAutoSwap(lastAction.operation)) {
          const tradeAmount = received[lastAction.tradeToken.address] || 0n;
          const stableDirect = received[lastAction.stablecoin.address] || 0n;
          lastAction.stableDirect = stableDirect.toString();
          lastAction.pendingSwap = tradeAmount > 0n ? {
            tokenIn: lastAction.tradeToken.address,
            tokenOut: lastAction.stablecoin.address,
            amountIn: tradeAmount.toString(),
            inputDecimals: lastAction.tradeToken.decimals,
            outputDecimals: lastAction.stablecoin.decimals
          } : null;
          lastAction.stage = lastAction.pendingSwap ? 'needs_attention' : 'completed';
          lastAction.error = lastAction.pendingSwap
            ? '流动性已撤出，实际到账数量已恢复；请仅重试稳定币兑换'
            : null;
        } else {
          lastAction.stage = 'completed';
          lastAction.error = null;
        }
        if (lastAction.stage === 'completed') lastAction.completedAt = new Date().toISOString();
      } else if (pending.kind === 'zap_in_swap') {
        const tradeLogs = receivedAmountsFromLogs(
          receipt,
          [lastAction.tradeToken.address],
          wallet.address
        );
        if (!tradeLogs) throw new Error('Zap In 兑换成功，但无法从回执确认交易代币实际到账');
        const received = tradeLogs[lastAction.tradeToken.address];
        lastAction.swap = {
          ...(lastAction.swap || {}),
          status: 'confirmed',
          hash: receipt.hash,
          amountSpent: lastAction.swap?.amountIn,
          amountReceived: received.toString(),
          confirmedAt: new Date().toISOString()
        };
        lastAction.stage = 'failed';
        lastAction.error = 'Zap In 兑换已确认，但补仓交易尚未执行；系统不会重复兑换，请人工处理钱包中的双币';
      } else if (pending.kind === 'zap_out_swap' || pending.kind === 'zap_out_swap_retry') {
        const stableLogs = receivedAmountsFromLogs(
          receipt,
          [lastAction.stablecoin.address],
          wallet.address
        );
        if (!stableLogs) throw new Error('兑换交易成功，但无法从回执确认稳定币实际到账');
        const received = stableLogs[lastAction.stablecoin.address];
        lastAction.stableFromSwap = received.toString();
        lastAction.finalStableReceived = (
          BigInt(lastAction.stableDirect || 0) + received
        ).toString();
        lastAction.pendingSwap = null;
        lastAction.stage = 'completed';
        lastAction.error = null;
        lastAction.completedAt = new Date().toISOString();
      } else {
        lastAction.stage = lastAction.pendingSwap ? 'needs_attention' : 'failed';
        lastAction.error = lastAction.pendingSwap
          ? '兑换授权交易已确认，可以安全地仅重试稳定币兑换'
          : '授权交易已确认；为避免自动续跑，请重新发起仓位操作';
      }
      lastAction.transactions ||= [];
      lastAction.transactions.push(resolvedTransaction);
      lastAction.currentTx = null;
      await persist(lastAction);
      res.json(lastAction);
    } catch (error) {
      if (lastAction?.currentTx?.hash) {
        lastAction.stage = 'needs_attention';
        lastAction.error = `链上交易仍待核对：${error.message}`;
        await persist(lastAction);
      }
      res.status(400).json({ error: error.message, action: lastAction });
    } finally {
      if (lockAcquired) inFlight = false;
      provider?.destroy();
    }
  });

  Object.defineProperty(router, 'isExecutionInFlight', {
    value: () => inFlight
  });
  Object.defineProperty(router, 'hasBlockingAction', {
    value: () => !readySettled || Boolean(readyError) || inFlight || managementActionBlocksExecution(lastAction)
  });
  return router;
}
