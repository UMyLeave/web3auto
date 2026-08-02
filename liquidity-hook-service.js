import { ethers } from 'ethers';

export const ALL_HOOK_MASK = (1n << 14n) - 1n;
export const BEFORE_ADD_LIQUIDITY_FLAG = 1n << 11n;
export const WHITELIST_HOOK_POLICY_VERSION = 2n;

const WHITELIST_HOOK_ABI = [
  'function policyVersion() view returns (uint256)',
  'function poolManager() view returns (address)',
  'function positionManager() view returns (address)',
  'function whitelistSize() view returns (uint256)',
  'function isWhitelisted(address wallet) view returns (bool)'
];

function normalizedAddress(value, label) {
  try {
    return ethers.getAddress(String(value || '').trim());
  } catch {
    throw new Error(`${label}地址格式错误`);
  }
}

export function normalizeWhitelistWallets(values, fallbackWallet = null) {
  const source = Array.isArray(values) && values.length
    ? values
    : (fallbackWallet ? [fallbackWallet] : []);
  if (!source.length) throw new Error('白名单 Hooks 至少需要一个钱包地址');

  const seen = new Set();
  const wallets = [];
  for (const value of source) {
    const address = normalizedAddress(value, '白名单钱包');
    if (address === ethers.ZeroAddress) throw new Error('白名单钱包不能是零地址');
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wallets.push(address);
  }
  return wallets;
}

export function normalizeWhitelistHookConfig(config, fallbackWallet = null) {
  const raw = config?.whitelistHook || {};
  const label = String(raw.label || '白名单 Hooks').trim().slice(0, 40) || '白名单 Hooks';
  const policyVersion = Number(raw.policyVersion ?? WHITELIST_HOOK_POLICY_VERSION);
  if (!Number.isInteger(policyVersion)
    || BigInt(policyVersion) !== WHITELIST_HOOK_POLICY_VERSION) {
    throw new Error(`白名单 Hooks 配置版本必须为 v${WHITELIST_HOOK_POLICY_VERSION}`);
  }
  const addressText = String(raw.address || '').trim();
  const address = addressText ? normalizedAddress(addressText, '白名单 Hooks 合约') : null;
  const allowedWallets = normalizeWhitelistWallets(raw.allowedWallets, fallbackWallet);
  return {
    id: 'wallet-whitelist',
    type: 'wallet-whitelist',
    policyVersion,
    label,
    address,
    allowedWallets,
    available: Boolean(address)
  };
}

export function publicHookPresets(config, fallbackWallet = null) {
  const hook = normalizeWhitelistHookConfig(config, fallbackWallet);
  return [{
    id: hook.id,
    type: hook.type,
    policyVersion: hook.policyVersion,
    label: hook.label,
    address: hook.address,
    available: hook.available,
    walletCount: hook.allowedWallets.length
  }];
}

export function hookPermissionBits(address) {
  return BigInt(address) & ALL_HOOK_MASK;
}

export function assertWhitelistHookPermissionAddress(address) {
  const normalized = normalizedAddress(address, '白名单 Hooks 合约');
  if (hookPermissionBits(normalized) !== BEFORE_ADD_LIQUIDITY_FLAG) {
    throw new Error('白名单 Hooks 地址权限位不正确，必须只启用 beforeAddLiquidity');
  }
  return normalized;
}

export async function verifyConfiguredWhitelistHook({
  provider,
  config,
  selectedHook,
  walletAddress,
  positionManager,
  poolManager
}) {
  const hook = normalizeWhitelistHookConfig(config, walletAddress);
  const selected = normalizedAddress(selectedHook, 'Hooks 合约');
  if (!hook.address || selected.toLowerCase() !== hook.address.toLowerCase()) return null;

  assertWhitelistHookPermissionAddress(hook.address);
  const code = await provider.getCode(hook.address);
  if (!code || code === '0x') throw new Error('配置的白名单 Hooks 尚未部署');

  const contract = new ethers.Contract(hook.address, WHITELIST_HOOK_ABI, provider);
  let policyVersion;
  try {
    policyVersion = await contract.policyVersion();
  } catch {
    throw new Error('白名单 Hooks 策略版本不兼容，请部署 v2 Hooks');
  }
  if (BigInt(policyVersion) !== WHITELIST_HOOK_POLICY_VERSION) {
    throw new Error('白名单 Hooks 策略版本不兼容，请部署 v2 Hooks');
  }
  const [
    chainPoolManager,
    chainPositionManager,
    whitelistSize,
    walletAllowed
  ] = await Promise.all([
    contract.poolManager(),
    contract.positionManager(),
    contract.whitelistSize(),
    contract.isWhitelisted(walletAddress)
  ]);
  if (chainPoolManager.toLowerCase() !== normalizedAddress(poolManager, 'PoolManager').toLowerCase()) {
    throw new Error('白名单 Hooks 绑定的 PoolManager 与当前项目不一致');
  }
  if (chainPositionManager.toLowerCase()
    !== normalizedAddress(positionManager, 'PositionManager').toLowerCase()) {
    throw new Error('白名单 Hooks 绑定的 PositionManager 与当前项目不一致');
  }
  if (BigInt(whitelistSize) !== BigInt(hook.allowedWallets.length)) {
    throw new Error('配置文件白名单数量与链上白名单不一致，请重新部署 Hooks');
  }
  if (!walletAllowed) throw new Error('当前执行钱包不在白名单 Hooks 的链上白名单中');

  const configuredResults = await Promise.all(
    hook.allowedWallets.map((wallet) => contract.isWhitelisted(wallet))
  );
  if (configuredResults.some((allowed) => !allowed)) {
    throw new Error('配置文件钱包与链上白名单不一致，请重新部署 Hooks');
  }
  return hook;
}
