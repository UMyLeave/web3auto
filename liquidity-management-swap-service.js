import { ethers } from 'ethers';
import {
  okxLiquidityGet,
  requireOkxCredentials,
  validateLiquidityTokenTaxes
} from './liquidity-swap-service.js';

const CHAIN_INDEX = '56';

function routeOf(response) {
  return response?.routerResult || response;
}

function checkedAddress(value, label) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`OKX 返回的${label}地址无效`);
  }
}

export function validateManagementSwapResponse(
  response,
  tokenIn,
  tokenOut,
  amountIn,
  walletAddress,
  config = {},
  requireTransaction = false
) {
  const route = routeOf(response);
  if (!route) throw new Error('OKX 响应缺少兑换路由');
  const expectedInput = ethers.getAddress(tokenIn);
  const expectedOutput = ethers.getAddress(tokenOut);
  if (checkedAddress(route.fromToken?.tokenContractAddress, '输入代币') !== expectedInput) {
    throw new Error('OKX 返回的输入代币不一致');
  }
  if (checkedAddress(route.toToken?.tokenContractAddress, '输出代币') !== expectedOutput) {
    throw new Error('OKX 返回的输出代币不一致');
  }
  const routedInput = BigInt(route.fromTokenAmount || amountIn);
  const quotedOutput = BigInt(route.toTokenAmount || 0);
  if (routedInput <= 0n || routedInput !== BigInt(amountIn)) {
    throw new Error('OKX 返回的输入数量与本次精确兑换金额不一致');
  }
  if (quotedOutput <= 0n) throw new Error('OKX 返回的预计输出数量无效');
  if (route.toToken?.isHoneyPot === true) throw new Error('OKX 将输出代币标记为高风险代币');
  validateLiquidityTokenTaxes(route);

  const fromDecimals = Number(route.fromToken?.decimal);
  const toDecimals = Number(route.toToken?.decimal);
  const fromPrice = Number(route.fromToken?.tokenUnitPrice);
  const toPrice = Number(route.toToken?.tokenUnitPrice);
  if ([fromDecimals, toDecimals, fromPrice, toPrice].every(Number.isFinite)
    && fromPrice > 0 && toPrice > 0) {
    const inputValue = Number(routedInput) / (10 ** fromDecimals) * fromPrice;
    const outputValue = Number(quotedOutput) / (10 ** toDecimals) * toPrice;
    const lossPercent = inputValue > 0
      ? Math.max(0, (inputValue - outputValue) / inputValue * 100)
      : 0;
    const maximumLoss = Number(config.maxSwapValueLossPercent ?? 5);
    if (lossPercent > maximumLoss) {
      throw new Error(`预计兑换价值损失 ${lossPercent.toFixed(2)}%，超过安全上限 ${maximumLoss}%`);
    }
  }

  if (requireTransaction) {
    const tx = response.tx;
    if (!tx) throw new Error('OKX swap 响应缺少交易数据');
    if (tx.from && ethers.getAddress(tx.from) !== ethers.getAddress(walletAddress)) {
      throw new Error('OKX 返回的交易发送钱包不一致');
    }
    if (!tx.to || ethers.getAddress(tx.to) === ethers.ZeroAddress || !ethers.isHexString(tx.data || '')) {
      throw new Error('OKX 返回的交易目标或 calldata 无效');
    }
    if (BigInt(tx.value || 0) !== 0n) throw new Error('ERC20 兑换交易包含异常原生币 value');
  }
  return { amountIn: routedInput, amountOut: quotedOutput, route };
}

function slippagePercent(config) {
  return String(Number(config.swapSlippageBps ?? 100) / 100);
}

export async function quoteManagementSwap({
  tokenIn,
  tokenOut,
  amountIn,
  walletAddress,
  config,
  environment
}) {
  requireOkxCredentials(environment);
  const response = await okxLiquidityGet('quote', {
    chainIndex: CHAIN_INDEX,
    amount: BigInt(amountIn).toString(),
    swapMode: 'exactIn',
    fromTokenAddress: ethers.getAddress(tokenIn),
    toTokenAddress: ethers.getAddress(tokenOut)
  }, config, environment);
  return {
    response,
    ...validateManagementSwapResponse(
      response,
      tokenIn,
      tokenOut,
      amountIn,
      walletAddress,
      config,
      false
    )
  };
}

export async function prepareManagementSwap({
  tokenIn,
  tokenOut,
  amountIn,
  walletAddress,
  config,
  environment
}) {
  requireOkxCredentials(environment);
  const response = await okxLiquidityGet('swap', {
    chainIndex: CHAIN_INDEX,
    amount: BigInt(amountIn).toString(),
    swapMode: 'exactIn',
    fromTokenAddress: ethers.getAddress(tokenIn),
    toTokenAddress: ethers.getAddress(tokenOut),
    slippagePercent: slippagePercent(config),
    userWalletAddress: ethers.getAddress(walletAddress),
    swapReceiverAddress: ethers.getAddress(walletAddress),
    gasLevel: 'fast'
  }, config, environment);
  return {
    response,
    ...validateManagementSwapResponse(
      response,
      tokenIn,
      tokenOut,
      amountIn,
      walletAddress,
      config,
      true
    )
  };
}

export async function managementSwapApprovalSpender({
  token,
  amount,
  config,
  environment
}) {
  requireOkxCredentials(environment);
  const response = await okxLiquidityGet('approve-transaction', {
    chainIndex: CHAIN_INDEX,
    tokenContractAddress: ethers.getAddress(token),
    approveAmount: BigInt(amount).toString()
  }, config, environment);
  if (!response.dexContractAddress) throw new Error('OKX 未返回授权地址');
  return ethers.getAddress(response.dexContractAddress);
}
