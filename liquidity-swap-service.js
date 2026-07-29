import crypto from 'node:crypto';
import { ethers } from 'ethers';

const OKX_API_BASE = 'https://web3.okx.com';
const CHAIN_INDEX = '56';

function requiredCredentials(environment) {
  return ['OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_API_PASSPHRASE']
    .filter((name) => !environment[name]);
}

export function okxCredentialsConfigured(environment = process.env) {
  return requiredCredentials(environment).length === 0;
}

export function requireOkxCredentials(environment = process.env) {
  const missing = requiredCredentials(environment);
  if (missing.length) {
    throw new Error(`稳定币自动分配缺少 ${missing.join('、')}`);
  }
}

function describeNetworkError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const message = cause?.message || error?.message || '未知网络错误';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return `连接超时 (${code})`;
  if (code === 'EHOSTDOWN') return `目标主机不可达 (${code})`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `DNS 解析失败 (${code})`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '请求超时';
  return `${code ? `${code}: ` : ''}${message}`;
}

function okxHeaders(environment, timestamp, signature) {
  const headers = {
    'OK-ACCESS-KEY': environment.OKX_API_KEY,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': environment.OKX_API_PASSPHRASE,
    'Content-Type': 'application/json'
  };
  if (environment.OKX_PROJECT_ID) headers['OK-ACCESS-PROJECT'] = environment.OKX_PROJECT_ID;
  return headers;
}

export async function okxLiquidityGet(
  endpoint,
  params,
  config = {},
  environment = process.env
) {
  requireOkxCredentials(environment);
  const attempts = Math.max(1, Number(config.okxRequestAttempts ?? 2));
  const timeoutMs = Math.max(2000, Number(config.okxRequestTimeoutMs) || 8000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const query = new URLSearchParams(params).toString();
    const requestPath = `/api/v6/dex/aggregator/${endpoint}`;
    const queryPath = query ? `?${query}` : '';
    const timestamp = new Date().toISOString();
    const signature = crypto.createHmac('sha256', environment.OKX_SECRET_KEY)
      .update(`${timestamp}GET${requestPath}${queryPath}`)
      .digest('base64');
    try {
      const response = await fetch(`${OKX_API_BASE}${requestPath}${queryPath}`, {
        headers: okxHeaders(environment, timestamp, signature),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`返回非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!response.ok || body.code !== '0' || !body.data?.length) {
        throw new Error(`HTTP ${response.status} / code ${body.code ?? '-'}: ${body.msg || response.statusText}`);
      }
      return body.data[0];
    } catch (error) {
      const detail = error instanceof TypeError || error?.cause
        ? describeNetworkError(error)
        : error.message;
      lastError = new Error(`OKX ${endpoint} 请求失败（第 ${attempt}/${attempts} 次）：${detail}`);
      lastError.okxEndpoint = endpoint;
      lastError.cause = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }
  throw lastError;
}

function responseRoute(response) {
  return response?.routerResult || response;
}

function normalizedRouteAddress(value) {
  return value ? ethers.getAddress(value) : null;
}

export function validateLiquidityTokenTaxes(route) {
  const tokens = [
    ['输入稳定币', route?.fromToken],
    ['目标代币', route?.toToken]
  ];
  for (const [label, token] of tokens) {
    if (token?.taxRate === undefined || token?.taxRate === null || token?.taxRate === '') {
      throw new Error(`OKX 未返回${label}税率，无法确认 Uniswap v4 结算兼容性`);
    }
    const taxRate = Number(token.taxRate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
      throw new Error(`OKX 返回的${label}税率无效`);
    }
    if (taxRate > 0) {
      throw new Error(
        `${label}存在 ${(taxRate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}% 转账/交易税，`
        + '标准 Uniswap v4 PositionManager 无法保证精确结算，已在兑换前停止'
      );
    }
  }
}

export function validateLiquiditySwapResponse(
  response,
  quoteToken,
  tradeToken,
  amountIn,
  walletAddress,
  config = {},
  requireTransaction = false
) {
  const route = responseRoute(response);
  if (!route) throw new Error('OKX 响应缺少兑换路由');
  const fromAddress = normalizedRouteAddress(route.fromToken?.tokenContractAddress);
  const toAddress = normalizedRouteAddress(route.toToken?.tokenContractAddress);
  if (!fromAddress || fromAddress !== ethers.getAddress(quoteToken)) {
    throw new Error('OKX 返回的输入稳定币不一致');
  }
  if (!toAddress || toAddress !== ethers.getAddress(tradeToken)) {
    throw new Error('OKX 返回的目标代币不一致');
  }
  const routedInput = BigInt(route.fromTokenAmount || amountIn);
  const quotedOutput = BigInt(route.toTokenAmount || 0);
  if (routedInput <= 0n || routedInput !== BigInt(amountIn)) {
    throw new Error('OKX 返回的稳定币输入数量与本次精确兑换金额不一致');
  }
  if (quotedOutput <= 0n) throw new Error('OKX 返回的预计交易代币数量无效');
  if (route.toToken?.isHoneyPot === true) throw new Error('OKX 将目标代币标记为高风险代币');
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
      throw new Error(`自动分配预计价值损失 ${lossPercent.toFixed(2)}%，超过安全上限 ${maximumLoss}%`);
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
    if (BigInt(tx.value || 0) !== 0n) throw new Error('稳定币兑换交易包含异常原生币 value');
  }
  return {
    amountIn: routedInput,
    amountOut: quotedOutput,
    route
  };
}

function slippagePercent(config) {
  return String(Number(config.swapSlippageBps ?? 100) / 100);
}

export async function quoteStableToTrade({
  quoteToken,
  tradeToken,
  amountIn,
  walletAddress,
  config,
  environment
}) {
  const response = await okxLiquidityGet('quote', {
    chainIndex: CHAIN_INDEX,
    amount: BigInt(amountIn).toString(),
    swapMode: 'exactIn',
    fromTokenAddress: ethers.getAddress(quoteToken),
    toTokenAddress: ethers.getAddress(tradeToken)
  }, config, environment);
  const validated = validateLiquiditySwapResponse(
    response,
    quoteToken,
    tradeToken,
    amountIn,
    walletAddress,
    config,
    false
  );
  return { response, ...validated };
}

export async function prepareStableToTradeSwap({
  quoteToken,
  tradeToken,
  amountIn,
  walletAddress,
  config,
  environment
}) {
  const response = await okxLiquidityGet('swap', {
    chainIndex: CHAIN_INDEX,
    amount: BigInt(amountIn).toString(),
    swapMode: 'exactIn',
    fromTokenAddress: ethers.getAddress(quoteToken),
    toTokenAddress: ethers.getAddress(tradeToken),
    slippagePercent: slippagePercent(config),
    userWalletAddress: ethers.getAddress(walletAddress),
    swapReceiverAddress: ethers.getAddress(walletAddress),
    gasLevel: 'fast'
  }, config, environment);
  const validated = validateLiquiditySwapResponse(
    response,
    quoteToken,
    tradeToken,
    amountIn,
    walletAddress,
    config,
    true
  );
  return { response, ...validated };
}

export async function okxApprovalSpender({
  token,
  amount,
  config,
  environment
}) {
  const response = await okxLiquidityGet('approve-transaction', {
    chainIndex: CHAIN_INDEX,
    tokenContractAddress: ethers.getAddress(token),
    approveAmount: BigInt(amount).toString()
  }, config, environment);
  if (!response.dexContractAddress) throw new Error('OKX 未返回稳定币授权地址');
  return ethers.getAddress(response.dexContractAddress);
}
