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
  hooksAcknowledge: document.querySelector('#hooksAcknowledge'),
  acknowledgeCustomHooks: document.querySelector('#acknowledgeCustomHooks'),
  previewButton: document.querySelector('#previewButton'),
  executeButton: document.querySelector('#executeButton'),
  previewState: document.querySelector('#previewState'),
  previewResult: document.querySelector('#previewResult'),
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

function renderPreview(plan) {
  const poolLabel = '新池 · 初始化预检通过';
  const sourceLabel = '输入的初始价格';
  const walletReady = plan.wallet?.stableInputSufficient;
  const canExecute = plan.privateKeyConfigured
    && plan.autoAllocationConfigured
    && plan.executionEnabled
    && walletReady
    && !blockingAction
    && (!plan.hooksWarning || elements.acknowledgeCustomHooks.checked);

  elements.previewResult.className = 'preview-stack';
  elements.previewResult.innerHTML = `
    <div class="pool-state">
      <span>池状态</span>
      <strong>${escapeHtml(poolLabel)}</strong>
    </div>
    <dl class="preview-list">
      <div><dt>投入稳定币</dt><dd>${escapeHtml(plan.stableInputAmount)} ${escapeHtml(plan.quoteSymbol)}</dd></div>
      <div><dt>生效价格</dt><dd>${escapeHtml(plan.activePrice)} ${escapeHtml(plan.quoteSymbol)} · ${sourceLabel}</dd></div>
      <div><dt>费率 / Spacing</dt><dd>${escapeHtml(plan.feePercent)}% / ${escapeHtml(plan.poolKey.tickSpacing)}</dd></div>
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
    ${plan.hooksWarning ? `<div class="preview-warning">${escapeHtml(plan.hooksWarning)}</div>` : ''}
    ${!plan.autoAllocationConfigured ? '<div class="preview-warning">未配置 OKX DEX API 凭证，无法完成稳定币自动分配。</div>' : ''}
    ${!plan.executionEnabled ? '<div class="preview-warning">只读预检可用；执行前需在 .env 中设置 LIQUIDITY_EXECUTE=true 并重启服务。</div>' : ''}
  `;
  elements.previewState.className = 'summary-badge ready';
  elements.previewState.textContent = '预检完成';
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
  elements.previewState.className = 'summary-badge error';
  elements.previewState.textContent = '预检失败';
  elements.previewResult.className = 'preview-error';
  elements.previewResult.textContent = error.message;
  elements.formMessage.textContent = error.message;
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
  const createdPoolId = action.poolInitializeTxHash
    ? (action.poolId || action.plan?.poolId)
    : null;
  blockingAction = attention;
  elements.previewState.className = `summary-badge${completed ? ' ready' : (attention || failed ? ' error' : '')}`;
  elements.previewState.textContent = completed
    ? '上次执行完成'
    : (attention
      ? '需要人工核对'
      : (failed ? '上次执行失败' : (cancelled ? '上次任务已结束' : '链上执行中')));
  elements.previewResult.className = attention || failed ? 'preview-error' : 'execution-result';
  elements.previewResult.innerHTML = `
    ${completed ? `<strong>NFT ID ${escapeHtml(action.nftId || '未从回执识别')}</strong>` : ''}
    <p>状态：${escapeHtml(action.stage || '—')}</p>
    ${createdPoolId ? `<p>已创建 Pool ID：${escapeHtml(createdPoolId)}</p>` : ''}
    ${action.poolInitializeTxHash ? `<p>建池交易：${escapeHtml(action.poolInitializeTxHash)}</p>` : ''}
    ${action.autoSwap?.status === 'confirmed' ? `<p>自动兑换：${escapeHtml(action.autoSwap.stableSpent)} ${escapeHtml(action.autoSwap.quoteSymbol)} → ${escapeHtml(action.autoSwap.tradeReceived)} ${escapeHtml(action.autoSwap.tradeSymbol)}</p>` : ''}
    ${action.autoSwap?.hash ? `<p>兑换交易：${escapeHtml(action.autoSwap.hash)}</p>` : ''}
    ${action.liquidityTxHash ? `<p>加池交易：${escapeHtml(action.liquidityTxHash)}</p>` : ''}
    ${action.currentTx?.hash ? `<p>待核对交易：${escapeHtml(action.currentTx.hash)}</p>` : ''}
    ${action.error ? `<p>${escapeHtml(action.error)}</p>` : ''}
    ${action.resolution ? `<p>${escapeHtml(action.resolution)}</p>` : ''}
  `;
  const canResolve = attention
    && !action.currentTx?.hash
    && !action.liquidityTxHash;
  elements.actionControls.hidden = !canResolve || inFlight;
  elements.resolveActionButton.disabled = inFlight;
  if (inFlight) {
    elements.executeButton.disabled = true;
    elements.formMessage.textContent = '已有加池任务正在执行，请等待链上结果。';
  }
}

async function resolveStoredAction() {
  if (!window.confirm(
    '结束后会保留钱包中的已兑换资产和已有链上授权，只解除本页面的新任务阻塞。'
    + '\n\n此操作不会撤销交易或退回兑换。是否结束本次任务？'
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
    elements.formMessage.textContent = '本次任务已结束；重新填写并预检后可发起新任务。';
    showToast('待处理任务已安全结束');
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
    renderStoredAction(status.lastAction, status.inFlight);
    if (status.inFlight) statusTimer = setTimeout(pollStatus, 1800);
  } catch {
    statusTimer = setTimeout(pollStatus, 3000);
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
  elements.executeButton.disabled = true;
  elements.executeButton.textContent = '链上执行中…';
  elements.previewButton.disabled = true;
  elements.formMessage.textContent = '正在处理授权并发送加池交易，请勿重复操作。';
  try {
    const action = await request('/api/liquidity/execute', {
      method: 'POST',
      body: JSON.stringify({
        ...collectPayload(),
        previewId: lastPreview.previewId,
        confirmed: true
      })
    });
    elements.previewState.className = 'summary-badge ready';
    elements.previewState.textContent = '执行完成';
    elements.previewResult.className = 'execution-result';
    elements.previewResult.innerHTML = `
      <strong>NFT ID ${escapeHtml(action.nftId || '未从回执识别')}</strong>
      <p>状态：${escapeHtml(action.stage)}</p>
      <p>Pool ID：${escapeHtml(action.poolId || action.plan?.poolId || '—')}</p>
      <p>建池交易：${escapeHtml(action.poolInitializeTxHash || '—')}</p>
      ${action.autoSwap?.status === 'confirmed' ? `<p>自动兑换：${escapeHtml(action.autoSwap.stableSpent)} ${escapeHtml(action.autoSwap.quoteSymbol)} → ${escapeHtml(action.autoSwap.tradeReceived)} ${escapeHtml(action.autoSwap.tradeSymbol)}</p>` : ''}
      <p>加池交易：${escapeHtml(action.liquidityTxHash || '—')}</p>
      <p>本次共确认 ${escapeHtml(action.transactions?.length || 0)} 笔链上交易。</p>
    `;
    elements.formMessage.textContent = '';
    showToast('初始化流动性执行完成');
    lastPreview = null;
  } catch (error) {
    if (error.data?.action) renderStoredAction(error.data.action, false);
    elements.formMessage.textContent = error.message;
    elements.previewState.className = 'summary-badge error';
    elements.previewState.textContent = '执行失败';
    showToast(error.message, 'error');
  } finally {
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
