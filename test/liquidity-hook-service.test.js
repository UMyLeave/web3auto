import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ethers } from 'ethers';
import {
  ALL_HOOK_MASK,
  BEFORE_ADD_LIQUIDITY_FLAG,
  WHITELIST_HOOK_POLICY_VERSION,
  assertWhitelistHookPermissionAddress,
  hookPermissionBits,
  normalizeWhitelistHookConfig,
  normalizeWhitelistWallets,
  publicHookPresets
} from '../liquidity-hook-service.js';
import {
  compileWhitelistHook,
  deploymentGasLimit,
  deploymentGasPrice,
  mineWhitelistHookSalt,
  whitelistHookInitCode
} from '../whitelist-hook-deployment.js';

const WALLET = '0xda83171fe04C97f029a3AA71ef260B30f03aB521';
const OTHER = '0x1111111111111111111111111111111111111111';
const POOL_MANAGER = '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF';
const POSITION_MANAGER = '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b';

test('whitelist config uses an address array, removes duplicates and supports wallet fallback', () => {
  assert.deepEqual(normalizeWhitelistWallets([], WALLET), [WALLET]);
  assert.deepEqual(normalizeWhitelistWallets([WALLET, WALLET.toLowerCase(), OTHER]), [
    WALLET,
    ethers.getAddress(OTHER)
  ]);
  assert.throws(() => normalizeWhitelistWallets([], null), /至少需要一个钱包/);
  assert.throws(() => normalizeWhitelistWallets([ethers.ZeroAddress]), /不能是零地址/);
});

test('hook presets remain visible but unavailable until a contract address is deployed', () => {
  const config = {
    whitelistHook: {
      label: '白名单 Hooks',
      address: '',
      allowedWallets: [WALLET]
    }
  };
  const normalized = normalizeWhitelistHookConfig(config);
  assert.equal(normalized.address, null);
  assert.equal(normalized.available, false);
  assert.deepEqual(publicHookPresets(config), [{
    id: 'wallet-whitelist',
    type: 'wallet-whitelist',
    policyVersion: 2,
    label: '白名单 Hooks',
    address: null,
    available: false,
    walletCount: 1
  }]);
  assert.throws(
    () => normalizeWhitelistHookConfig({
      whitelistHook: { ...config.whitelistHook, policyVersion: 1 }
    }),
    /配置版本必须为 v2/
  );
});

test('whitelist hook address must enable only beforeAddLiquidity', () => {
  const valid = ethers.getAddress('0x0000000000000000000000000000000000000800');
  const extraPermission = ethers.getAddress('0x0000000000000000000000000000000000000c00');
  assert.equal(ALL_HOOK_MASK, 0x3fffn);
  assert.equal(BEFORE_ADD_LIQUIDITY_FLAG, 0x0800n);
  assert.equal(WHITELIST_HOOK_POLICY_VERSION, 2n);
  assert.equal(hookPermissionBits(valid), BEFORE_ADD_LIQUIDITY_FLAG);
  assert.equal(assertWhitelistHookPermissionAddress(valid), valid);
  assert.throws(
    () => assertWhitelistHookPermissionAddress(extraPermission),
    /权限位不正确/
  );
});

test('Solidity hook compiles and CREATE2 mining produces the exact permission bits', async () => {
  const source = await fs.readFile(
    new URL('../contracts/WhitelistLiquidityHook.sol', import.meta.url),
    'utf8'
  );
  const artifact = compileWhitelistHook(source);
  const functionNames = artifact.abi
    .filter((entry) => entry.type === 'function')
    .map((entry) => entry.name);
  assert.ok(functionNames.includes('beforeAddLiquidity'));
  assert.ok(functionNames.includes('isWhitelisted'));
  assert.ok(functionNames.includes('policyVersion'));
  assert.ok(!functionNames.includes('beforeRemoveLiquidity'));
  assert.doesNotMatch(source, /\.msgSender\(/);
  assert.match(source, /\.ownerOf\(uint256\(params\.salt\)\)/);

  const initCode = whitelistHookInitCode({
    artifact,
    poolManager: POOL_MANAGER,
    positionManager: POSITION_MANAGER,
    allowedWallets: [WALLET]
  });
  const mined = mineWhitelistHookSalt({ initCode });
  assert.equal(BigInt(mined.address) & ALL_HOOK_MASK, BEFORE_ADD_LIQUIDITY_FLAG);
  assert.ok(mined.attempts > 0);
  assert.ok(mined.attempts <= 1_000_000);
});

test('v2 whitelist policy authenticates the final NFT owner instead of an intermediary router', async () => {
  const source = await fs.readFile(
    new URL('../contracts/WhitelistLiquidityHook.sol', import.meta.url),
    'utf8'
  );
  assert.match(source, /sender != positionManager/);
  assert.match(source, /ownerOf\(uint256\(params\.salt\)\)/);
  assert.doesNotMatch(source, /msgSender/);
  assert.match(source, /policyVersion = 2/);
});

test('hook deployment gas policy applies the configured floor and final gas-limit ceiling', () => {
  assert.equal(deploymentGasPrice({
    rpcGasPrice: ethers.parseUnits('0.05', 'gwei'),
    minGasPriceGwei: 0.1,
    maxGasPriceGwei: 5
  }), ethers.parseUnits('0.1', 'gwei'));
  assert.equal(deploymentGasLimit(481_774n, 3_000_000), 578_129n);
  assert.throws(() => deploymentGasLimit(2_600_000n, 3_000_000), /超过安全上限/);
  assert.throws(() => deploymentGasPrice({
    rpcGasPrice: ethers.parseUnits('6', 'gwei'),
    minGasPriceGwei: 0.1,
    maxGasPriceGwei: 5
  }), /超过安全上限/);
});

test('liquidity page exposes an empty-by-default hook preset selector', async () => {
  const [html, browserModule] = await Promise.all([
    fs.readFile(new URL('../public/liquidity.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/liquidity.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="hooksPreset"/);
  assert.match(html, /空（不携带 Hooks）/);
  assert.match(browserModule, /renderHookPresets/);
  assert.match(browserModule, /elements\.hooks\.value = elements\.hooksPreset\.value \|\| ZERO_ADDRESS/);
});

test('liquidity page accepts the full static v4 fee precision', async () => {
  const html = await fs.readFile(
    new URL('../public/liquidity.html', import.meta.url),
    'utf8'
  );
  assert.match(
    html,
    /id="feePercent"[^>]*step="0\.0001"/
  );
});
