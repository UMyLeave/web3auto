import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_PATH = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACTION_PATH = path.join(__dirname, '.guard-action.json');
const ACTION_TMP_PATH = path.join(__dirname, '.guard-action.json.tmp');
const AUTH_COOKIE = 'web3auto_session';
const AUTH_SESSION_DEFAULT_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

const V4_POSITION_MANAGER = '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b';
const POSITION_ABI = [
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256 info)',
  'function poolManager() view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable'
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];
const POOL_MANAGER_ABI = ['function extsload(bytes32 slot) view returns (bytes32)'];
const POSITION_INTERFACE = new ethers.Interface(POSITION_ABI);
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const ZERO = ethers.ZeroAddress;
const OKX_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const OKX_API_BASE = 'https://web3.okx.com';
const CHAIN_ID = 56n;
const Q96 = 1n << 96n;
const UINT24_MASK = 0xffffffn;
const UINT160_MASK = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const state = {
  running: false,
  armed: false,
  checking: false,
  lastBlock: null,
  lastTargetLiquidity: null,
  lastTargetLiquidities: null,
  lastAction: null,
  error: null,
  inFlight: false,
  arming: false,
  targetTriggered: false,
  targetLiquidityReference: null,
  targetReferenceBlock: null,
  baseline: null,
  guardNotice: null,
  rpc: null,
  monitorTransport: 'polling',
  monitorWarning: null,
  mineHealthWarning: null
};

let receiptWakeSequence = 0;
let latestStreamBlock = null;
const streamBlockObservedAt = new Map();
const receiptWakeWaiters = new Set();
const authSessions = new Map();
const loginFailures = new Map();

function publishStreamBlock(blockNumber) {
  const numericBlock = Number(blockNumber);
  if (!Number.isFinite(numericBlock)) return;
  latestStreamBlock = Math.max(latestStreamBlock || 0, numericBlock);
  if (!streamBlockObservedAt.has(numericBlock)) {
    streamBlockObservedAt.set(numericBlock, new Date().toISOString());
  }
  while (streamBlockObservedAt.size > 32) {
    streamBlockObservedAt.delete(streamBlockObservedAt.keys().next().value);
  }
  receiptWakeSequence += 1;
  for (const wake of receiptWakeWaiters) wake();
  receiptWakeWaiters.clear();
}

function waitForReceiptWake(sequence, timeoutMs) {
  if (receiptWakeSequence !== sequence) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      receiptWakeWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    receiptWakeWaiters.add(finish);
  });
}

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '32kb' }));
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});

function authEnabled() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function authUsername() {
  return String(process.env.ADMIN_USERNAME || 'admin');
}

function authSessionDurationMs() {
  const requested = Number(process.env.AUTH_SESSION_HOURS || 12) * 60 * 60 * 1000;
  return Math.min(
    AUTH_SESSION_MAX_MS,
    Math.max(60 * 60 * 1000, Number.isFinite(requested) ? requested : AUTH_SESSION_DEFAULT_MS)
  );
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return null;
    const name = part.slice(0, separator).trim();
    if (!name) return null;
    return [name, decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(Boolean));
}

function constantTimeTextEqual(first, second) {
  const firstHash = crypto.createHash('sha256').update(String(first)).digest();
  const secondHash = crypto.createHash('sha256').update(String(second)).digest();
  return crypto.timingSafeEqual(firstHash, secondHash);
}

function pruneAuthState(now = Date.now()) {
  for (const [token, session] of authSessions) {
    if (session.expiresAt <= now) authSessions.delete(token);
  }
  for (const [ip, failure] of loginFailures) {
    if (now - failure.startedAt >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
  }
}

function sessionForRequest(req) {
  if (!authEnabled()) return { disabled: true, csrfToken: null, expiresAt: Infinity };
  pruneAuthState();
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (!token) return null;
  const session = authSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) authSessions.delete(token);
    return null;
  }
  return { ...session, token };
}

function secureAuthCookie(req) {
  return process.env.AUTH_COOKIE_SECURE === 'true' || req.secure;
}

function authCookie(token, req, maxAgeSeconds) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secureAuthCookie(req)) parts.push('Secure');
  return parts.join('; ');
}

function requirePageAuth(req, res, next) {
  if (sessionForRequest(req)) return next();
  res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireApiAuth(req, res, next) {
  const session = sessionForRequest(req);
  if (!session) return res.status(401).json({ error: '登录已失效，请重新登录', code: 'AUTH_REQUIRED' });
  req.authSession = session;
  return next();
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !authEnabled()) return next();
  const supplied = req.get('x-csrf-token');
  if (!supplied || !constantTimeTextEqual(supplied, req.authSession.csrfToken)) {
    return res.status(403).json({ error: '安全令牌无效，请刷新页面后重试', code: 'CSRF_INVALID' });
  }
  return next();
}

function loginFailureState(ip, now = Date.now()) {
  const current = loginFailures.get(ip);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    const fresh = { count: 0, startedAt: now };
    loginFailures.set(ip, fresh);
    return fresh;
  }
  return current;
}

app.get('/login', (req, res) => {
  if (!authEnabled() || sessionForRequest(req)) return res.redirect(303, '/');
  res.set('Cache-Control', 'no-store');
  return res.sendFile(path.join(PUBLIC_PATH, 'login.html'));
});

app.get(['/', '/index.html'], requirePageAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
});

app.get('/api/auth/status', (req, res) => {
  const session = sessionForRequest(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    enabled: authEnabled(),
    authenticated: Boolean(session),
    username: session ? authUsername() : null,
    csrfToken: session?.csrfToken || null,
    expiresAt: Number.isFinite(session?.expiresAt) ? new Date(session.expiresAt).toISOString() : null
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!authEnabled()) return res.status(400).json({ error: '服务器尚未启用登录密码' });
  const now = Date.now();
  pruneAuthState(now);
  const failure = loginFailureState(req.ip, now);
  if (failure.count >= LOGIN_MAX_FAILURES) {
    const retryAfterMs = Math.max(1000, LOGIN_WINDOW_MS - (now - failure.startedAt));
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ error: `登录失败次数过多，请在 ${Math.ceil(retryAfterMs / 60_000)} 分钟后重试` });
  }
  const usernameMatches = constantTimeTextEqual(req.body?.username || '', authUsername());
  const passwordMatches = constantTimeTextEqual(req.body?.password || '', process.env.ADMIN_PASSWORD);
  if (!usernameMatches || !passwordMatches) {
    failure.count += 1;
    return res.status(401).json({
      error: '用户名或密码错误',
      remainingAttempts: Math.max(0, LOGIN_MAX_FAILURES - failure.count)
    });
  }
  loginFailures.delete(req.ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const durationMs = authSessionDurationMs();
  const session = {
    csrfToken,
    createdAt: now,
    expiresAt: now + durationMs
  };
  authSessions.set(token, session);
  res.set('Set-Cookie', authCookie(token, req, Math.floor(durationMs / 1000)));
  return res.json({
    authenticated: true,
    username: authUsername(),
    csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString()
  });
});

app.use('/api', requireApiAuth, requireCsrf);

app.post('/api/auth/logout', (req, res) => {
  if (req.authSession?.token) authSessions.delete(req.authSession.token);
  res.set('Set-Cookie', authCookie('', req, 0));
  res.json({ authenticated: false });
});

app.use(express.static(PUBLIC_PATH, { index: false }));

async function readConfig() {
  return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
}

async function writeConfig(config) {
  const tempPath = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, CONFIG_PATH);
}

async function persistAction(action) {
  state.lastAction = action;
  if (!action) return;
  await fs.writeFile(ACTION_TMP_PATH, `${JSON.stringify(action, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(ACTION_TMP_PATH, ACTION_PATH);
}

async function restoreAction() {
  try {
    state.lastAction = JSON.parse(await fs.readFile(ACTION_PATH, 'utf8'));
    if (['withdraw_submitted', 'withdraw_confirmed', 'swapping'].includes(state.lastAction.stage)
      || state.lastAction.currentTx?.hash) {
      state.lastAction.stage = 'needs_attention';
      state.lastAction.error ||= '服务曾在链上流程中断，需要核对已有交易后恢复';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`恢复执行记录失败: ${error.message}`);
  }
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

async function streamTransactionReceipt(hash, timeoutMs = 1200) {
  const provider = monitorBlockProvider;
  if (!provider || provider.destroyed) return null;
  try {
    return await withTimeout(
      provider.getTransactionReceipt(hash),
      timeoutMs,
      'WSS 回执查询超时'
    );
  } catch {
    return null;
  }
}

class RpcPool {
  constructor(urls, config) {
    this.timeoutMs = Math.max(500, Number(config.rpcTimeoutMs) || 5000);
    this.parallelism = Math.max(2, Number(config.rpcParallelism) || 4);
    this.failureCooldownMs = Math.max(5000, Number(config.rpcFailureCooldownMs) || 30_000);
    this.entries = [...new Set(urls.filter(Boolean))].map((url) => ({
      url,
      provider: new ethers.JsonRpcProvider(url, Number(CHAIN_ID), { batchMaxCount: 1, staticNetwork: true }),
      latency: 1000,
      failures: 0,
      successes: 0,
      chainChecked: false,
      pending: 0,
      cooldownUntil: 0
    }));
  }

  ordered() {
    return [...this.entries].sort((a, b) => {
      const now = Date.now();
      const scoreA = (a.cooldownUntil > now ? 1_000_000 : 0) + a.failures * 10_000 + a.pending * 5000 + a.latency;
      const scoreB = (b.cooldownUntil > now ? 1_000_000 : 0) + b.failures * 10_000 + b.pending * 5000 + b.latency;
      return scoreA - scoreB;
    });
  }

  async attempt(entry, fn, timeoutMs = this.timeoutMs) {
    const startedAt = Date.now();
    entry.pending += 1;
    const operation = (async () => {
      if (!entry.chainChecked) {
        const chainId = BigInt(await entry.provider.send('eth_chainId', []));
        if (chainId !== CHAIN_ID) throw new Error(`链 ID 错误: ${chainId}`);
        entry.chainChecked = true;
      }
      return fn(entry.provider, entry.url);
    })();
    operation.then(
      () => { entry.pending = Math.max(0, entry.pending - 1); },
      () => { entry.pending = Math.max(0, entry.pending - 1); }
    );
    try {
      const value = await withTimeout(operation, timeoutMs, `RPC 超时（${timeoutMs}ms）`);
      entry.successes += 1;
      entry.failures = Math.max(0, entry.failures - 1);
      entry.cooldownUntil = 0;
      entry.latency = Math.round(entry.successes === 1
        ? Date.now() - startedAt
        : entry.latency * 0.7 + (Date.now() - startedAt) * 0.3);
      return value;
    } catch (error) {
      entry.failures += 1;
      if (entry.failures >= 2) entry.cooldownUntil = Date.now() + this.failureCooldownMs;
      throw new Error(`${entry.url}: ${error.message}`);
    }
  }

  async call(fn) {
    if (!this.entries.length) throw new Error('rpcUrls 不能为空');
    const entries = this.ordered();
    const errors = [];
    for (let offset = 0; offset < entries.length; offset += this.parallelism) {
      const batch = entries.slice(offset, offset + this.parallelism);
      try {
        return await Promise.any(batch.map((entry) => this.attempt(entry, fn)));
      } catch (error) {
        errors.push(...(error.errors || [error]));
      }
    }
    throw new Error(`所有 RPC 节点均不可用：${errors.at(-1)?.message || '未知错误'}`);
  }

  async quorum(fn, keyFn, required = 2, sampleSize = 5) {
    if (this.entries.length < required) throw new Error(`至少需要 ${required} 个 RPC 节点`);
    const now = Date.now();
    const ordered = this.ordered();
    const ready = ordered.filter((entry) => entry.cooldownUntil <= now && entry.pending === 0);
    const candidates = ready.length >= required ? ready : ordered.filter((entry) => entry.cooldownUntil <= now);
    const entries = (candidates.length >= required ? candidates : ordered)
      .slice(0, Math.max(required, Math.min(sampleSize, this.entries.length)));
    return new Promise((resolve, reject) => {
      const groups = new Map();
      const errors = [];
      let pending = entries.length;
      let settled = false;
      for (const entry of entries) {
        this.attempt(entry, fn).then((value) => {
          if (settled) return;
          const key = keyFn(value);
          const group = groups.get(key) || { value, voters: [] };
          group.voters.push(entry.url);
          groups.set(key, group);
          if (group.voters.length >= required) {
            settled = true;
            resolve(group);
          }
        }).catch((error) => {
          errors.push(error);
        }).finally(() => {
          pending -= 1;
          if (!settled && pending === 0) {
            reject(new Error(`RPC 未形成 ${required} 节点共识：${errors.at(-1)?.message || '返回值不一致'}`));
          }
        });
      }
    });
  }

  async broadcast(signedTransaction) {
    const expectedHash = ethers.keccak256(signedTransaction);
    const now = Date.now();
    const healthy = this.ordered().filter((entry) => entry.cooldownUntil <= now);
    const entries = healthy.length ? healthy : this.ordered();
    try {
      const response = await Promise.any(entries.map((entry) => this.attempt(
        entry,
        (provider) => provider.broadcastTransaction(signedTransaction),
        Math.max(4000, this.timeoutMs)
      )));
      if (response.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('广播返回的交易哈希不一致');
      return expectedHash;
    } catch (error) {
      throw new Error(`所有 RPC 广播均失败：${error.errors?.at(-1)?.message || error.message}`);
    }
  }

  async firstReceipt(hash) {
    const now = Date.now();
    const ready = this.ordered().filter((entry) => entry.cooldownUntil <= now && entry.pending === 0);
    const entries = (ready.length ? ready : this.ordered()).slice(0, Math.min(4, this.entries.length));
    try {
      return await Promise.any(entries.map((entry) => this.attempt(entry, async (provider) => {
        const receipt = await provider.getTransactionReceipt(hash);
        if (!receipt) throw new Error('交易暂未收录');
        return receipt;
      })));
    } catch {
      return null;
    }
  }

  async waitForReceipt(hash, confirmations, timeoutMs, pollIntervalMs = 150, onIncluded) {
    const deadline = Date.now() + timeoutMs;
    let includedAt = null;
    let receiptDetectedAt = null;
    while (Date.now() < deadline) {
      const wakeSequence = receiptWakeSequence;
      const receipt = await Promise.any([
        this.firstReceipt(hash).then((value) => {
          if (!value) throw new Error('HTTP RPC 暂未返回回执');
          return value;
        }),
        streamTransactionReceipt(hash).then((value) => {
          if (!value) throw new Error('WSS RPC 暂未返回回执');
          return value;
        })
      ]).catch(() => null);
      if (receipt) {
        if (Number(receipt.status) !== 1) throw new Error(`交易执行失败: ${hash}`);
        if (!includedAt) {
          receiptDetectedAt = new Date().toISOString();
          includedAt = streamBlockObservedAt.get(receipt.blockNumber) || receiptDetectedAt;
          if (onIncluded) await onIncluded(receipt, includedAt, receiptDetectedAt);
        }
        let head = latestStreamBlock || 0;
        if (head - receipt.blockNumber + 1 < confirmations) {
          head = Math.max(head, await this.call((provider) => provider.getBlockNumber()));
        }
        if (head - receipt.blockNumber + 1 >= confirmations) {
          const confirmedAt = new Date().toISOString();
          return {
            receipt,
            includedAt,
            receiptDetectedAt,
            receiptDetectionLagMs: elapsedMs(includedAt, receiptDetectedAt),
            confirmedAt,
            confirmationWaitMs: elapsedMs(includedAt, confirmedAt)
          };
        }
      }
      await waitForReceiptWake(wakeSequence, pollIntervalMs);
    }
    throw new Error(`等待交易确认超时，请在区块浏览器检查: ${hash}`);
  }

  diagnostics() {
    return this.ordered().map((entry) => ({
      url: entry.url,
      latencyMs: Number.isFinite(entry.latency) ? entry.latency : null,
      successes: entry.successes,
      failures: entry.failures,
      pending: entry.pending,
      cooldownMs: Math.max(0, entry.cooldownUntil - Date.now())
    }));
  }

  destroy() {
    for (const entry of this.entries) entry.provider.destroy();
  }
}

let cachedPool = null;
let cachedPoolKey = null;

function getRpcPool(config) {
  const key = JSON.stringify({
    urls: config.rpcUrls,
    timeout: config.rpcTimeoutMs,
    parallelism: config.rpcParallelism,
    failureCooldown: config.rpcFailureCooldownMs
  });
  if (cachedPool && key === cachedPoolKey) return cachedPool;
  cachedPool?.destroy();
  cachedPool = new RpcPool(config.rpcUrls || [], config);
  cachedPoolKey = key;
  return cachedPool;
}

async function loadRuntime() {
  const config = await readConfig();
  config.targetNftIds = configuredTargetNftIds(config);
  const pool = getRpcPool(config);
  let wallet = null;
  if (process.env.PRIVATE_KEY) {
    try {
      wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
    } catch {
      throw new Error('当前后台进程加载的 PRIVATE_KEY 格式无效；请检查 .env，并在修改后重新启动脚本');
    }
  }
  return { config, pool, wallet };
}

function normalizeTargetNftIds(value) {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => String(item ?? '').split(/[\s,，;；]+/))
    : String(value ?? '').split(/[\s,，;；]+/);
  const ids = parts.map((item) => item.trim()).filter(Boolean);
  if (!ids.length) throw new Error('请至少填写一个对方 NFT ID');
  const invalid = ids.find((id) => !/^\d+$/.test(id));
  if (invalid) throw new Error(`对方 NFT ID 必须是数字，无法识别：${invalid}`);
  return [...new Set(ids)];
}

function configuredTargetNftIds(config) {
  return normalizeTargetNftIds(config.targetNftIds ?? config.targetNftId);
}

function sameTargetNftIds(first, second) {
  let firstIds;
  let secondIds;
  try {
    firstIds = normalizeTargetNftIds(first);
    secondIds = normalizeTargetNftIds(second);
  } catch {
    return false;
  }
  return firstIds.length === secondIds.length
    && firstIds.every((id, index) => id === secondIds[index]);
}

function actionTargetNftIds(action) {
  return normalizeTargetNftIds(action?.targetNftIds ?? action?.targetNftId);
}

function requireIds(config) {
  const targetNftIds = configuredTargetNftIds(config);
  const myNftId = String(config.myNftId ?? '').trim();
  if (!/^\d+$/.test(myNftId)) throw new Error('请填写我的数字 NFT ID');
  if (targetNftIds.includes(myNftId)) throw new Error('对方 NFT ID 不能包含我的 NFT ID');
  return { targetNftIds, myNftId };
}

function poolFingerprint(poolKey) {
  return [
    ethers.getAddress(poolKey.currency0),
    ethers.getAddress(poolKey.currency1),
    String(poolKey.fee),
    String(poolKey.tickSpacing),
    ethers.getAddress(poolKey.hooks)
  ].join(':').toLowerCase();
}

function tokenPairFingerprint(poolKey) {
  return [poolKey.currency0, poolKey.currency1]
    .map((token) => ethers.getAddress(token).toLowerCase())
    .sort()
    .join(':');
}

function sameTokenPair(firstPoolKey, secondPoolKey) {
  return tokenPairFingerprint(firstPoolKey) === tokenPairFingerprint(secondPoolKey);
}

function monitoredAssetToken(poolKey, config) {
  const stableAddresses = new Set(
    configuredStablecoins(config).map((entry) => entry.address.toLowerCase())
  );
  const nonStableTokens = [poolKey.currency0, poolKey.currency1]
    .map((token) => ethers.getAddress(token))
    .filter((token) => !stableAddresses.has(token.toLowerCase()));
  return nonStableTokens.length === 1 ? nonStableTokens[0].toLowerCase() : null;
}

function compatibleMonitoredPair(firstPoolKey, secondPoolKey, config) {
  if (sameTokenPair(firstPoolKey, secondPoolKey)) return true;
  const firstAsset = monitoredAssetToken(firstPoolKey, config);
  const secondAsset = monitoredAssetToken(secondPoolKey, config);
  return Boolean(firstAsset && secondAsset && firstAsset === secondAsset);
}

async function finalizedBlockNumber(provider, config) {
  try {
    const block = await provider.getBlock('finalized');
    if (block) return block.number;
  } catch {
    // Some public RPCs do not expose the finalized tag.
  }
  const head = await provider.getBlockNumber();
  return Math.max(0, head - Math.max(2, Number(config.fallbackFinalityBlocks) || 3));
}

async function observationBlockNumber(provider, config) {
  if (config.monitorBlockTag === 'latest') return provider.getBlockNumber();
  return finalizedBlockNumber(provider, config);
}

async function positionAt(provider, tokenId, blockTag) {
  const manager = new ethers.Contract(V4_POSITION_MANAGER, POSITION_ABI, provider);
  const [liquidity, details, owner] = await Promise.all([
    manager.getPositionLiquidity(tokenId, { blockTag }),
    manager.getPoolAndPositionInfo(tokenId, { blockTag }),
    manager.ownerOf(tokenId, { blockTag })
  ]);
  return {
    liquidity,
    liquidityText: liquidity.toString(),
    poolKey: details[0],
    info: BigInt(details[1]),
    infoText: details[1].toString(),
    pool: poolFingerprint(details[0]),
    owner: ethers.getAddress(owner)
  };
}

function signed24(value) {
  const raw = BigInt(value) & UINT24_MASK;
  return Number(raw >= 0x800000n ? raw - 0x1000000n : raw);
}

function positionTicks(info) {
  return {
    tickLower: signed24(info >> 8n),
    tickUpper: signed24(info >> 32n)
  };
}

function sqrtPriceAtTick(tick) {
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
    [0x1000n, 0xd097f3bdfd202b8845ad8f792aa5825n],
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
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  const remainder = ratio & ((1n << 32n) - 1n);
  return (ratio >> 32n) + (remainder === 0n ? 0n : 1n);
}

function principalAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };
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

function stableValueAtSqrtPrice(amount0, amount1, sqrtPriceX96, stableTokenIndex) {
  if (sqrtPriceX96 <= 0n) throw new Error('池子价格尚未初始化，无法估算仓位价值');
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  if (stableTokenIndex === 0) {
    return amount0 + amount1 * (1n << 192n) / priceX192;
  }
  if (stableTokenIndex === 1) {
    return amount1 + amount0 * priceX192 / (1n << 192n);
  }
  return null;
}

const tokenMetadataCache = new Map();

async function tokenMetadata(provider, token, blockTag = 'latest') {
  const address = ethers.getAddress(token);
  if (address === ZERO) return { address, symbol: 'BNB', decimals: 18 };
  if (tokenMetadataCache.has(address)) return tokenMetadataCache.get(address);
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  let symbol = `${address.slice(0, 6)}…${address.slice(-4)}`;
  let decimals = 18;
  let verified = false;
  try {
    [symbol, decimals] = await Promise.all([
      contract.symbol({ blockTag }),
      contract.decimals({ blockTag }).then(Number)
    ]);
    verified = true;
  } catch {
    // Non-standard tokens still remain identifiable by address.
  }
  const metadata = { address, symbol: String(symbol), decimals: Number(decimals) };
  if (verified) tokenMetadataCache.set(address, metadata);
  return metadata;
}

function poolIdOf(poolKey) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
  ));
}

async function enrichedPosition(provider, position, blockTag, config) {
  const positionManager = new ethers.Contract(V4_POSITION_MANAGER, POSITION_ABI, provider);
  const poolManagerAddress = await positionManager.poolManager({ blockTag });
  const poolId = poolIdOf(position.poolKey);
  const poolsSlot = ethers.zeroPadValue(ethers.toBeHex(6), 32);
  const stateSlot = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [poolId, poolsSlot]));
  const poolManager = new ethers.Contract(poolManagerAddress, POOL_MANAGER_ABI, provider);
  const [slot0Word, token0, token1] = await Promise.all([
    poolManager.extsload(stateSlot, { blockTag }),
    tokenMetadata(provider, position.poolKey.currency0, blockTag),
    tokenMetadata(provider, position.poolKey.currency1, blockTag)
  ]);
  const slot0 = BigInt(slot0Word);
  const sqrtPriceX96 = slot0 & UINT160_MASK;
  const currentTick = signed24(slot0 >> 160n);
  const { tickLower, tickUpper } = positionTicks(position.info);
  const { amount0, amount1 } = principalAmounts(position.liquidity, sqrtPriceX96, tickLower, tickUpper);
  const stablecoins = configuredStablecoins(config);
  const stableAddresses = new Set(stablecoins.map((item) => item.address.toLowerCase()));
  const token0IsStable = stableAddresses.has(token0.address.toLowerCase());
  const token1IsStable = stableAddresses.has(token1.address.toLowerCase());
  const stableTokenIndex = token0IsStable ? 0 : token1IsStable ? 1 : null;
  const stableMetadata = stableTokenIndex === 0 ? token0 : stableTokenIndex === 1 ? token1 : null;
  const stableValueRaw = stableTokenIndex === null
    ? null
    : stableValueAtSqrtPrice(amount0, amount1, sqrtPriceX96, stableTokenIndex);
  return {
    ...publicPosition(position),
    currentTick,
    tickLower,
    tickUpper,
    amountsEstimated: true,
    amountsExcludeFees: true,
    estimatedStableValue: stableValueRaw === null ? null : {
      ...stableMetadata,
      raw: stableValueRaw.toString(),
      formatted: ethers.formatUnits(stableValueRaw, stableMetadata.decimals),
      basis: 'current_pool_price',
      excludesFees: true
    },
    amounts: [
      {
        ...token0,
        raw: amount0.toString(),
        formatted: ethers.formatUnits(amount0, token0.decimals),
        isStablecoin: token0IsStable
      },
      {
        ...token1,
        raw: amount1.toString(),
        formatted: ethers.formatUnits(amount1, token1.decimals),
        isStablecoin: token1IsStable
      }
    ]
  };
}

function publicPosition(position) {
  const { tickLower, tickUpper } = positionTicks(position.info);
  return {
    liquidity: position.liquidityText,
    owner: position.owner,
    pool: position.pool,
    tickLower,
    tickUpper,
    poolKey: {
      currency0: ethers.getAddress(position.poolKey.currency0),
      currency1: ethers.getAddress(position.poolKey.currency1),
      fee: Number(position.poolKey.fee),
      tickSpacing: Number(position.poolKey.tickSpacing),
      hooks: ethers.getAddress(position.poolKey.hooks)
    }
  };
}

async function fullSnapshotFromProvider(provider, config) {
  const block = await finalizedBlockNumber(provider, config);
  const targetNftIds = configuredTargetNftIds(config);
  const [targets, mine] = await Promise.all([
    Promise.all(targetNftIds.map(async (nftId) => {
      try {
        return { nftId, ...(await positionAt(provider, nftId, block)) };
      } catch (error) {
        throw new Error(`对方 NFT #${nftId} 查询失败：${error.message}`);
      }
    })),
    positionAt(provider, config.myNftId, block)
  ]);
  return { block, targets, target: targets[0], mine };
}

function snapshotKey(snapshot) {
  return [
    ...snapshot.targets.flatMap((target) => [
      target.nftId,
      target.liquidityText,
      target.pool,
      target.infoText
    ]),
    snapshot.mine.liquidityText,
    snapshot.mine.pool,
    snapshot.mine.infoText,
    snapshot.mine.owner.toLowerCase()
  ].join('|');
}

async function getFullConsensus(runtime) {
  const required = Math.max(2, Number(runtime.config.rpcQuorum) || 2);
  const sampleSize = Math.max(required, Number(runtime.config.rpcQuorumSample) || 5);
  const consensus = await runtime.pool.quorum(
    (provider) => fullSnapshotFromProvider(provider, runtime.config),
    snapshotKey,
    required,
    sampleSize
  );
  state.rpc = { voters: consensus.voters, nodes: runtime.pool.diagnostics() };
  return consensus.value;
}

async function mineSnapshotFromProvider(provider, config) {
  const block = await finalizedBlockNumber(provider, config);
  const mine = await positionAt(provider, config.myNftId, block);
  return { block, mine };
}

async function getMineConsensus(runtime) {
  const required = Math.max(2, Number(runtime.config.rpcQuorum) || 2);
  const sampleSize = Math.max(required, Number(runtime.config.rpcQuorumSample) || 5);
  const consensus = await runtime.pool.quorum(
    (provider) => mineSnapshotFromProvider(provider, runtime.config),
    (snapshot) => [
      snapshot.mine.liquidityText,
      snapshot.mine.pool,
      snapshot.mine.owner.toLowerCase()
    ].join('|'),
    required,
    sampleSize
  );
  state.rpc = { voters: consensus.voters, nodes: runtime.pool.diagnostics() };
  return consensus.value;
}

async function mineHealthSnapshotFromProvider(provider, config) {
  const block = await observationBlockNumber(provider, config);
  const mine = await positionAt(provider, config.myNftId, block);
  return { block, mine };
}

async function getMineHealthConsensus(runtime) {
  const required = Math.max(2, Number(runtime.config.rpcQuorum) || 2);
  const sampleSize = Math.max(required, Number(runtime.config.rpcQuorumSample) || 5);
  const consensus = await runtime.pool.quorum(
    (provider) => mineHealthSnapshotFromProvider(provider, runtime.config),
    (snapshot) => [
      snapshot.mine.liquidityText,
      snapshot.mine.pool,
      snapshot.mine.owner.toLowerCase()
    ].join('|'),
    required,
    sampleSize
  );
  return consensus.value;
}

function minePositionIssue(snapshot, baseline, walletAddress) {
  if (!snapshot?.mine || !baseline) {
    return { code: 'baseline_missing', message: '布防基线已丢失，监控已停止' };
  }
  if (snapshot.mine.pool !== baseline.pool) {
    return { code: 'pool_changed', message: '我的 NFT 池子与布防基线不一致，监控已停止' };
  }
  if (snapshot.mine.owner.toLowerCase() !== walletAddress.toLowerCase()) {
    return { code: 'owner_changed', message: '我的 NFT 已转移到其他钱包，监控已自动停止' };
  }
  if (snapshot.mine.liquidity === 0n) {
    return { code: 'liquidity_zero', message: '检测到我的流动性已在外部撤出，监控已自动停止；脚本不会兑换外部撤仓资产' };
  }
  return null;
}

function minePositionInactiveError(issue) {
  const error = new Error(issue.message);
  error.code = 'MINE_POSITION_INACTIVE';
  error.issue = issue;
  return error;
}

async function targetObservationFromProvider(provider, config) {
  const block = await observationBlockNumber(provider, config);
  const manager = new ethers.Contract(V4_POSITION_MANAGER, POSITION_ABI, provider);
  const targets = await Promise.all(configuredTargetNftIds(config).map(async (nftId) => {
    try {
      const liquidity = await manager.getPositionLiquidity(nftId, { blockTag: block });
      return { nftId, liquidity, liquidityText: liquidity.toString() };
    } catch (error) {
      throw new Error(`对方 NFT #${nftId} 流动性查询失败：${error.message}`);
    }
  }));
  return {
    block,
    targets,
    liquidity: targets[0].liquidity,
    liquidityText: targets[0].liquidityText
  };
}

async function getTargetConsensus(runtime) {
  const required = Math.max(2, Number(runtime.config.rpcQuorum) || 2);
  const sampleSize = Math.max(required, Number(runtime.config.rpcQuorumSample) || 5);
  const consensus = await runtime.pool.quorum(
    (provider) => targetObservationFromProvider(provider, runtime.config),
    (value) => value.targets
      .map((target) => `${target.nftId}:${target.liquidityText}`)
      .join('|'),
    required,
    sampleSize
  );
  state.rpc = { voters: consensus.voters, nodes: runtime.pool.diagnostics() };
  return consensus.value;
}

function targetLiquidityMap(targets) {
  return Object.fromEntries((targets || []).map((target) => [
    String(target.nftId),
    String(target.liquidityText ?? target.liquidity)
  ]));
}

function targetLiquidityDecreases(targets, reference) {
  if (!reference) return [];
  return (targets || []).flatMap((target) => {
    const nftId = String(target.nftId);
    if (reference[nftId] === undefined) return [];
    const previousLiquidity = BigInt(reference[nftId]);
    const currentLiquidity = BigInt(target.liquidityText ?? target.liquidity);
    if (currentLiquidity >= previousLiquidity) return [];
    return [{
      targetNftId: nftId,
      previousLiquidity: previousLiquidity.toString(),
      currentLiquidity: currentLiquidity.toString(),
      decreasedBy: (previousLiquidity - currentLiquidity).toString()
    }];
  });
}

function encodeUnlimitedApproval(spender) {
  return ERC20_INTERFACE.encodeFunctionData(
    'approve',
    [ethers.getAddress(spender), MAX_UINT256]
  );
}

async function cacheSwapApprovals(runtime, tokens, stableAddress) {
  const stable = ethers.getAddress(stableAddress);
  const address = runtime.wallet.address;
  const swappableTokens = [...new Set(tokens.map((token) => ethers.getAddress(token)))]
    .filter((token) => token !== ZERO && token.toLowerCase() !== stable.toLowerCase());
  const entries = [];
  // Keep this loop sequential. A pool without a whitelisted stablecoin can have
  // two swappable ERC-20s, and parallel approval preparation could reuse a nonce.
  for (const tokenAddress of swappableTokens) {
    const approve = await okxGet('approve-transaction', {
      chainIndex: '56',
      tokenContractAddress: tokenAddress,
      approveAmount: MAX_UINT256.toString()
    }, runtime.config, { attempts: 1 });
    const spender = ethers.getAddress(approve.dexContractAddress);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI);
    let allowance = await runtime.pool.call(
      (provider) => token.connect(provider).allowance(address, spender)
    );
    let approvalTxHash = null;
    let approvalStatus = 'already_unlimited';
    if (allowance !== MAX_UINT256) {
      const approvalTransaction = await sendTransaction(runtime, {
        to: tokenAddress,
        data: encodeUnlimitedApproval(spender),
        value: 0n
      }, (hash) => {
        approvalTxHash = hash;
      }, null, 'approval');
      approvalTxHash = approvalTransaction.receipt.hash;
      allowance = MAX_UINT256;
      approvalStatus = 'approved_unlimited';
    }
    entries.push({
      token: tokenAddress,
      spender,
      allowance: allowance.toString(),
      approvalStatus,
      approvalTxHash,
      cachedAt: new Date().toISOString()
    });
  }
  return Object.fromEntries(entries.map((entry) => [entry.token.toLowerCase(), entry]));
}

async function armGuard(runtime) {
  const { targetNftIds } = requireIds(runtime.config);
  requireOkxCredentials();
  if (!runtime.wallet) throw new Error('缺少或无法解析 PRIVATE_KEY');
  try {
    const supportedChain = await okxGet(
      'supported/chain',
      { chainIndex: '56' },
      runtime.config,
      { attempts: 1 }
    );
    if (String(supportedChain.chainIndex) !== '56') throw new Error('OKX 未返回 BSC chainIndex=56');
  } catch (error) {
    throw new Error(`OKX 兑换服务当前不可用，拒绝布防：${error.message}`);
  }
  const snapshot = await getFullConsensus(runtime);
  const mismatchedTargets = snapshot.targets
    .filter((target) => !compatibleMonitoredPair(target.poolKey, snapshot.mine.poolKey, runtime.config))
    .map((target) => target.nftId);
  if (mismatchedTargets.length) {
    throw new Error(
      `以下目标 NFT 与我的 NFT 不是同一风险代币，拒绝布防：${mismatchedTargets.join('、')}；`
      + 'USDT、USD1、USDC、U 等白名单稳定币允许不同'
    );
  }
  const emptyTargets = snapshot.targets
    .filter((target) => target.liquidity === 0n)
    .map((target) => target.nftId);
  if (emptyTargets.length) {
    throw new Error(`以下目标 NFT 当前流动性已经为 0，必须先观察到非零流动性才能布防：${emptyTargets.join('、')}`);
  }
  if (snapshot.mine.liquidity === 0n) throw new Error('我的 NFT 当前流动性为 0，无法布防');
  if (snapshot.mine.owner.toLowerCase() !== runtime.wallet.address.toLowerCase()) {
    throw new Error('PRIVATE_KEY 对应钱包不是 myNftId 的持有人');
  }
  const tokens = [snapshot.mine.poolKey.currency0, snapshot.mine.poolKey.currency1]
    .map((token) => ethers.getAddress(token));
  const poolStablecoin = findPoolStablecoin(runtime.config, snapshot.mine.poolKey);
  const [metadata, swapApprovals] = await Promise.all([
    runtime.pool.call((provider) => Promise.all(
      [...new Set([...tokens, poolStablecoin])]
        .map((token) => tokenMetadata(provider, token, snapshot.block))
    )),
    cacheSwapApprovals(runtime, tokens, poolStablecoin)
  ]);
  state.lastBlock = snapshot.block;
  state.lastTargetLiquidity = snapshot.target.liquidityText;
  state.lastTargetLiquidities = targetLiquidityMap(snapshot.targets);
  state.targetLiquidityReference = targetLiquidityMap(snapshot.targets);
  state.targetReferenceBlock = snapshot.block;
  state.baseline = {
    targetNftIds,
    targets: snapshot.targets.map((target) => ({
      nftId: target.nftId,
      liquidity: target.liquidityText,
      pool: target.pool,
      poolKey: {
        currency0: ethers.getAddress(target.poolKey.currency0),
        currency1: ethers.getAddress(target.poolKey.currency1),
        fee: Number(target.poolKey.fee),
        tickSpacing: Number(target.poolKey.tickSpacing),
        hooks: ethers.getAddress(target.poolKey.hooks)
      }
    })),
    myNftId: String(runtime.config.myNftId),
    samePool: snapshot.targets.every((target) => target.pool === snapshot.mine.pool),
    pool: snapshot.mine.pool,
    owner: snapshot.mine.owner,
    liquidity: snapshot.mine.liquidityText,
    observedAtBlock: snapshot.block,
    poolKey: {
      currency0: tokens[0],
      currency1: tokens[1],
      fee: Number(snapshot.mine.poolKey.fee),
      tickSpacing: Number(snapshot.mine.poolKey.tickSpacing),
      hooks: ethers.getAddress(snapshot.mine.poolKey.hooks)
    },
    tokens,
    poolStablecoin,
    tokenMetadata: Object.fromEntries(metadata.map((item) => [item.address.toLowerCase(), item])),
    swapApprovals
  };
  state.targetTriggered = false;
  state.armed = true;
}

async function encodeWithdraw(tokenId, liquidity, poolKey, recipient) {
  const actions = ethers.concat(['0x01', '0x11']);
  const params = [
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
      [tokenId, liquidity, 0, 0, '0x']
    ),
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'address'],
      [poolKey.currency0, poolKey.currency1, recipient]
    )
  ];
  return ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes[]'], [actions, params]);
}

async function balanceSnapshotFromProvider(provider, tokens, address, blockTag = 'latest') {
  const uniqueTokens = [...new Set(tokens.map((token) => ethers.getAddress(token)))];
  const balances = await Promise.all(uniqueTokens.map((token) =>
    token === ZERO
      ? provider.getBalance(address, blockTag)
      : new ethers.Contract(token, ERC20_ABI, provider).balanceOf(address, { blockTag })
  ));
  return Object.fromEntries(uniqueTokens.map((token, index) => [token, balances[index]]));
}

async function balanceSnapshot(runtime, tokens, address, blockTag = 'latest') {
  return runtime.pool.call(
    (provider) => balanceSnapshotFromProvider(provider, tokens, address, blockTag)
  );
}

async function fastIncludedBalanceSnapshot(runtime, tokens, address, blockTag) {
  const attempts = [balanceSnapshot(runtime, tokens, address, blockTag)];
  const streamProvider = monitorBlockProvider;
  if (streamProvider && !streamProvider.destroyed) {
    attempts.push(withTimeout(
      balanceSnapshotFromProvider(streamProvider, tokens, address, blockTag),
      Math.max(1000, Number(runtime.config.rpcTimeoutMs) || 5000),
      'WSS 到账余额查询超时'
    ));
  }
  return Promise.any(attempts);
}

function positiveDelta(after, before, token) {
  return (after[token] ?? 0n) - (before[token] ?? 0n);
}

function elapsedMs(start, end = new Date().toISOString()) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function activeSwapAttemptTiming(activeSwap, endedAt) {
  if (!activeSwap?.startedAt) return { durationMs: null, confirmationWaitMs: 0 };
  let approvalWaitMs = Number(activeSwap.approvalConfirmationWaitMs || 0);
  if (activeSwap.approvalIncludedAt && !activeSwap.approvalConfirmedAt) {
    approvalWaitMs += Number(elapsedMs(activeSwap.approvalIncludedAt, endedAt) || 0);
  }
  let swapWaitMs = 0;
  if (activeSwap.swapIncludedAt) {
    swapWaitMs = Number(
      activeSwap.swapConfirmationWaitMs
      ?? elapsedMs(activeSwap.swapIncludedAt, endedAt)
      ?? 0
    );
  }
  const criticalEnd = activeSwap.swapIncludedAt || endedAt;
  return {
    durationMs: Math.max(0, Number(elapsedMs(activeSwap.startedAt, criticalEnd) || 0) - approvalWaitMs),
    confirmationWaitMs: approvalWaitMs + swapWaitMs
  };
}

function actionTokenMeta(action, token) {
  return action.tokenMetadata?.[ethers.getAddress(token).toLowerCase()] || null;
}

function completeActionMetrics(action) {
  action.timingVersion = 4;
  const withdrawCriticalEnd = action.withdrawIncludedAt || action.withdrawConfirmedAt;
  if (withdrawCriticalEnd && action.detectedAt) {
    action.withdrawDurationMs = elapsedMs(action.detectedAt, withdrawCriticalEnd);
  }
  const measuredSwaps = (action.results || []).filter((result) =>
    result.status !== 'skipped'
    && result.status !== 'resolved_manually'
    && Number.isFinite(Number(result.durationMs))
  );
  action.swapDurationMs = measuredSwaps.length
    ? measuredSwaps.reduce((total, result) => total + Number(result.durationMs), 0)
    : null;
  action.confirmationWaitMs = Number(action.withdrawConfirmationWaitMs || 0)
    + (action.results || []).reduce((total, result) => total + Number(result.confirmationWaitMs || 0), 0);
  action.verificationDurationMs = (action.results || [])
    .reduce((total, result) => total + Number(result.verificationDurationMs || 0), 0);
  action.nonCriticalDurationMs = action.confirmationWaitMs + action.verificationDurationMs;
  if (action.completedAt && action.detectedAt) {
    action.processDurationMs = elapsedMs(action.detectedAt, action.completedAt);
    action.totalDurationMs = Math.max(0, action.processDurationMs - action.nonCriticalDurationMs);
  }
  action.finalStablecoinReceived = (action.results || []).reduce((total, result) => {
    const isStableInput = ethers.getAddress(result.tokenIn) === ethers.getAddress(action.poolStablecoin);
    const amount = result.actualReceived ?? (isStableInput && result.status === 'skipped' ? result.amountIn : '0');
    return total + BigInt(amount || 0);
  }, 0n).toString();
}

function configuredStablecoins(config) {
  const entries = Array.isArray(config.stablecoins) ? [...config.stablecoins] : [];
  if (config.stablecoin?.address) entries.unshift(config.stablecoin);
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry?.address) return false;
    const address = ethers.getAddress(entry.address);
    if (seen.has(address)) return false;
    seen.add(address);
    return true;
  }).map((entry) => ({ ...entry, address: ethers.getAddress(entry.address) }));
}

function findPoolStablecoin(config, poolKey) {
  const poolTokens = [poolKey.currency0, poolKey.currency1].map((token) => ethers.getAddress(token));
  const candidates = configuredStablecoins(config).filter((entry) => poolTokens.includes(entry.address));
  if (candidates.length) return candidates[0].address;
  if (!config.stablecoin?.address) throw new Error('当前池子未匹配到稳定币，且 config.json 未配置默认 stablecoin');
  return ethers.getAddress(config.stablecoin.address);
}

function requireOkxCredentials() {
  for (const name of ['OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_API_PASSPHRASE']) {
    if (!process.env[name]) throw new Error(`缺少 ${name}，未执行撤出`);
  }
}

function okxHeaders(timestamp, signature) {
  const headers = {
    'OK-ACCESS-KEY': process.env.OKX_API_KEY,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': process.env.OKX_API_PASSPHRASE,
    'Content-Type': 'application/json'
  };
  if (process.env.OKX_PROJECT_ID) headers['OK-ACCESS-PROJECT'] = process.env.OKX_PROJECT_ID;
  return headers;
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

async function okxGet(endpoint, params, config = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? config.okxRequestAttempts ?? 2));
  const timeoutMs = Math.max(2000, Number(config.okxRequestTimeoutMs) || 8000);
  const externalSignal = options.signal;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (externalSignal?.aborted) {
      const aborted = new Error(`OKX ${endpoint} 预准备已取消`);
      aborted.okxEndpoint = endpoint;
      throw aborted;
    }
    const query = new URLSearchParams(params).toString();
    const requestPath = `/api/v6/dex/aggregator/${endpoint}`;
    const queryPath = query ? `?${query}` : '';
    const timestamp = new Date().toISOString();
    const signature = crypto.createHmac('sha256', process.env.OKX_SECRET_KEY)
      .update(`${timestamp}GET${requestPath}${queryPath}`)
      .digest('base64');
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${OKX_API_BASE}${requestPath}${queryPath}`, {
        headers: okxHeaders(timestamp, signature),
        signal: externalSignal
          ? AbortSignal.any([externalSignal, timeoutSignal])
          : timeoutSignal
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
      if (externalSignal?.aborted) {
        const aborted = new Error(`OKX ${endpoint} 预准备已取消`);
        aborted.okxEndpoint = endpoint;
        aborted.cause = error;
        throw aborted;
      }
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

function bigintFrom(value, fallback = 0n) {
  if (value === undefined || value === null || value === '') return fallback;
  return BigInt(value);
}

function transactionConfirmations(config, kind = 'swap') {
  if (kind === 'withdraw') {
    return Math.max(1, Number(config.withdrawConfirmations ?? 1) || 1);
  }
  if (kind === 'approval') {
    return Math.max(1, Number(config.approvalConfirmations ?? 1) || 1);
  }
  return Math.max(1, Number(config.swapConfirmations ?? config.confirmations ?? 2) || 2);
}

async function prepareTransaction(runtime, request) {
  if (!runtime.wallet) throw new Error('缺少 PRIVATE_KEY');
  const from = runtime.wallet.address;
  const to = ethers.getAddress(request.to);
  const value = bigintFrom(request.value);
  const data = request.data || '0x';
  if (!ethers.isHexString(data)) throw new Error('交易 calldata 格式错误');

  const prepared = await runtime.pool.call(async (provider) => {
    const callRequest = { from, to, data, value };
    const [nonce, estimatedGas, feeData] = await Promise.all([
      provider.getTransactionCount(from, 'pending'),
      provider.estimateGas(callRequest),
      provider.getFeeData()
    ]);
    if (!feeData.gasPrice) throw new Error('RPC 未返回 gasPrice');
    return { nonce, estimatedGas, gasPrice: feeData.gasPrice };
  });

  const minimumGasPrice = ethers.parseUnits(String(runtime.config.minGasPriceGwei ?? 0.1), 'gwei');
  const requestedGasPrice = bigintFrom(request.gasPrice);
  const gasPrice = [prepared.gasPrice, requestedGasPrice, minimumGasPrice]
    .reduce((highest, value) => value > highest ? value : highest, 0n);
  const maxGasPrice = ethers.parseUnits(String(runtime.config.maxGasPriceGwei ?? 5), 'gwei');
  if (minimumGasPrice > maxGasPrice) {
    throw new Error('GasPrice 下限不能高于安全上限');
  }
  if (gasPrice > maxGasPrice) {
    throw new Error(`当前 gasPrice 超过安全上限 ${runtime.config.maxGasPriceGwei ?? 5} Gwei`);
  }
  const gasLimit = prepared.estimatedGas * 12n / 10n;
  const maxGasLimit = BigInt(runtime.config.maxGasLimit ?? 3_000_000);
  if (gasLimit > maxGasLimit) throw new Error(`预估 Gas ${gasLimit} 超过安全上限 ${maxGasLimit}`);

  const signed = await runtime.wallet.signTransaction({
    chainId: CHAIN_ID,
    type: 0,
    nonce: prepared.nonce,
    to,
    data,
    value,
    gasLimit,
    gasPrice
  });
  const expectedHash = ethers.keccak256(signed);
  return {
    chainId: CHAIN_ID,
    from,
    to,
    value,
    data,
    nonce: prepared.nonce,
    gasLimit,
    gasPrice,
    signed,
    expectedHash
  };
}

async function submitPreparedTransaction(runtime, prepared, onBroadcast, onIncluded, confirmationKind = 'swap') {
  // Persist the deterministic hash before broadcasting. If every RPC returns an
  // ambiguous timeout, the guard will not generate a second withdrawal blindly.
  if (onBroadcast) await onBroadcast(prepared.expectedHash);
  const hash = await runtime.pool.broadcast(prepared.signed);
  if (hash !== prepared.expectedHash) throw new Error('本地交易哈希与广播哈希不一致');
  return runtime.pool.waitForReceipt(
    hash,
    transactionConfirmations(runtime.config, confirmationKind),
    Math.max(30_000, Number(runtime.config.transactionTimeoutMs) || 90_000),
    Math.max(100, Number(runtime.config.receiptPollIntervalMs) || 150),
    onIncluded
  );
}

async function sendTransaction(runtime, request, onBroadcast, onIncluded, confirmationKind = 'swap') {
  const prepared = await prepareTransaction(runtime, request);
  return submitPreparedTransaction(runtime, prepared, onBroadcast, onIncluded, confirmationKind);
}

function validateSwapResponse(swap, tokenIn, stableAddress, amountIn, walletAddress, config = {}) {
  const fromAddress = tokenIn === ZERO ? OKX_NATIVE : ethers.getAddress(tokenIn);
  const result = swap.routerResult;
  if (!result || !swap.tx) throw new Error('OKX swap 响应缺少 routerResult 或 tx');
  const resultFrom = result.fromToken?.tokenContractAddress;
  const resultTo = result.toToken?.tokenContractAddress;
  if (resultFrom && resultFrom.toLowerCase() !== fromAddress.toLowerCase()) throw new Error('OKX 返回的输入币种不一致');
  if (resultTo && ethers.getAddress(resultTo) !== ethers.getAddress(stableAddress)) throw new Error('OKX 返回的目标币种不一致');
  if (result.fromTokenAmount && BigInt(result.fromTokenAmount) > amountIn) throw new Error('OKX 请求使用的输入数量超出余额增量');
  if (!result.toTokenAmount || BigInt(result.toTokenAmount) <= 0n) throw new Error('OKX 返回的预计到账数量无效');
  const fromDecimals = Number(result.fromToken?.decimal);
  const toDecimals = Number(result.toToken?.decimal);
  const fromPrice = Number(result.fromToken?.tokenUnitPrice);
  const toPrice = Number(result.toToken?.tokenUnitPrice);
  if ([fromDecimals, toDecimals, fromPrice, toPrice].every(Number.isFinite) && fromPrice > 0 && toPrice > 0) {
    const inputValue = Number(result.fromTokenAmount || amountIn) / (10 ** fromDecimals) * fromPrice;
    const outputValue = Number(result.toTokenAmount) / (10 ** toDecimals) * toPrice;
    const valueLossPercent = inputValue > 0 ? Math.max(0, (inputValue - outputValue) / inputValue * 100) : 0;
    const maxLoss = Number(config.maxQuoteValueLossPercent ?? 5);
    if (valueLossPercent > maxLoss) {
      throw new Error(`OKX 路由预计价值损失 ${valueLossPercent.toFixed(2)}%，超过安全上限 ${maxLoss}%`);
    }
  }
  if (swap.tx.from && ethers.getAddress(swap.tx.from) !== ethers.getAddress(walletAddress)) throw new Error('OKX 交易发送地址不一致');
  if (!swap.tx.to || ethers.getAddress(swap.tx.to) === ZERO || !ethers.isHexString(swap.tx.data || '')) {
    throw new Error('OKX 返回的交易目标或 calldata 无效');
  }
  const txValue = bigintFrom(swap.tx.value);
  if (tokenIn !== ZERO && txValue !== 0n) throw new Error('ERC-20 兑换交易包含异常原生币 value');
  if (tokenIn === ZERO && txValue > amountIn) throw new Error('原生币兑换 value 超过可用数量');
}

function singleSwapCandidate(tokens, after, before, stableAddress) {
  const stable = ethers.getAddress(stableAddress);
  const candidates = [...new Set(tokens.map((token) => ethers.getAddress(token)))]
    .map((token) => ({ token, amount: positiveDelta(after, before, token) }))
    .filter(({ token, amount }) => amount > 0n && token.toLowerCase() !== stable.toLowerCase());
  return candidates.length === 1 ? candidates[0] : null;
}

function preparedSwapMatches(preloaded, tokenIn, amountIn, stableAddress, maxAgeMs = 5000, now = Date.now()) {
  if (!preloaded || preloaded.status !== 'ready' || !preloaded.preparedTransaction) return false;
  const preparedAtMs = Date.parse(preloaded.quoteReceivedAt || preloaded.completedAt || '');
  if (!Number.isFinite(preparedAtMs) || now - preparedAtMs < 0 || now - preparedAtMs > maxAgeMs) return false;
  return ethers.getAddress(preloaded.tokenIn) === ethers.getAddress(tokenIn)
    && BigInt(preloaded.amountIn) === BigInt(amountIn)
    && ethers.getAddress(preloaded.toToken) === ethers.getAddress(stableAddress);
}

function cachedApprovalForAmount(baseline, tokenIn, amountIn) {
  if (!baseline || tokenIn === ZERO) return null;
  const tokenAddress = ethers.getAddress(tokenIn);
  const cached = baseline.swapApprovals?.[tokenAddress.toLowerCase()];
  if (!cached?.spender || BigInt(cached.allowance || 0) < amountIn) return null;
  return {
    spender: ethers.getAddress(cached.spender),
    allowance: BigInt(cached.allowance),
    cachedAt: cached.cachedAt || null
  };
}

function trackSwapPreload(promise) {
  const handle = {
    settled: false,
    value: null,
    error: null,
    fallbackReason: null,
    promise: null
  };
  handle.promise = Promise.resolve(promise).then(
    (value) => {
      handle.settled = true;
      handle.value = value;
      return value;
    },
    (error) => {
      handle.settled = true;
      handle.error = error;
      return null;
    }
  );
  return handle;
}

async function consumeSwapPreload(handle, runtime, tokenIn, amountIn, stableAddress) {
  if (!handle) return null;
  if (!handle.settled) await handle.promise;
  if (handle.error) {
    handle.fallbackReason = `并行预准备失败：${handle.error.message}`;
    return null;
  }
  if (!handle.value) {
    handle.fallbackReason = '当前撤仓结果不适合单笔并行预准备';
    return null;
  }
  if (handle.value.status === 'approval_required') {
    handle.fallbackReason = '现有 allowance 不足，需要串行授权';
    return null;
  }
  const maxAgeMs = Math.max(1000, Math.min(30_000, Number(runtime.config.swapPreloadMaxAgeMs ?? 5000)));
  if (!preparedSwapMatches(handle.value, tokenIn, amountIn, stableAddress, maxAgeMs)) {
    handle.fallbackReason = '并行报价已过期，或币种、金额、目标稳定币不再匹配';
    return null;
  }
  handle.fallbackReason = null;
  return handle.value;
}

async function preloadSwapToStable(runtime, tokenIn, amountIn, stableAddress, stableBalanceAtBlock, signal = null) {
  const startedAt = new Date().toISOString();
  const stable = ethers.getAddress(stableAddress);
  const input = tokenIn === ZERO ? OKX_NATIVE : ethers.getAddress(tokenIn);
  const address = runtime.wallet.address;
  let approvalSpender = null;
  let approvalSource = tokenIn === ZERO ? 'native' : 'live';

  if (tokenIn !== ZERO) {
    const tokenAddress = ethers.getAddress(tokenIn);
    const cachedApproval = cachedApprovalForAmount(state.baseline, tokenAddress, amountIn);
    if (cachedApproval) {
      approvalSpender = cachedApproval.spender;
      approvalSource = 'armed_cache';
    } else {
      const approve = await okxGet('approve-transaction', {
        chainIndex: '56',
        tokenContractAddress: tokenAddress,
        approveAmount: MAX_UINT256.toString()
      }, runtime.config, { signal });
      approvalSpender = ethers.getAddress(approve.dexContractAddress);
      const token = new ethers.Contract(tokenAddress, ERC20_ABI);
      const allowance = await runtime.pool.call(
        (provider) => token.connect(provider).allowance(address, approvalSpender)
      );
      if (allowance < amountIn) {
        return {
          status: 'approval_required',
          tokenIn,
          amountIn: amountIn.toString(),
          toToken: stable,
          approvalSpender,
          approvalSource,
          startedAt,
          completedAt: new Date().toISOString()
        };
      }
    }
  }

  const [swap, stableBalanceBefore] = await Promise.all([
    okxGet('swap', {
      chainIndex: '56',
      amount: amountIn.toString(),
      swapMode: 'exactIn',
      fromTokenAddress: input,
      toTokenAddress: stable,
      slippagePercent: String(Number(runtime.config.swap.maxSlippageBps ?? 100) / 100),
      userWalletAddress: address,
      swapReceiverAddress: address,
      gasLevel: 'fast'
    }, runtime.config, { signal }),
    stableBalanceAtBlock === undefined || stableBalanceAtBlock === null
      ? walletTokenBalance(runtime, stable, address)
      : Promise.resolve(BigInt(stableBalanceAtBlock))
  ]);
  if (signal?.aborted) throw new Error('兑换预准备已取消');
  const quoteReceivedAt = new Date().toISOString();
  validateSwapResponse(swap, tokenIn, stable, amountIn, address, runtime.config);
  const preparedTransaction = await prepareTransaction(runtime, {
    to: swap.tx.to,
    data: swap.tx.data,
    value: bigintFrom(swap.tx.value),
    gasPrice: swap.tx.gasPrice
  });
  if (signal?.aborted) throw new Error('兑换预准备已取消');
  return {
    status: 'ready',
    tokenIn,
    amountIn: amountIn.toString(),
    toToken: stable,
    swap,
    approvalSpender,
    approvalSource,
    stableBalanceBefore: stableBalanceBefore.toString(),
    preparedTransaction,
    startedAt,
    quoteReceivedAt,
    completedAt: new Date().toISOString()
  };
}

async function swapToStable(runtime, tokenIn, amountIn, stableAddress, action, preloadHandle = null) {
  const stable = ethers.getAddress(stableAddress);
  const input = tokenIn === ZERO ? OKX_NATIVE : ethers.getAddress(tokenIn);
  const startedAt = new Date().toISOString();
  const inputMeta = actionTokenMeta(action, tokenIn);
  const stableMeta = actionTokenMeta(action, stable);
  if (amountIn <= 0n || input.toLowerCase() === stable.toLowerCase()) {
    return {
      tokenIn,
      tokenInSymbol: inputMeta?.symbol,
      tokenInDecimals: inputMeta?.decimals,
      amountIn: amountIn.toString(),
      toToken: stable,
      toTokenSymbol: stableMeta?.symbol,
      toTokenDecimals: stableMeta?.decimals,
      actualReceived: amountIn.toString(),
      status: 'skipped',
      reason: '已经是目标稳定币',
      startedAt,
      completedAt: startedAt,
      durationMs: 0
    };
  }

  const address = runtime.wallet.address;
  action.activeSwap = {
    tokenIn,
    amountIn: amountIn.toString(),
    toToken: stable,
    stage: 'checking_approval',
    startedAt,
    approvalTxHash: null,
    swapTxHash: null
  };
  await persistAction(action);
  let approvalConfirmationWaitMs = 0;
  let preloaded = await consumeSwapPreload(
    preloadHandle,
    runtime,
    tokenIn,
    amountIn,
    stable
  );
  if (preloaded) {
    try {
      validateSwapResponse(preloaded.swap, tokenIn, stable, amountIn, address, runtime.config);
    } catch (error) {
      if (preloadHandle) preloadHandle.fallbackReason = `并行报价复核失败：${error.message}`;
      preloaded = null;
    }
  }
  action.activeSwap.preloadFallbackReason = preloaded
    ? null
    : preloadHandle?.fallbackReason || null;

  if (!preloaded && tokenIn !== ZERO) {
    action.activeSwap.stage = 'requesting_approval';
    await persistAction(action);
    const approve = await okxGet('approve-transaction', {
      chainIndex: '56',
      tokenContractAddress: ethers.getAddress(tokenIn),
      approveAmount: MAX_UINT256.toString()
    }, runtime.config);
    const token = new ethers.Contract(ethers.getAddress(tokenIn), ERC20_ABI);
    const allowance = await runtime.pool.call((provider) => token.connect(provider).allowance(address, approve.dexContractAddress));
    if (allowance < amountIn) {
      action.activeSwap.stage = 'approving';
      const approvalTransaction = await sendTransaction(runtime, {
        // approve(...) must be called on the ERC-20 token contract.
        to: ethers.getAddress(tokenIn),
        data: encodeUnlimitedApproval(approve.dexContractAddress),
        value: 0n
      }, async (hash) => {
        action.currentTx = { type: 'approve', token: tokenIn, hash };
        action.activeSwap.approvalTxHash = hash;
        action.activeSwap.approvalSubmittedAt = new Date().toISOString();
        await persistAction(action);
      }, (_receipt, includedAt) => {
        action.activeSwap.approvalIncludedAt = includedAt;
      }, 'approval');
      const approvalReceipt = approvalTransaction.receipt;
      action.activeSwap.approvalTxHash = approvalReceipt.hash;
      action.activeSwap.approvalIncludedAt = approvalTransaction.includedAt;
      action.activeSwap.approvalConfirmedAt = approvalTransaction.confirmedAt;
      action.activeSwap.approvalConfirmationWaitMs = approvalTransaction.confirmationWaitMs;
      approvalConfirmationWaitMs = approvalTransaction.confirmationWaitMs;
      action.activeSwap.approvalGasUsed = approvalReceipt.gasUsed.toString();
      action.activeSwap.approvalFeeWei = (approvalReceipt.gasUsed * (approvalReceipt.gasPrice || 0n)).toString();
      action.currentTx = null;
      await persistAction(action);
    }
  }

  let swap;
  let stableBalanceBefore;
  if (preloaded) {
    swap = preloaded.swap;
    stableBalanceBefore = BigInt(preloaded.stableBalanceBefore);
  } else {
    action.activeSwap.stage = 'requesting_swap';
    await persistAction(action);
    [swap, stableBalanceBefore] = await Promise.all([
      okxGet('swap', {
        chainIndex: '56',
        amount: amountIn.toString(),
        swapMode: 'exactIn',
        fromTokenAddress: input,
        toTokenAddress: stable,
        slippagePercent: String(Number(runtime.config.swap.maxSlippageBps ?? 100) / 100),
        userWalletAddress: address,
        swapReceiverAddress: address,
        gasLevel: 'fast'
      }, runtime.config),
      walletTokenBalance(runtime, stable, address)
    ]);
  }
  validateSwapResponse(swap, tokenIn, stable, amountIn, address, runtime.config);
  action.activeSwap.stage = 'swapping';
  const onBroadcast = async (hash) => {
    action.currentTx = { type: 'swap', token: tokenIn, amountIn: amountIn.toString(), toToken: stable, hash };
    action.activeSwap.swapTxHash = hash;
    action.activeSwap.swapSubmittedAt = new Date().toISOString();
    await persistAction(action);
  };
  const onIncluded = (_receipt, includedAt, receiptDetectedAt) => {
    action.activeSwap.swapIncludedAt = includedAt;
    action.activeSwap.swapReceiptDetectedAt = receiptDetectedAt;
  };
  const swapTransaction = preloaded
    ? await submitPreparedTransaction(runtime, preloaded.preparedTransaction, onBroadcast, onIncluded)
    : await sendTransaction(runtime, {
      to: swap.tx.to,
      data: swap.tx.data,
      value: bigintFrom(swap.tx.value),
      gasPrice: swap.tx.gasPrice
    }, onBroadcast, onIncluded);
  const receipt = swapTransaction.receipt;
  action.activeSwap.swapIncludedAt = swapTransaction.includedAt;
  action.activeSwap.swapConfirmedAt = swapTransaction.confirmedAt;
  action.activeSwap.swapConfirmationWaitMs = swapTransaction.confirmationWaitMs;
  const verificationStartedAt = new Date().toISOString();
  const stableBalanceAfter = await walletTokenBalance(runtime, stable, address, receipt.blockNumber);
  const completedAt = new Date().toISOString();
  const verificationDurationMs = elapsedMs(verificationStartedAt, completedAt);
  const criticalDurationMs = Math.max(
    0,
    Number(elapsedMs(startedAt, swapTransaction.includedAt) || 0) - approvalConfirmationWaitMs
  );
  return {
    tokenIn,
    tokenInSymbol: inputMeta?.symbol,
    tokenInDecimals: inputMeta?.decimals,
    amountIn: amountIn.toString(),
    toToken: stable,
    toTokenSymbol: stableMeta?.symbol,
    toTokenDecimals: stableMeta?.decimals,
    quotedReceived: swap.routerResult.toTokenAmount,
    actualReceived: positiveDelta(
      { [stable]: stableBalanceAfter },
      { [stable]: stableBalanceBefore },
      stable
    ).toString(),
    txHash: receipt.hash,
    router: swap.tx.to,
    approvalTxHash: action.activeSwap.approvalTxHash,
    gasUsed: receipt.gasUsed.toString(),
    feeWei: (receipt.gasUsed * (receipt.gasPrice || 0n)).toString(),
    status: 'confirmed',
    preparationMode: preloaded ? 'overlapped_with_withdraw_confirmation' : 'serial',
    approvalSource: preloaded?.approvalSource || 'live',
    preloadDurationMs: preloaded ? elapsedMs(preloaded.startedAt, preloaded.completedAt) : null,
    preloadFallbackReason: preloaded ? null : preloadHandle?.fallbackReason || null,
    startedAt,
    submittedAt: action.activeSwap.swapSubmittedAt,
    includedAt: swapTransaction.includedAt,
    receiptDetectedAt: swapTransaction.receiptDetectedAt,
    receiptDetectionLagMs: swapTransaction.receiptDetectionLagMs,
    confirmedAt: swapTransaction.confirmedAt,
    completedAt,
    durationMs: criticalDurationMs,
    confirmationWaitMs: approvalConfirmationWaitMs + swapTransaction.confirmationWaitMs,
    verificationDurationMs
  };
}

function resetGuardAfterExecution() {
  state.running = false;
  state.armed = false;
  state.baseline = null;
  state.targetTriggered = false;
  state.targetLiquidityReference = null;
  state.targetReferenceBlock = null;
  clearTimeout(timer);
  clearTimeout(mineHealthTimer);
  idleBlockStream();
}

function stopMonitoringForMineIssue(issue) {
  state.running = false;
  state.armed = false;
  state.baseline = null;
  state.targetTriggered = false;
  state.targetLiquidityReference = null;
  state.targetReferenceBlock = null;
  state.error = null;
  state.mineHealthWarning = null;
  state.guardNotice = {
    id: `mine-position:${issue.code}:${Date.now()}`,
    type: 'warning',
    message: issue.message,
    detectedAt: new Date().toISOString()
  };
  clearTimeout(timer);
  clearTimeout(mineHealthTimer);
  idleBlockStream();
}

async function executeWithdraw(runtime, trigger = null) {
  if (state.inFlight) throw new Error('已有链上操作正在执行');
  state.inFlight = true;
  const targetNftIds = configuredTargetNftIds(runtime.config);
  const action = {
    stage: 'preparing',
    targetNftIds,
    targetNftId: trigger?.targetNftId || targetNftIds[0],
    triggerType: trigger ? 'liquidity_decrease' : null,
    trigger,
    myNftId: String(runtime.config.myNftId),
    detectedAt: trigger?.detectedAt || new Date().toISOString(),
    detectedBlock: trigger?.observedBlock ?? state.lastBlock,
    withdrawStartedAt: new Date().toISOString(),
    withdrawTxHash: null,
    results: [],
    currentTx: null,
    activeSwap: null,
    completedAt: null
  };
  await persistAction(action);

  try {
    const baselineTokens = Array.isArray(state.baseline?.tokens) ? state.baseline.tokens : null;
    const [snapshot, baselineBefore] = await Promise.all([
      getMineConsensus(runtime),
      baselineTokens
        ? balanceSnapshot(runtime, baselineTokens, runtime.wallet.address)
        : Promise.resolve(null)
    ]);
    const mineIssue = minePositionIssue(snapshot, state.baseline, runtime.wallet.address);
    if (mineIssue) throw minePositionInactiveError(mineIssue);

    const poolStablecoin = findPoolStablecoin(runtime.config, snapshot.mine.poolKey);
    const tokens = [snapshot.mine.poolKey.currency0, snapshot.mine.poolKey.currency1]
      .map((token) => ethers.getAddress(token));
    const baselineMatches = baselineTokens
      && tokens.every((token, index) => token === ethers.getAddress(baselineTokens[index]));
    const before = baselineMatches
      ? baselineBefore
      : await balanceSnapshot(runtime, tokens, runtime.wallet.address);
    const baselineMetadata = state.baseline.tokenMetadata || {};
    const hasBaselineMetadata = [...new Set([...tokens, poolStablecoin])]
      .every((token) => baselineMetadata[token.toLowerCase()]);
    const metadata = hasBaselineMetadata
      ? Object.values(baselineMetadata)
      : await runtime.pool.call((provider) => Promise.all(
        [...new Set([...tokens, poolStablecoin])]
          .map((token) => tokenMetadata(provider, token, snapshot.block))
      ));
    action.stage = 'withdrawing';
    action.tokens = tokens;
    action.poolStablecoin = poolStablecoin;
    action.tokenMetadata = Object.fromEntries(metadata.map((item) => [item.address.toLowerCase(), item]));
    action.beforeBalances = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value.toString()]));
    await persistAction(action);

    const unlockData = await encodeWithdraw(
      runtime.config.myNftId,
      snapshot.mine.liquidity,
      snapshot.mine.poolKey,
      runtime.wallet.address
    );
    const deadline = Math.floor(Date.now() / 1000) + 120;
    let afterBalancesPromise = null;
    let swapPreloadHandle = null;
    const withdrawTransaction = await sendTransaction(runtime, {
      to: V4_POSITION_MANAGER,
      data: POSITION_INTERFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]),
      value: 0n
    }, async (hash) => {
      action.withdrawTxHash = hash;
      action.currentTx = { type: 'withdraw', hash };
      action.stage = 'withdraw_submitted';
      action.withdrawSubmittedAt = new Date().toISOString();
      await persistAction(action);
    }, (includedReceipt, includedAt) => {
      action.withdrawIncludedAt = includedAt;
      action.withdrawBlock = includedReceipt.blockNumber;
      afterBalancesPromise = fastIncludedBalanceSnapshot(
        runtime,
        tokens,
        runtime.wallet.address,
        includedReceipt.blockNumber
      ).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      swapPreloadHandle = trackSwapPreload(afterBalancesPromise.then(async (afterResult) => {
        if (afterResult.error) throw afterResult.error;
        const candidate = singleSwapCandidate(tokens, afterResult.value, before, poolStablecoin);
        if (!candidate) return null;
        return preloadSwapToStable(
          runtime,
          candidate.token,
          candidate.amount,
          poolStablecoin,
          afterResult.value[poolStablecoin]
        );
      }));
    }, 'withdraw');
    const receipt = withdrawTransaction.receipt;

    action.withdrawTxHash = receipt.hash;
    action.withdrawBlock = receipt.blockNumber;
    action.withdrawIncludedAt = withdrawTransaction.includedAt;
    action.withdrawReceiptDetectedAt = withdrawTransaction.receiptDetectedAt;
    action.withdrawReceiptDetectionLagMs = withdrawTransaction.receiptDetectionLagMs;
    action.withdrawConfirmedAt = withdrawTransaction.confirmedAt;
    action.withdrawConfirmationWaitMs = withdrawTransaction.confirmationWaitMs;
    action.withdrawDurationMs = elapsedMs(action.detectedAt, action.withdrawIncludedAt);
    action.withdrawGasUsed = receipt.gasUsed.toString();
    action.withdrawFeeWei = (receipt.gasUsed * (receipt.gasPrice || 0n)).toString();
    action.currentTx = null;
    action.stage = 'withdraw_confirmed';
    await persistAction(action);

    const afterResult = afterBalancesPromise
      ? await afterBalancesPromise
      : { value: await balanceSnapshot(runtime, tokens, runtime.wallet.address, receipt.blockNumber) };
    if (afterResult.error) throw afterResult.error;
    const after = afterResult.value;
    action.afterBalances = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value.toString()]));
    action.stage = 'swapping';
    await persistAction(action);

    for (const token of tokens) {
      const amount = positiveDelta(after, before, token);
      const meta = actionTokenMeta(action, token);
      if (amount <= 0n) {
        action.results.push({
          tokenIn: token,
          tokenInSymbol: meta?.symbol,
          tokenInDecimals: meta?.decimals,
          amountIn: amount.toString(),
          status: 'skipped',
          reason: '未检测到正余额增量'
        });
        await persistAction(action);
        continue;
      }
      try {
        const result = await swapToStable(
          runtime,
          token,
          amount,
          poolStablecoin,
          action,
          swapPreloadHandle
        );
        action.results.push(result);
        action.currentTx = null;
        action.activeSwap = null;
        await persistAction(action);
      } catch (error) {
        const failedAt = new Date().toISOString();
        const failedTiming = activeSwapAttemptTiming(action.activeSwap, failedAt);
        action.results.push({
          tokenIn: token,
          tokenInSymbol: meta?.symbol,
          tokenInDecimals: meta?.decimals,
          amountIn: amount.toString(),
          toToken: poolStablecoin,
          toTokenSymbol: actionTokenMeta(action, poolStablecoin)?.symbol,
          toTokenDecimals: actionTokenMeta(action, poolStablecoin)?.decimals,
          status: 'failed',
          error: error.message,
          errorEndpoint: error.okxEndpoint || null,
          preloadFallbackReason: action.activeSwap?.preloadFallbackReason || null,
          approvalTxHash: action.activeSwap?.approvalTxHash || null,
          startedAt: action.activeSwap?.startedAt || null,
          includedAt: action.activeSwap?.swapIncludedAt || null,
          failedAt,
          durationMs: failedTiming.durationMs,
          confirmationWaitMs: failedTiming.confirmationWaitMs
        });
        action.activeSwap = null;
        action.stage = 'needs_attention';
        action.error = error.message;
        completeActionMetrics(action);
        await persistAction(action);
        throw error;
      }
    }

    action.stage = 'completed';
    action.currentTx = null;
    action.completedAt = new Date().toISOString();
    completeActionMetrics(action);
    await persistAction(action);
    state.error = null;
    resetGuardAfterExecution();
  } catch (error) {
    if (error.code === 'MINE_POSITION_INACTIVE' && !action.withdrawTxHash) {
      action.stage = 'cancelled_external_position';
      action.reason = error.message;
      action.error = null;
      action.completedAt = new Date().toISOString();
      action.timingVersion = 4;
      action.processDurationMs = elapsedMs(action.detectedAt, action.completedAt);
      action.withdrawDurationMs = null;
      action.swapDurationMs = null;
      action.confirmationWaitMs = 0;
      action.verificationDurationMs = 0;
      action.nonCriticalDurationMs = 0;
      action.totalDurationMs = null;
      action.finalStablecoinReceived = null;
      await persistAction(action);
      stopMonitoringForMineIssue(error.issue);
      error.guardHandled = true;
      throw error;
    }
    if (action.stage !== 'needs_attention') {
      action.stage = action.withdrawTxHash ? 'needs_attention' : 'failed_before_withdraw';
      action.error = error.message;
      await persistAction(action);
    }
    if (action.withdrawTxHash) {
      resetGuardAfterExecution();
    }
    throw error;
  } finally {
    state.inFlight = false;
  }
}

async function walletTokenBalance(runtime, token, address, blockTag = 'latest') {
  return runtime.pool.call((provider) => {
    if (token === ZERO) return provider.getBalance(address, blockTag);
    return new ethers.Contract(token, ERC20_ABI, provider).balanceOf(address, { blockTag });
  });
}

async function hydratePendingResults(runtime, action) {
  if (!Array.isArray(action.tokens) || !action.beforeBalances) {
    throw new Error('执行记录缺少 token 或撤出前余额，无法自动恢复');
  }
  if (!action.afterBalances) {
    const current = await balanceSnapshot(runtime, action.tokens, runtime.wallet.address);
    action.afterBalances = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value.toString()]));
  }
  const knownTokens = new Set(action.results.map((item) => item.tokenIn.toLowerCase()));
  for (const token of action.tokens) {
    if (knownTokens.has(token.toLowerCase())) continue;
    const amount = BigInt(action.afterBalances[token] ?? 0) - BigInt(action.beforeBalances[token] ?? 0);
    action.results.push(amount > 0n
      ? { tokenIn: token, amountIn: amount.toString(), status: 'failed', error: '从余额快照恢复的待兑换任务' }
      : { tokenIn: token, amountIn: amount.toString(), status: 'skipped', reason: '未检测到正余额增量' });
  }
  if (!action.tokenMetadata) {
    const metadata = await runtime.pool.call((provider) => Promise.all(
      [...new Set([...action.tokens, action.poolStablecoin].map((token) => ethers.getAddress(token)))]
        .map((token) => tokenMetadata(provider, token))
    ));
    action.tokenMetadata = Object.fromEntries(metadata.map((item) => [item.address.toLowerCase(), item]));
  }
  for (const result of action.results) {
    const inputMeta = actionTokenMeta(action, result.tokenIn);
    const outputMeta = actionTokenMeta(action, action.poolStablecoin);
    result.tokenInSymbol ||= inputMeta?.symbol;
    result.tokenInDecimals ??= inputMeta?.decimals;
    result.toToken ||= action.poolStablecoin;
    result.toTokenSymbol ||= outputMeta?.symbol;
    result.toTokenDecimals ??= outputMeta?.decimals;
    if (result.status === 'skipped'
      && ethers.getAddress(result.tokenIn) === ethers.getAddress(action.poolStablecoin)) {
      result.actualReceived ||= result.amountIn;
    }
  }
  await persistAction(action);
}

async function retryPendingSwaps(runtime) {
  const action = state.lastAction;
  if (!action || action.stage !== 'needs_attention' || !action.withdrawTxHash) {
    throw new Error('没有可安全重试的撤出后兑换任务');
  }
  if (action.myNftId !== String(runtime.config.myNftId)
    || !sameTargetNftIds(actionTargetNftIds(action), configuredTargetNftIds(runtime.config))) {
    throw new Error('当前 NFT 配置与待恢复任务不一致');
  }
  if (!runtime.wallet) throw new Error('缺少 PRIVATE_KEY');

  state.inFlight = true;
  try {
    action.retryStartedAt = new Date().toISOString();
    if (action.currentTx?.hash) {
      const receipt = await runtime.pool.firstReceipt(action.currentTx.hash);
      if (!receipt) {
        throw new Error(`交易状态仍不明确，拒绝重复发送，请先检查: ${action.currentTx.hash}`);
      }
      if (action.currentTx.type === 'withdraw') {
        if (Number(receipt.status) !== 1) {
          action.stage = 'failed_before_withdraw';
          action.error = `撤出交易执行失败: ${receipt.hash}`;
          action.currentTx = null;
          await persistAction(action);
          throw new Error(action.error);
        }
        action.withdrawBlock = receipt.blockNumber;
        action.currentTx = null;
        action.stage = 'withdraw_confirmed';
        await persistAction(action);
      }
    }

    await hydratePendingResults(runtime, action);

    if (action.currentTx?.hash) {
      const receipt = await runtime.pool.firstReceipt(action.currentTx.hash);
      if (!receipt) {
        throw new Error(`交易状态仍不明确，拒绝重复发送，请先检查: ${action.currentTx.hash}`);
      }
      if (Number(receipt.status) === 1 && action.currentTx.type === 'swap') {
        const result = action.results.find((item) =>
          item.status === 'failed' && item.tokenIn.toLowerCase() === action.currentTx.token.toLowerCase()
        );
        if (result) {
          result.status = 'confirmed_late';
          result.txHash = receipt.hash;
          delete result.error;
        }
      }
      action.currentTx = null;
      await persistAction(action);
    }

    const failedResults = action.results.filter((item) => item.status === 'failed');
    for (const failed of failedResults) {
      const amount = BigInt(failed.amountIn);
      const balance = await walletTokenBalance(runtime, failed.tokenIn, runtime.wallet.address);
      if (balance < amount) {
        throw new Error(`待兑换资产余额不足，拒绝可能的重复兑换: ${failed.tokenIn}`);
      }
      try {
        const previousDurationMs = Number.isFinite(Number(failed.durationMs)) ? Number(failed.durationMs) : 0;
        const previousConfirmationWaitMs = Number(failed.confirmationWaitMs || 0);
        const previousVerificationDurationMs = Number(failed.verificationDurationMs || 0);
        const replacement = await swapToStable(runtime, failed.tokenIn, amount, action.poolStablecoin, action);
        Object.assign(failed, replacement);
        failed.durationMs = previousDurationMs + (Number(replacement.durationMs) || 0);
        failed.confirmationWaitMs = previousConfirmationWaitMs + Number(replacement.confirmationWaitMs || 0);
        failed.verificationDurationMs = previousVerificationDurationMs + Number(replacement.verificationDurationMs || 0);
        delete failed.error;
        delete failed.errorEndpoint;
        delete failed.failedAt;
        action.currentTx = null;
        action.activeSwap = null;
        await persistAction(action);
      } catch (error) {
        const failedAt = new Date().toISOString();
        const previousDurationMs = Number.isFinite(Number(failed.durationMs)) ? Number(failed.durationMs) : 0;
        const previousConfirmationWaitMs = Number(failed.confirmationWaitMs || 0);
        const failedTiming = activeSwapAttemptTiming(action.activeSwap, failedAt);
        const attemptStartedAt = action.activeSwap?.startedAt || action.retryStartedAt;
        failed.error = error.message;
        failed.errorEndpoint = error.okxEndpoint || null;
        failed.approvalTxHash ||= action.activeSwap?.approvalTxHash || null;
        failed.startedAt ||= attemptStartedAt;
        failed.includedAt ||= action.activeSwap?.swapIncludedAt || null;
        failed.failedAt = failedAt;
        failed.durationMs = failedTiming.durationMs === null
          ? previousDurationMs || null
          : previousDurationMs + failedTiming.durationMs;
        failed.confirmationWaitMs = previousConfirmationWaitMs + failedTiming.confirmationWaitMs;
        action.activeSwap = null;
        action.error = error.message;
        completeActionMetrics(action);
        await persistAction(action);
        throw error;
      }
    }

    if (!action.results.some((item) => item.status === 'failed')) {
      action.stage = 'completed';
      action.error = null;
      action.currentTx = null;
      action.completedAt = new Date().toISOString();
      completeActionMetrics(action);
      await persistAction(action);
      state.error = null;
      resetGuardAfterExecution();
    }
    return action;
  } finally {
    state.inFlight = false;
  }
}

async function checkOnce({ allowExecute = false } = {}) {
  if (state.checking) return state;
  state.checking = true;
  try {
    const runtime = await loadRuntime();
    const { targetNftIds } = requireIds(runtime.config);
    const target = await getTargetConsensus(runtime);
    const previousBlock = state.lastBlock;
    state.lastBlock = Math.max(state.lastBlock || 0, target.block);
    state.lastTargetLiquidity = target.liquidityText;
    state.lastTargetLiquidities = targetLiquidityMap(target.targets);

    if (!allowExecute) return state;
    if (!state.running || !state.armed) return state;
    if (!sameTargetNftIds(state.baseline?.targetNftIds, targetNftIds)
      || state.baseline?.myNftId !== String(runtime.config.myNftId)) {
      state.running = false;
      state.armed = false;
      throw new Error('NFT ID 已变化，监控已停止，请重新布防');
    }

    if (!state.running || !state.armed) return state;
    if (target.block < (state.targetReferenceBlock ?? previousBlock ?? 0)) return state;
    const decreases = targetLiquidityDecreases(target.targets, state.targetLiquidityReference);
    if (!decreases.length) {
      state.targetLiquidityReference = targetLiquidityMap(target.targets);
      state.targetReferenceBlock = target.block;
      return state;
    }
    if (!state.targetTriggered) {
      // Lock the trigger before asynchronous chain work. Failures before a
      // deterministic withdrawal hash exists may retry; ambiguous broadcasts do not.
      state.targetTriggered = true;
      const trigger = {
        ...decreases[0],
        affectedTargets: decreases,
        observedBlock: target.block,
        detectedAt: new Date().toISOString()
      };
      try {
        await executeWithdraw(runtime, trigger);
      } catch (error) {
        if (state.lastAction?.stage === 'failed_before_withdraw' && !state.lastAction?.withdrawTxHash) {
          state.targetTriggered = false;
        }
        throw error;
      }
    }
    return state;
  } finally {
    state.checking = false;
  }
}

let timer;
let mineHealthTimer;
let mineHealthChecking = false;
let monitorBlockProvider = null;
let monitorBlockListener = null;
let monitorBlockErrorListener = null;
let monitorBlockUrl = null;
let blockWakePending = false;

function scheduleLoop(delayMs = 0) {
  if (!state.running) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void loop();
  }, Math.max(0, delayMs));
}

function scheduleMineHealthLoop(delayMs = 2000) {
  if (!state.running || !state.armed) return;
  clearTimeout(mineHealthTimer);
  mineHealthTimer = setTimeout(() => {
    mineHealthTimer = null;
    void mineHealthLoop();
  }, Math.max(500, delayMs));
}

async function mineHealthLoop() {
  if (!state.running || !state.armed) return;
  let nextDelay = 2000;
  if (state.inFlight || mineHealthChecking) {
    scheduleMineHealthLoop(nextDelay);
    return;
  }
  mineHealthChecking = true;
  try {
    const runtime = await loadRuntime();
    nextDelay = Math.max(1000, Number(runtime.config.myPositionCheckIntervalMs) || 2000);
    const snapshot = await getMineHealthConsensus(runtime);
    if (!state.running || !state.armed || state.inFlight) return;
    if (state.baseline?.myNftId !== String(runtime.config.myNftId)) return;
    const issue = minePositionIssue(snapshot, state.baseline, runtime.wallet.address);
    if (issue) {
      stopMonitoringForMineIssue(issue);
      return;
    }
    state.mineHealthWarning = null;
  } catch (error) {
    if (state.running && state.armed && !state.inFlight) {
      state.mineHealthWarning = `我的仓位健康检查暂时失败，将继续重试：${error.message}`;
    }
  } finally {
    mineHealthChecking = false;
    if (state.running && state.armed) scheduleMineHealthLoop(nextDelay);
  }
}

function wakeMonitor() {
  if (!state.running) return;
  blockWakePending = true;
  if (!state.checking) scheduleLoop(0);
}

function closeWebSocketWithoutDestroy(provider) {
  if (!provider) return;
  try {
    provider.websocket.close();
  } catch {
    // The socket may already be closed or may have failed before opening.
  }
}

function guardRawWebSocketErrors(provider) {
  try {
    const socket = provider.websocket;
    if (typeof socket.on !== 'function') return;
    socket.on('error', (error) => {
      if (monitorBlockProvider !== provider) return;
      state.monitorWarning = `WSS 底层连接已断开，监控继续使用 HTTP 轮询：${error.message}`;
      clearBrokenBlockStream(provider);
    });
  } catch {
    // A provider that failed before exposing its socket will fall back to HTTP.
  }
}

function idleBlockStream() {
  state.monitorTransport = monitorBlockProvider && !monitorBlockProvider.destroyed
    ? 'wss-idle'
    : 'polling';
}

function shutdownBlockStream(provider = monitorBlockProvider) {
  if (!provider) {
    state.monitorTransport = 'polling';
    return;
  }
  if (monitorBlockProvider === provider) {
    monitorBlockProvider = null;
    monitorBlockListener = null;
    monitorBlockErrorListener = null;
    monitorBlockUrl = null;
  }
  // Do not call provider.off(), removeAllListeners() or destroy(). ethers v6
  // starts eth_unsubscribe without awaiting it, and destroying the provider
  // can later surface an unhandled rejection that terminates the process.
  closeWebSocketWithoutDestroy(provider);
  state.monitorTransport = 'polling';
}

function blockStreamCanBeReused(provider, currentUrl, requestedUrl) {
  if (!provider
    || provider.destroyed
    || currentUrl !== requestedUrl) {
    return false;
  }
  try {
    return provider.websocket.readyState === 1;
  } catch {
    return false;
  }
}

function clearBrokenBlockStream(provider) {
  if (monitorBlockProvider !== provider) return;
  monitorBlockProvider = null;
  monitorBlockListener = null;
  monitorBlockErrorListener = null;
  monitorBlockUrl = null;
  state.monitorTransport = 'polling';
  closeWebSocketWithoutDestroy(provider);
}

async function startBlockStream(config) {
  state.monitorWarning = null;
  if (!config.wssRpcUrl) {
    shutdownBlockStream();
    return 'disabled';
  }
  if (blockStreamCanBeReused(monitorBlockProvider, monitorBlockUrl, config.wssRpcUrl)) {
    state.monitorTransport = 'wss+http-quorum';
    return 'reused';
  }
  if (monitorBlockProvider) shutdownBlockStream();
  let provider;
  try {
    provider = new ethers.WebSocketProvider(
      config.wssRpcUrl,
      Number(CHAIN_ID),
      { staticNetwork: true }
    );
    guardRawWebSocketErrors(provider);
    await withTimeout(provider.getNetwork(), 5000, 'WSS 连接超时');
    monitorBlockProvider = provider;
    monitorBlockUrl = config.wssRpcUrl;
    monitorBlockListener = (blockNumber) => {
      publishStreamBlock(blockNumber);
      wakeMonitor();
    };
    monitorBlockErrorListener = (error) => {
      if (monitorBlockProvider !== provider) return;
      state.monitorWarning = `WSS 已断开，监控继续使用 HTTP 轮询：${error.message}`;
      clearBrokenBlockStream(provider);
    };
    await provider.on('block', monitorBlockListener);
    await provider.on('error', monitorBlockErrorListener);
    state.monitorTransport = 'wss+http-quorum';
    return 'connected';
  } catch (error) {
    state.monitorWarning = `WSS 不可用，已自动使用 HTTP 轮询：${error.message}`;
    if (monitorBlockProvider === provider) {
      clearBrokenBlockStream(provider);
    } else if (provider) {
      closeWebSocketWithoutDestroy(provider);
    }
    return 'fallback';
  }
}

async function loop() {
  if (!state.running) return;
  blockWakePending = false;
  try {
    await checkOnce({ allowExecute: true });
    state.error = null;
  } catch (error) {
    if (!error.guardHandled) state.error = error.message;
  }
  if (!state.running) return;
  let delay = 1000;
  try {
    delay = Math.max(250, Number((await readConfig()).pollIntervalMs) || 450);
  } catch (error) {
    state.error = `读取配置失败: ${error.message}`;
  }
  scheduleLoop(blockWakePending ? 0 : delay);
}

app.get('/api/status', (_req, res) => {
  res.json({ ...state, autoExecute: process.env.AUTO_EXECUTE === 'true' });
});

app.get('/api/config', async (_req, res) => {
  try {
    const config = await readConfig();
    res.json({
      ...config,
      targetNftIds: configuredTargetNftIds(config),
      privateKeyConfigured: Boolean(process.env.PRIVATE_KEY)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    if (state.running || state.inFlight) throw new Error('监控运行或交易执行期间不能修改配置，请先停止');
    if (state.lastAction?.stage === 'needs_attention') throw new Error('存在待处理的撤出后兑换任务，请先点击“重试兑换”或手工处理');
    const config = await readConfig();
    const slippagePercent = Number(req.body.slippagePercent);
    const maxAllowedPercent = Number(config.maxAllowedSlippageBps ?? 500) / 100;
    if (!Number.isFinite(slippagePercent) || slippagePercent < 0 || slippagePercent > maxAllowedPercent) {
      throw new Error(`卖出滑点必须在 0% 到 ${maxAllowedPercent}% 之间`);
    }
    config.targetNftIds = normalizeTargetNftIds(req.body.targetNftIds ?? req.body.targetNftId);
    delete config.targetNftId;
    config.myNftId = String(req.body.myNftId ?? '').trim();
    config.swap = { ...config.swap, maxSlippageBps: Math.round(slippagePercent * 100) };
    requireIds(config);
    await writeConfig(config);
    state.armed = false;
    state.baseline = null;
    state.targetTriggered = false;
    state.targetLiquidityReference = null;
    state.targetReferenceBlock = null;
    state.lastTargetLiquidities = null;
    res.json(config);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/positions', async (req, res) => {
  try {
    const config = await readConfig();
    const lookupConfig = {
      ...config,
      targetNftIds: normalizeTargetNftIds(req.body.targetNftIds ?? req.body.targetNftId),
      myNftId: String(req.body.myNftId ?? '').trim()
    };
    requireIds(lookupConfig);
    const runtime = {
      config: lookupConfig,
      pool: getRpcPool(lookupConfig),
      wallet: null
    };
    const snapshot = await getFullConsensus(runtime);
    const [targets, mine] = await runtime.pool.call((provider) => Promise.all([
      Promise.all(snapshot.targets.map(async (position) => ({
        nftId: position.nftId,
        ...(await enrichedPosition(provider, position, snapshot.block, lookupConfig))
      }))),
      enrichedPosition(provider, snapshot.mine, snapshot.block, lookupConfig)
    ]));
    res.json({
      block: snapshot.block,
      samePool: snapshot.targets.every((target) => target.pool === snapshot.mine.pool),
      exactSameTokenPair: snapshot.targets.every((target) => sameTokenPair(target.poolKey, snapshot.mine.poolKey)),
      sameTokenPair: snapshot.targets.every((target) =>
        compatibleMonitoredPair(target.poolKey, snapshot.mine.poolKey, lookupConfig)
      ),
      targets,
      target: targets[0],
      mine,
      voters: state.rpc?.voters || []
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/start', async (_req, res) => {
  try {
    if (process.env.AUTO_EXECUTE !== 'true') throw new Error('AUTO_EXECUTE=false。请在 .env 中明确开启自动交易。');
    if (state.inFlight) throw new Error('已有链上操作正在执行');
    if (state.lastAction?.stage === 'needs_attention') throw new Error('存在待处理的撤出后兑换任务，请先重试兑换或手工处理');
    if (!state.running) {
      const runtime = await loadRuntime();
      state.inFlight = true;
      state.arming = true;
      try {
        await armGuard(runtime);
      } finally {
        state.arming = false;
        state.inFlight = false;
      }
      state.running = true;
      state.error = null;
      state.guardNotice = null;
      state.mineHealthWarning = null;
      await startBlockStream(runtime.config);
      scheduleLoop(0);
      scheduleMineHealthLoop(runtime.config.myPositionCheckIntervalMs);
    }
    res.json(state);
  } catch (error) {
    state.running = false;
    state.armed = false;
    state.error = error.message;
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/stop', (_req, res) => {
  state.running = false;
  state.armed = false;
  clearTimeout(timer);
  clearTimeout(mineHealthTimer);
  state.mineHealthWarning = null;
  idleBlockStream();
  res.json({ ...state, warning: state.inFlight ? '已停止后续监控，但已经广播的链上交易无法取消' : null });
});

app.post('/api/check', async (_req, res) => {
  try {
    await checkOnce({ allowExecute: false });
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/retry-swaps', async (_req, res) => {
  try {
    if (state.running) throw new Error('请先停止监控再重试兑换');
    if (state.inFlight) throw new Error('已有链上操作正在执行');
    const runtime = await loadRuntime();
    const action = await retryPendingSwaps(runtime);
    res.json(action);
  } catch (error) {
    state.error = error.message;
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/resolve-manual', async (_req, res) => {
  try {
    if (state.running || state.inFlight) throw new Error('请先停止监控，且等待当前链上操作结束');
    const action = state.lastAction;
    if (!action || action.stage !== 'needs_attention' || !action.withdrawTxHash) {
      throw new Error('没有需要手动确认的兑换任务');
    }
    if (action.currentTx?.hash) {
      throw new Error(`仍有状态待确认的交易，不能手动关闭任务：${action.currentTx.hash}`);
    }
    const runtime = await loadRuntime();
    if (!runtime.wallet) throw new Error('缺少 PRIVATE_KEY，无法核对钱包余额');
    await hydratePendingResults(runtime, action);
    const failedResults = action.results.filter((item) => item.status === 'failed');
    if (!failedResults.length) throw new Error('执行记录中没有失败的兑换');

    const checkedAt = new Date().toISOString();
    for (const failed of failedResults) {
      const expectedAmount = BigInt(failed.amountIn);
      const currentBalance = await walletTokenBalance(runtime, failed.tokenIn, runtime.wallet.address);
      if (currentBalance >= expectedAmount) {
        const meta = actionTokenMeta(action, failed.tokenIn);
        throw new Error(
          `${meta?.symbol || failed.tokenIn} 余额仍足以执行原兑换任务，无法确认已手动处理；`
          + '如确实不需要兑换，请先自行核对资产去向'
        );
      }
      failed.status = 'resolved_manually';
      failed.manualResolvedAt = checkedAt;
      failed.remainingBalance = currentBalance.toString();
      failed.manualOutputUnknown = true;
      failed.reason = '用户已在外部手动处理；脚本仅核对原待兑换余额已不足，不推测实际到账数量';
      delete failed.error;
      delete failed.errorEndpoint;
      delete failed.failedAt;
    }

    action.stage = 'completed_manual';
    action.manualResolution = true;
    action.manualResolvedAt = checkedAt;
    action.completedAt = checkedAt;
    action.currentTx = null;
    action.activeSwap = null;
    action.error = null;
    action.timingVersion = 4;
    action.processDurationMs = elapsedMs(action.detectedAt, checkedAt);
    action.totalDurationMs = null;
    action.swapDurationMs = null;
    action.nonCriticalDurationMs = null;
    // The output of an external manual swap cannot be measured reliably from
    // this process, so do not present the old quote as actual proceeds.
    action.finalStablecoinReceived = null;
    await persistAction(action);
    state.error = null;
    resetGuardAfterExecution();
    res.json(action);
  } catch (error) {
    state.error = error.message;
    res.status(400).json({ error: error.message });
  }
});

export async function startServer(options = {}) {
  await restoreAction();
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  if (authEnabled() && String(process.env.ADMIN_PASSWORD).length < 12) {
    throw new Error('ADMIN_PASSWORD 至少需要 12 个字符');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase()) && !authEnabled()) {
    throw new Error('非本机监听必须先配置 ADMIN_PASSWORD，拒绝启动未认证的管理页面');
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      console.log(`BSC v4 liquidity guard: http://${host}:${port}`);
      resolve(server);
    });
    server.once('close', () => {
      shutdownBlockStream();
      cachedPool?.destroy();
      cachedPool = null;
      cachedPoolKey = null;
    });
  });
}

export {
  RpcPool,
  blockStreamCanBeReused,
  cacheSwapApprovals,
  cachedApprovalForAmount,
  closeWebSocketWithoutDestroy,
  compatibleMonitoredPair,
  completeActionMetrics,
  consumeSwapPreload,
  app,
  describeNetworkError,
  encodeUnlimitedApproval,
  guardRawWebSocketErrors,
  idleBlockStream,
  minePositionIssue,
  normalizeTargetNftIds,
  poolFingerprint,
  positionTicks,
  prepareTransaction,
  preparedSwapMatches,
  principalAmounts,
  publishStreamBlock,
  shutdownBlockStream,
  sameTokenPair,
  singleSwapCandidate,
  startBlockStream,
  stableValueAtSqrtPrice,
  sqrtPriceAtTick,
  targetLiquidityDecreases,
  transactionConfirmations,
  validateSwapResponse
};

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) await startServer();
