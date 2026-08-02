import { ethers } from 'ethers';
import solc from 'solc';
import {
  ALL_HOOK_MASK,
  BEFORE_ADD_LIQUIDITY_FLAG,
  normalizeWhitelistWallets
} from './liquidity-hook-service.js';

export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const SOLIDITY_SOURCE_NAME = 'WhitelistLiquidityHook.sol';
export const SOLIDITY_CONTRACT_NAME = 'WhitelistLiquidityHook';

export function deploymentGasPrice({
  rpcGasPrice,
  minGasPriceGwei = 0.1,
  maxGasPriceGwei = 5
}) {
  const rpcPrice = BigInt(rpcGasPrice);
  const minimum = ethers.parseUnits(String(minGasPriceGwei), 'gwei');
  const maximum = ethers.parseUnits(String(maxGasPriceGwei), 'gwei');
  if (minimum <= 0n || maximum < minimum) {
    throw new Error('Hook 部署 Gas Price 上下限配置无效');
  }
  const gasPrice = rpcPrice < minimum ? minimum : rpcPrice;
  if (gasPrice > maximum) {
    throw new Error(`当前 gasPrice 超过安全上限 ${maxGasPriceGwei} Gwei`);
  }
  return gasPrice;
}

export function deploymentGasLimit(estimatedGas, maximumGasLimit = 3_000_000) {
  const estimate = BigInt(estimatedGas);
  const maximum = BigInt(maximumGasLimit);
  const gasLimit = (estimate * 12n + 9n) / 10n;
  if (gasLimit > maximum) {
    throw new Error(`Hook 部署 Gas Limit ${gasLimit} 超过安全上限 ${maximum}`);
  }
  return gasLimit;
}

export function compileWhitelistHook(source) {
  const input = {
    language: 'Solidity',
    sources: {
      [SOLIDITY_SOURCE_NAME]: { content: source }
    },
    settings: {
      optimizer: { enabled: true, runs: 20_000 },
      evmVersion: 'paris',
      metadata: { bytecodeHash: 'none' },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object']
        }
      }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((item) => item.severity === 'error');
  if (errors.length) {
    throw new Error(errors.map((item) => item.formattedMessage || item.message).join('\n'));
  }
  const artifact = output.contracts?.[SOLIDITY_SOURCE_NAME]?.[SOLIDITY_CONTRACT_NAME];
  if (!artifact?.evm?.bytecode?.object) throw new Error('Solidity 编译器没有生成 Hook 字节码');
  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    warnings: (output.errors || [])
      .filter((item) => item.severity !== 'error')
      .map((item) => item.formattedMessage || item.message)
  };
}

export function whitelistHookInitCode({
  artifact,
  poolManager,
  positionManager,
  allowedWallets
}) {
  const wallets = normalizeWhitelistWallets(allowedWallets);
  const constructorArguments = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address[]'],
    [
      ethers.getAddress(poolManager),
      ethers.getAddress(positionManager),
      wallets
    ]
  );
  return ethers.concat([artifact.bytecode, constructorArguments]);
}

export function create2Address(deployer, salt, initCodeHash) {
  return ethers.getAddress(`0x${ethers.keccak256(ethers.concat([
    '0xff',
    ethers.getAddress(deployer),
    ethers.zeroPadValue(ethers.toBeHex(salt), 32),
    initCodeHash
  ])).slice(-40)}`);
}

export function mineWhitelistHookSalt({
  deployer = CREATE2_DEPLOYER,
  initCode,
  startSalt = 0n,
  maximumAttempts = 1_000_000
}) {
  const initCodeHash = ethers.keccak256(initCode);
  const startedAt = Date.now();
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    const saltValue = BigInt(startSalt) + BigInt(attempt);
    const salt = ethers.zeroPadValue(ethers.toBeHex(saltValue), 32);
    const address = create2Address(deployer, salt, initCodeHash);
    if ((BigInt(address) & ALL_HOOK_MASK) === BEFORE_ADD_LIQUIDITY_FLAG) {
      return {
        address,
        salt,
        saltValue,
        attempts: attempt + 1,
        elapsedMs: Date.now() - startedAt,
        initCodeHash
      };
    }
  }
  throw new Error(`在 ${maximumAttempts} 次尝试内没有找到白名单 Hooks CREATE2 地址`);
}
