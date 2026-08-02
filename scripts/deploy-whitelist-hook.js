import 'dotenv/config';
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
const configPath = path.join(root, 'liquidity-config.json');
const sourcePath = path.join(root, 'contracts', 'WhitelistLiquidityHook.sol');
const broadcast = process.argv.includes('--broadcast');
const POSITION_MANAGER_ABI = ['function poolManager() view returns (address)'];

async function openProvider(config) {
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

async function saveHookAddress(config, address) {
  const next = {
    ...config,
    whitelistHook: {
      ...config.whitelistHook,
      policyVersion: Number(WHITELIST_HOOK_POLICY_VERSION),
      address
    }
  };
  const temporaryPath = `${configPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, configPath);
}

let provider;
try {
  const [configText, source] = await Promise.all([
    fs.readFile(configPath, 'utf8'),
    fs.readFile(sourcePath, 'utf8')
  ]);
  const config = JSON.parse(configText);
  const privateKey = String(process.env.PRIVATE_KEY || '').trim();
  const deployerWallet = privateKey ? new ethers.Wallet(privateKey) : null;
  const hookConfig = normalizeWhitelistHookConfig(config, deployerWallet?.address || null);
  const positionManager = ethers.getAddress(config.positionManager);

  provider = await openProvider(config);
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
  const existingCode = await provider.getCode(mined.address);
  const summary = {
    mode: broadcast ? 'broadcast' : 'dry-run',
    deployerWallet: deployerWallet?.address || null,
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
    alreadyDeployed: existingCode !== '0x'
  };

  if (!broadcast) {
    console.log(JSON.stringify(summary, null, 2));
    console.log('仅完成编译、地址挖掘和链上只读检查；未广播部署交易。');
    console.log('真实部署需要同时设置 HOOK_DEPLOY=true 并传入 --broadcast。');
  } else {
    if (process.env.HOOK_DEPLOY !== 'true') {
      throw new Error('HOOK_DEPLOY 未开启，拒绝广播 Hook 部署交易');
    }
    if (!deployerWallet) throw new Error('缺少 PRIVATE_KEY，不能部署 Hook');

    if (existingCode === '0x') {
      const signer = deployerWallet.connect(provider);
      const data = ethers.concat([mined.salt, initCode]);
      const estimatedGas = await provider.estimateGas({
        from: signer.address,
        to: CREATE2_DEPLOYER,
        data,
        value: 0n
      });
      const feeData = await provider.getFeeData();
      if (!feeData.gasPrice) throw new Error('RPC 未返回 gasPrice');
      const gasPrice = deploymentGasPrice({
        rpcGasPrice: feeData.gasPrice,
        minGasPriceGwei: config.minGasPriceGwei,
        maxGasPriceGwei: config.maxGasPriceGwei
      });
      const balance = await provider.getBalance(signer.address);
      const gasLimit = deploymentGasLimit(estimatedGas, config.maxGasLimit);
      const maximumCost = gasLimit * gasPrice;
      if (balance < maximumCost) throw new Error('部署钱包 BNB 不足以支付 Hook 部署 Gas');

      const transaction = await signer.sendTransaction({
        to: CREATE2_DEPLOYER,
        data,
        value: 0n,
        gasLimit,
        gasPrice
      });
      console.log(JSON.stringify({
        ...summary,
        estimatedGas: estimatedGas.toString(),
        gasLimit: gasLimit.toString(),
        gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
        maximumCostWei: maximumCost.toString(),
        transactionHash: transaction.hash
      }, null, 2));
      const receipt = await transaction.wait(1);
      if (!receipt || Number(receipt.status) !== 1) throw new Error('Hook 部署交易执行失败');
    }

    const deployedCode = await provider.getCode(mined.address);
    if (!deployedCode || deployedCode === '0x') throw new Error('部署后没有读取到 Hook 合约代码');
    const hook = new ethers.Contract(mined.address, artifact.abi, provider);
    const [
      policyVersion,
      boundPoolManager,
      boundPositionManager,
      whitelistSize,
      configuredWallets
    ] =
      await Promise.all([
        hook.policyVersion(),
        hook.poolManager(),
        hook.positionManager(),
        hook.whitelistSize(),
        Promise.all(hookConfig.allowedWallets.map((wallet) => hook.isWhitelisted(wallet)))
      ]);
    if (BigInt(policyVersion) !== WHITELIST_HOOK_POLICY_VERSION) {
      throw new Error('部署后的 Hook 策略版本校验失败');
    }
    if (boundPoolManager.toLowerCase() !== poolManager.toLowerCase()) {
      throw new Error('部署后的 Hook PoolManager 校验失败');
    }
    if (boundPositionManager.toLowerCase() !== positionManager.toLowerCase()) {
      throw new Error('部署后的 Hook PositionManager 校验失败');
    }
    if (BigInt(whitelistSize) !== BigInt(hookConfig.allowedWallets.length)
      || configuredWallets.some((allowed) => !allowed)) {
      throw new Error('部署后的 Hook 白名单校验失败');
    }

    await saveHookAddress(config, mined.address);
    console.log(`白名单 Hooks 已部署并写入配置：${mined.address}`);
  }
} finally {
  provider?.destroy();
}
