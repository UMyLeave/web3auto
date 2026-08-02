import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  normalizeWhitelistHookConfig,
  WHITELIST_HOOK_POLICY_VERSION
} from '../liquidity-hook-service.js';
import {
  compileWhitelistHook,
  CREATE2_DEPLOYER,
  deploymentGasLimit,
  deploymentGasPrice,
  mineWhitelistHookSalt,
  whitelistHookInitCode
} from '../whitelist-hook-deployment.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await fs.readFile(path.join(root, 'liquidity-config.json'), 'utf8'));
const source = await fs.readFile(
  path.join(root, 'contracts', 'WhitelistLiquidityHook.sol'),
  'utf8'
);
const POSITION_MANAGER_ABI = ['function poolManager() view returns (address)'];

async function openReadOnlyProvider() {
  const errors = [];
  for (const rpcUrl of config.rpcUrls || []) {
    const provider = new ethers.JsonRpcProvider(rpcUrl, 56, {
      batchMaxCount: 1,
      staticNetwork: true
    });
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== 56n) throw new Error('chainId 不是 56');
      return provider;
    } catch (error) {
      errors.push(error.message);
      provider.destroy();
    }
  }
  throw new Error(`没有可用的 BSC RPC：${errors.at(-1) || '未配置 rpcUrls'}`);
}

let provider;
try {
  const hookConfig = normalizeWhitelistHookConfig(config);
  const positionManager = ethers.getAddress(config.positionManager);
  provider = await openReadOnlyProvider();
  const positionManagerContract = new ethers.Contract(
    positionManager,
    POSITION_MANAGER_ABI,
    provider
  );
  const poolManager = ethers.getAddress(await positionManagerContract.poolManager());
  const create2Code = await provider.getCode(CREATE2_DEPLOYER);
  if (!create2Code || create2Code === '0x') {
    throw new Error(`BSC 上没有标准 CREATE2 部署器：${CREATE2_DEPLOYER}`);
  }

  const artifact = compileWhitelistHook(source);
  const initCode = whitelistHookInitCode({
    artifact,
    poolManager,
    positionManager,
    allowedWallets: hookConfig.allowedWallets
  });
  const mined = mineWhitelistHookSalt({ initCode });
  const deploymentData = ethers.concat([mined.salt, initCode]);
  const [existingCode, feeData, walletBalance] = await Promise.all([
    provider.getCode(mined.address),
    provider.getFeeData(),
    provider.getBalance(hookConfig.allowedWallets[0])
  ]);
  if (!feeData.gasPrice) throw new Error('RPC 未返回 gasPrice');
  const gasPrice = deploymentGasPrice({
    rpcGasPrice: feeData.gasPrice,
    minGasPriceGwei: config.minGasPriceGwei,
    maxGasPriceGwei: config.maxGasPriceGwei
  });
  let estimatedGas = null;
  let gasLimit = null;
  if (existingCode === '0x') {
    estimatedGas = await provider.estimateGas({
      from: hookConfig.allowedWallets[0],
      to: CREATE2_DEPLOYER,
      data: deploymentData,
      value: 0n
    });
    gasLimit = deploymentGasLimit(estimatedGas, config.maxGasLimit);
  }
  const maximumCost = gasLimit === null ? 0n : gasLimit * gasPrice;
  console.log(JSON.stringify({
    mode: 'read-only',
    poolManager,
    positionManager,
    allowedWallets: hookConfig.allowedWallets,
    policyVersion: Number(WHITELIST_HOOK_POLICY_VERSION),
    hookAddress: mined.address,
    permissionBits: '0x0800',
    salt: mined.salt,
    attempts: mined.attempts,
    miningElapsedMs: mined.elapsedMs,
    initCodeBytes: (initCode.length - 2) / 2,
    alreadyDeployed: existingCode !== '0x',
    estimatedGas: estimatedGas?.toString() || null,
    gasLimit: gasLimit?.toString() || null,
    rpcGasPriceGwei: ethers.formatUnits(feeData.gasPrice, 'gwei'),
    gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
    maximumCostBnb: ethers.formatEther(maximumCost),
    walletBalanceBnb: ethers.formatEther(walletBalance),
    walletHasEnoughGas: walletBalance >= maximumCost
  }, null, 2));
  console.log('只完成编译、地址挖掘和链上读取；此脚本不具备广播交易能力。');
} finally {
  provider?.destroy();
}
