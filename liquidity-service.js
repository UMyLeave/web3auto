import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import { ethers } from 'ethers';
import {
  okxApprovalSpender,
  okxCredentialsConfigured,
  prepareStableToTradeSwap,
  quoteStableToTrade
} from './liquidity-swap-service.js';
import {
  publicHookPresets,
  verifyConfiguredWhitelistHook
} from './liquidity-hook-service.js';

const CHAIN_ID = 56n;
const ZERO = ethers.ZeroAddress;
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const UINT24_MASK = 0xffffffn;
const UINT160_MASK = (1n << 160n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MAX_TICK_SPACING = 32767;
const EXECUTION_MODE_INITIALIZE_ONLY = 'initialize_only';
const EXECUTION_MODE_INITIALIZE_AND_ADD = 'initialize_and_add';
const ERC721_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const POSITION_ABI = [
  'function poolManager() view returns (address)',
  'function permit2() view returns (address)',
  'function nextTokenId() view returns (uint256)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256 info)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)'
];
const ERC20_ABI = [
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

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, path);
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

export function integerSqrt(value) {
  if (value < 0n) throw new Error('不能计算负数平方根');
  if (value < 2n) return value;
  let result = 1n << ((BigInt(value.toString(2).length) + 1n) / 2n);
  while (true) {
    const next = (result + value / result) >> 1n;
    if (next >= result) return result;
    result = next;
  }
}

export function decimalFraction(value, label = '数值') {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${label}必须是正数`);
  const fraction = match[2] || '';
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1]) * denominator + BigInt(fraction || '0');
  if (numerator <= 0n) throw new Error(`${label}必须大于 0`);
  return { numerator, denominator, text };
}

function fractionToUnits(numerator, denominator, decimals) {
  return numerator * (10n ** BigInt(decimals)) / denominator;
}

export function sqrtPriceAtTick(tick) {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > 887272n) throw new Error(`Tick 超出范围: ${tick}`);
  let ratio = absTick & 0x1n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const multipliers = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n]
  ];
  for (const [bit, multiplier] of multipliers) {
    if (absTick & bit) ratio = ratio * multiplier >> 128n;
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  const remainder = ratio & ((1n << 32n) - 1n);
  return (ratio >> 32n) + (remainder === 0n ? 0n : 1n);
}

export function priceToSqrtPriceX96(priceValue, tradeDecimals, quoteDecimals, tradeIsCurrency0) {
  const price = decimalFraction(priceValue, '代币价格');
  const numerator = tradeIsCurrency0
    ? price.numerator * (10n ** BigInt(quoteDecimals))
    : price.denominator * (10n ** BigInt(tradeDecimals));
  const denominator = tradeIsCurrency0
    ? price.denominator * (10n ** BigInt(tradeDecimals))
    : price.numerator * (10n ** BigInt(quoteDecimals));
  const sqrtPriceX96 = integerSqrt(numerator * Q192 / denominator);
  if (sqrtPriceX96 < sqrtPriceAtTick(MIN_TICK) || sqrtPriceX96 >= sqrtPriceAtTick(MAX_TICK)) {
    throw new Error('代币价格超出 Uniswap v4 支持范围');
  }
  return sqrtPriceX96;
}

export function tickAtSqrtPrice(sqrtPriceX96) {
  const target = BigInt(sqrtPriceX96);
  if (target < sqrtPriceAtTick(MIN_TICK) || target >= sqrtPriceAtTick(MAX_TICK)) {
    throw new Error('sqrtPriceX96 超出 Tick 范围');
  }
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sqrtPriceAtTick(middle) <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

function signed24(value) {
  const raw = BigInt(value) & UINT24_MASK;
  return Number(raw >= 0x800000n ? raw - 0x1000000n : raw);
}

export function poolIdOf(poolKey) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
  ));
}

function usableTickFloor(tick, spacing) {
  return Math.max(
    Math.ceil(MIN_TICK / spacing) * spacing,
    Math.floor(tick / spacing) * spacing
  );
}

function usableTickCeil(tick, spacing) {
  return Math.min(
    Math.floor(MAX_TICK / spacing) * spacing,
    Math.ceil(tick / spacing) * spacing
  );
}

export function liquidityRangeTicks(input, currentTick, tradeIsCurrency0, tradeDecimals, quoteDecimals) {
  const spacing = input.tickSpacing;
  if (input.rangeType === 'full') {
    return {
      tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
      tickUpper: Math.floor(MAX_TICK / spacing) * spacing
    };
  }
  let rawLower;
  let rawUpper;
  if (input.rangeType === 'custom') {
    const lowerTick = tickAtSqrtPrice(priceToSqrtPriceX96(
      input.lowerPrice,
      tradeDecimals,
      quoteDecimals,
      tradeIsCurrency0
    ));
    const upperTick = tickAtSqrtPrice(priceToSqrtPriceX96(
      input.upperPrice,
      tradeDecimals,
      quoteDecimals,
      tradeIsCurrency0
    ));
    rawLower = Math.min(lowerTick, upperTick);
    rawUpper = Math.max(lowerTick, upperTick);
  } else {
    const percent = Number(input.rangePercent) / 100;
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 1) {
      throw new Error('初始化区间百分比必须大于 0 且小于 100');
    }
    const lowerRatio = tradeIsCurrency0 ? 1 - percent : 1 / (1 + percent);
    const upperRatio = tradeIsCurrency0 ? 1 + percent : 1 / (1 - percent);
    rawLower = currentTick + Math.floor(Math.log(lowerRatio) / Math.log(1.0001));
    rawUpper = currentTick + Math.ceil(Math.log(upperRatio) / Math.log(1.0001));
  }
  const tickLower = usableTickFloor(Math.min(rawLower, rawUpper), spacing);
  const tickUpper = usableTickCeil(Math.max(rawLower, rawUpper), spacing);
  if (tickLower >= tickUpper) throw new Error('初始化区间过窄，无法按 Tick Spacing 对齐');
  if (currentTick < tickLower || currentTick >= tickUpper) {
    throw new Error('池子当前价格不在所选流动性区间内');
  }
  return { tickLower, tickUpper };
}

export function resolveLiquidityRangeTicks(
  input,
  currentTick,
  tradeIsCurrency0,
  tradeDecimals,
  quoteDecimals,
  fixedTicks = null
) {
  const range = fixedTicks
    ? {
      tickLower: Number(fixedTicks.tickLower),
      tickUpper: Number(fixedTicks.tickUpper)
    }
    : liquidityRangeTicks(
      input,
      currentTick,
      tradeIsCurrency0,
      tradeDecimals,
      quoteDecimals
    );
  if (!Number.isInteger(range.tickLower) || !Number.isInteger(range.tickUpper)) {
    throw new Error('锁定的流动性区间无效');
  }
  if (range.tickLower % input.tickSpacing !== 0 || range.tickUpper % input.tickSpacing !== 0) {
    throw new Error('锁定的流动性区间未按 Tick Spacing 对齐');
  }
  if (range.tickLower >= range.tickUpper) throw new Error('锁定的流动性区间无效');
  if (currentTick < range.tickLower || currentTick >= range.tickUpper) {
    throw new Error('池子当前价格已离开预检时锁定的流动性区间');
  }
  return range;
}

export function stableBudgetAllocation(
  budgetValue,
  priceValue,
  tradeDecimals,
  quoteDecimals,
  tradeIsCurrency0,
  sqrtPriceX96,
  tickLower,
  tickUpper
) {
  const budget = decimalFraction(budgetValue, '投入稳定币');
  const price = decimalFraction(priceValue, '代币价格');
  const stableBudget = fractionToUnits(budget.numerator, budget.denominator, quoteDecimals);
  if (stableBudget <= 0n) throw new Error('投入稳定币金额过小');

  const sample = principalAmounts(
    MAX_UINT128,
    BigInt(sqrtPriceX96),
    tickLower,
    tickUpper
  );
  const sampleTrade = tradeIsCurrency0 ? sample.amount0 : sample.amount1;
  const sampleQuote = tradeIsCurrency0 ? sample.amount1 : sample.amount0;
  if (sampleTrade === 0n) {
    return {
      stableBudget,
      stableToSwap: 0n,
      quoteAmount: stableBudget,
      tradeAmount: 0n,
      sampleTrade,
      sampleQuote
    };
  }
  if (sampleQuote === 0n) {
    const tradeAmount = fractionToUnits(
      budget.numerator * price.denominator,
      budget.denominator * price.numerator,
      tradeDecimals
    );
    return {
      stableBudget,
      stableToSwap: stableBudget,
      quoteAmount: 0n,
      tradeAmount,
      sampleTrade,
      sampleQuote
    };
  }

  const tradeValueDenominator = price.denominator * (10n ** BigInt(tradeDecimals));
  const sampleTradeValueNumerator = sampleTrade
    * price.numerator
    * (10n ** BigInt(quoteDecimals));
  const sampleQuoteValueNumerator = sampleQuote * tradeValueDenominator;
  const totalValueNumerator = sampleTradeValueNumerator + sampleQuoteValueNumerator;
  const quoteAmount = stableBudget * sampleQuoteValueNumerator / totalValueNumerator;
  const stableToSwap = stableBudget - quoteAmount;
  const tradeAmount = stableToSwap
    * tradeValueDenominator
    / (price.numerator * (10n ** BigInt(quoteDecimals)));
  return {
    stableBudget,
    stableToSwap,
    quoteAmount,
    tradeAmount,
    sampleTrade,
    sampleQuote
  };
}

export function optimizedStableSwapAmount(
  stableBudget,
  desiredTradeAmount,
  desiredQuoteAmount,
  quotedAmountIn,
  quotedAmountOut
) {
  const budget = BigInt(stableBudget);
  const desiredTrade = BigInt(desiredTradeAmount);
  const desiredQuote = BigInt(desiredQuoteAmount);
  const quoteIn = BigInt(quotedAmountIn);
  const quoteOut = BigInt(quotedAmountOut);
  if (budget <= 0n) throw new Error('投入稳定币必须大于 0');
  if (desiredTrade === 0n) return 0n;
  if (desiredQuote === 0n) return budget;
  if (quoteIn <= 0n || quoteOut <= 0n) throw new Error('自动分配报价数量无效');
  const amount = budget * desiredTrade * quoteIn
    / (quoteOut * desiredQuote + desiredTrade * quoteIn);
  return amount <= 0n ? 1n : (amount > budget ? budget : amount);
}

function principalAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  const sqrtLower = sqrtPriceAtTick(tickLower);
  const sqrtUpper = sqrtPriceAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtLower) {
    return {
      amount0: liquidity * (sqrtUpper - sqrtLower) * Q96 / (sqrtLower * sqrtUpper),
      amount1: 0n
    };
  }
  if (sqrtPriceX96 < sqrtUpper) {
    return {
      amount0: liquidity * (sqrtUpper - sqrtPriceX96) * Q96 / (sqrtPriceX96 * sqrtUpper),
      amount1: liquidity * (sqrtPriceX96 - sqrtLower) / Q96
    };
  }
  return {
    amount0: 0n,
    amount1: liquidity * (sqrtUpper - sqrtLower) / Q96
  };
}

export function liquidityForAmounts(amount0, amount1, sqrtPriceX96, tickLower, tickUpper) {
  const sqrtLower = sqrtPriceAtTick(tickLower);
  const sqrtUpper = sqrtPriceAtTick(tickUpper);
  let liquidity;
  if (sqrtPriceX96 <= sqrtLower) {
    liquidity = amount0 * sqrtLower * sqrtUpper / ((sqrtUpper - sqrtLower) * Q96);
  } else if (sqrtPriceX96 < sqrtUpper) {
    const liquidity0 = amount0 * sqrtPriceX96 * sqrtUpper / ((sqrtUpper - sqrtPriceX96) * Q96);
    const liquidity1 = amount1 * Q96 / (sqrtPriceX96 - sqrtLower);
    liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  } else {
    liquidity = amount1 * Q96 / (sqrtUpper - sqrtLower);
  }
  if (liquidity <= 0n) throw new Error('初始化金额过小，无法生成非零流动性');
  return liquidity;
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

export function normalizeLiquidityInput(body, config) {
  let tradeToken;
  let quoteToken;
  let hooks;
  try {
    tradeToken = ethers.getAddress(String(body.tradeToken || '').trim());
    quoteToken = ethers.getAddress(String(body.quoteToken || '').trim());
    hooks = ethers.getAddress(String(body.hooks || ZERO).trim());
  } catch {
    throw new Error('代币或 Hooks 合约地址格式错误');
  }
  if (tradeToken === ZERO || quoteToken === ZERO) throw new Error('当前页面只支持 ERC20/ERC20 池');
  if (tradeToken === quoteToken) throw new Error('交易代币和计价代币不能相同');
  const stablecoin = normalizeStablecoins(config)
    .find((entry) => entry.address.toLowerCase() === quoteToken.toLowerCase());
  if (!stablecoin) throw new Error('计价代币必须来自流动性模块的稳定币白名单');

  const executionMode = String(body.executionMode || EXECUTION_MODE_INITIALIZE_AND_ADD);
  if (![EXECUTION_MODE_INITIALIZE_ONLY, EXECUTION_MODE_INITIALIZE_AND_ADD].includes(executionMode)) {
    throw new Error('无法识别初始化执行模式');
  }
  const addsLiquidity = executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD;
  const price = decimalFraction(body.price, '代币价格');
  let budget = null;
  if (addsLiquidity) {
    budget = decimalFraction(body.budget, '投入稳定币');
    const maximumBudget = decimalFraction(config.maxStableBudget ?? 1000, '稳定币投入安全上限');
    if (budget.numerator * maximumBudget.denominator > maximumBudget.numerator * budget.denominator) {
      throw new Error(`稳定币投入超过安全上限 ${config.maxStableBudget ?? 1000} ${stablecoin.symbol}`);
    }
  }

  const feeFraction = decimalFraction(body.feePercent, 'V4 费率');
  const feeDecimals = feeFraction.text.split('.')[1] || '';
  if (feeDecimals.length > 4) {
    throw new Error('V4 费率最多支持 4 位小数（最小精度 0.0001%）');
  }
  const fee = Number(feeFraction.numerator * 10_000n / feeFraction.denominator);
  const maxFee = Number(config.maxFeePercent ?? 10);
  if (!Number.isSafeInteger(fee) || fee <= 0 || fee > maxFee * 10_000) {
    throw new Error(`V4 费率必须大于 0 且不超过 ${maxFee}%`);
  }
  const tickSpacing = Number(body.tickSpacing);
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > MAX_TICK_SPACING) {
    throw new Error(`Tick Spacing 必须是 1 到 ${MAX_TICK_SPACING} 的整数`);
  }

  const rangeType = addsLiquidity ? String(body.rangeType || 'percent') : null;
  if (addsLiquidity && !['percent', 'full', 'custom'].includes(rangeType)) {
    throw new Error('无法识别初始化区间');
  }
  let lowerPrice = null;
  let upperPrice = null;
  if (rangeType === 'custom') {
    lowerPrice = decimalFraction(body.lowerPrice, '最低价格').text;
    upperPrice = decimalFraction(body.upperPrice, '最高价格').text;
    const lower = decimalFraction(lowerPrice);
    const upper = decimalFraction(upperPrice);
    if (lower.numerator * upper.denominator >= upper.numerator * lower.denominator) {
      throw new Error('自定义最低价格必须小于最高价格');
    }
  }
  return {
    tradeToken,
    quoteToken,
    quoteSymbol: stablecoin.symbol,
    executionMode,
    price: price.text,
    budget: budget?.text || null,
    fee,
    feePercent: fee / 10_000,
    tickSpacing,
    hooks,
    acknowledgeCustomHooks: body.acknowledgeCustomHooks === true,
    rangeType,
    rangePercent: addsLiquidity && rangeType === 'percent' ? String(body.rangePercent || '90') : null,
    lowerPrice,
    upperPrice
  };
}

export function liquidityExecutionFingerprint(input) {
  const payload = {
    tradeToken: ethers.getAddress(input.tradeToken).toLowerCase(),
    quoteToken: ethers.getAddress(input.quoteToken).toLowerCase(),
    executionMode: String(input.executionMode || EXECUTION_MODE_INITIALIZE_AND_ADD),
    price: String(input.price),
    budget: input.budget === null ? null : String(input.budget),
    fee: Number(input.fee),
    tickSpacing: Number(input.tickSpacing),
    hooks: ethers.getAddress(input.hooks).toLowerCase(),
    acknowledgeCustomHooks: input.acknowledgeCustomHooks === true,
    rangeType: input.rangeType === null ? null : String(input.rangeType),
    rangePercent: input.rangePercent === null ? null : String(input.rangePercent),
    lowerPrice: input.lowerPrice === null ? null : String(input.lowerPrice),
    upperPrice: input.upperPrice === null ? null : String(input.upperPrice)
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
}

export function assertLiquidityPreviewAuthorization(
  authorization,
  { previewId, fingerprint, owner, now = Date.now() }
) {
  if (!previewId || !authorization || authorization.id !== previewId) {
    throw new Error('执行前必须重新完成一次只读预检');
  }
  if (!Number.isFinite(authorization.expiresAt) || now > authorization.expiresAt) {
    throw new Error('只读预检已过期，请重新预检后再执行');
  }
  if (authorization.fingerprint !== fingerprint) {
    throw new Error('执行参数与刚才的只读预检不一致，请重新预检');
  }
  if (authorization.owner.toLowerCase() !== ethers.getAddress(owner).toLowerCase()) {
    throw new Error('执行钱包与只读预检钱包不一致，请重新预检');
  }
}

export function exactAllowanceActions(currentAllowance, requiredAllowance) {
  const current = BigInt(currentAllowance);
  const required = BigInt(requiredAllowance);
  if (current < 0n || required < 0n) throw new Error('授权金额不能为负数');
  if (current === required) return [];
  return current > 0n ? ['reset', ...(required > 0n ? ['approve'] : [])] : ['approve'];
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

async function poolState(provider, poolManagerAddress, poolKey) {
  const poolId = poolIdOf(poolKey);
  const poolsSlot = ethers.zeroPadValue(ethers.toBeHex(6), 32);
  const stateSlot = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [poolId, poolsSlot]));
  const manager = new ethers.Contract(poolManagerAddress, POOL_MANAGER_ABI, provider);
  const slot0 = BigInt(await manager.extsload(stateSlot));
  const sqrtPriceX96 = slot0 & UINT160_MASK;
  return {
    poolId,
    initialized: sqrtPriceX96 !== 0n,
    sqrtPriceX96,
    currentTick: sqrtPriceX96 === 0n ? null : signed24(slot0 >> 160n)
  };
}

export function encodeMintLiquidity(poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner) {
  const actions = ethers.concat(['0x02', '0x0d']);
  const params = [
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',
        'int24',
        'int24',
        'uint256',
        'uint128',
        'uint128',
        'address',
        'bytes'
      ],
      [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, '0x']
    ),
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address'],
      [poolKey.currency0, poolKey.currency1]
    )
  ];
  return ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes[]'], [actions, params]);
}

export function encodeInitializePool(poolKey, sqrtPriceX96) {
  return POSITION_INTERFACE.encodeFunctionData('initializePool', [poolKey, sqrtPriceX96]);
}

export function encodeLiquidityTransaction(plan, owner, deadline) {
  const unlockData = encodeMintLiquidity(
    plan.poolKey,
    plan.tickLower,
    plan.tickUpper,
    plan.liquidity,
    plan.amount0Max,
    plan.amount1Max,
    owner
  );
  const mintCall = POSITION_INTERFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
  return POSITION_INTERFACE.encodeFunctionData('multicall', [[mintCall]]);
}

export function assertPoolAvailableForCreation(pool) {
  if (pool?.initialized) {
    throw new Error(
      '相同交易代币、稳定币、费率、Tick Spacing 和 Hooks 的池子已存在；'
      + '当前页面只创建新池，不会继续向已有池添加流动性'
    );
  }
}

export function assertExecutionPlanInvariant(plan, authorization, requireInitialized = false) {
  if (plan.pool.poolId.toLowerCase() !== authorization.poolId.toLowerCase()) {
    throw new Error('执行期间 PoolKey 与预检结果不一致，已停止执行');
  }
  if (plan.requestedSqrtPriceX96.toString() !== authorization.requestedSqrtPriceX96) {
    throw new Error('执行期间初始价格与预检结果不一致，已停止执行');
  }
  if (plan.input?.executionMode !== EXECUTION_MODE_INITIALIZE_ONLY
    && (plan.tickLower !== authorization.tickLower || plan.tickUpper !== authorization.tickUpper)) {
    throw new Error('执行期间流动性区间与预检结果不一致，已停止执行');
  }
  if (requireInitialized && !plan.pool.initialized) {
    throw new Error('建池交易已确认，但未读取到目标池初始化状态；已在兑换前停止');
  }
}

async function buildPlan(
  provider,
  config,
  body,
  owner = null,
  estimateGas = true,
  fixedAmountCaps = null,
  allowInitializedPool = false,
  fixedTicks = null
) {
  const input = normalizeLiquidityInput(body, config);
  const addsLiquidity = input.executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD;
  const positionManagerAddress = ethers.getAddress(config.positionManager);
  const positionManager = new ethers.Contract(positionManagerAddress, POSITION_ABI, provider);
  const [trade, quote, poolManagerAddress, permit2Address, nextTokenId] = await Promise.all([
    strictTokenMetadata(provider, input.tradeToken),
    strictTokenMetadata(provider, input.quoteToken),
    positionManager.poolManager(),
    addsLiquidity ? positionManager.permit2() : Promise.resolve(null),
    addsLiquidity ? positionManager.nextTokenId() : Promise.resolve(null)
  ]);
  if (input.hooks !== ZERO) {
    const hookCode = await provider.getCode(input.hooks);
    if (!hookCode || hookCode === '0x') throw new Error('自定义 Hooks 地址没有部署合约代码');
    if (owner) {
      await verifyConfiguredWhitelistHook({
        provider,
        config,
        selectedHook: input.hooks,
        walletAddress: owner,
        positionManager: positionManagerAddress,
        poolManager: poolManagerAddress
      });
    }
  }

  const tradeIsCurrency0 = BigInt(trade.address) < BigInt(quote.address);
  const poolKey = {
    currency0: tradeIsCurrency0 ? trade.address : quote.address,
    currency1: tradeIsCurrency0 ? quote.address : trade.address,
    fee: input.fee,
    tickSpacing: input.tickSpacing,
    hooks: input.hooks
  };
  const currentPool = await poolState(provider, ethers.getAddress(poolManagerAddress), poolKey);
  if (!allowInitializedPool) assertPoolAvailableForCreation(currentPool);
  const requestedSqrtPriceX96 = priceToSqrtPriceX96(
    input.price,
    trade.decimals,
    quote.decimals,
    tradeIsCurrency0
  );
  const activeSqrtPriceX96 = currentPool.initialized
    ? currentPool.sqrtPriceX96
    : requestedSqrtPriceX96;
  const currentTick = currentPool.initialized
    ? currentPool.currentTick
    : tickAtSqrtPrice(requestedSqrtPriceX96);
  const activePrice = currentPool.initialized
    ? sqrtPriceToHumanPrice(activeSqrtPriceX96, trade.decimals, quote.decimals, tradeIsCurrency0)
    : input.price;
  let tickLower = null;
  let tickUpper = null;
  let allocation = null;
  let amount0Max = 0n;
  let amount1Max = 0n;
  let liquidity = 0n;
  let estimatedAmounts = { amount0: 0n, amount1: 0n };
  if (addsLiquidity) {
    ({ tickLower, tickUpper } = resolveLiquidityRangeTicks(
      input,
      currentTick,
      tradeIsCurrency0,
      trade.decimals,
      quote.decimals,
      fixedTicks
    ));
    allocation = stableBudgetAllocation(
      input.budget,
      activePrice,
      trade.decimals,
      quote.decimals,
      tradeIsCurrency0,
      activeSqrtPriceX96,
      tickLower,
      tickUpper
    );
    amount0Max = fixedAmountCaps
      ? BigInt(fixedAmountCaps.amount0Max)
      : (tradeIsCurrency0 ? allocation.tradeAmount : allocation.quoteAmount);
    amount1Max = fixedAmountCaps
      ? BigInt(fixedAmountCaps.amount1Max)
      : (tradeIsCurrency0 ? allocation.quoteAmount : allocation.tradeAmount);
    if (amount0Max < 0n || amount1Max < 0n || (amount0Max === 0n && amount1Max === 0n)) {
      throw new Error('自动分配后的仓位投入必须大于 0');
    }
    if (amount0Max > MAX_UINT128 || amount1Max > MAX_UINT128) {
      throw new Error('初始化金额超过 uint128 上限');
    }
    liquidity = liquidityForAmounts(
      amount0Max,
      amount1Max,
      activeSqrtPriceX96,
      tickLower,
      tickUpper
    );
    if (liquidity > MAX_UINT128) throw new Error('计算出的流动性超过 uint128 上限');
    estimatedAmounts = principalAmounts(liquidity, activeSqrtPriceX96, tickLower, tickUpper);
  }

  const token0 = poolKey.currency0.toLowerCase() === trade.address.toLowerCase() ? trade : quote;
  const token1 = poolKey.currency1.toLowerCase() === trade.address.toLowerCase() ? trade : quote;
  const permit2 = permit2Address ? ethers.getAddress(permit2Address) : null;
  let wallet = null;
  let approvals = null;
  if (owner && addsLiquidity) {
    const token0Contract = new ethers.Contract(poolKey.currency0, ERC20_ABI, provider);
    const token1Contract = new ethers.Contract(poolKey.currency1, ERC20_ABI, provider);
    const permit2Contract = new ethers.Contract(permit2, PERMIT2_ABI, provider);
    const [balance0, balance1, erc20Allowance0, erc20Allowance1, permitAllowance0, permitAllowance1] =
      await Promise.all([
        token0Contract.balanceOf(owner),
        token1Contract.balanceOf(owner),
        token0Contract.allowance(owner, permit2),
        token1Contract.allowance(owner, permit2),
        permit2Contract.allowance(owner, poolKey.currency0, positionManagerAddress),
        permit2Contract.allowance(owner, poolKey.currency1, positionManagerAddress)
      ]);
    wallet = {
      address: owner,
      balance0,
      balance1,
      sufficient0: balance0 >= amount0Max,
      sufficient1: balance1 >= amount1Max,
      stableBalance: tradeIsCurrency0 ? balance1 : balance0,
      tradeBalance: tradeIsCurrency0 ? balance0 : balance1,
      stableInputSufficient: (tradeIsCurrency0 ? balance1 : balance0) >= allocation.stableBudget
    };
    const expiryFloor = Math.floor(Date.now() / 1000) + 300;
    approvals = {
      token0ToPermit2: amount0Max > 0n && erc20Allowance0 !== amount0Max,
      token1ToPermit2: amount1Max > 0n && erc20Allowance1 !== amount1Max,
      permit2Token0ToManager: amount0Max > 0n && (
        BigInt(permitAllowance0.amount) !== amount0Max
        || Number(permitAllowance0.expiration) < expiryFloor
      ),
      permit2Token1ToManager: amount1Max > 0n && (
        BigInt(permitAllowance1.amount) !== amount1Max
        || Number(permitAllowance1.expiration) < expiryFloor
      )
    };
  }

  const deadline = addsLiquidity
    ? Math.floor(Date.now() / 1000) + Math.max(60, Number(config.transactionDeadlineSeconds) || 180)
    : null;
  const initializeCalldata = encodeInitializePool(poolKey, requestedSqrtPriceX96);
  const calldata = owner && addsLiquidity ? encodeLiquidityTransaction({
    poolKey,
    tickLower,
    tickUpper,
    liquidity,
    amount0Max,
    amount1Max
  }, owner, deadline) : null;
  let initializationEstimatedGas = null;
  if (estimateGas && owner && !currentPool.initialized) {
    try {
      initializationEstimatedGas = await provider.estimateGas({
        from: owner,
        to: positionManagerAddress,
        data: initializeCalldata,
        value: 0n
      });
    } catch (rawError) {
      const error = describeLiquidityExecutionError(rawError);
      throw new Error(`池子初始化预检失败：${error.message}`);
    }
  }
  let estimatedGas = null;
  const approvalsReady = addsLiquidity
    ? Boolean(approvals && !Object.values(approvals).some(Boolean))
    : true;
  if (estimateGas && currentPool.initialized && approvalsReady && calldata) {
    try {
      estimatedGas = await provider.estimateGas({
        from: owner,
        to: positionManagerAddress,
        data: calldata,
        value: 0n
      });
    } catch (rawError) {
      const error = describeLiquidityExecutionError(rawError);
      throw new Error(`添加流动性预检失败：${error.message}`);
    }
  }

  return {
    input,
    positionManagerAddress,
    poolManagerAddress: ethers.getAddress(poolManagerAddress),
    permit2,
    trade,
    quote,
    token0,
    token1,
    tradeIsCurrency0,
    poolKey,
    pool: currentPool,
    requestedSqrtPriceX96,
    activeSqrtPriceX96,
    activePrice,
    currentTick,
    tickLower,
    tickUpper,
    amount0Max,
    amount1Max,
    amount0Estimated: estimatedAmounts.amount0,
    amount1Estimated: estimatedAmounts.amount1,
    stableInputAmount: allocation?.stableBudget || 0n,
    allocation,
    liquidity,
    nextTokenId,
    wallet,
    approvals,
    approvalsReady,
    initializationEstimatedGas,
    estimatedGas,
    deadline,
    initializeCalldata,
    calldata
  };
}

function amountCapsFromTradeQuote(plan, tradeAmount, quoteAmount) {
  return plan.tradeIsCurrency0
    ? { amount0Max: BigInt(tradeAmount), amount1Max: BigInt(quoteAmount) }
    : { amount0Max: BigInt(quoteAmount), amount1Max: BigInt(tradeAmount) };
}

async function buildAutoAllocationQuote(provider, config, environment, plan, owner) {
  const allocation = plan.allocation;
  if (allocation.stableToSwap === 0n) {
    // Even a currently stable-only position creates a pool that may later need to
    // settle the trade token. Fetch read-only risk metadata so taxed tokens cannot
    // bypass the compatibility guard by selecting an out-of-range position.
    await quoteStableToTrade({
      quoteToken: plan.quote.address,
      tradeToken: plan.trade.address,
      amountIn: allocation.stableBudget,
      walletAddress: owner || ZERO,
      config,
      environment
    });
    return {
      required: false,
      stableInput: allocation.stableBudget,
      stableToSwap: 0n,
      quoteForLiquidity: allocation.stableBudget,
      quotedTradeAmount: 0n,
      spender: null,
      approvalRequired: false,
      amountCaps: amountCapsFromTradeQuote(plan, 0n, allocation.stableBudget)
    };
  }
  const firstQuote = await quoteStableToTrade({
    quoteToken: plan.quote.address,
    tradeToken: plan.trade.address,
    amountIn: allocation.stableToSwap,
    walletAddress: owner || ZERO,
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
  const requoteThreshold = allocation.stableToSwap / 1000n;
  const finalQuote = difference > (requoteThreshold > 0n ? requoteThreshold : 1n)
    ? await quoteStableToTrade({
      quoteToken: plan.quote.address,
      tradeToken: plan.trade.address,
      amountIn: optimizedAmount,
      walletAddress: owner || ZERO,
      config,
      environment
    })
    : firstQuote;
  const stableToSwap = finalQuote.amountIn;
  if (stableToSwap > allocation.stableBudget) throw new Error('自动兑换金额超过稳定币投入');
  const quoteForLiquidity = allocation.stableBudget - stableToSwap;
  const spender = await okxApprovalSpender({
    token: plan.quote.address,
    amount: stableToSwap,
    config,
    environment
  });
  const allowance = owner
    ? await new ethers.Contract(plan.quote.address, ERC20_ABI, provider).allowance(owner, spender)
    : null;
  return {
    required: true,
    stableInput: allocation.stableBudget,
    stableToSwap,
    quoteForLiquidity,
    quotedTradeAmount: finalQuote.amountOut,
    spender,
    approvalRequired: allowance === null ? null : allowance !== stableToSwap,
    amountCaps: amountCapsFromTradeQuote(plan, finalQuote.amountOut, quoteForLiquidity)
  };
}

function publicPlan(plan, config, autoAllocation = null) {
  const format = (value, decimals) => ethers.formatUnits(value, decimals);
  return {
    chainId: Number(CHAIN_ID),
    positionManager: plan.positionManagerAddress,
    poolManager: plan.poolManagerAddress,
    permit2: plan.permit2,
    poolId: plan.pool.poolId,
    poolInitialized: plan.pool.initialized,
    poolPriceSource: plan.pool.initialized ? 'existing_pool' : 'requested_initial_price',
    requestedPrice: plan.input.price,
    activePrice: plan.activePrice,
    quoteSymbol: plan.input.quoteSymbol,
    executionMode: plan.input.executionMode,
    budget: plan.input.budget,
    feePercent: plan.input.feePercent,
    poolKey: plan.poolKey,
    currentTick: plan.currentTick,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    liquidity: plan.input.executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD
      ? plan.liquidity.toString()
      : null,
    nextTokenId: plan.nextTokenId?.toString() || null,
    tradeToken: plan.trade,
    quoteToken: plan.quote,
    token0: {
      ...plan.token0,
      amountMax: format(plan.amount0Max, plan.token0.decimals),
      amountEstimated: format(plan.amount0Estimated, plan.token0.decimals)
    },
    token1: {
      ...plan.token1,
      amountMax: format(plan.amount1Max, plan.token1.decimals),
      amountEstimated: format(plan.amount1Estimated, plan.token1.decimals)
    },
    wallet: plan.wallet ? {
      address: plan.wallet.address,
      balance0: format(plan.wallet.balance0, plan.token0.decimals),
      balance1: format(plan.wallet.balance1, plan.token1.decimals),
      sufficient0: plan.wallet.sufficient0,
      sufficient1: plan.wallet.sufficient1,
      stableBalance: format(plan.wallet.stableBalance, plan.quote.decimals),
      tradeBalance: format(plan.wallet.tradeBalance, plan.trade.decimals),
      stableInputSufficient: plan.wallet.stableInputSufficient
    } : null,
    approvals: plan.approvals,
    approvalsReady: Boolean(plan.approvalsReady),
    initializationEstimatedGas: plan.initializationEstimatedGas?.toString() || null,
    estimatedGas: plan.estimatedGas?.toString() || null,
    hooksWarning: plan.input.hooks === ZERO
      ? null
      : '自定义 Hooks 会在初始化或加流动性时执行外部合约逻辑',
    maximumBudget: String(config.maxStableBudget ?? 1000),
    stableInputAmount: format(plan.stableInputAmount, plan.quote.decimals),
    autoAllocation: autoAllocation ? {
      required: autoAllocation.required,
      stableInput: format(autoAllocation.stableInput, plan.quote.decimals),
      stableToSwap: format(autoAllocation.stableToSwap, plan.quote.decimals),
      quoteForLiquidity: format(autoAllocation.quoteForLiquidity, plan.quote.decimals),
      quotedTradeAmount: format(autoAllocation.quotedTradeAmount, plan.trade.decimals),
      spender: autoAllocation.spender,
      approvalRequired: autoAllocation.approvalRequired
    } : null
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

function transactionEntry(kind, token, hash, receipt = null) {
  return {
    kind,
    token,
    hash,
    status: receipt ? (Number(receipt.status) === 1 ? 'confirmed' : 'failed') : 'pending',
    blockNumber: receipt?.blockNumber ?? null,
    confirmedAt: receipt ? new Date().toISOString() : null
  };
}

export function actionIsInitializeOnly(action) {
  return action?.executionMode === EXECUTION_MODE_INITIALIZE_ONLY
    || action?.request?.executionMode === EXECUTION_MODE_INITIALIZE_ONLY
    || action?.plan?.executionMode === EXECUTION_MODE_INITIALIZE_ONLY;
}

export function applyInitializationReceiptReconciliation(
  action,
  receipt,
  checkedAt = new Date().toISOString()
) {
  const hash = receipt?.hash || action.currentTx?.hash || action.poolInitializeTxHash || null;
  action.initializationReconciliation = {
    checkedAt,
    hash,
    confirmed: Boolean(receipt),
    succeeded: receipt ? Number(receipt.status) === 1 : null
  };
  if (!receipt) {
    action.stage = 'needs_attention';
    action.error = '池子初始化交易已广播，但暂未读取到链上回执，请稍后重新核对';
    return false;
  }

  const existingIndex = action.transactions?.findIndex((entry) => (
    entry.kind === 'initialize_pool' && entry.hash === hash
  )) ?? -1;
  const entry = {
    kind: 'initialize_pool',
    token: null,
    hash,
    status: Number(receipt.status) === 1 ? 'confirmed' : 'failed',
    blockNumber: receipt.blockNumber ?? null,
    confirmedAt: checkedAt
  };
  action.transactions ||= [];
  if (existingIndex >= 0) action.transactions[existingIndex] = entry;
  else action.transactions.push(entry);
  action.currentTx = null;

  if (Number(receipt.status) !== 1) {
    action.stage = 'failed';
    action.error = `池子初始化交易链上执行失败：${hash}`;
    action.failedAt = checkedAt;
    return true;
  }

  action.poolInitializeTxHash = hash;
  action.poolInitializedAt ||= checkedAt;
  action.stage = 'completed';
  action.error = null;
  action.completedAt ||= checkedAt;
  return true;
}

async function ensureTokenAllowance(
  provider,
  wallet,
  config,
  tokenAddress,
  spender,
  amount,
  action,
  persist,
  kind
) {
  const required = BigInt(amount);
  if (required < 0n) throw new Error('代币授权金额不能为负数');
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const allowance = await token.allowance(wallet.address, spender);
  const actions = exactAllowanceActions(allowance, required);
  if (actions.includes('reset')) {
    const resetReceipt = await sendTransaction(provider, wallet, config, {
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [spender, 0n]),
      value: 0n
    }, async (hash) => {
      action.currentTx = transactionEntry(`${kind}_reset`, tokenAddress, hash);
      await persist(action);
    });
    action.transactions.push(transactionEntry(`${kind}_reset`, tokenAddress, resetReceipt.hash, resetReceipt));
    action.currentTx = null;
    await persist(action);
  }
  if (actions.includes('approve')) {
    const receipt = await sendTransaction(provider, wallet, config, {
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [spender, required]),
      value: 0n
    }, async (hash) => {
      action.currentTx = transactionEntry(kind, tokenAddress, hash);
      await persist(action);
    });
    action.transactions.push(transactionEntry(kind, tokenAddress, receipt.hash, receipt));
    action.currentTx = null;
    await persist(action);
  }
  const verifiedAllowance = await token.allowance(wallet.address, spender);
  if (verifiedAllowance !== required) {
    throw new Error(`代币授权结果与本次所需金额不一致：${tokenAddress}`);
  }
}

async function ensureApprovals(provider, wallet, config, plan, action, persist) {
  const permit2 = plan.permit2;
  const expiry = Math.floor(Date.now() / 1000)
    + Math.max(600, Number(config.permit2ExpirationSeconds) || 3600);
  const currencies = [
    { address: plan.poolKey.currency0, amount: plan.amount0Max },
    { address: plan.poolKey.currency1, amount: plan.amount1Max }
  ];
  for (const currency of currencies) {
    if (currency.amount === 0n) continue;
    const token = new ethers.Contract(currency.address, ERC20_ABI, provider);
    let allowance = await token.allowance(wallet.address, permit2);
    const erc20Actions = exactAllowanceActions(allowance, currency.amount);
    if (erc20Actions.includes('reset')) {
      const zeroData = ERC20_INTERFACE.encodeFunctionData('approve', [permit2, 0n]);
      const receipt = await sendTransaction(provider, wallet, config, {
        to: currency.address,
        data: zeroData,
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('erc20_reset', currency.address, hash);
        await persist(action);
      });
      action.transactions.push(transactionEntry('erc20_reset', currency.address, receipt.hash, receipt));
      action.currentTx = null;
      await persist(action);
    }
    if (erc20Actions.includes('approve')) {
      const approvalData = ERC20_INTERFACE.encodeFunctionData('approve', [permit2, currency.amount]);
      const receipt = await sendTransaction(provider, wallet, config, {
        to: currency.address,
        data: approvalData,
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('erc20_permit2', currency.address, hash);
        await persist(action);
      });
      action.transactions.push(transactionEntry('erc20_permit2', currency.address, receipt.hash, receipt));
      action.currentTx = null;
      await persist(action);
    }
    allowance = await token.allowance(wallet.address, permit2);
    if (allowance !== currency.amount) {
      throw new Error(`Permit2 的 ERC20 授权结果与本次仓位金额不一致：${currency.address}`);
    }

    const permit2Contract = new ethers.Contract(permit2, PERMIT2_ABI, provider);
    const permitAllowance = await permit2Contract.allowance(
      wallet.address,
      currency.address,
      plan.positionManagerAddress
    );
    if (BigInt(permitAllowance.amount) !== currency.amount
      || Number(permitAllowance.expiration) < expiry - 300) {
      const permitData = PERMIT2_INTERFACE.encodeFunctionData('approve', [
        currency.address,
        plan.positionManagerAddress,
        currency.amount,
        expiry
      ]);
      const receipt = await sendTransaction(provider, wallet, config, {
        to: permit2,
        data: permitData,
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('permit2_position_manager', currency.address, hash);
        await persist(action);
      });
      action.transactions.push(transactionEntry(
        'permit2_position_manager',
        currency.address,
        receipt.hash,
        receipt
      ));
      action.currentTx = null;
      await persist(action);
    }
    const verifiedPermitAllowance = await permit2Contract.allowance(
      wallet.address,
      currency.address,
      plan.positionManagerAddress
    );
    if (BigInt(verifiedPermitAllowance.amount) !== currency.amount
      || Number(verifiedPermitAllowance.expiration) < expiry - 300) {
      throw new Error(`Permit2 仓位授权结果与本次仓位金额不一致：${currency.address}`);
    }
  }
}

function mintedTokenId(receipt, positionManager, owner) {
  const ownerTopic = ethers.zeroPadValue(owner, 32).toLowerCase();
  const zeroTopic = ethers.zeroPadValue(ZERO, 32).toLowerCase();
  for (const log of receipt.logs || []) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue;
    if (log.topics?.[0]?.toLowerCase() !== ERC721_TRANSFER_TOPIC.toLowerCase()) continue;
    if (log.topics?.[1]?.toLowerCase() !== zeroTopic || log.topics?.[2]?.toLowerCase() !== ownerTopic) continue;
    if (log.topics[3]) return BigInt(log.topics[3]).toString();
  }
  return null;
}

function actionPositionScanStartBlock(action, headBlock) {
  const explicit = Number(action?.startedBlockNumber);
  if (Number.isSafeInteger(explicit) && explicit >= 0) return Math.min(explicit, headBlock);
  const initialization = action?.transactions?.find((entry) => (
    entry.kind === 'initialize_pool'
      && entry.blockNumber !== null
      && entry.blockNumber !== undefined
  ));
  const initializationBlock = Number(initialization?.blockNumber);
  if (Number.isSafeInteger(initializationBlock) && initializationBlock >= 0) {
    return Math.min(initializationBlock, headBlock);
  }
  return Math.max(0, headBlock - 20_000);
}

async function incomingPositionTokenIds(
  provider,
  positionManager,
  owner,
  fromBlock,
  toBlock
) {
  const ownerTopic = ethers.zeroPadValue(owner, 32);
  const ids = new Set();
  const blockChunk = 2_000;
  for (let start = fromBlock; start <= toBlock; start += blockChunk) {
    const end = Math.min(toBlock, start + blockChunk - 1);
    const logs = await provider.getLogs({
      address: positionManager,
      fromBlock: start,
      toBlock: end,
      topics: [ERC721_TRANSFER_TOPIC, null, ownerTopic]
    });
    for (const log of logs) {
      if (log.topics?.[3]) ids.add(BigInt(log.topics[3]).toString());
    }
  }
  return [...ids].sort((left, right) => (
    BigInt(left) < BigInt(right) ? -1 : (BigInt(left) > BigInt(right) ? 1 : 0)
  ));
}

export async function findActionTargetPoolPositions(provider, config, action) {
  const positionManagerAddress = ethers.getAddress(config.positionManager);
  const owner = ethers.getAddress(action.wallet);
  const targetPoolId = String(action.poolId || action.plan?.poolId || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(targetPoolId)) throw new Error('待核对任务缺少有效 Pool ID');

  const headBlock = await provider.getBlockNumber();
  const fromBlock = actionPositionScanStartBlock(action, headBlock);
  const tokenIds = await incomingPositionTokenIds(
    provider,
    positionManagerAddress,
    owner,
    fromBlock,
    headBlock
  );
  if (!tokenIds.length) return [];

  const manager = new ethers.Contract(positionManagerAddress, POSITION_ABI, provider);
  const positions = [];
  const batchSize = 12;
  for (let offset = 0; offset < tokenIds.length; offset += batchSize) {
    const batch = tokenIds.slice(offset, offset + batchSize);
    const inspected = await Promise.allSettled(batch.map(async (nftId) => {
      const [currentOwner, details, liquidity] = await Promise.all([
        manager.ownerOf(nftId),
        manager.getPoolAndPositionInfo(nftId),
        manager.getPositionLiquidity(nftId)
      ]);
      if (ethers.getAddress(currentOwner) !== owner || BigInt(liquidity) <= 0n) return null;
      if (poolIdOf(details[0]).toLowerCase() !== targetPoolId) return null;
      return { nftId, liquidity: BigInt(liquidity).toString() };
    }));
    for (const result of inspected) {
      if (result.status === 'fulfilled' && result.value) positions.push(result.value);
    }
  }
  return positions;
}

export function applyActionPositionReconciliation(action, positions, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const noPositionStage = options.noPositionStage || 'failed';
  const nftIds = positions.map((position) => String(position.nftId));
  if (action.currentTx?.hash) {
    action.unconfirmedTransactions ||= [];
    if (!action.unconfirmedTransactions.some((entry) => entry.hash === action.currentTx.hash)) {
      action.unconfirmedTransactions.push({
        ...action.currentTx,
        status: 'not_confirmed_before_position_check',
        checkedAt
      });
    }
  }
  action.currentTx = null;
  action.positionReconciliation = {
    checkedAt,
    poolId: action.poolId || action.plan?.poolId || null,
    found: nftIds.length > 0,
    nftIds,
    positions
  };

  if (nftIds.length) {
    action.stage = 'completed';
    action.nftId = nftIds[0];
    action.nftIds = nftIds;
    action.error = null;
    action.completedAt = checkedAt;
    action.resolution = `执行异常后链上检测到目标池 NFT #${nftIds.join('、')}`;
    return action;
  }

  const originalError = String(options.errorMessage || action.error || '加池流程未完成')
    .split('；链上未发现本次目标池 NFT')[0];
  action.stage = noPositionStage;
  action.error = `${originalError}；链上未发现本次目标池 NFT 仓位，已解除新任务阻塞`;
  action.resolution = '未发现目标池 NFT 仓位，保留钱包资产和链上授权并放行新任务';
  action.failedAt ||= checkedAt;
  if (noPositionStage === 'cancelled') action.resolvedAt = checkedAt;
  return action;
}

export function actionMayHaveMintedPosition(action) {
  return action?.currentTx?.kind === 'mint_liquidity'
    || Boolean(action?.liquidityTxHash);
}

function actionPlanSummary(plan) {
  return {
    executionMode: plan.input.executionMode,
    poolId: plan.pool.poolId,
    poolKey: plan.poolKey,
    poolWasInitialized: plan.pool.initialized,
    activePrice: plan.activePrice,
    currentTick: plan.currentTick,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    token0: {
      address: plan.token0.address,
      symbol: plan.token0.symbol,
      decimals: plan.token0.decimals,
      amountMax: ethers.formatUnits(plan.amount0Max, plan.token0.decimals),
      amountEstimated: ethers.formatUnits(plan.amount0Estimated, plan.token0.decimals)
    },
    token1: {
      address: plan.token1.address,
      symbol: plan.token1.symbol,
      decimals: plan.token1.decimals,
      amountMax: ethers.formatUnits(plan.amount1Max, plan.token1.decimals),
      amountEstimated: ethers.formatUnits(plan.amount1Estimated, plan.token1.decimals)
    },
    budget: plan.input.budget,
    quoteSymbol: plan.input.quoteSymbol
  };
}

function describeLiquidityExecutionError(error) {
  const diagnostic = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.message
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  if (diagnostic.includes('0x5212cba1')) {
    return new Error(
      'Uniswap v4 结算失败（CurrencyNotSettled）：代币实际到账量与仓位欠款不一致；'
      + '常见原因是转账税或特殊转账逻辑，已停止且未广播加池交易'
    );
  }
  if (diagnostic.includes('socket hang up')
    || diagnostic.includes('econnreset')
    || diagnostic.includes('connection reset')) {
    return new Error('BSC RPC 连接被节点中断（socket hang up）');
  }
  return error;
}

function contextualLiquidityExecutionError(error, action = null) {
  const described = describeLiquidityExecutionError(error);
  if (actionIsInitializeOnly(action)) return described;
  const initializationConfirmed = action?.transactions?.some(
    (entry) => entry.kind === 'initialize_pool'
      && entry.hash === action.poolInitializeTxHash
      && entry.blockNumber !== null
      && entry.blockNumber !== undefined
  );
  if (initializationConfirmed
    && !action.autoSwap?.hash
    && !described.message.includes('建池已成功')) {
    return new Error(`${described.message}；建池已成功，兑换交易未发送`);
  }
  return described;
}

export function createLiquidityRouter({
  configPath,
  actionPath,
  environment = process.env,
  executionConflict = () => null
}) {
  const router = express.Router();
  let inFlight = false;
  let lastAction = null;
  const tokenMetadataCache = new Map();
  const previewAuthorizations = new Map();
  const prunePreviewAuthorizations = (now = Date.now()) => {
    for (const [id, authorization] of previewAuthorizations) {
      if (authorization.expiresAt < now) previewAuthorizations.delete(id);
    }
  };
  const ready = (async () => {
    try {
      lastAction = await readJson(actionPath);
      if (lastAction.error) {
        const conciseError = contextualLiquidityExecutionError({
          message: lastAction.error
        }, lastAction).message;
        if (conciseError !== lastAction.error) {
          lastAction.error = conciseError;
          await writeJsonAtomic(actionPath, lastAction);
        }
      }
      const interrupted = [
        'initializing',
        'preparing_swap',
        'swapping',
        'preparing_liquidity',
        'approving',
        'resuming',
        'submitting'
      ].includes(lastAction.stage);
      const uncertainTransaction = Boolean(
        lastAction.currentTx?.hash
        || (lastAction.stage === 'needs_attention' && lastAction.liquidityTxHash)
        || (lastAction.stage === 'needs_attention'
          && actionIsInitializeOnly(lastAction)
          && lastAction.poolInitializeTxHash)
      );
      if (uncertainTransaction) {
        lastAction.stage = 'needs_attention';
        lastAction.error ||= '服务曾在加池流程中断，请先核对已广播交易';
        await writeJsonAtomic(actionPath, lastAction);
        if (actionIsInitializeOnly(lastAction)) {
          let reconciliationProvider;
          try {
            const config = await readJson(configPath);
            reconciliationProvider = await openProvider(config);
            const hash = lastAction.currentTx?.hash || lastAction.poolInitializeTxHash;
            const receipt = await reconciliationProvider.getTransactionReceipt(hash);
            applyInitializationReceiptReconciliation(lastAction, receipt);
            await writeJsonAtomic(actionPath, lastAction);
          } catch (reconciliationError) {
            lastAction.initializationReconciliation = {
              checkedAt: new Date().toISOString(),
              hash: lastAction.currentTx?.hash || lastAction.poolInitializeTxHash || null,
              confirmed: false,
              succeeded: null,
              error: reconciliationError.message
            };
            await writeJsonAtomic(actionPath, lastAction);
          } finally {
            reconciliationProvider?.destroy();
          }
          return;
        }
        if (!actionMayHaveMintedPosition(lastAction)) {
          applyActionPositionReconciliation(lastAction, [], {
            errorMessage: lastAction.error,
            noPositionStage: 'failed'
          });
          await writeJsonAtomic(actionPath, lastAction);
          return;
        }
        let reconciliationProvider;
        try {
          const config = await readJson(configPath);
          reconciliationProvider = await openProvider(config);
          const positions = await findActionTargetPoolPositions(
            reconciliationProvider,
            config,
            lastAction
          );
          applyActionPositionReconciliation(lastAction, positions, {
            errorMessage: lastAction.error,
            noPositionStage: 'failed'
          });
          await writeJsonAtomic(actionPath, lastAction);
        } catch (reconciliationError) {
          lastAction.positionReconciliation = {
            checkedAt: new Date().toISOString(),
            poolId: lastAction.poolId || lastAction.plan?.poolId || null,
            found: false,
            nftIds: [],
            positions: [],
            error: reconciliationError.message
          };
          await writeJsonAtomic(actionPath, lastAction);
        } finally {
          reconciliationProvider?.destroy();
        }
      } else if (interrupted || lastAction.stage === 'needs_attention') {
        lastAction.stage = 'failed';
        lastAction.error = lastAction.error
          ? `${lastAction.error}；系统不会自动续跑`
          : '上次流程未完成；系统不会自动续跑，请重新预检后发起新任务';
        lastAction.failedAt ||= new Date().toISOString();
        await writeJsonAtomic(actionPath, lastAction);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
      if (environment.PRIVATE_KEY) {
        try {
          walletAddress = new ethers.Wallet(environment.PRIVATE_KEY).address;
        } catch {
          walletAddress = null;
        }
      }
      res.json({
        chainId: Number(CHAIN_ID),
        stablecoins: normalizeStablecoins(config),
        maxStableBudget: Number(config.maxStableBudget ?? 1000),
        maxFeePercent: Number(config.maxFeePercent ?? 10),
        positionManager: ethers.getAddress(config.positionManager),
        hookPresets: publicHookPresets(config, walletAddress),
        walletAddress,
        privateKeyConfigured: Boolean(walletAddress),
        autoAllocationConfigured: okxCredentialsConfigured(environment),
        executionEnabled: environment.LIQUIDITY_EXECUTE === 'true',
        inFlight,
        lastAction
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/status', async (_req, res) => {
    try {
      await ready;
      res.json({ inFlight, lastAction });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/balances', async (req, res) => {
    let provider;
    try {
      await ready;
      res.set('Cache-Control', 'no-store');
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY');
      let wallet;
      try {
        wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      } catch {
        throw new Error('PRIVATE_KEY 格式无效');
      }
      const config = await readJson(configPath);
      const stablecoins = normalizeStablecoins(config);
      const requestedQuote = req.query.quoteToken
        ? ethers.getAddress(String(req.query.quoteToken))
        : stablecoins[0]?.address;
      const quote = stablecoins.find(
        (entry) => entry.address.toLowerCase() === requestedQuote?.toLowerCase()
      );
      if (!quote) throw new Error('余额查询的计价代币不在白名单');
      const requestedTokens = [quote.address];
      if (req.query.tradeToken) {
        const trade = ethers.getAddress(String(req.query.tradeToken));
        if (trade !== quote.address && trade !== ZERO) requestedTokens.push(trade);
      }
      provider = await openProvider(config);
      const metadata = await Promise.all(requestedTokens.map(async (token) => {
        const key = token.toLowerCase();
        if (!tokenMetadataCache.has(key)) {
          tokenMetadataCache.set(key, await strictTokenMetadata(provider, token));
        }
        return tokenMetadataCache.get(key);
      }));
      const [nativeBalance, balances] = await Promise.all([
        provider.getBalance(wallet.address),
        Promise.all(metadata.map((item) => (
          new ethers.Contract(item.address, ERC20_ABI, provider).balanceOf(wallet.address)
        )))
      ]);
      res.json({
        walletAddress: wallet.address,
        updatedAt: new Date().toISOString(),
        native: {
          symbol: 'BNB',
          balance: ethers.formatEther(nativeBalance)
        },
        tokens: metadata.map((item, index) => ({
          ...item,
          balance: ethers.formatUnits(balances[index], item.decimals)
        }))
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    } finally {
      provider?.destroy();
    }
  });

  router.post('/preview', async (req, res) => {
    let provider;
    try {
      await ready;
      const config = await readJson(configPath);
      provider = await openProvider(config);
      let owner = null;
      if (environment.PRIVATE_KEY) {
        try {
          owner = new ethers.Wallet(environment.PRIVATE_KEY).address;
        } catch {
          throw new Error('PRIVATE_KEY 格式无效');
        }
      }
      const basePlan = await buildPlan(provider, config, req.body, owner, false);
      const addsLiquidity = basePlan.input.executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD;
      const autoAllocation = addsLiquidity
        ? await buildAutoAllocationQuote(provider, config, environment, basePlan, owner)
        : null;
      const plan = await buildPlan(
        provider,
        config,
        req.body,
        owner,
        true,
        autoAllocation?.amountCaps || null,
        false,
        addsLiquidity
          ? { tickLower: basePlan.tickLower, tickUpper: basePlan.tickUpper }
          : null
      );
      prunePreviewAuthorizations();
      const previewId = crypto.randomUUID();
      const previewValiditySeconds = Math.min(
        600,
        Math.max(30, Number(config.previewValiditySeconds) || 120)
      );
      const previewAuthorization = {
        id: previewId,
        owner: owner || ZERO,
        fingerprint: liquidityExecutionFingerprint(basePlan.input),
        poolId: basePlan.pool.poolId,
        requestedSqrtPriceX96: basePlan.requestedSqrtPriceX96.toString(),
        tickLower: basePlan.tickLower,
        tickUpper: basePlan.tickUpper,
        expiresAt: Date.now() + previewValiditySeconds * 1000
      };
      previewAuthorizations.set(previewId, previewAuthorization);
      res.json({
        ...publicPlan(plan, config, autoAllocation),
        previewId,
        previewExpiresAt: new Date(previewAuthorization.expiresAt).toISOString(),
        privateKeyConfigured: Boolean(owner),
        autoAllocationConfigured: okxCredentialsConfigured(environment),
        executionEnabled: environment.LIQUIDITY_EXECUTE === 'true'
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    } finally {
      provider?.destroy();
    }
  });

  router.post('/execute', async (req, res) => {
    let provider;
    let action;
    let wallet;
    let config;
    let pendingSwapApproval = null;
    try {
      await ready;
      if (req.body.confirmed !== true) throw new Error('必须先确认本次建池执行及风险提示');
      if (environment.LIQUIDITY_EXECUTE !== 'true') {
        throw new Error('LIQUIDITY_EXECUTE=false，请在 .env 中单独开启加池交易');
      }
      if (inFlight) throw new Error('已有初始化流动性任务正在执行');
      if (lastAction?.stage === 'needs_attention') {
        throw new Error('上一次加池任务存在待核对交易，请先检查独立执行记录');
      }
      const conflict = executionConflict();
      if (conflict) throw new Error(conflict);
      if (!environment.PRIVATE_KEY) throw new Error('缺少 PRIVATE_KEY');

      inFlight = true;
      config = await readJson(configPath);
      try {
        wallet = new ethers.Wallet(environment.PRIVATE_KEY);
      } catch {
        throw new Error('PRIVATE_KEY 格式无效');
      }
      provider = await openProvider(config);
      const basePlan = await buildPlan(provider, config, req.body, wallet.address, false);
      const addsLiquidity = basePlan.input.executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD;
      prunePreviewAuthorizations();
      const previewAuthorization = previewAuthorizations.get(String(req.body.previewId || ''));
      assertLiquidityPreviewAuthorization(previewAuthorization, {
        previewId: String(req.body.previewId || ''),
        fingerprint: liquidityExecutionFingerprint(basePlan.input),
        owner: wallet.address
      });
      assertExecutionPlanInvariant(basePlan, previewAuthorization);
      const lockedTicks = addsLiquidity ? {
        tickLower: previewAuthorization.tickLower,
        tickUpper: previewAuthorization.tickUpper
      } : null;
      if (basePlan.input.hooks !== ZERO && !basePlan.input.acknowledgeCustomHooks) {
        throw new Error('使用自定义 Hooks 前必须勾选风险确认');
      }
      if (addsLiquidity && !basePlan.wallet.stableInputSufficient) {
        throw new Error(
          `钱包 ${basePlan.quote.symbol} 余额不足，无法投入 ${basePlan.input.budget} ${basePlan.quote.symbol}`
        );
      }
      const autoAllocation = addsLiquidity
        ? await buildAutoAllocationQuote(provider, config, environment, basePlan, wallet.address)
        : null;
      const quotedPlan = await buildPlan(
        provider,
        config,
        req.body,
        wallet.address,
        true,
        autoAllocation?.amountCaps || null,
        false,
        lockedTicks
      );
      assertExecutionPlanInvariant(quotedPlan, previewAuthorization);
      previewAuthorizations.delete(previewAuthorization.id);
      const startedBlockNumber = await provider.getBlockNumber();

      action = {
        id: crypto.randomUUID(),
        stage: 'initializing',
        startedAt: new Date().toISOString(),
        startedBlockNumber,
        wallet: wallet.address,
        executionMode: basePlan.input.executionMode,
        poolId: quotedPlan.pool.poolId,
        request: {
          tradeToken: basePlan.input.tradeToken,
          quoteToken: basePlan.input.quoteToken,
          executionMode: basePlan.input.executionMode,
          price: basePlan.input.price,
          budget: basePlan.input.budget,
          feePercent: basePlan.input.feePercent,
          tickSpacing: basePlan.input.tickSpacing,
          rangeType: basePlan.input.rangeType,
          rangePercent: basePlan.input.rangePercent,
          lowerPrice: basePlan.input.lowerPrice,
          upperPrice: basePlan.input.upperPrice,
          hooks: basePlan.input.hooks,
          acknowledgeCustomHooks: basePlan.input.acknowledgeCustomHooks
        },
        plan: actionPlanSummary(quotedPlan),
        autoSwap: autoAllocation ? {
          status: autoAllocation.required ? 'planned' : 'not_required',
          quoteToken: basePlan.quote.address,
          quoteSymbol: basePlan.quote.symbol,
          tradeToken: basePlan.trade.address,
          tradeSymbol: basePlan.trade.symbol,
          stableInput: ethers.formatUnits(autoAllocation.stableInput, basePlan.quote.decimals),
          stableToSwap: ethers.formatUnits(autoAllocation.stableToSwap, basePlan.quote.decimals),
          expectedTrade: ethers.formatUnits(
            autoAllocation.quotedTradeAmount,
            basePlan.trade.decimals
          ),
          spender: autoAllocation.spender,
          hash: null
        } : null,
        transactions: [],
        currentTx: null,
        error: null
      };
      await persist(action);

      const initializationReceipt = await sendTransaction(provider, wallet, config, {
        to: quotedPlan.positionManagerAddress,
        data: quotedPlan.initializeCalldata,
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('initialize_pool', null, hash);
        action.poolInitializeTxHash = hash;
        await persist(action);
      });
      action.transactions.push(transactionEntry(
        'initialize_pool',
        null,
        initializationReceipt.hash,
        initializationReceipt
      ));
      action.currentTx = null;
      action.poolInitializedAt = new Date().toISOString();
      if (!addsLiquidity) {
        action.stage = 'completed';
        action.completedAt = new Date().toISOString();
        await persist(action);
        res.json(action);
        return;
      }
      action.stage = 'preparing_swap';
      await persist(action);

      const initializedPlan = await buildPlan(
        provider,
        config,
        req.body,
        wallet.address,
        false,
        autoAllocation.amountCaps,
        true,
        lockedTicks
      );
      assertExecutionPlanInvariant(initializedPlan, previewAuthorization, true);
      if (Math.abs(initializedPlan.currentTick - basePlan.currentTick)
        > basePlan.input.tickSpacing * 2) {
        throw new Error('建池确认后池价变化超过两个 Tick Spacing；已在兑换前停止');
      }

      let stableForLiquidity = autoAllocation.stableInput;
      let tradeForLiquidity = 0n;
      if (autoAllocation.required) {
        await ensureTokenAllowance(
          provider,
          wallet,
          config,
          basePlan.quote.address,
          autoAllocation.spender,
          autoAllocation.stableToSwap,
          action,
          persist,
          'stable_okx'
        );
        pendingSwapApproval = {
          token: basePlan.quote.address,
          spender: autoAllocation.spender
        };
        const quoteContract = new ethers.Contract(basePlan.quote.address, ERC20_ABI, provider);
        const tradeContract = new ethers.Contract(basePlan.trade.address, ERC20_ABI, provider);
        const [stableBefore, tradeBefore] = await Promise.all([
          quoteContract.balanceOf(wallet.address),
          tradeContract.balanceOf(wallet.address)
        ]);
        if (stableBefore < autoAllocation.stableInput) {
          throw new Error('自动兑换前稳定币余额已不足，已停止执行');
        }

        const prepared = await prepareStableToTradeSwap({
          quoteToken: basePlan.quote.address,
          tradeToken: basePlan.trade.address,
          amountIn: autoAllocation.stableToSwap,
          walletAddress: wallet.address,
          config,
          environment
        });
        action.stage = 'swapping';
        action.autoSwap.status = 'prepared';
        action.autoSwap.expectedTrade = ethers.formatUnits(
          prepared.amountOut,
          basePlan.trade.decimals
        );
        await persist(action);

        const swapReceipt = await sendTransaction(provider, wallet, config, {
          to: ethers.getAddress(prepared.response.tx.to),
          data: prepared.response.tx.data,
          value: BigInt(prepared.response.tx.value || 0)
        }, async (hash) => {
          action.currentTx = transactionEntry(
            'stable_to_trade',
            basePlan.quote.address,
            hash
          );
          action.autoSwap.status = 'broadcast';
          action.autoSwap.hash = hash;
          await persist(action);
        });
        action.transactions.push(transactionEntry(
          'stable_to_trade',
          basePlan.quote.address,
          swapReceipt.hash,
          swapReceipt
        ));
        action.currentTx = null;
        action.autoSwap.status = 'confirmed_pending_validation';
        await persist(action);
        const [stableAfter, tradeAfter] = await Promise.all([
          quoteContract.balanceOf(wallet.address),
          tradeContract.balanceOf(wallet.address)
        ]);
        const stableSpent = stableBefore - stableAfter;
        const tradeReceived = tradeAfter - tradeBefore;
        await ensureTokenAllowance(
          provider,
          wallet,
          config,
          basePlan.quote.address,
          autoAllocation.spender,
          0n,
          action,
          persist,
          'stable_okx_cleanup'
        );
        pendingSwapApproval = null;
        const minimumReceived = prepared.amountOut
          * BigInt(Math.max(0, 10_000 - Number(config.swapSlippageBps ?? 100)))
          / 10_000n;
        if (stableSpent !== prepared.amountIn) {
          throw new Error('自动兑换实际扣除的稳定币与本次精确兑换金额不一致，请人工核对交易');
        }
        if (tradeReceived <= 0n || tradeReceived < minimumReceived) {
          throw new Error('自动兑换实际到账低于滑点保护值，请人工核对交易');
        }

        stableForLiquidity = autoAllocation.stableInput - stableSpent;
        tradeForLiquidity = tradeReceived;
        action.autoSwap = {
          ...action.autoSwap,
          status: 'confirmed',
          hash: swapReceipt.hash,
          stableSpent: ethers.formatUnits(stableSpent, basePlan.quote.decimals),
          tradeReceived: ethers.formatUnits(tradeReceived, basePlan.trade.decimals),
          confirmedAt: new Date().toISOString()
        };
        action.stage = 'preparing_liquidity';
        await persist(action);
      }

      const actualAmountCaps = amountCapsFromTradeQuote(
        basePlan,
        tradeForLiquidity,
        stableForLiquidity
      );
      let refreshed = await buildPlan(
        provider,
        config,
        req.body,
        wallet.address,
        false,
        actualAmountCaps,
        true,
        lockedTicks
      );
      assertExecutionPlanInvariant(refreshed, previewAuthorization, true);
      if (Math.abs(refreshed.currentTick - initializedPlan.currentTick)
        > basePlan.input.tickSpacing * 2) {
        throw new Error('执行期间池价变化超过两个 Tick Spacing，请重新预检');
      }
      if (!refreshed.wallet.sufficient0 || !refreshed.wallet.sufficient1) {
        throw new Error('自动分配后钱包资产不足，已停止发送加池交易');
      }

      action.stage = 'approving';
      action.plan = actionPlanSummary(refreshed);
      await persist(action);
      await ensureApprovals(provider, wallet, config, refreshed, action, persist);

      refreshed = await buildPlan(
        provider,
        config,
        req.body,
        wallet.address,
        true,
        actualAmountCaps,
        true,
        lockedTicks
      );
      assertExecutionPlanInvariant(refreshed, previewAuthorization, true);
      if (Math.abs(refreshed.currentTick - initializedPlan.currentTick)
        > basePlan.input.tickSpacing * 2) {
        throw new Error('授权期间池价变化超过两个 Tick Spacing，请重新预检');
      }
      if (!refreshed.wallet.sufficient0 || !refreshed.wallet.sufficient1) {
        throw new Error('授权后钱包余额不足，已停止发送加池交易');
      }
      if (!refreshed.approvalsReady || refreshed.estimatedGas === null) {
        throw new Error('授权后加池预检未完整通过，已停止发送加池交易');
      }
      action.stage = 'submitting';
      action.plan = actionPlanSummary(refreshed);
      await persist(action);
      const receipt = await sendTransaction(provider, wallet, config, {
        to: refreshed.positionManagerAddress,
        data: refreshed.calldata,
        value: 0n
      }, async (hash) => {
        action.currentTx = transactionEntry('mint_liquidity', null, hash);
        action.liquidityTxHash = hash;
        await persist(action);
      });
      action.transactions.push(transactionEntry('mint_liquidity', null, receipt.hash, receipt));
      action.currentTx = null;
      action.nftId = mintedTokenId(receipt, refreshed.positionManagerAddress, wallet.address);
      if (!action.nftId) {
        action.stage = 'needs_attention';
        action.error = '加池交易已确认成功，但未从回执识别 NFT ID；请先核对链上仓位，系统不会重复发送';
        action.completedAt = new Date().toISOString();
        await persist(action);
        return res.status(409).json({ error: action.error, action });
      }
      action.stage = 'completed';
      action.completedAt = new Date().toISOString();
      await persist(action);
      res.json(action);
    } catch (rawError) {
      let error = contextualLiquidityExecutionError(rawError, action);
      if (action) {
        if (actionIsInitializeOnly(action)) {
          const confirmedInitialization = action.transactions?.find((entry) => (
            entry.kind === 'initialize_pool'
            && entry.blockNumber !== null
            && entry.blockNumber !== undefined
          ));
          if (confirmedInitialization) {
            applyInitializationReceiptReconciliation(action, {
              hash: confirmedInitialization.hash,
              blockNumber: confirmedInitialization.blockNumber,
              status: 1
            });
          } else if (action.currentTx?.hash && provider) {
            try {
              const receipt = await provider.getTransactionReceipt(action.currentTx.hash);
              applyInitializationReceiptReconciliation(action, receipt);
            } catch (reconciliationError) {
              action.stage = 'needs_attention';
              action.error = `${error.message}；暂时无法核对池子初始化交易：${reconciliationError.message}`;
            }
          } else {
            action.stage = 'failed';
            action.error = error.message;
            action.failedAt = new Date().toISOString();
          }
          await persist(action);
          if (action.stage === 'completed') return res.json(action);
          return res.status(action.stage === 'needs_attention' ? 409 : 400).json({
            error: action.error,
            action
          });
        }
        if (rawError.transactionConfirmedFailed && action.currentTx) {
          action.transactions.push({
            ...action.currentTx,
            status: 'failed',
            confirmedAt: new Date().toISOString()
          });
          action.currentTx = null;
        }
        if (pendingSwapApproval && provider && wallet && !action.currentTx?.hash) {
          try {
            await ensureTokenAllowance(
              provider,
              wallet,
              config,
              pendingSwapApproval.token,
              pendingSwapApproval.spender,
              0n,
              action,
              persist,
              'stable_okx_cleanup_after_failure'
            );
            pendingSwapApproval = null;
          } catch (cleanupError) {
            error = new Error(`${error.message}；同时清理兑换授权失败：${cleanupError.message}`);
          }
        }
        let positionReconciled = false;
        try {
          const positions = actionMayHaveMintedPosition(action)
            ? await findActionTargetPoolPositions(provider, config, action)
            : [];
          applyActionPositionReconciliation(action, positions, {
            errorMessage: error.message,
            noPositionStage: 'failed'
          });
          positionReconciled = true;
        } catch (positionError) {
          action.stage = action.currentTx?.hash ? 'needs_attention' : 'failed';
          action.error = `${error.message}；自动核对目标池 NFT 失败：${positionError.message}`;
          action.failedAt = new Date().toISOString();
        }
        await persist(action);
        if (positionReconciled && action.stage === 'completed') return res.json(action);
      }
      res.status(400).json({ error: action?.error || error.message, action: action || null });
    } finally {
      inFlight = false;
      provider?.destroy();
    }
  });

  router.post('/resolve', async (req, res) => {
    let provider;
    try {
      await ready;
      if (req.body.confirmed !== true) throw new Error('必须确认核对链上交易并处理待确认任务');
      if (inFlight) throw new Error('加池任务执行中，不能结束记录');
      if (lastAction?.stage !== 'needs_attention') throw new Error('当前没有待处理任务');
      inFlight = true;
      const config = await readJson(configPath);
      if (actionIsInitializeOnly(lastAction)) {
        provider = await openProvider(config);
        const hash = lastAction.currentTx?.hash || lastAction.poolInitializeTxHash;
        if (!hash) throw new Error('待核对任务缺少池子初始化交易哈希');
        const receipt = await provider.getTransactionReceipt(hash);
        const settled = applyInitializationReceiptReconciliation(lastAction, receipt);
        await persist(lastAction);
        if (!settled) {
          return res.status(409).json({ error: lastAction.error, action: lastAction });
        }
        return res.json(lastAction);
      }
      let positions = [];
      if (actionMayHaveMintedPosition(lastAction)) {
        provider = await openProvider(config);
        positions = await findActionTargetPoolPositions(provider, config, lastAction);
      }
      applyActionPositionReconciliation(lastAction, positions, {
        errorMessage: lastAction.error,
        noPositionStage: 'cancelled'
      });
      await persist(lastAction);
      res.json(lastAction);
    } catch (error) {
      res.status(400).json({ error: error.message });
    } finally {
      inFlight = false;
      provider?.destroy();
    }
  });

  Object.defineProperty(router, 'isExecutionInFlight', {
    value: () => inFlight
  });
  return router;
}
