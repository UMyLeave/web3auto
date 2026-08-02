const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
let selectedBudget = '10';
let selectedRange = { type: 'percent', percent: '90' };
let toastTimer = null;
let statusTimer = null;
let balanceTimer = null;
let balancePollVersion = 0;
let blockingAction = false;
let executionRequestPending = false;
let executionStartedAtMs = 0;

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

function refreshConditionalFields() {
  elements.customBudgetField.classList.toggle('visible', selectedBudget === 'custom');
  elements.customRangeFields.classList.toggle('visible', selectedRange.type === 'custom');
  elements.hooksAcknowledge.classList.toggle('visible', customHooksEnabled());
}

function invalidatePreview() {
  lastPreview = null;
  elements.executeButton.disabled = true;
  elements.previewState.className = 'summary-badge';
  elements.previewState.textContent = '参数已变更';
}

function collectPayload() {
  return {
    tradeToken: elements.tradeToken.value.trim(),
    quoteToken: elements.quoteToken.value,
    price: elements.price.value.trim(),
    feePercent: elements.feePercent.value.trim(),
    tickSpacing: elements.tickSpacing.value.trim(),
    budget: selectedBudget === 'custom' ? elements.customBudget.value.trim() : selectedBudget,
    rangeType: selectedRange.type,
    rangePercent: selectedRange.percent || null,
    lowerPrice: selectedRange.type === 'custom' ? elements.lowerPrice.value.trim() : null,
    upperPrice: selectedRange.type === 'custom' ? elements.upperPrice.value.trim() : null,
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
    approving: ['正在处理授权', '正在完成 ERC20 与 Permit2 授权'],
    submitting: ['正在添加仓位', '仓位交易已发送或正在等待链上确认']
  };
  return progress[action?.stage] || ['正在执行', '正在读取最新链上状态'];
}

function renderPreview(plan) {
  const sourceLabel = '输入的初始价格';
  const walletReady = plan.wallet?.stableInputSufficient;
  const canExecute = plan.privateKeyConfigured
    && plan.autoAllocationConfigured
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
      <strong>新池 · 初始化预检通过</strong>
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

  elements.positionResult.className = 'preview-stack';
  elements.positionResult.innerHTML = `
    <dl class="preview-list">
      <div><dt>投入稳定币</dt><dd>${escapeHtml(plan.stableInputAmount)} ${escapeHtml(plan.quoteSymbol)}</dd></div>
      <div><dt>Tick 区间</dt><dd>${escapeHtml(plan.tickLower)} ～ ${escapeHtml(plan.tickUpper)}</dd></div>
      <div><dt>授权状态</dt><dd>${escapeHtml(approvalSummary(plan.approvals, plan.autoAllocation))}</dd></div>
      <div><dt>预计 NFT ID</dt><dd>${escapeHtml(plan.nextTokenId)}</dd></div>
    </dl>
    ${plan.autoAllocation ? `
      <div class="pool-state">
        <span>自动兑换</span>
        <strong>${plan.autoAllocation.required
          ? `${escapeHtml(plan.autoAllocation.stableToSwap)} ${escapeHtml(plan.quoteToken.symbol)} → 预计 ${escapeHtml(plan.autoAllocation.quotedTradeAmount)} ${escapeHtml(plan.tradeToken.symbol)}`
          : `无需兑换，全部使用 ${escapeHtml(plan.quoteToken.symbol)}`}</strong>
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
      </dl>
    ` : ''}
    ${!plan.autoAllocationConfigured ? '<div class="preview-warning">未配置 OKX DEX API 凭证，无法完成稳定币自动分配。</div>' : ''}
    ${!plan.executionEnabled ? '<div class="preview-warning">只读预检可用；执行前需在 .env 中设置 LIQUIDITY_EXECUTE=true 并重启服务。</div>' : ''}
  `;
  setStageBadge(elements.previewState, '预检完成', 'ready');
  setStageBadge(elements.poolStageState, '预检通过', 'ready');
  setStageBadge(elements.positionStageState, '仓位预览', 'ready');
  elements.executeButton.disabled = !canExecute;

  if (!plan.privateKeyConfigured) {
    elements.formMessage.textContent = '未配置 PRIVATE_KEY，当前只能预检。';
  } else if (!plan.autoAllocationConfigured) {
    elements.formMessage.textContent = '未配置 OKX DEX API 凭证，不能执行自动分配。';
  } else if (!walletReady) {
    elements.formMessage.textContent = `钱包 ${plan.quoteToken.symbol} 余额不足，不能执行。`;
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
  elements.positionResult.textContent = '预检未通过，不会执行兑换和添加仓位。';
  elements.actionControls.hidden = true;
  elements.formMessage.textContent = error.message;
}

function renderExecutionStarting(plan) {
  resetRenderKey(elements.poolResult);
  resetRenderKey(elements.positionResult);
  setStageBadge(elements.previewState, '执行中', 'loading');
  setStageBadge(elements.poolStageState, '创建中', 'loading');
  setStageBadge(elements.positionStageState, '等待池子', 'loading');
  elements.poolResult.className = 'preview-stack';
  elements.poolResult.innerHTML = `
    ${loadingMarkup('正在创建池子', '池子确认后会立即在这里显示 Pool ID')}
    <dl class="preview-list">
      <div><dt>预计 Pool ID</dt><dd>${escapeHtml(plan.poolId)}</dd></div>
      <div><dt>交易对</dt><dd>${escapeHtml(plan.token0.symbol)} / ${escapeHtml(plan.token1.symbol)}</dd></div>
    </dl>
  `;
  elements.positionResult.className = 'preview-stack';
  elements.positionResult.innerHTML = loadingMarkup(
    '等待池子创建完成',
    '之后将依次显示兑换、授权和添加仓位进度'
  );
  elements.actionControls.hidden = true;
}

function renderStoredAction(action, inFlight = false) {
  if (!action) {
    blockingAction = false;
    elements.actionControls.hidden = true;
    return;
  }
  const completed = action.stage === 'completed';
  const attention = action.stage === 'needs_attention';
  const failed = action.stage === 'failed';
  const cancelled = action.stage === 'cancelled';
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
      setStageBadge(elements.poolStageState, '未创建', failed || attention ? 'error' : '');
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
  if (elements.positionResult.dataset.renderKey !== positionRenderKey) {
    if (completed) {
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
  if (running) {
    elements.executeButton.disabled = true;
    elements.formMessage.textContent = '已有加池任务正在执行，请等待链上结果。';
  }
}

async function resolveStoredAction() {
  if (!window.confirm(
    '系统会先只读查询本次目标 Pool ID 的 NFT 仓位。'
    + '\n找到仓位会记录 NFT ID；没有仓位会保留钱包资产和已有授权，并解除新任务阻塞。'
    + '\n\n不会续跑、补发或撤销交易。是否继续？'
  )) return;
  elements.resolveActionButton.disabled = true;
  try {
    const action = await request('/api/liquidity/resolve', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    renderStoredAction(action, false);
    lastPreview = null;
    elements.executeButton.disabled = true;
    elements.formMessage.textContent = action.nftId
      ? `已检测到目标池 NFT #${action.nftId}，待确认状态已解除。`
      : '未检测到目标池 NFT，待确认状态已解除，可发起新任务。';
    showToast(action.nftId ? `已识别 NFT #${action.nftId}` : '未发现仓位，已安全放行');
  } catch (error) {
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
    showToast('初始化流动性执行完成');
    lastPreview = null;
  } catch (error) {
    if (error.data?.action) renderStoredAction(error.data.action, false);
    elements.formMessage.textContent = error.message;
    setStageBadge(elements.previewState, '执行失败', 'error');
    showToast(error.message, 'error');
  } finally {
    executionRequestPending = false;
    executionStartedAtMs = 0;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(pollStatus, 0);
    elements.executeButton.textContent = '确认并执行加池';
    elements.previewButton.disabled = false;
  }
}

function bindChoices() {
  document.querySelectorAll('[data-budget]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-budget]').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      selectedBudget = button.dataset.budget;
      refreshConditionalFields();
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
      refreshConditionalFields();
      invalidatePreview();
    });
  });
}

function bindInputs() {
  elements.form.addEventListener('submit', preview);
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

async function loadOptions() {
  try {
    options = await request('/api/liquidity/options');
    elements.quoteToken.innerHTML = options.stablecoins.map((item) => (
      `<option value="${escapeHtml(item.address)}">${escapeHtml(item.symbol)}</option>`
    )).join('');
    renderHookPresets();
    refreshQuote();

    if (!options.privateKeyConfigured) {
      elements.walletState.className = 'wallet-state blocked';
      elements.walletState.textContent = '未配置 PRIVATE_KEY · 仅预检';
    } else if (!options.autoAllocationConfigured) {
      elements.walletState.className = 'wallet-state blocked';
      elements.walletState.textContent = `${options.walletAddress} · 自动分配未配置`;
    } else if (!options.executionEnabled) {
      elements.walletState.className = 'wallet-state';
      elements.walletState.textContent = `${options.walletAddress} · 执行未开启`;
    } else {
      elements.walletState.className = 'wallet-state ready';
      elements.walletState.textContent = `${options.walletAddress} · 可执行`;
    }
    if (options.inFlight) {
      elements.walletState.className = 'wallet-state';
      elements.walletState.textContent = `${options.walletAddress || '服务端钱包'} · 加池执行中`;
    }
    renderStoredAction(options.lastAction, options.inFlight);
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
refreshConditionalFields();
loadOptions();
