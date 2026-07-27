const $ = (id) => document.getElementById(id);

let firstStatus = true;
let lastSeenAction = null;
let lastStage = null;
let lastStatusError = null;
let lastGuardNoticeId = null;
let refreshing = false;
let formDirty = false;
let alarmAudio;
let alarmTimer = null;
let alarmActive = false;
const alarmOscillators = new Set();
let lookupTimer;
let lookupSequence = 0;
let lookupInFlight = false;
let currentConfig = null;
let currentStatus = null;
let latestPositions = null;
let refreshFailures = 0;
let refreshTimer = null;
let initialLookupScheduled = false;
let csrfToken = null;
const toastKeys = new Map();

async function request(url, options = {}) {
  const { timeoutMs = 15_000, headers = {}, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = {
      'content-type': 'application/json',
      ...headers
    };
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(String(fetchOptions.method || 'GET').toUpperCase())) {
      requestHeaders['x-csrf-token'] = csrfToken;
    }
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
      ...fetchOptions
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`接口 ${url} 返回了网页而不是 JSON，请使用 npm start 启动后访问 http://127.0.0.1:3000`);
    }
    if (response.status === 401 && body.code === 'AUTH_REQUIRED') {
      window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      throw new Error('登录已失效，正在跳转');
    }
    if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('服务响应超时；后台操作可能仍在继续，请查看状态后再决定是否重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function initializeAuth() {
  const response = await fetch('/api/auth/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`认证状态检查失败（HTTP ${response.status}）`);
  const status = await response.json();
  if (status.enabled && !status.authenticated) {
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    return false;
  }
  csrfToken = status.csrfToken || null;
  $('logout').hidden = !status.enabled;
  return true;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function normalizeTargetIds(value) {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => String(item ?? '').split(/[\s,，;；]+/))
    : String(value ?? '').split(/[\s,，;；]+/);
  return [...new Set(parts.map((item) => item.trim()).filter(Boolean))];
}

function configTargetIds(config) {
  return normalizeTargetIds(config?.targetNftIds ?? config?.targetNftId);
}

function actionTargetIds(action) {
  return normalizeTargetIds(action?.targetNftIds ?? action?.targetNftId);
}

function sameIdList(first, second) {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '-';
}

function notify(message, type = 'info', key = message) {
  const now = Date.now();
  if (now - (toastKeys.get(key) || 0) < 2500) return;
  toastKeys.set(key, now);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-mark">${type === 'success' ? '✓' : ['error', 'warning'].includes(type) ? '!' : 'i'}</span><span>${escapeHtml(message)}</span>`;
  $('toastRegion').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 220);
  }, type === 'error' ? 6500 : 3800);
}

function setPolling(active) {
  $('polling').classList.toggle('active', active);
}

function armAlarm() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!alarmAudio) alarmAudio = new AudioContextClass();
  if (alarmAudio.state === 'suspended') alarmAudio.resume();
}

function beep(at) {
  if (!alarmAudio) return;
  const start = alarmAudio.currentTime + at;
  const oscillator = alarmAudio.createOscillator();
  const gain = alarmAudio.createGain();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(880, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
  oscillator.connect(gain);
  gain.connect(alarmAudio.destination);
  alarmOscillators.add(oscillator);
  oscillator.onended = () => {
    alarmOscillators.delete(oscillator);
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(start);
  oscillator.stop(start + 0.2);
}

function alarmBurst() {
  beep(0);
  beep(0.28);
  beep(0.56);
}

function playAlarm() {
  armAlarm();
  if (alarmActive) return;
  alarmActive = true;
  alarmBurst();
  alarmTimer = window.setInterval(alarmBurst, 1100);
}

function stopAlarm() {
  alarmActive = false;
  if (alarmTimer !== null) {
    window.clearInterval(alarmTimer);
    alarmTimer = null;
  }
  for (const oscillator of alarmOscillators) {
    try {
      oscillator.stop();
    } catch {
      // The oscillator may already have ended between the click and cleanup.
    }
  }
  alarmOscillators.clear();
}

function showAlert(action) {
  const hash = action?.withdrawTxHash || '交易已提交';
  const triggerId = action?.trigger?.targetNftId;
  $('alertBody').textContent = triggerId
    ? `目标 NFT #${triggerId} 流动性下降；撤出交易：${hash}`
    : `撤出交易：${hash}`;
  $('alertDrawer').classList.add('open');
  $('alertDrawer').setAttribute('aria-hidden', 'false');
  playAlarm();
}

function tokenConfig(address) {
  if (!address || !currentConfig) return null;
  const entries = [currentConfig.stablecoin, ...(currentConfig.stablecoins || [])].filter(Boolean);
  return entries.find((item) => item.address?.toLowerCase() === address.toLowerCase()) || null;
}

function resultTokenMeta(action, result, output = false) {
  const address = output ? (result.toToken || action.poolStablecoin) : result.tokenIn;
  const stored = action.tokenMetadata?.[address?.toLowerCase()];
  const configured = tokenConfig(address);
  return {
    address,
    symbol: (output ? result.toTokenSymbol : result.tokenInSymbol) || stored?.symbol || configured?.symbol || shortAddress(address),
    decimals: Number((output ? result.toTokenDecimals : result.tokenInDecimals) ?? stored?.decimals ?? 18)
  };
}

function compactDecimal(value, maxFraction = 8) {
  const [whole, fraction = ''] = String(value).split('.');
  const trimmed = fraction.slice(0, maxFraction).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function formatRaw(raw, decimals = 18, maxFraction = 8) {
  if (raw === undefined || raw === null) return '-';
  try {
    const negative = BigInt(raw) < 0n;
    const absolute = negative ? -BigInt(raw) : BigInt(raw);
    const scale = 10n ** BigInt(decimals);
    const whole = absolute / scale;
    const fraction = (absolute % scale).toString().padStart(decimals, '0');
    return `${negative ? '-' : ''}${compactDecimal(`${whole}.${fraction}`, maxFraction)}`;
  } catch {
    return String(raw);
  }
}

function formatLiquidity(value) {
  if (value === undefined || value === null) return '-';
  try {
    return BigInt(value).toLocaleString('en-US');
  } catch {
    return String(value);
  }
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return '-';
  if (!Number.isFinite(Number(ms))) return '-';
  const value = Number(ms);
  return `${(value / 1000).toFixed(3)} 秒（${value} 毫秒）`;
}

function exchangeDurationText(action) {
  if (action.manualResolution) return '外部手动处理，无法完整统计';
  if (Number.isFinite(Number(action.swapDurationMs))) return formatDuration(action.swapDurationMs);
  const measuredResults = (action.results || []).filter((result) =>
    result.status !== 'skipped'
    && result.status !== 'resolved_manually'
    && Number.isFinite(Number(result.durationMs))
  );
  if (!measuredResults.length) return '-';
  const derivedDurationMs = measuredResults.reduce((total, result) => total + Number(result.durationMs), 0);
  return formatDuration(derivedDurationMs);
}

function nonCriticalDurationText(action) {
  if (Number(action.timingVersion) < 2) return '旧记录未拆分';
  return formatDuration(action.nonCriticalDurationMs);
}

function localTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}

function actionStage(action) {
  return {
    preparing: ['正在准备撤退', 'working'],
    withdrawing: ['正在撤退', 'working'],
    withdraw_submitted: ['撤退交易已提交', 'working'],
    withdraw_confirmed: ['撤退成功，准备兑换', 'working'],
    swapping: ['正在兑换稳定币', 'working'],
    needs_attention: ['撤退成功，兑换待处理', 'failed'],
    completed: ['撤退及兑换已完成', 'success'],
    completed_manual: ['兑换已手动处理', 'success'],
    cancelled_external_position: ['我的仓位已在外部处理，布防停止', 'neutral'],
    failed_before_withdraw: ['撤退前失败', 'failed']
  }[action?.stage] || ['等待执行', 'neutral'];
}

function renderExecutionSummary(action) {
  if (!action) {
    $('result').innerHTML = '<div class="result-empty">尚未执行</div>';
    return;
  }
  const [stageText, stageTone] = actionStage(action);
  const withdrawalState = action.withdrawTxHash
    ? '成功提交并确认'
    : action.stage === 'cancelled_external_position'
      ? '未执行（检测到外部处理）'
      : action.stage === 'failed_before_withdraw'
        ? '未执行'
        : '等待中';
  const withdrawalLink = action.withdrawTxHash
    ? `<a href="https://bscscan.com/tx/${escapeHtml(action.withdrawTxHash)}" target="_blank" rel="noreferrer">查看撤退交易 ↗</a>`
    : '';
  const resultRows = (action.results || []).map((result) => {
    const input = resultTokenMeta(action, result);
    const output = resultTokenMeta(action, result, true);
    const inputAmount = formatRaw(result.amountIn, input.decimals);
    const outputRaw = result.actualReceived ?? result.quotedReceived;
    const outputAmount = outputRaw !== undefined ? formatRaw(outputRaw, output.decimals) : '-';
    const confirmed = ['confirmed', 'confirmed_late'].includes(result.status);
    const resolvedManually = result.status === 'resolved_manually';
    const skippedStable = result.status === 'skipped'
      && input.address?.toLowerCase() === action.poolStablecoin?.toLowerCase();
    const statusText = confirmed ? '兑换成功' : resolvedManually ? '已手动处理' : skippedStable ? '稳定币保留' : result.status === 'failed' ? '兑换失败' : '已跳过';
    const tone = confirmed || skippedStable || resolvedManually ? 'success' : result.status === 'failed' ? 'failed' : 'neutral';
    const route = resolvedManually
      ? `${inputAmount} ${input.symbol} → 外部手动处理（到账未知）`
      : skippedStable
      ? `${inputAmount} ${input.symbol}（无需兑换）`
      : `${inputAmount} ${input.symbol} → ${outputAmount} ${output.symbol}`;
    const baseDetail = result.error || result.reason || (result.actualReceived ? '最终实际到账' : result.quotedReceived ? '显示 OKX 预计到账' : '');
    const detail = result.preloadFallbackReason
      ? `${baseDetail}${baseDetail ? '；' : ''}预准备回退：${result.preloadFallbackReason}`
      : baseDetail;
    const txLink = result.txHash
      ? `<a href="https://bscscan.com/tx/${escapeHtml(result.txHash)}" target="_blank" rel="noreferrer">兑换交易 ↗</a>`
      : result.approvalTxHash
        ? `<a href="https://bscscan.com/tx/${escapeHtml(result.approvalTxHash)}" target="_blank" rel="noreferrer">授权交易 ↗</a>`
        : '';
    const durationText = resolvedManually
      ? (Number.isFinite(Number(result.durationMs))
        ? `脚本尝试耗时：${formatDuration(result.durationMs)}；外部耗时无法统计`
        : '外部兑换耗时无法统计')
      : skippedStable
        ? '无需兑换'
        : `兑换耗时：${formatDuration(result.durationMs)}${result.preparationMode === 'overlapped_with_withdraw_confirmation' ? ' · 已并行预准备' : ''}${result.approvalSource === 'armed_cache' ? ' · 已复用授权缓存' : ''}`;
    return `<div class="swap-summary"><div><span class="result-status ${tone}">${statusText}</span><strong>${escapeHtml(route)}</strong><small>${escapeHtml(detail)}</small></div><div class="swap-side"><span>${escapeHtml(durationText)}</span>${txLink}</div></div>`;
  }).join('');
  const stableMeta = resultTokenMeta(action, { tokenIn: action.poolStablecoin, toToken: action.poolStablecoin }, true);
  const derivedStable = (action.results || []).reduce((total, result) => {
    const isStableInput = result.tokenIn?.toLowerCase() === action.poolStablecoin?.toLowerCase();
    const amount = result.actualReceived ?? (isStableInput && result.status === 'skipped' ? result.amountIn : '0');
    try { return total + BigInt(amount || 0); } catch { return total; }
  }, 0n);
  const finalStableRaw = action.manualResolution
    ? null
    : action.finalStablecoinReceived ?? (derivedStable > 0n ? derivedStable.toString() : null);
  const totalStable = finalStableRaw ? `${formatRaw(finalStableRaw, stableMeta.decimals)} ${stableMeta.symbol}` : '-';
  const trigger = action.trigger;
  const affectedTargets = trigger?.affectedTargets?.length ? trigger.affectedTargets : (trigger ? [trigger] : []);
  const triggerTarget = affectedTargets.length
    ? affectedTargets.map((item) => `NFT #${item.targetNftId}`).join('、')
    : '-';
  const triggerChange = affectedTargets.length
    ? affectedTargets.map((item) =>
      `#${item.targetNftId}: ${formatLiquidity(item.previousLiquidity)} → ${formatLiquidity(item.currentLiquidity)}（减少 ${formatLiquidity(item.decreasedBy)}）`
    ).join('；')
    : '-';
  $('result').innerHTML = `
    <div class="result-hero">
      <div><span class="result-status ${stageTone}">${escapeHtml(stageText)}</span><strong>NFT #${escapeHtml(action.myNftId)}</strong></div>
      <span>${escapeHtml(localTime(action.completedAt || action.detectedAt))}</span>
    </div>
    <div class="result-facts">
      <div><span>检测时间</span><strong>${escapeHtml(localTime(action.detectedAt))}</strong></div>
      <div><span>触发目标</span><strong>${escapeHtml(triggerTarget)}</strong></div>
      <div><span>目标流动性变化</span><strong>${escapeHtml(triggerChange)}</strong></div>
      <div><span>撤退状态</span><strong>${escapeHtml(withdrawalState)}</strong>${withdrawalLink}</div>
      <div><span>撤退耗时</span><strong>${escapeHtml(formatDuration(action.withdrawDurationMs))}</strong></div>
      <div><span>兑换耗时</span><strong>${escapeHtml(exchangeDurationText(action))}</strong></div>
      <div><span>${Number(action.timingVersion) >= 2 ? '关键总耗时' : '原总流程耗时（旧口径）'}</span><strong>${escapeHtml(formatDuration(action.totalDurationMs))}</strong></div>
      <div class="noncritical-time"><span>确认 / 核验耗时（不重要）</span><strong>${escapeHtml(nonCriticalDurationText(action))}</strong><small>交易入块后的等待，不计入关键总耗时</small></div>
      <div><span>最终获得稳定币</span><strong>${escapeHtml(totalStable)}</strong></div>
    </div>
    <div class="swap-list">${resultRows || '<div class="result-empty">尚无资产处理结果</div>'}</div>
    ${action.reason ? `<div class="result-notice"><strong>监控已安全停止</strong><span>${escapeHtml(action.reason)}</span></div>` : ''}
    ${action.error ? `<div class="result-error"><strong>需要处理</strong><span>${escapeHtml(action.error)}</span></div>` : ''}
  `;
}

function notifyGuardNotice(status) {
  const notice = status.guardNotice;
  if (!notice?.id || notice.id === lastGuardNoticeId) return;
  notify(notice.message, notice.type || 'warning', `guard-notice:${notice.id}`);
  lastGuardNoticeId = notice.id;
}

function notifyStageChange(status) {
  const action = status.lastAction;
  const stage = action?.stage || null;
  if (firstStatus || !stage || stage === lastStage) {
    lastStage = stage;
    return;
  }
  const [message, tone] = actionStage(action);
  notify(message, tone === 'failed' ? 'error' : tone === 'success' ? 'success' : 'info', `stage:${stage}`);
  lastStage = stage;
}

function updateButtons(status) {
  const action = status?.lastAction;
  const needsAttention = action?.stage === 'needs_attention';
  const completedForCurrentIds = ['completed', 'completed_manual'].includes(action?.stage)
    && sameIdList(actionTargetIds(action), configTargetIds(currentConfig))
    && action.myNftId === String(currentConfig?.myNftId)
    && !formDirty;
  const start = $('start');
  if (status?.arming) {
    start.textContent = '正在预授权并布防…';
  } else if (status?.inFlight) {
    start.textContent = action?.stage === 'swapping' ? '正在兑换…' : '正在撤退…';
  } else if (status?.armed) {
    start.textContent = '✓ 已布防';
  } else if (needsAttention) {
    start.textContent = '兑换待处理';
  } else if (completedForCurrentIds) {
    start.textContent = '✓ 本轮已完成';
  } else {
    start.textContent = '验证并布防';
  }
  start.classList.toggle('armed', Boolean(status?.armed));
  start.disabled = Boolean(status?.inFlight || status?.armed || status?.running || needsAttention || completedForCurrentIds);
  $('retry').disabled = Boolean(status?.inFlight || !needsAttention);
  $('retry').classList.toggle('attention', needsAttention && !status?.inFlight);
  $('resolveManual').disabled = Boolean(status?.inFlight || !needsAttention);
  $('stop').disabled = Boolean(!status?.running && !status?.inFlight);
  $('save').disabled = Boolean(status?.running || status?.inFlight || needsAttention);
  $('check').disabled = Boolean(status?.inFlight);
}

async function refresh() {
  if (refreshing) return false;
  refreshing = true;
  setPolling(true);
  try {
    const [config, status] = await Promise.all([request('/api/config'), request('/api/status')]);
    currentConfig = config;
    currentStatus = status;
    if (!formDirty) {
      $('target').value = configTargetIds(config).join(', ');
      $('mine').value = config.myNftId;
      $('slippage').value = ((config.swap?.maxSlippageBps ?? 100) / 100).toFixed(2);
      updateSlippageBps();
    }
    $('slippage').max = String((config.maxAllowedSlippageBps ?? 500) / 100);
    $('mode').textContent = status.armed
      ? (status.monitorTransport === 'wss+http-quorum' ? '已布防 · WSS 唤醒 · 多节点共识' : '已布防 · HTTP 轮询 · 多节点共识')
      : status.arming ? '正在检查并预授权' : status.inFlight ? '正在执行保护流程' : (status.autoExecute ? '自动执行待布防' : '仅观察模式');
    $('running').textContent = status.arming ? '布防准备中' : status.inFlight ? '交易执行中' : (status.running ? '运行中' : '已停止');
    $('block').textContent = status.lastBlock ?? latestPositions?.block ?? '-';
    $('error').textContent = status.error || status.mineHealthWarning || status.guardNotice?.message || status.monitorWarning || '';
    document.querySelectorAll('#updated, #lastCompleted').forEach((node) => {
      node.textContent = localTime(status.lastAction?.completedAt || status.lastAction?.detectedAt);
    });
    renderExecutionSummary(status.lastAction);
    const actionStable = status.lastAction?.poolStablecoin;
    const actionStableMeta = actionStable
      ? resultTokenMeta(status.lastAction, { tokenIn: actionStable, toToken: actionStable }, true)
      : null;
    const positionStable = aggregateTargetAmounts(
      latestPositions?.targets || (latestPositions?.target ? [latestPositions.target] : [])
    ).find((item) => item.isStablecoin);
    $('stablecoinStatus').textContent = actionStableMeta?.symbol || positionStable?.symbol || config.stablecoin?.symbol || '-';
    updateButtons(status);
    notifyStageChange(status);
    notifyGuardNotice(status);
    if (!firstStatus && status.error && status.error !== lastStatusError) {
      notify(status.error, 'error', `status-error:${status.error}`);
    } else if (!firstStatus && lastStatusError && !status.error) {
      notify('系统状态已恢复正常', 'success', 'status-recovered');
    }
    lastStatusError = status.error || null;
    const actionId = status.lastAction?.detectedAt
      ? `${status.lastAction.detectedAt}:${status.lastAction.trigger?.targetNftId || status.lastAction.withdrawTxHash || ''}`
      : status.lastAction?.withdrawTxHash;
    if (!firstStatus && actionId && actionId !== lastSeenAction) showAlert(status.lastAction);
    if (actionId) lastSeenAction = actionId;
    firstStatus = false;
    document.body.classList.remove('offline');
    if (refreshFailures > 0) notify('已重新连接后台服务', 'success', 'service-reconnected');
    refreshFailures = 0;
    return true;
  } catch (error) {
    refreshFailures += 1;
    $('error').textContent = error.message;
    document.body.classList.add('offline');
    if (refreshFailures === 1) notify(error.message, 'error', 'refresh-error');
    return false;
  } finally {
    refreshing = false;
    setPolling(false);
  }
}

function nextRefreshDelay() {
  if (refreshFailures === 0) return 450;
  return Math.min(15_000, 1000 * (2 ** Math.min(refreshFailures - 1, 4)));
}

async function pollStatus() {
  const connected = await refresh();
  if (connected && !initialLookupScheduled) {
    initialLookupScheduled = true;
    schedulePositionLookup();
  }
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(pollStatus, nextRefreshDelay());
}

function updateSlippageBps() {
  const percent = Number($('slippage').value);
  $('slippageBps').textContent = Number.isFinite(percent) ? `${Math.round(percent * 100)} BPS` : '-';
}

function displayPositionAmount(amount) {
  return `${compactDecimal(amount.formatted, 6)} ${amount.symbol}`;
}

function renderPosition(label, tokenId, position, kind) {
  const amounts = position.amounts || [];
  const amountRows = amounts.map((amount) =>
    `<div class="asset-amount ${amount.isStablecoin ? 'stable' : ''}"><dt>${amount.isStablecoin ? '稳定币' : '代币'} · ${escapeHtml(amount.symbol)}</dt><dd>${escapeHtml(displayPositionAmount(amount))}</dd></div>`
  ).join('');
  const stableValue = position.estimatedStableValue;
  const valueRow = stableValue
    ? `<div class="asset-value"><dt>仓位估值 · 按当前池价</dt><dd>≈ ${escapeHtml(displayPositionAmount(stableValue))}</dd></div>`
    : '';
  return `<article class="position-card ${escapeHtml(kind)}"><div class="position-card-head"><span>${escapeHtml(label)}</span><strong>#${escapeHtml(tokenId)}</strong></div><dl>${valueRow}${amountRows}<div><dt>流动性</dt><dd>${escapeHtml(position.liquidity)}</dd></div><div><dt>持有人</dt><dd title="${escapeHtml(position.owner)}">${escapeHtml(shortAddress(position.owner))}</dd></div><div><dt>价格区间 Tick</dt><dd>${escapeHtml(position.tickLower)} ～ ${escapeHtml(position.tickUpper)}</dd></div><div><dt>费率 / Tick 间距</dt><dd>${escapeHtml(position.poolKey.fee)} / ${escapeHtml(position.poolKey.tickSpacing)}</dd></div></dl></article>`;
}

function aggregateTargetAmounts(targets) {
  const totals = new Map();
  for (const position of targets || []) {
    for (const amount of position.amounts || []) {
      const key = String(amount.address || '').toLowerCase();
      const current = totals.get(key) || { ...amount, raw: '0' };
      try {
        current.raw = (BigInt(current.raw) + BigInt(amount.raw || 0)).toString();
      } catch {
        current.raw = amount.raw;
      }
      current.formatted = formatRaw(current.raw, Number(current.decimals), 6);
      totals.set(key, current);
    }
  }
  return [...totals.values()];
}

function aggregateTargetValues(targets) {
  const totals = new Map();
  for (const position of targets || []) {
    const value = position.estimatedStableValue;
    if (!value?.address) continue;
    const key = value.address.toLowerCase();
    const current = totals.get(key) || { ...value, raw: '0' };
    current.raw = (BigInt(current.raw) + BigInt(value.raw || 0)).toString();
    current.formatted = formatRaw(current.raw, Number(current.decimals), 6);
    totals.set(key, current);
  }
  return [...totals.values()];
}

function updateTargetMetric(targets) {
  const values = aggregateTargetValues(targets);
  if (values.length) {
    $('targetPosition').innerHTML = values
      .map((value) => `<span>≈ ${escapeHtml(displayPositionAmount(value))}</span>`)
      .join('<span class="metric-separator">·</span>');
    $('targetPositionDetail').textContent = `${targets.length} 个目标 NFT · 按各池当前价格折算 · 不含未领取手续费`;
    return;
  }
  const amounts = aggregateTargetAmounts(targets);
  if (!amounts.length) {
    $('targetPosition').textContent = '-';
    return;
  }
  const stable = amounts.find((item) => item.isStablecoin);
  const token = amounts.find((item) => !item.isStablecoin);
  $('targetPosition').innerHTML = [
    stable ? `<span>${escapeHtml(displayPositionAmount(stable))}</span>` : '',
    token ? `<span>${escapeHtml(displayPositionAmount(token))}</span>` : ''
  ].filter(Boolean).join('<span class="metric-separator">·</span>');
  $('targetPositionDetail').textContent = `${targets.length} 个目标 NFT · 合计预计可撤本金`;
}

async function lookupPositions({ silent = false } = {}) {
  const targetNftIds = normalizeTargetIds($('target').value);
  const myNftId = $('mine').value.trim();
  if (!targetNftIds.length
    || targetNftIds.some((id) => !/^\d+$/.test(id))
    || !/^\d+$/.test(myNftId)
    || targetNftIds.includes(myNftId)) {
    $('positionPreview').innerHTML = '<div class="preview-empty">输入一个或多个对方数字 NFT ID，并填写不同的我的 NFT ID</div>';
    $('targetPosition').textContent = '-';
    return;
  }
  if (lookupInFlight) return;
  lookupInFlight = true;
  const sequence = ++lookupSequence;
  if (!silent) $('positionPreview').innerHTML = '<div class="preview-empty">正在通过多节点查询仓位…</div>';
  try {
    const data = await request('/api/positions', {
      method: 'POST',
      body: JSON.stringify({ targetNftIds, myNftId }),
      timeoutMs: 25_000
    });
    if (sequence !== lookupSequence) return;
    latestPositions = data;
    const poolState = data.samePool
      ? '<span class="pool-match ok">全部同一池子 · 可继续验证</span>'
      : data.exactSameTokenPair
        ? '<span class="pool-match ok">全部为同一代币对 · 允许不同费率池 · 可布防</span>'
        : data.sameTokenPair
          ? '<span class="pool-match ok">风险代币相同 · 白名单稳定币不同 · 可布防</span>'
        : '<span class="pool-match bad">存在不同代币对 · 无法布防</span>';
    const targets = data.targets || (data.target ? [{ ...data.target, nftId: targetNftIds[0] }] : []);
    const targetCards = targets
      .map((position, index) => renderPosition(`对方仓位 ${index + 1}`, position.nftId, position, 'target'))
      .join('');
    $('positionPreview').innerHTML = `<div class="preview-summary">${poolState}<span>共 ${escapeHtml(targets.length)} 个目标 · 最终区块 ${escapeHtml(data.block)} · 数量为预计本金，不含未领取手续费</span></div><div class="position-grid">${targetCards}${renderPosition('我的仓位', myNftId, data.mine, 'mine')}</div>`;
    updateTargetMetric(targets);
    const stable = aggregateTargetAmounts(targets).find((item) => item.isStablecoin);
    if (stable) $('stablecoinStatus').textContent = stable.symbol;
  } catch (error) {
    if (sequence !== lookupSequence) return;
    if (!silent) $('positionPreview').innerHTML = `<div class="preview-error">${escapeHtml(error.message)}</div>`;
  } finally {
    lookupInFlight = false;
  }
}

function schedulePositionLookup() {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(() => lookupPositions(), 600);
}

function markIdChanged() {
  formDirty = true;
  latestPositions = null;
  $('targetPosition').textContent = '-';
  updateButtons(currentStatus);
  schedulePositionLookup();
}

async function saveCurrentConfig() {
  const config = await request('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      targetNftIds: normalizeTargetIds($('target').value),
      myNftId: $('mine').value,
      slippagePercent: $('slippage').value
    })
  });
  currentConfig = config;
  formDirty = false;
}

async function runButton(button, pendingText, operation, successMessage) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try {
    await operation();
    notify(successMessage, 'success');
  } catch (error) {
    $('error').textContent = error.message;
    notify(error.message, 'error');
  } finally {
    button.textContent = original;
    await refresh();
  }
}

$('target').oninput = markIdChanged;
$('mine').oninput = markIdChanged;
$('slippage').oninput = () => {
  formDirty = true;
  updateSlippageBps();
  updateButtons(currentStatus);
};

$('save').onclick = () => runButton($('save'), '保存中…', async () => {
  await saveCurrentConfig();
  await lookupPositions();
}, '设置保存成功');

$('check').onclick = () => runButton($('check'), '检查中…', async () => {
  if (formDirty) await saveCurrentConfig();
  await request('/api/check', { method: 'POST', timeoutMs: 25_000 });
  await lookupPositions();
}, '只读检查完成');

$('start').onclick = () => runButton($('start'), '正在验证…', async () => {
  armAlarm();
  if (formDirty) await saveCurrentConfig();
  await request('/api/start', { method: 'POST', timeoutMs: 120_000 });
}, '验证通过，布防成功');

$('retry').onclick = () => runButton($('retry'), '正在重试…', async () => {
  armAlarm();
  await request('/api/retry-swaps', { method: 'POST', timeoutMs: 240_000 });
}, '待处理兑换已完成');

$('resolveManual').onclick = async () => {
  const confirmed = window.confirm('确认你已经在外部手动处理失败的代币吗？脚本会核对余额并关闭待处理任务，但无法推算外部兑换的实际到账数量。');
  if (!confirmed) return;
  await runButton($('resolveManual'), '正在核对…', async () => {
    await request('/api/resolve-manual', { method: 'POST', timeoutMs: 30_000 });
  }, '已确认手动处理，待处理状态已解除');
};

$('stop').onclick = () => runButton($('stop'), '停止中…', async () => {
  await request('/api/stop', { method: 'POST' });
}, '监控已停止');

$('logout').onclick = async () => {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } finally {
    csrfToken = null;
    window.location.replace('/login');
  }
};

$('closeAlert').onclick = () => {
  stopAlarm();
  $('alertDrawer').classList.remove('open');
  $('alertDrawer').setAttribute('aria-hidden', 'true');
};

if (window.location.protocol === 'file:') {
  $('mode').textContent = '本地预览模式';
  $('running').textContent = '未连接服务';
  $('error').textContent = '当前为本地预览：页面样式可正常查看，监控和配置功能请通过 npm start 启动服务后访问。';
} else {
  void (async () => {
    try {
      if (!await initializeAuth()) return;
      void pollStatus();
      setInterval(() => {
        if (refreshFailures === 0 && !formDirty && !currentStatus?.inFlight) lookupPositions({ silent: true });
      }, 5000);
    } catch (error) {
      $('error').textContent = error.message;
      notify(error.message, 'error');
    }
  })();
}
