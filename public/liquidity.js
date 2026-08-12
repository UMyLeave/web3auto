const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EXECUTION_MODE_INITIALIZE_ONLY = 'initialize_only';
const EXECUTION_MODE_INITIALIZE_AND_ADD = 'initialize_and_add';
const CREATE_FORM_STORAGE_KEY = 'liquidity-create-form-v1';

const elements = {
  form: document.querySelector('#liquidityForm'),
  tradeToken: document.querySelector('#tradeToken'),
  quoteToken: document.querySelector('#quoteToken'),
  quoteAddress: document.querySelector('#quoteAddress'),
  price: document.querySelector('#price'),
  priceHint: document.querySelector('#priceHint'),
  feePercent: document.querySelector('#feePercent'),
  tickSpacing: document.querySelector('#tickSpacing'),
  customBudgetField: document.querySelector('#customBudgetField'),
  customBudget: document.querySelector('#customBudget'),
  budgetUnit: document.querySelector('#budgetUnit'),
  rangeSection: document.querySelector('#rangeSection'),
  customRangeFields: document.querySelector('#customRangeFields'),
  lowerPrice: document.querySelector('#lowerPrice'),
  upperPrice: document.querySelector('#upperPrice'),
  hooks: document.querySelector('#hooks'),
  hooksPreset: document.querySelector('#hooksPreset'),
  hooksPresetHint: document.querySelector('#hooksPresetHint'),
  hooksAcknowledge: document.querySelector('#hooksAcknowledge'),
  acknowledgeCustomHooks: document.querySelector('#acknowledgeCustomHooks'),
  previewButton: document.querySelector('#previewButton'),
  executeButton: document.querySelector('#executeButton'),
  previewState: document.querySelector('#previewState'),
  poolStageState: document.querySelector('#poolStageState'),
  positionStageState: document.querySelector('#positionStageState'),
  positionBlockTitle: document.querySelector('#positionBlockTitle'),
  poolResult: document.querySelector('#poolResult'),
  positionResult: document.querySelector('#positionResult'),
  actionControls: document.querySelector('#actionControls'),
  resolveActionButton: document.querySelector('#resolveActionButton'),
  walletState: document.querySelector('#walletState'),
  walletAddress: document.querySelector('#walletAddress'),
  walletBalances: document.querySelector('#walletBalances'),
  balanceUpdated: document.querySelector('#balanceUpdated'),
  formMessage: document.querySelector('#formMessage'),
  toast: document.querySelector('#liquidityToast')
};

let options = null;
let lastPreview = null;
let selectedBudget = 'none';
let selectedRange = { type: 'percent', percent: '90' };
let toastTimer = null;
let statusTimer = null;
let balanceTimer = null;
let balancePollVersion = 0;
let blockingAction = false;
let executionRequestPending = false;
let executionStartedAtMs = 0;
let displayedAction = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function request(path, requestOptions = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...requestOptions
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `liquidity-toast visible${type === 'error' ? ' error' : ''}`;
  toastTimer = setTimeout(() => {
    elements.toast.className = 'liquidity-toast';
  }, 3200);
}

function selectedQuote() {
  return options?.stablecoins?.find((item) => item.address === elements.quoteToken.value) || null;
}

function refreshQuote() {
  const quote = selectedQuote();
  elements.quoteAddress.value = quote?.address || '';
  elements.budgetUnit.textContent = quote?.symbol || 'U';
  elements.priceHint.textContent = `1 交易代币 = ${elements.price.value || '—'} ${quote?.symbol || '稳定币'}`;
}

function readStoredFormSnapshot() {
  try {
    const raw = window.sessionStorage.getItem(CREATE_FORM_STORAGE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

function persistFormSnapshot() {
  const snapshot = {
    tradeToken: elements.tradeToken.value,
    quoteToken: elements.quoteToken.value,
    price: elements.price.value,
    feePercent: elements.feePercent.value,
    tickSpacing: elements.tickSpacing.value,
    customBudget: elements.customBudget.value,
    lowerPrice: elements.lowerPrice.value,
    upperPrice: elements.upperPrice.value,
    hooks: elements.hooks.value,
    acknowledgeCustomHooks: elements.acknowledgeCustomHooks.checked,
    selectedBudget,
    selectedRange
  };
  try {
    window.sessionStorage.setItem(CREATE_FORM_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Private browsing or a blocked storage policy should not interrupt form use.
  }
}

function restoreFormSnapshot() {
  const snapshot = readStoredFormSnapshot();
  if (!snapshot) return false;

  const setValue = (element, value) => {
    if (typeof value === 'string' || typeof value === 'number') element.value = String(value);
  };
  setValue(elements.tradeToken, snapshot.tradeToken);
  const storedQuote = options?.stablecoins?.find((item) => (
    item.address?.toLowerCase() === String(snapshot.quoteToken || '').toLowerCase()
  ));
  if (storedQuote) {
    elements.quoteToken.value = storedQuote.address;
  }
  setValue(elements.price, snapshot.price);
  setValue(elements.feePercent, snapshot.feePercent);
  setValue(elements.tickSpacing, snapshot.tickSpacing);
  setValue(elements.customBudget, snapshot.customBudget);
  setValue(elements.lowerPrice, snapshot.lowerPrice);
  setValue(elements.upperPrice, snapshot.upperPrice);
  setValue(elements.hooks, snapshot.hooks || ZERO_ADDRESS);
  elements.acknowledgeCustomHooks.checked = Boolean(snapshot.acknowledgeCustomHooks);

  const budget = String(snapshot.selectedBudget || 'none');
  selectedBudget = ['none', '10', '20', '50', 'custom'].includes(budget) ? budget : 'none';
  document.querySelectorAll('[data-budget]').forEach((button) => {
    button.classList.toggle('active', button.dataset.budget === selectedBudget);
  });

  const range = snapshot.selectedRange && typeof snapshot.selectedRange === 'object'
    ? snapshot.selectedRange
    : {};
  const rangeType = ['percent', 'full', 'custom'].includes(range.type) ? range.type : 'percent';
  selectedRange = {
    type: rangeType,
    percent: rangeType === 'percent' ? (range.percent || '90') : null
  };
  let matchingRange = [...document.querySelectorAll('[data-range]')].find((button) => (
    button.dataset.range === selectedRange.type
      && (selectedRange.type !== 'percent' || button.dataset.percent === String(selectedRange.percent))
  ));
  if (!matchingRange) {
    matchingRange = [...document.querySelectorAll('[data-range]')].find((button) => (
      button.dataset.range === 'percent' && button.dataset.percent === '90'
    ));
    selectedRange = {
      type: matchingRange?.dataset.range || 'percent',
      percent: matchingRange?.dataset.percent || '90'
    };
  }
  if (matchingRange) {
    selectedRange.percent = matchingRange.dataset.percent || null;
  }
  document.querySelectorAll('[data-range]').forEach((button) => {
    button.classList.toggle('active', button === matchingRange);
  });

  syncHooksPresetFromAddress();
  refreshConditionalFields();
  refreshQuote();
  return true;
}

function customHooksEnabled() {
  const value = elements.hooks.value.trim().toLowerCase();
  return Boolean(value && value !== ZERO_ADDRESS);
}

function configuredHookPreset() {
  const hooksAddress = elements.hooks.value.trim().toLowerCase();
  return options?.hookPresets?.find((preset) => (
    preset.available
    && preset.address?.toLowerCase() === hooksAddress
  )) || null;
}

function syncHooksPresetFromAddress() {
  const value = elements.hooks.value.trim().toLowerCase();
  const preset = configuredHookPreset();
  if (!value || value === ZERO_ADDRESS) {
    elements.hooksPreset.value = '';
    elements.hooksPresetHint.textContent = '初始化时不携带 Hooks';
  } else if (preset) {
    elements.hooksPreset.value = preset.address;
    elements.hooksPresetHint.textContent = `${preset.label} · ${preset.walletCount} 个白名单钱包`;
  } else {
    elements.hooksPreset.value = 'custom';
    elements.hooksPresetHint.textContent = '当前使用手动输入的自定义 Hooks';
  }
}

function renderHookPresets() {
  const presets = options?.hookPresets || [];
  elements.hooksPreset.innerHTML = [
    '<option value="">空（不携带 Hooks）</option>',
    ...presets.map((preset) => (
      `<option value="${escapeHtml(preset.address || '')}" ${preset.available ? '' : 'disabled'}>`
      + `${escapeHtml(preset.label)}${preset.available ? '' : '（未部署）'}`
      + '</option>'
    )),
    '<option value="custom" hidden>自定义地址</option>'
  ].join('');
  syncHooksPresetFromAddress();
}

function addsLiquidity() {
  return selectedBudget !== 'none';
}

function actionInitializeOnly(action) {
  return action?.executionMode === EXECUTION_MODE_INITIALIZE_ONLY
    || action?.request?.executionMode === EXECUTION_MODE_INITIALIZE_ONLY
    || action?.plan?.executionMode === EXECUTION_MODE_INITIALIZE_ONLY;
}

function refreshConditionalFields() {
  elements.customBudgetField.classList.toggle('visible', selectedBudget === 'custom');
  elements.rangeSection.hidden = !addsLiquidity();
  elements.customRangeFields.classList.toggle(
    'visible',
    addsLiquidity() && selectedRange.type === 'custom'
  );
  elements.hooksAcknowledge.classList.toggle('visible', customHooksEnabled());
  if (!executionRequestPending) {
    elements.executeButton.textContent = addsLiquidity()
      ? '确认并执行加池'
      : '确认并创建池子';
  }
}

function invalidatePreview() {
  lastPreview = null;
  elements.executeButton.disabled = true;
  elements.previewState.className = 'summary-badge';
  elements.previewState.textContent = '参数已变更';
}

function collectPayload() {
  const withPosition = addsLiquidity();
  return {
    tradeToken: elements.tradeToken.value.trim(),
    quoteToken: elements.quoteToken.value,
    price: elements.price.value.trim(),
    feePercent: elements.feePercent.value.trim(),
    tickSpacing: elements.tickSpacing.value.trim(),
    executionMode: withPosition
      ? EXECUTION_MODE_INITIALIZE_AND_ADD
      : EXECUTION_MODE_INITIALIZE_ONLY,
    budget: withPosition
      ? (selectedBudget === 'custom' ? elements.customBudget.value.trim() : selectedBudget)
      : null,
    rangeType: withPosition ? selectedRange.type : null,
    rangePercent: withPosition ? (selectedRange.percent || null) : null,
    lowerPrice: withPosition && selectedRange.type === 'custom'
      ? elements.lowerPrice.value.trim()
      : null,
    upperPrice: withPosition && selectedRange.type === 'custom'
      ? elements.upperPrice.value.trim()
      : null,
    hooks: elements.hooks.value.trim() || ZERO_ADDRESS,
    acknowledgeCustomHooks: elements.acknowledgeCustomHooks.checked
  };
}

function approvalSummary(approvals, autoAllocation) {
  if (!approvals) return '未配置私钥，未查询钱包授权';
  const required = Object.values(approvals).filter(Boolean).length
    + (autoAllocation?.approvalRequired ? 1 : 0);
  return required ? `执行前需要 ${required} 项授权` : '现有授权可直接使用';
}

function setStageBadge(element, text, state = '') {
  const className = `summary-badge${state ? ` ${state}` : ''}`;
  if (element.className !== className) element.className = className;
  if (element.textContent !== text) element.textContent = text;
}

function resetRenderKey(element) {
  delete element.dataset.renderKey;
}

function loadingMarkup(title, detail) {
  return `
    <div class="execution-loading">
      <span aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
    </div>
  `;
}

function actionPoolId(action) {
  return action?.poolId || action?.plan?.poolId || null;
}

function poolInitializationConfirmed(action) {
  return Boolean(
    action?.poolInitializedAt
    || action?.transactions?.some((transaction) => (
      transaction.kind === 'initialize_pool'
      && transaction.status !== 'failed'
      && transaction.blockNumber !== null
      && transaction.blockNumber !== undefined
    ))
  );
}

function actionPair(action) {
  const symbols = [action?.plan?.token0?.symbol, action?.plan?.token1?.symbol].filter(Boolean);
  return symbols.length ? symbols.join(' / ') : '—';
}

function actionFeePercent(action) {
  if (action?.request?.feePercent) return `${action.request.feePercent}%`;
  const rawFee = Number(action?.plan?.poolKey?.fee);
  return Number.isFinite(rawFee) ? `${rawFee / 10_000}%` : '—';
}

function stageProgress(action) {
  const progress = {
    initializing: ['正在创建池子', '池子初始化交易正在等待链上确认'],
    preparing_swap: ['正在准备兑换', '池子已创建，正在重新校验价格和兑换参数'],
    swapping: ['正在兑换代币', '稳定币兑换交易正在准备或等待链上确认'],
    preparing_liquidity: ['正在计算仓位', '兑换已确认，正在按实际到账数量重新计算仓位'],
    resuming: ['正在恢复加仓', '正在复用上次已兑换的钱包资产，不会再次建池或兑换'],
    approving: ['正在处理授权', '正在完成 ERC20 与 Permit2 授权'],
    submitting: ['正在添加仓位', '仓位交易已发送或正在等待链上确认']
  };
  return progress[action?.stage] || ['正在执行', '正在读取最新链上状态'];
}

function renderPreview(plan) {
  const recovery = Boolean(plan.recoveryMode);
  const sourceLabel = recovery ? '已初始化池的链上价格' : '输入的初始价格';
  const withPosition = plan.executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD;
  const walletReady = !withPosition || (recovery
    ? plan.wallet?.sufficient0 && plan.wallet?.sufficient1
    : plan.wallet?.stableInputSufficient);
  const canExecute = plan.privateKeyConfigured
    && (!withPosition || plan.autoAllocationConfigured)
    && plan.executionEnabled
    && walletReady
    && !blockingAction
    && (!plan.hooksWarning || elements.acknowledgeCustomHooks.checked);

  resetRenderKey(elements.poolResult);
  resetRenderKey(elements.positionResult);
  elements.poolResult.className = 'preview-stack';
  elements.poolResult.innerHTML = `
    <div class="pool-state">
      <span>池状态</span>
      <strong>${recovery ? '恢复上次任务 · 跳过重复建池' : '新池 · 初始化预检通过'}</strong>
    </div>
    <dl class="preview-list">
      <div><dt>预计 Pool ID</dt><dd>${escapeHtml(plan.poolId)}</dd></div>
      <div><dt>交易对</dt><dd>${escapeHtml(plan.token0.symbol)} / ${escapeHtml(plan.token1.symbol)}</dd></div>
      <div><dt>生效价格</dt><dd>${escapeHtml(plan.activePrice)} ${escapeHtml(plan.quoteSymbol)} · ${sourceLabel}</dd></div>
      <div><dt>费率 / Spacing</dt><dd>${escapeHtml(plan.feePercent)}% / ${escapeHtml(plan.poolKey.tickSpacing)}</dd></div>
      <div><dt>Hooks</dt><dd>${escapeHtml(plan.poolKey.hooks || ZERO_ADDRESS)}</dd></div>
    </dl>
    ${plan.hooksWarning ? `<div class="preview-warning">${escapeHtml(plan.hooksWarning)}</div>` : ''}
  `;

  elements.positionBlockTitle.textContent = withPosition ? '兑换与仓位' : '仓位处理';
  elements.positionResult.className = 'preview-stack';
  elements.positionResult.innerHTML = withPosition ? `
    <dl class="preview-list">
      <div><dt>投入稳定币</dt><dd>${escapeHtml(plan.stableInputAmount)} ${escapeHtml(plan.quoteSymbol)}</dd></div>
      <div><dt>Tick 区间</dt><dd>${escapeHtml(plan.tickLower)} ～ ${escapeHtml(plan.tickUpper)}</dd></div>
      <div><dt>授权状态</dt><dd>${escapeHtml(approvalSummary(plan.approvals, plan.autoAllocation))}</dd></div>
      <div><dt>预计 NFT ID</dt><dd>${escapeHtml(plan.nextTokenId)}</dd></div>
    </dl>
    ${plan.autoAllocation ? `
      <div class="pool-state">
        <span>自动兑换</span>
        <strong>${plan.autoAllocation.recovered
          ? `复用上次已兑换资产，本次不再兑换`
          : (plan.autoAllocation.required
          ? `${escapeHtml(plan.autoAllocation.stableToSwap)} ${escapeHtml(plan.quoteToken.symbol)} → 预计 ${escapeHtml(plan.autoAllocation.quotedTradeAmount)} ${escapeHtml(plan.tradeToken.symbol)}`
          : `无需兑换，全部使用 ${escapeHtml(plan.quoteToken.symbol)}`)}</strong>
      </div>
      <dl class="preview-list">
        <div><dt>保留用于仓位</dt><dd>${escapeHtml(plan.autoAllocation.quoteForLiquidity)} ${escapeHtml(plan.quoteToken.symbol)}</dd></div>
        <div><dt>兑换后用于仓位</dt><dd>${escapeHtml(plan.autoAllocation.quotedTradeAmount)} ${escapeHtml(plan.tradeToken.symbol)}</dd></div>
      </dl>
    ` : ''}
    <div class="token-preview">
      ${[plan.token0, plan.token1].map((token) => `
        <div class="token-row">
          <div>
            <strong>${escapeHtml(token.symbol)}</strong>
            <span>预计 ${escapeHtml(token.amountEstimated)} · 上限 ${escapeHtml(token.amountMax)}</span>
          </div>
          <small>${escapeHtml(token.address)}</small>
        </div>
      `).join('')}
    </div>
    ${plan.wallet ? `
      <dl class="preview-list">
        <div><dt>钱包 ${escapeHtml(plan.quoteToken.symbol)}</dt><dd>${escapeHtml(plan.wallet.stableBalance)} · ${plan.wallet.stableInputSufficient ? '投入充足' : '投入不足'}</dd></div>
        ${recovery ? `<div><dt>钱包 ${escapeHtml(plan.tradeToken.symbol)}</dt><dd>${escapeHtml(plan.wallet.tradeBalance)} · ${plan.wallet.sufficient0 && plan.wallet.sufficient1 ? '恢复数量充足' : '恢复数量不足'}</dd></div>` : ''}
      </dl>
    ` : ''}
    ${recovery ? '<div class="preview-warning">恢复模式只会补齐必要授权并创建仓位 NFT；不会重复建池或再次兑换。</div>' : ''}
    ${!plan.autoAllocationConfigured ? '<div class="preview-warning">未配置 OKX DEX API 凭证，无法完成稳定币自动分配。</div>' : ''}
    ${!plan.executionEnabled ? '<div class="preview-warning">只读预检可用；执行前需在 .env 中设置 LIQUIDITY_EXECUTE=true 并重启服务。</div>' : ''}
  ` : `
    <div class="pool-state">
      <span>执行模式</span>
      <strong>仅初始化池子</strong>
    </div>
    <dl class="preview-list">
      <div><dt>投入稳定币</dt><dd>不投入</dd></div>
      <div><dt>流动性区间</dt><dd>本次不需要</dd></div>
      <div><dt>自动兑换</dt><dd>不执行</dd></div>
      <div><dt>仓位 NFT</dt><dd>不创建</dd></div>
    </dl>
    <div class="preview-warning">该 PoolKey 初始化后不能再次创建；本次完成后池内仍没有流动性。</div>
    ${!plan.executionEnabled ? '<div class="preview-warning">只读预检可用；执行前需在 .env 中设置 LIQUIDITY_EXECUTE=true 并重启服务。</div>' : ''}
  `;
  setStageBadge(elements.previewState, '预检完成', 'ready');
  setStageBadge(elements.poolStageState, '预检通过', 'ready');
  setStageBadge(elements.positionStageState, withPosition ? '仓位预览' : '本次跳过', 'ready');
  elements.executeButton.disabled = !canExecute;

  if (!plan.privateKeyConfigured) {
    elements.formMessage.textContent = '未配置 PRIVATE_KEY，当前只能预检。';
  } else if (withPosition && !plan.autoAllocationConfigured) {
    elements.formMessage.textContent = '未配置 OKX DEX API 凭证，不能执行自动分配。';
  } else if (withPosition && !walletReady) {
    elements.formMessage.textContent = recovery
      ? '钱包中上次已兑换的仓位资产数量不足，不能恢复。'
      : `钱包 ${plan.quoteToken.symbol} 余额不足，不能执行。`;
  } else if (!plan.executionEnabled) {
    elements.formMessage.textContent = '执行开关未开启，当前只能预检。';
  } else if (blockingAction) {
    elements.formMessage.textContent = '上一次任务有待核对交易，请先确认该交易的链上状态。';
  } else if (plan.hooksWarning && !elements.acknowledgeCustomHooks.checked) {
    elements.formMessage.textContent = '勾选自定义 Hooks 风险确认后才能执行。';
  } else {
    elements.formMessage.textContent = '';
  }
}

function renderPreviewError(error) {
  resetRenderKey(elements.poolResult);
  resetRenderKey(elements.positionResult);
  setStageBadge(elements.previewState, '预检失败', 'error');
  setStageBadge(elements.poolStageState, '预检失败', 'error');
  setStageBadge(elements.positionStageState, '未开始');
  elements.poolResult.className = 'preview-error';
  elements.poolResult.textContent = error.message;
  elements.positionResult.className = 'summary-empty';
  elements.positionResult.textContent = addsLiquidity()
    ? '预检未通过，不会执行兑换和添加仓位。'
    : '预检未通过，不会发送池子初始化交易。';
  elements.actionControls.hidden = true;
  elements.formMessage.textContent = error.message;
}

function renderExecutionStarting(plan) {
  const withPosition = plan.executionMode === EXECUTION_MODE_INITIALIZE_AND_ADD;
  const recovery = Boolean(plan.recoveryMode);
  resetRenderKey(elements.poolResult);
  resetRenderKey(elements.positionResult);
  setStageBadge(elements.previewState, '执行中', 'loading');
  setStageBadge(elements.poolStageState, recovery ? '已复用' : '创建中', recovery ? 'ready' : 'loading');
  setStageBadge(elements.positionStageState, recovery ? '恢复中' : (withPosition ? '等待池子' : '本次跳过'), withPosition ? 'loading' : 'ready');
  elements.poolResult.className = 'preview-stack';
  elements.poolResult.innerHTML = `
    ${recovery
    ? '<div class="execution-result"><strong>已复用上次创建的池子</strong><p>本次不发送建池交易。</p></div>'
    : loadingMarkup('正在创建池子', '池子确认后会立即在这里显示 Pool ID')}
    <dl class="preview-list">
      <div><dt>预计 Pool ID</dt><dd>${escapeHtml(plan.poolId)}</dd></div>
      <div><dt>交易对</dt><dd>${escapeHtml(plan.token0.symbol)} / ${escapeHtml(plan.token1.symbol)}</dd></div>
    </dl>
  `;
  elements.positionBlockTitle.textContent = withPosition ? '兑换与仓位' : '仓位处理';
  elements.positionResult.className = 'preview-stack';
  elements.positionResult.innerHTML = withPosition
    ? (recovery
      ? loadingMarkup('正在恢复加仓', '只会补齐授权并添加仓位，不会再次兑换')
      : loadingMarkup('等待池子创建完成', '之后将依次显示兑换、授权和添加仓位进度'))
    : '<div class="summary-empty">本次只创建池子，不会执行兑换、授权或添加仓位。</div>';
  elements.actionControls.hidden = true;
}

function renderStoredAction(action, inFlight = false) {
  displayedAction = action || null;
  if (!action) {
    blockingAction = false;
    elements.actionControls.hidden = true;
    return;
  }
  const completed = action.stage === 'completed';
  const attention = action.stage === 'needs_attention';
  const failed = action.stage === 'failed';
  const cancelled = action.stage === 'cancelled';
  const initializeOnly = actionInitializeOnly(action);
  const terminal = completed || attention || failed || cancelled;
  const running = inFlight || !terminal;
  const poolConfirmed = poolInitializationConfirmed(action);
  const createdPoolId = poolConfirmed ? actionPoolId(action) : null;
  const confirmedTransactions = action.transactions?.filter((transaction) => (
    transaction.blockNumber !== null && transaction.blockNumber !== undefined
  )).length || 0;
  blockingAction = attention;

  if (completed) {
    setStageBadge(elements.previewState, '执行完成', 'ready');
  } else if (attention) {
    setStageBadge(elements.previewState, '需要人工核对', 'error');
  } else if (failed) {
    setStageBadge(elements.previewState, '执行失败', 'error');
  } else if (cancelled) {
    setStageBadge(elements.previewState, '任务已结束');
  } else {
    setStageBadge(elements.previewState, '执行中', 'loading');
  }

  const actionIdentity = action.id || action.startedAt || 'stored-action';
  const poolRenderKey = JSON.stringify(poolConfirmed
    ? [actionIdentity, 'confirmed', createdPoolId, action.poolInitializeTxHash]
    : [
      actionIdentity,
      action.stage,
      actionPoolId(action),
      action.poolInitializeTxHash,
      action.error,
      action.resolution
    ]);
  if (elements.poolResult.dataset.renderKey !== poolRenderKey) {
    if (poolConfirmed) {
      setStageBadge(elements.poolStageState, '已创建', 'ready');
      elements.poolResult.className = 'execution-result';
      elements.poolResult.innerHTML = `
        <strong>Pool ID ${escapeHtml(createdPoolId)}</strong>
        <p>交易对：${escapeHtml(actionPair(action))}</p>
        <p>费率 / Spacing：${escapeHtml(actionFeePercent(action))} / ${escapeHtml(action.plan?.poolKey?.tickSpacing ?? '—')}</p>
        <p>生效价格：${escapeHtml(action.plan?.activePrice ?? '—')} ${escapeHtml(action.plan?.quoteSymbol ?? '')}</p>
        <p>建池交易：${escapeHtml(action.poolInitializeTxHash || '—')}</p>
      `;
    } else if (failed || attention || cancelled) {
      setStageBadge(
        elements.poolStageState,
        attention ? '待核对' : '未创建',
        failed || attention ? 'error' : ''
      );
      elements.poolResult.className = failed || attention ? 'preview-error' : 'execution-result';
      elements.poolResult.innerHTML = `
        <p>Pool ID：${escapeHtml(actionPoolId(action) || '—')}</p>
        ${action.poolInitializeTxHash ? `<p>建池交易：${escapeHtml(action.poolInitializeTxHash)}</p>` : ''}
        <p>${escapeHtml(action.error || action.resolution || '池子没有完成链上初始化')}</p>
      `;
    } else {
      setStageBadge(elements.poolStageState, '创建中', 'loading');
      elements.poolResult.className = 'preview-stack';
      elements.poolResult.innerHTML = `
        ${loadingMarkup('正在创建池子', '链上确认后会立即更新 Pool ID')}
        <dl class="preview-list">
          <div><dt>预计 Pool ID</dt><dd>${escapeHtml(actionPoolId(action) || '—')}</dd></div>
          <div><dt>交易对</dt><dd>${escapeHtml(actionPair(action))}</dd></div>
          ${action.poolInitializeTxHash ? `<div><dt>建池交易</dt><dd>${escapeHtml(action.poolInitializeTxHash)}</dd></div>` : ''}
        </dl>
      `;
    }
    elements.poolResult.dataset.renderKey = poolRenderKey;
  }

  const positionRenderKey = JSON.stringify([
    actionIdentity,
    initializeOnly,
    action.stage,
    poolConfirmed,
    confirmedTransactions,
    action.autoSwap?.status,
    action.autoSwap?.hash,
    action.autoSwap?.stableSpent,
    action.autoSwap?.tradeReceived,
    action.currentTx?.hash,
    action.liquidityTxHash,
    action.nftId,
    action.error,
    action.resolution
  ]);
  elements.positionBlockTitle.textContent = initializeOnly ? '仓位处理' : '兑换与仓位';
  if (elements.positionResult.dataset.renderKey !== positionRenderKey) {
    if (initializeOnly) {
      setStageBadge(elements.positionStageState, '本次跳过', 'ready');
      elements.positionResult.className = 'execution-result';
      elements.positionResult.innerHTML = `
        <strong>未添加流动性仓位</strong>
        <p>本次模式仅初始化池子，没有投入稳定币。</p>
        <p>未执行自动兑换、代币授权或 NFT 仓位创建。</p>
        <p>已确认 ${escapeHtml(confirmedTransactions)} 笔链上交易。</p>
      `;
    } else if (completed) {
      setStageBadge(elements.positionStageState, '已完成', 'ready');
      elements.positionResult.className = 'execution-result';
      elements.positionResult.innerHTML = `
        <strong>NFT ID ${escapeHtml(action.nftId || '未从回执识别')}</strong>
        ${action.autoSwap?.status === 'confirmed'
          ? `<p>实际兑换：${escapeHtml(action.autoSwap.stableSpent)} ${escapeHtml(action.autoSwap.quoteSymbol)} → ${escapeHtml(action.autoSwap.tradeReceived)} ${escapeHtml(action.autoSwap.tradeSymbol)}</p>`
          : '<p>实际兑换：本次区间无需兑换</p>'}
        ${action.positionReconciliation?.found
          ? '<p>该仓位由失败后的链上核对识别，实际投入数量以 NFT 链上仓位为准。</p>'
          : `<p>添加仓位：${escapeHtml(action.plan?.token0?.amountEstimated || '—')} ${escapeHtml(action.plan?.token0?.symbol || '')} + ${escapeHtml(action.plan?.token1?.amountEstimated || '—')} ${escapeHtml(action.plan?.token1?.symbol || '')}</p>`}
        <p>Tick 区间：${escapeHtml(action.plan?.tickLower ?? '—')} ～ ${escapeHtml(action.plan?.tickUpper ?? '—')}</p>
        <p>加池交易：${escapeHtml(action.liquidityTxHash || '—')}</p>
        <p>本次共确认 ${escapeHtml(confirmedTransactions)} 笔链上交易。</p>
      `;
    } else if (failed || attention) {
      setStageBadge(elements.positionStageState, attention ? '待核对' : '未完成', 'error');
      elements.positionResult.className = 'preview-error';
      elements.positionResult.innerHTML = `
        ${action.autoSwap?.status === 'confirmed' ? `<p>已完成兑换：${escapeHtml(action.autoSwap.stableSpent)} ${escapeHtml(action.autoSwap.quoteSymbol)} → ${escapeHtml(action.autoSwap.tradeReceived)} ${escapeHtml(action.autoSwap.tradeSymbol)}</p>` : ''}
        ${action.autoSwap?.hash ? `<p>兑换交易：${escapeHtml(action.autoSwap.hash)}</p>` : ''}
        ${action.liquidityTxHash ? `<p>加池交易：${escapeHtml(action.liquidityTxHash)}</p>` : ''}
        ${action.currentTx?.hash ? `<p>待核对交易：${escapeHtml(action.currentTx.hash)}</p>` : ''}
        <p>${escapeHtml(action.error || '兑换或添加仓位流程没有完成')}</p>
        ${action.resolution ? `<p>${escapeHtml(action.resolution)}</p>` : ''}
      `;
    } else if (cancelled) {
      setStageBadge(elements.positionStageState, '已结束');
      elements.positionResult.className = 'execution-result';
      elements.positionResult.innerHTML = `
        <p>${escapeHtml(action.resolution || '任务已结束')}</p>
        ${action.autoSwap?.status === 'confirmed' ? `<p>已完成兑换：${escapeHtml(action.autoSwap.stableSpent)} ${escapeHtml(action.autoSwap.quoteSymbol)} → ${escapeHtml(action.autoSwap.tradeReceived)} ${escapeHtml(action.autoSwap.tradeSymbol)}</p>` : ''}
      `;
    } else {
      const [title, detail] = stageProgress(action);
      setStageBadge(
        elements.positionStageState,
        poolConfirmed ? title.replace('正在', '') : '等待池子',
        'loading'
      );
      elements.positionResult.className = 'preview-stack';
      elements.positionResult.innerHTML = `
        ${loadingMarkup(
          poolConfirmed ? title : '等待池子创建完成',
          poolConfirmed ? detail : '池子确认后才会开始兑换和添加仓位'
        )}
        <dl class="preview-list">
          <div><dt>当前阶段</dt><dd>${escapeHtml(action.stage || '—')}</dd></div>
          <div><dt>已确认交易</dt><dd>${escapeHtml(confirmedTransactions)} 笔</dd></div>
          ${action.autoSwap?.status === 'confirmed' ? `<div><dt>实际兑换</dt><dd>${escapeHtml(action.autoSwap.stableSpent)} ${escapeHtml(action.autoSwap.quoteSymbol)} → ${escapeHtml(action.autoSwap.tradeReceived)} ${escapeHtml(action.autoSwap.tradeSymbol)}</dd></div>` : ''}
          ${action.currentTx?.hash ? `<div><dt>当前交易</dt><dd>${escapeHtml(action.currentTx.hash)}</dd></div>` : ''}
        </dl>
      `;
    }
    elements.positionResult.dataset.renderKey = positionRenderKey;
  }

  const canResolve = attention;
  elements.actionControls.hidden = !canResolve || inFlight;
  elements.resolveActionButton.disabled = inFlight;
  elements.resolveActionButton.textContent = initializeOnly ? '核对建池交易' : '核对仓位并放行';
  if (running) {
    elements.executeButton.disabled = true;
    elements.formMessage.textContent = initializeOnly
      ? '已有池子初始化任务正在执行，请等待链上结果。'
      : '已有加池任务正在执行，请等待链上结果。';
  }
}

async function resolveStoredAction() {
  const initializeOnly = actionInitializeOnly(displayedAction);
  const prompt = initializeOnly
    ? '系统会只读查询本次池子初始化交易的链上回执。\n\n不会续跑、补发或撤销交易。是否继续？'
    : '系统会先只读查询本次目标 Pool ID 的 NFT 仓位。'
      + '\n找到仓位会记录 NFT ID；没有仓位会保留钱包资产和已有授权，并解除新任务阻塞。'
      + '\n\n不会续跑、补发或撤销交易。是否继续？';
  if (!window.confirm(prompt)) return;
  elements.resolveActionButton.disabled = true;
  try {
    const action = await request('/api/liquidity/resolve', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    renderStoredAction(action, false);
    lastPreview = null;
    elements.executeButton.disabled = true;
    if (initializeOnly) {
      elements.formMessage.textContent = action.stage === 'completed'
        ? '已确认池子初始化交易成功。'
        : '已确认池子初始化交易失败，可重新预检。';
      showToast(action.stage === 'completed' ? '池子初始化已确认' : '建池交易已确认失败');
    } else {
      elements.formMessage.textContent = action.nftId
        ? `已检测到目标池 NFT #${action.nftId}，待确认状态已解除。`
        : '未检测到目标池 NFT，待确认状态已解除，可发起新任务。';
      showToast(action.nftId ? `已识别 NFT #${action.nftId}` : '未发现仓位，已安全放行');
    }
    if (action.stage === 'completed') {
      window.dispatchEvent(new CustomEvent('liquidity:create-completed', { detail: action }));
    }
  } catch (error) {
    if (error.data?.action) renderStoredAction(error.data.action, false);
    elements.formMessage.textContent = error.message;
    showToast(error.message, 'error');
  } finally {
    elements.resolveActionButton.disabled = false;
  }
}

async function pollStatus() {
  clearTimeout(statusTimer);
  try {
    const status = await request('/api/liquidity/status');
    const actionStartedAt = Date.parse(status.lastAction?.startedAt || '');
    const belongsToCurrentExecution = !executionRequestPending
      || (Number.isFinite(actionStartedAt) && actionStartedAt >= executionStartedAtMs - 1_000);
    if (belongsToCurrentExecution) {
      renderStoredAction(status.lastAction, status.inFlight || executionRequestPending);
    }
    if (status.inFlight || executionRequestPending) {
      statusTimer = setTimeout(pollStatus, 700);
    }
  } catch {
    if (executionRequestPending) statusTimer = setTimeout(pollStatus, 1200);
  }
}

function setBusy(busy, label = '只读预检') {
  elements.previewButton.disabled = busy;
  elements.previewButton.textContent = busy ? '正在读取链上…' : label;
  if (busy) elements.executeButton.disabled = true;
}

async function preview(event) {
  event?.preventDefault();
  setBusy(true);
  elements.formMessage.textContent = '';
  try {
    const plan = await request('/api/liquidity/preview', {
      method: 'POST',
      body: JSON.stringify(collectPayload())
    });
    lastPreview = plan;
    renderPreview(plan);
    showToast('只读预检完成，没有广播交易');
  } catch (error) {
    lastPreview = null;
    renderPreviewError(error);
    showToast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function executeSummary() {
  if (!lastPreview) return '';
  if (lastPreview.executionMode === EXECUTION_MODE_INITIALIZE_ONLY) {
    return [
      '执行模式：仅初始化池子',
      `交易对：${lastPreview.token0.symbol} / ${lastPreview.token1.symbol}`,
      `初始价格：${lastPreview.activePrice} ${lastPreview.quoteSymbol}`,
      '投入稳定币：不投入',
      '自动兑换、授权和仓位 NFT：均不执行',
      '',
      '该 PoolKey 初始化后不能再次创建，且本次完成后池内仍没有流动性。确认发送建池交易吗？'
    ].join('\n');
  }
  if (lastPreview.recoveryMode) {
    return [
      '执行模式：恢复上次未完成的加仓',
      `复用池子：${lastPreview.poolId}`,
      `复用钱包资产：${lastPreview.autoAllocation.quotedTradeAmount} ${lastPreview.tradeToken.symbol} + ${lastPreview.autoAllocation.quoteForLiquidity} ${lastPreview.quoteSymbol}`,
      '建池交易：不发送',
      '自动兑换：不执行',
      '本次只会补齐必要的 ERC20 / Permit2 授权，然后发送一笔加仓交易。',
      '',
      '确认恢复加仓吗？'
    ].join('\n');
  }
  const allocation = lastPreview.autoAllocation;
  return [
    '池状态：新池，先独立初始化成功再执行兑换与加仓',
    `投入稳定币：${lastPreview.stableInputAmount} ${lastPreview.quoteSymbol}`,
    allocation?.required
      ? `自动兑换：${allocation.stableToSwap} ${lastPreview.quoteSymbol} → 预计 ${allocation.quotedTradeAmount} ${lastPreview.tradeToken.symbol}`
      : '自动兑换：当前区间无需兑换',
    `预计仓位：${lastPreview.token0.amountEstimated} ${lastPreview.token0.symbol} + ${lastPreview.token1.amountEstimated} ${lastPreview.token1.symbol}`,
    `Tick 区间：${lastPreview.tickLower} ～ ${lastPreview.tickUpper}`,
    '',
    '确认后服务端会先发送建池交易；只有建池确认成功，才可能依次发送稳定币授权、自动兑换、Permit2 授权和加仓交易。是否继续？'
  ].join('\n');
}

async function executeLiquidity() {
  if (!lastPreview || elements.executeButton.disabled) return;
  if (!window.confirm(executeSummary())) return;
  persistFormSnapshot();
  const executionPreview = lastPreview;
  executionRequestPending = true;
  executionStartedAtMs = Date.now();
  elements.executeButton.disabled = true;
  elements.executeButton.textContent = '链上执行中…';
  elements.previewButton.disabled = true;
  elements.formMessage.textContent = '正在创建池子，请勿重复操作。';
  renderExecutionStarting(executionPreview);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(pollStatus, 250);
  try {
    const action = await request('/api/liquidity/execute', {
      method: 'POST',
      body: JSON.stringify({
        ...collectPayload(),
        previewId: executionPreview.previewId,
        confirmed: true
      })
    });
    renderStoredAction(action, false);
    elements.formMessage.textContent = '';
    showToast(executionPreview.executionMode === EXECUTION_MODE_INITIALIZE_ONLY
      ? '池子初始化完成'
      : '初始化流动性执行完成');
    persistFormSnapshot();
    window.dispatchEvent(new CustomEvent('liquidity:create-completed', { detail: action }));
    lastPreview = null;
  } catch (error) {
    if (error.data?.action) renderStoredAction(error.data.action, false);
    elements.formMessage.textContent = error.message;
    if (!error.data?.action) setStageBadge(elements.previewState, '执行失败', 'error');
    showToast(error.message, 'error');
  } finally {
    executionRequestPending = false;
    executionStartedAtMs = 0;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(pollStatus, 0);
    elements.executeButton.textContent = addsLiquidity()
      ? '确认并执行加池'
      : '确认并创建池子';
    elements.previewButton.disabled = false;
  }
}

function bindChoices() {
  document.querySelectorAll('[data-budget]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-budget]').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      selectedBudget = button.dataset.budget;
      persistFormSnapshot();
      refreshConditionalFields();
      refreshWalletState();
      invalidatePreview();
    });
  });
  document.querySelectorAll('[data-range]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-range]').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      selectedRange = {
        type: button.dataset.range,
        percent: button.dataset.percent || null
      };
      persistFormSnapshot();
      refreshConditionalFields();
      invalidatePreview();
    });
  });
}

function bindInputs() {
  elements.form.addEventListener('submit', preview);
  elements.form.addEventListener('input', persistFormSnapshot);
  elements.form.addEventListener('change', persistFormSnapshot);
  elements.executeButton.addEventListener('click', executeLiquidity);
  elements.resolveActionButton.addEventListener('click', resolveStoredAction);
  elements.quoteToken.addEventListener('change', () => {
    refreshQuote();
    invalidatePreview();
    restartBalancePolling();
  });
  elements.price.addEventListener('input', () => {
    refreshQuote();
    invalidatePreview();
  });
  elements.hooks.addEventListener('input', () => {
    syncHooksPresetFromAddress();
    refreshConditionalFields();
    invalidatePreview();
  });
  elements.hooksPreset.addEventListener('change', () => {
    elements.hooks.value = elements.hooksPreset.value || ZERO_ADDRESS;
    syncHooksPresetFromAddress();
    persistFormSnapshot();
    refreshConditionalFields();
    invalidatePreview();
  });
  elements.acknowledgeCustomHooks.addEventListener('change', () => {
    invalidatePreview();
  });
  [
    elements.tradeToken,
    elements.feePercent,
    elements.tickSpacing,
    elements.customBudget,
    elements.lowerPrice,
    elements.upperPrice
  ].forEach((input) => input.addEventListener('input', () => {
    invalidatePreview();
    if (input === elements.tradeToken) restartBalancePolling(350);
  }));
}

function compactBalance(value) {
  const [whole = '0', fraction = ''] = String(value ?? '0').split('.');
  const visibleFraction = fraction.slice(0, 8).replace(/0+$/, '');
  if (/^0+$/.test(whole) && !visibleFraction && /[1-9]/.test(fraction)) {
    return '<0.00000001';
  }
  return visibleFraction ? `${whole}.${visibleFraction}` : whole;
}

function validTokenAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || '').trim());
}

function renderBalances(data) {
  elements.walletAddress.textContent = data.walletAddress;
  elements.walletAddress.title = data.walletAddress;
  const balances = [data.native, ...(data.tokens || [])];
  elements.walletBalances.className = 'wallet-balance-list';
  elements.walletBalances.innerHTML = balances.map((item) => `
    <div class="balance-pill">
      <span>${escapeHtml(item.symbol)}</span>
      <strong>${escapeHtml(compactBalance(item.balance))}</strong>
    </div>
  `).join('');
  const updatedAt = new Date(data.updatedAt);
  elements.balanceUpdated.textContent = `更新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })} · 每 5 秒刷新`;
}

async function pollWalletBalances(version) {
  if (version !== balancePollVersion) return;
  try {
    if (!options?.privateKeyConfigured) {
      elements.walletAddress.textContent = '未配置 PRIVATE_KEY';
      elements.walletBalances.className = 'wallet-balance-list error';
      elements.walletBalances.innerHTML = '<span class="balance-placeholder">服务端没有可查询的钱包</span>';
      return;
    }
    const params = new URLSearchParams({ quoteToken: elements.quoteToken.value });
    if (validTokenAddress(elements.tradeToken.value)) {
      params.set('tradeToken', elements.tradeToken.value.trim());
    }
    const data = await request(`/api/liquidity/balances?${params}`);
    if (version === balancePollVersion) renderBalances(data);
  } catch (error) {
    if (version === balancePollVersion) {
      elements.walletBalances.className = 'wallet-balance-list error';
      elements.walletBalances.innerHTML = `<span class="balance-placeholder">${escapeHtml(error.message)}</span>`;
      elements.balanceUpdated.textContent = '查询失败 · 5 秒后重试';
    }
  } finally {
    if (version === balancePollVersion && options?.privateKeyConfigured) {
      balanceTimer = setTimeout(() => pollWalletBalances(version), 5000);
    }
  }
}

function restartBalancePolling(delay = 0) {
  clearTimeout(balanceTimer);
  balancePollVersion += 1;
  const version = balancePollVersion;
  balanceTimer = setTimeout(() => pollWalletBalances(version), delay);
}

function refreshWalletState() {
  if (!options) return;
  if (!options.privateKeyConfigured) {
    elements.walletState.className = 'wallet-state blocked';
    elements.walletState.textContent = '未配置 PRIVATE_KEY · 仅预检';
  } else if (addsLiquidity() && !options.autoAllocationConfigured && !options.recoveryAvailable) {
    elements.walletState.className = 'wallet-state blocked';
    elements.walletState.textContent = `${options.walletAddress} · 自动分配未配置`;
  } else if (!options.executionEnabled) {
    elements.walletState.className = 'wallet-state';
    elements.walletState.textContent = `${options.walletAddress} · 执行未开启`;
  } else {
    elements.walletState.className = 'wallet-state ready';
    elements.walletState.textContent = `${options.walletAddress} · ${addsLiquidity() ? '可执行' : '可初始化池子'}`;
  }
  if (options.inFlight) {
    elements.walletState.className = 'wallet-state';
    elements.walletState.textContent = `${options.walletAddress || '服务端钱包'} · 建池执行中`;
  }
}

function loadRecoveryRequest(action) {
  if (!options?.recoveryAvailable || !action?.request) return false;
  const request = action.request;
  elements.tradeToken.value = request.tradeToken || '';
  elements.quoteToken.value = request.quoteToken || elements.quoteToken.value;
  elements.price.value = request.price || '';
  elements.feePercent.value = request.feePercent ?? '';
  elements.tickSpacing.value = request.tickSpacing ?? '';
  elements.hooks.value = request.hooks || ZERO_ADDRESS;
  elements.acknowledgeCustomHooks.checked = Boolean(request.acknowledgeCustomHooks);

  const budget = String(request.budget || '');
  const budgetButton = [...document.querySelectorAll('[data-budget]')]
    .find((button) => button.dataset.budget === budget);
  selectedBudget = budgetButton ? budget : 'custom';
  elements.customBudget.value = budget;
  document.querySelectorAll('[data-budget]').forEach((button) => {
    button.classList.toggle('active', button.dataset.budget === selectedBudget);
  });

  const matchingRange = [...document.querySelectorAll('[data-range]')].find((button) => (
    button.dataset.range === request.rangeType
      && (request.rangeType !== 'percent' || button.dataset.percent === String(request.rangePercent))
  ));
  selectedRange = matchingRange
    ? { type: matchingRange.dataset.range, percent: matchingRange.dataset.percent || null }
    : { type: request.rangeType || 'custom', percent: request.rangePercent || null };
  elements.lowerPrice.value = request.lowerPrice || '';
  elements.upperPrice.value = request.upperPrice || '';
  document.querySelectorAll('[data-range]').forEach((button) => {
    button.classList.toggle('active', button === matchingRange);
  });

  syncHooksPresetFromAddress();
  refreshConditionalFields();
  refreshQuote();
  persistFormSnapshot();
  return true;
}

async function loadOptions() {
  try {
    options = await request('/api/liquidity/options');
    elements.quoteToken.innerHTML = options.stablecoins.map((item) => (
      `<option value="${escapeHtml(item.address)}">${escapeHtml(item.symbol)}</option>`
    )).join('');
    renderHookPresets();
    const recoveryLoaded = loadRecoveryRequest(options.lastAction);
    if (!recoveryLoaded) restoreFormSnapshot();
    refreshQuote();
    refreshWalletState();
    renderStoredAction(options.lastAction, options.inFlight);
    if (recoveryLoaded) {
      elements.formMessage.textContent = '已载入上次失败任务的原参数；点击“只读预检”后可恢复加仓，不会再次兑换。';
    }
    if (options.inFlight) statusTimer = setTimeout(pollStatus, 1000);
    restartBalancePolling();
  } catch (error) {
    elements.walletState.className = 'wallet-state blocked';
    elements.walletState.textContent = '流动性模块不可用';
    renderPreviewError(error);
  }
}

bindChoices();
bindInputs();
window.addEventListener('liquidity:open-create', restoreFormSnapshot);
refreshConditionalFields();
loadOptions();
