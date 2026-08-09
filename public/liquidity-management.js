const API_ROOT = '/api/liquidity-management';
const TERMINAL_STAGES = new Set(['completed', 'failed', 'cancelled']);
const OPERATION_META = {
  increase: {
    label: '补仓',
    button: '继续补仓',
    description: '投入稳定币，自动 Zap In，并沿用该 NFT 的原 Tick 区间增加流动性。'
  },
  withdraw: {
    label: '撤出流动性',
    button: '全部撤出',
    description: '固定撤出 100% 流动性，代币与稳定币双币到账，不执行兑换。'
  },
  reduce: {
    label: '减仓',
    button: '继续减仓',
    description: '按比例撤出流动性，交易代币与稳定币双币到账，不执行兑换。'
  },
  emergency: {
    label: '紧急撤退',
    button: '紧急撤退',
    description: '固定撤出 100% 流动性，并把本次实际收到的代币全部 Zap Out 为稳定币。'
  }
};

const panel = document.querySelector('#liquidityManagePanel');
const createPanel = document.querySelector('#liquidityCreatePanel');
const tabButtons = [...document.querySelectorAll('[data-liquidity-tab]')];

const state = {
  options: null,
  position: null,
  operation: 'increase',
  budgetPreset: '10',
  busy: false,
  status: null,
  pollTimer: null,
  loaded: false
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortAddress(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function compactNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '—');
  if (number === 0) return '0';
  if (Math.abs(number) >= 1_000_000) return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  if (Math.abs(number) < 0.000001) return number.toExponential(3);
  return number.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function formatRaw(value, decimals) {
  if (value === null || value === undefined) return '—';
  try {
    const negative = BigInt(value) < 0n;
    const amount = negative ? -BigInt(value) : BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);
    return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
  } catch {
    return String(value);
  }
}

async function request(path, requestOptions = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
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

function setMessage(message, type = '') {
  const element = panel.querySelector('#lmMessage');
  if (!element) return;
  element.textContent = message || '';
  element.className = `lm-message${type ? ` ${type}` : ''}`;
}

function showToast(message, type = 'success') {
  const toast = document.querySelector('#liquidityToast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `liquidity-toast visible${type === 'error' ? ' error' : ''}`;
  window.setTimeout(() => {
    if (toast.textContent === message) toast.className = 'liquidity-toast';
  }, 3200);
}

function switchTab(name, updateHash = true) {
  const managing = name === 'manage';
  createPanel.hidden = managing;
  panel.hidden = !managing;
  for (const button of tabButtons) {
    const active = button.dataset.liquidityTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  if (updateHash) history.replaceState(null, '', managing ? '#manage' : '#create');
  if (managing && !state.loaded) loadManagement();
}

function renderShell() {
  panel.innerHTML = `
    <div class="lm-layout">
      <section class="liquidity-card lm-main-card">
        <div class="lm-section lm-position-search">
          <div class="section-label">
            <span>选择已有仓位</span>
            <small>仅允许管理当前执行钱包持有的 NFT</small>
          </div>
          <form id="lmPositionForm" class="lm-search-row">
            <label class="liquidity-field" for="lmNftId">
              <span>Uniswap v4 NFT ID</span>
              <input id="lmNftId" inputmode="numeric" autocomplete="off" placeholder="例如 12345">
            </label>
            <button id="lmLoadPosition" class="secondary-button" type="submit">读取仓位</button>
          </form>
          <div id="lmPositionCard" class="lm-position-empty">输入 NFT ID 后读取币对、区间和当前流动性。</div>
        </div>

        <div id="lmOperations" class="lm-section lm-operation-section">
          <div class="section-label">
            <span>仓位操作</span>
            <small>所有操作均沿用当前 NFT，不销毁空仓 NFT</small>
          </div>
          <div class="lm-operation-tabs" role="tablist" aria-label="仓位操作">
            ${Object.entries(OPERATION_META).map(([key, item]) => `
              <button type="button" class="lm-operation-tab${key === state.operation ? ' active' : ''}"
                data-lm-operation="${key}" role="tab" aria-selected="${key === state.operation}">
                ${item.label}
              </button>
            `).join('')}
          </div>
          <div id="lmOperationBody" class="lm-operation-body"></div>
          <div class="lm-action-row">
            <button id="lmActionButton" class="primary-button" type="button" disabled>继续补仓</button>
          </div>
          <p id="lmMessage" class="lm-message" aria-live="polite"></p>
        </div>
      </section>

      <aside class="lm-summary-column">
        <section class="liquidity-card lm-summary-card">
          <div class="summary-heading">
            <div>
              <span>操作摘要</span>
              <small>点击操作后自动核对链上状态</small>
            </div>
            <span id="lmSummaryBadge" class="summary-badge">待操作</span>
          </div>
          <div id="lmSummary" class="lm-summary-empty">
            读取仓位并选择操作后，这里会显示预计结果和链上执行状态。
          </div>
          <div id="lmRecovery" class="lm-recovery" hidden></div>
        </section>

        <section class="liquidity-card lm-rules-card">
          <strong>执行规则</strong>
          <ul>
            <li>补仓自动 Zap In，固定沿用 NFT 原 Tick 区间</li>
            <li>撤出流动性固定 100%，双币到账且不兑换</li>
            <li>减仓按比例撤出，交易代币与稳定币双币到账且不兑换</li>
            <li>紧急撤退固定 100%，本次代币 Zap Out 为稳定币</li>
            <li>撤出成功但兑换失败时，只允许重试兑换，不重复撤出</li>
          </ul>
        </section>
      </aside>
    </div>
  `;
}

function positionRange(position) {
  try {
    const tradeIsCurrency0 = !position.token0.isStablecoin;
    const tradeDecimals = tradeIsCurrency0 ? position.token0.decimals : position.token1.decimals;
    const stableDecimals = tradeIsCurrency0 ? position.token1.decimals : position.token0.decimals;
    const scale = 10 ** (tradeDecimals - stableDecimals);
    const priceAtTick = (tick) => {
      const raw = 1.0001 ** tick;
      return tradeIsCurrency0 ? raw * scale : scale / raw;
    };
    const prices = [priceAtTick(position.tickLower), priceAtTick(position.tickUpper)].sort((a, b) => a - b);
    return `${compactNumber(prices[0])} – ${compactNumber(prices[1])} ${position.stablecoin.symbol}`;
  } catch {
    return `Tick ${position.tickLower} – ${position.tickUpper}`;
  }
}

function renderPosition() {
  const element = panel.querySelector('#lmPositionCard');
  const position = state.position;
  if (!position) {
    element.className = 'lm-position-empty';
    element.textContent = '输入 NFT ID 后读取币对、区间和当前流动性。';
    return;
  }
  const value = position.valueInStablecoin
    ? `≈ ${compactNumber(position.valueInStablecoin.formatted, 4)} ${position.valueInStablecoin.symbol}`
    : '暂不支持估值';
  element.className = 'lm-position-card';
  element.innerHTML = `
    <div class="lm-position-heading">
      <div>
        <span>NFT #${escapeHtml(position.nftId)}</span>
        <strong>${escapeHtml(position.token0.symbol)} / ${escapeHtml(position.token1.symbol)}</strong>
      </div>
      <span class="lm-range-state ${position.inRange ? 'in-range' : 'out-range'}">
        ${position.inRange ? '区间内' : '区间外'}
      </span>
    </div>
    <div class="lm-position-total">
      <span>仓位总计</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
    <div class="lm-token-grid">
      <div>
        <span>${escapeHtml(position.token0.symbol)}${position.token0.isStablecoin ? ' · 稳定币' : ''}</span>
        <strong>${escapeHtml(compactNumber(position.token0.amount))}</strong>
      </div>
      <div>
        <span>${escapeHtml(position.token1.symbol)}${position.token1.isStablecoin ? ' · 稳定币' : ''}</span>
        <strong>${escapeHtml(compactNumber(position.token1.amount))}</strong>
      </div>
    </div>
    <dl class="lm-position-facts">
      <div><dt>价格区间</dt><dd>${escapeHtml(positionRange(position))}</dd></div>
      <div><dt>当前价格</dt><dd>${escapeHtml(compactNumber(position.activePrice))} ${escapeHtml(position.stablecoin?.symbol || '')}</dd></div>
      <div><dt>Tick</dt><dd>${position.tickLower} / ${position.currentTick} / ${position.tickUpper}</dd></div>
      <div><dt>流动性</dt><dd>${escapeHtml(position.liquidity)}</dd></div>
      <div><dt>Pool ID</dt><dd title="${escapeHtml(position.poolId)}">${escapeHtml(shortAddress(position.poolId))}</dd></div>
    </dl>
    ${position.hooksWarning ? `<div class="lm-hook-warning">${escapeHtml(position.hooksWarning)}</div>` : ''}
    ${position.unsupportedReason ? `<div class="preview-error">${escapeHtml(position.unsupportedReason)}</div>` : ''}
  `;
}

function currentBudget() {
  return state.budgetPreset === 'custom'
    ? panel.querySelector('#lmCustomBudget')?.value.trim() || ''
    : state.budgetPreset;
}

function operationBodyMarkup() {
  const operation = state.operation;
  const meta = OPERATION_META[operation];
  if (operation === 'increase') {
    return `
      <p class="lm-operation-description">${meta.description}</p>
      <div class="lm-budget-options" role="group" aria-label="补仓金额">
        ${['10', '20', '50'].map((value) => `
          <button type="button" class="choice${state.budgetPreset === value ? ' active' : ''}"
            data-lm-budget="${value}">${value}U</button>
        `).join('')}
        <button type="button" class="choice${state.budgetPreset === 'custom' ? ' active' : ''}"
          data-lm-budget="custom">自定义</button>
      </div>
      <label class="liquidity-field lm-custom-budget${state.budgetPreset === 'custom' ? ' visible' : ''}" for="lmCustomBudget">
        <span>自定义稳定币投入</span>
        <div class="field-with-unit">
          <input id="lmCustomBudget" type="number" min="0" step="any" inputmode="decimal"
            placeholder="输入金额">
          <span>${escapeHtml(state.position?.stablecoin?.symbol || 'U')}</span>
        </div>
      </label>
      <div class="lm-inline-note">自动兑换所需代币后添加到原 NFT；不会创建新仓位或修改 Tick 区间。</div>
    `;
  }
  if (operation === 'reduce') {
    return `
      <p class="lm-operation-description">${meta.description}</p>
      <div class="lm-reduce-heading">
        <label for="lmReducePercent">减仓比例</label>
        <strong><span id="lmReduceValue">25</span>%</strong>
      </div>
      <input id="lmReducePercent" class="lm-range-input" type="range" min="1" max="99" step="1" value="25">
      <div class="lm-percent-options">
        ${[10, 25, 50, 75].map((value) => `<button type="button" data-lm-percent="${value}">${value}%</button>`).join('')}
      </div>
      <div class="lm-inline-note">本次按比例撤出的交易代币与稳定币会直接进入执行钱包，不触发 Zap。</div>
    `;
  }
  const warning = operation === 'emergency'
    ? '<div class="lm-danger-note">此操作会清空 NFT 流动性，并兑换本次撤出的全部交易代币。</div>'
    : '<div class="lm-inline-note">不选择比例：固定撤出全部流动性，双币直接进入执行钱包。</div>';
  return `<p class="lm-operation-description">${meta.description}</p>${warning}`;
}

function operationRequiresSwap() {
  return ['increase', 'emergency'].includes(state.operation);
}

function actionDisabledReason() {
  if (state.busy) return '正在处理';
  if (!state.position) return '请先读取仓位';
  if (!state.position.supported) return state.position.unsupportedReason || '当前仓位不受支持';
  if (!state.options?.privateKeyConfigured) return '服务端缺少 PRIVATE_KEY';
  if (!state.options?.executionEnabled) return 'LIQUIDITY_EXECUTE 尚未开启';
  if (operationRequiresSwap() && !state.options?.autoSwapConfigured) return '自动 Zap 缺少 OKX API 配置';
  if (state.status?.inFlight) return '已有仓位管理任务正在执行';
  if (state.status?.lastAction?.stage === 'needs_attention') return '请先处理上一次未完成任务';
  if (state.operation === 'increase') {
    const budget = Number(currentBudget());
    if (!Number.isFinite(budget) || budget <= 0) return '请输入有效补仓金额';
    if (budget > Number(state.options.maxStableBudget)) return `补仓上限为 ${state.options.maxStableBudget} U`;
  } else if (state.position.liquidity === '0') {
    return '当前 NFT 没有可撤出的流动性';
  }
  return null;
}

function refreshOperation() {
  const body = panel.querySelector('#lmOperationBody');
  body.innerHTML = operationBodyMarkup();
  for (const button of panel.querySelectorAll('[data-lm-budget]')) {
    button.addEventListener('click', () => {
      state.budgetPreset = button.dataset.lmBudget;
      refreshOperation();
    });
  }
  const customBudget = panel.querySelector('#lmCustomBudget');
  customBudget?.addEventListener('input', refreshActionButton);
  const range = panel.querySelector('#lmReducePercent');
  range?.addEventListener('input', () => {
    panel.querySelector('#lmReduceValue').textContent = range.value;
  });
  for (const button of panel.querySelectorAll('[data-lm-percent]')) {
    button.addEventListener('click', () => {
      range.value = button.dataset.lmPercent;
      panel.querySelector('#lmReduceValue').textContent = range.value;
    });
  }
  refreshActionButton();
}

function refreshActionButton() {
  const button = panel.querySelector('#lmActionButton');
  if (!button) return;
  const reason = actionDisabledReason();
  button.disabled = Boolean(reason);
  button.textContent = state.busy ? '正在核对链上状态…' : OPERATION_META[state.operation].button;
  button.title = reason || '';
}

function collectPayload() {
  const nftId = panel.querySelector('#lmNftId').value.trim();
  const payload = { operation: state.operation, nftId };
  if (state.operation === 'increase') payload.budget = currentBudget();
  if (state.operation === 'reduce') payload.percent = panel.querySelector('#lmReducePercent').value;
  return payload;
}

function planRows(plan) {
  if (plan.operation === 'increase') {
    return [
      ['稳定币投入', `${compactNumber(plan.stableInput)} ${plan.position.stablecoin.symbol}`],
      ['自动兑换', `${compactNumber(plan.stableToSwap)} ${plan.position.stablecoin.symbol} → ≈ ${compactNumber(plan.quotedTradeAmount)} ${plan.position.tradeToken.symbol}`],
      ['预计加入', `${compactNumber(plan.expectedAmount0)} ${plan.position.token0.symbol} + ${compactNumber(plan.expectedAmount1)} ${plan.position.token1.symbol}`],
      ['Tick 区间', `${plan.position.tickLower} ～ ${plan.position.tickUpper}`],
      ['预计新增流动性', plan.liquidityDelta]
    ];
  }
  const rows = [
    ['撤出比例', `${plan.percent}%`],
    ['预计双币到账', `${compactNumber(plan.expectedAmount0)} ${plan.position.token0.symbol} + ${compactNumber(plan.expectedAmount1)} ${plan.position.token1.symbol}`],
    ['最小到账保护', `${compactNumber(plan.minimumAmount0)} ${plan.position.token0.symbol} + ${compactNumber(plan.minimumAmount1)} ${plan.position.token1.symbol}`],
    ['预计剩余流动性', plan.remainingLiquidity]
  ];
  if (plan.operation === 'emergency') {
    rows.push(
      ['预计兑换代币', `${compactNumber(plan.expectedTradeToSwap)} ${plan.position.tradeToken.symbol}`],
      ['预计兑换得稳定币', `≈ ${compactNumber(plan.quotedStableFromSwap)} ${plan.position.stablecoin.symbol}`]
    );
  } else {
    rows.push(['到账方式', '交易代币 + 稳定币，双币到账且不兑换']);
  }
  return rows;
}

function renderPlan(plan) {
  const summary = panel.querySelector('#lmSummary');
  const badge = panel.querySelector('#lmSummaryBadge');
  const settlementNotice = ['increase', 'emergency'].includes(plan.operation)
    ? '预计值用于确认操作范围；兑换按链上实际成交数量结算，撤出结果包含本次领取的手续费。'
    : '预计值用于确认操作范围；撤出按链上实际到账数量结算，双币直接到账且不兑换。';
  badge.className = 'summary-badge ready';
  badge.textContent = '等待确认';
  summary.className = 'lm-summary-content';
  summary.innerHTML = `
    <div class="lm-summary-title">
      <span>${escapeHtml(OPERATION_META[plan.operation].label)}</span>
      <strong>NFT #${escapeHtml(plan.position.nftId)}</strong>
    </div>
    <dl class="lm-summary-list">
      ${planRows(plan).map(([label, value]) => `
        <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>
      `).join('')}
    </dl>
    <div class="lm-summary-notice">${settlementNotice}</div>
    ${plan.position.hooksWarning ? `<div class="lm-hook-warning">${escapeHtml(plan.position.hooksWarning)}</div>` : ''}
  `;
}

function confirmationText(plan) {
  const lines = [
    `${OPERATION_META[plan.operation].label} · NFT #${plan.position.nftId}`,
    '',
    ...planRows(plan).map(([label, value]) => `${label}：${value}`),
    '',
    '链上执行后无法撤销。预计数量会随价格、手续费和实际成交变化。'
  ];
  if (plan.operation === 'withdraw') lines.push('本次固定撤出 100%，双币到账，不执行兑换。');
  if (plan.operation === 'reduce') lines.push('本次按所选比例减仓，双币到账，不执行兑换。');
  if (plan.operation === 'emergency') lines.push('本次固定撤出 100%，交易代币将自动兑换为稳定币。');
  if (plan.position.hooksWarning) lines.push(`\n风险提示：${plan.position.hooksWarning}`);
  return lines.join('\n');
}

function stageLabel(stage) {
  return ({
    preparing: '准备执行',
    preparing_zap_in: '准备 Zap In',
    zap_in_swap: 'Zap In 兑换中',
    approving_position: '仓位授权中',
    increasing: '补仓执行中',
    withdrawing: '撤出执行中',
    withdraw_confirmed: '撤出已确认',
    zap_out_swap: 'Zap Out 兑换中',
    zap_out_swap_retry: '重试兑换中',
    cleaning_swap_approval: '清理兑换授权中',
    completed: '已完成',
    needs_attention: '需要处理',
    failed: '执行失败',
    cancelled: '已取消'
  })[stage] || stage || '待操作';
}

function transactionMarkup(action) {
  const transactions = [...(action.transactions || [])];
  if (action.currentTx?.hash && !transactions.some((item) => item.hash === action.currentTx.hash)) {
    transactions.push(action.currentTx);
  }
  if (!transactions.length) return '';
  return `
    <div class="lm-transaction-list">
      ${transactions.map((transaction) => `
        <a href="https://bscscan.com/tx/${encodeURIComponent(transaction.hash)}" target="_blank" rel="noreferrer">
          <span>${escapeHtml(transaction.kind.replaceAll('_', ' '))}</span>
          <strong>${escapeHtml(shortAddress(transaction.hash))}</strong>
          <small>${escapeHtml(transaction.status || 'pending')}</small>
        </a>
      `).join('')}
    </div>
  `;
}

function actionResultRows(action) {
  const rows = [];
  if (action.finalLiquidity !== undefined) rows.push(['最终流动性', action.finalLiquidity]);
  if (action.actualLiquidityDelta) rows.push(['实际新增流动性', action.actualLiquidityDelta]);
  if (action.receivedAmounts) {
    for (const token of [action.token0, action.token1]) {
      const raw = action.receivedAmounts[token.address];
      if (raw !== undefined) rows.push([`${token.symbol} 实际到账`, formatRaw(raw, token.decimals)]);
    }
  }
  if (action.finalStableReceived !== undefined) {
    rows.push([`${action.stablecoin.symbol} 合计到账`, formatRaw(action.finalStableReceived, action.stablecoin.decimals)]);
  }
  return rows;
}

function renderAction(action, inFlight = false) {
  if (!action) return;
  const badge = panel.querySelector('#lmSummaryBadge');
  const summary = panel.querySelector('#lmSummary');
  const stage = action.stage;
  const badgeState = stage === 'completed' ? 'success' : stage === 'failed' || stage === 'needs_attention' ? 'danger' : 'ready';
  badge.className = `summary-badge ${badgeState}`;
  badge.textContent = stageLabel(stage);
  const results = actionResultRows(action);
  summary.className = 'lm-summary-content';
  summary.innerHTML = `
    <div class="lm-summary-title">
      <span>${escapeHtml(OPERATION_META[action.operation]?.label || action.operation)}</span>
      <strong>NFT #${escapeHtml(action.nftId)}</strong>
    </div>
    <div class="lm-stage-line${inFlight ? ' running' : ''}">
      <span></span>
      <div><strong>${escapeHtml(stageLabel(stage))}</strong><small>${inFlight ? '链上任务执行中，请勿重复提交' : escapeHtml(action.completedAt || action.failedAt || '')}</small></div>
    </div>
    ${results.length ? `<dl class="lm-summary-list">${results.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
    ${transactionMarkup(action)}
    ${action.error ? `<div class="preview-error">${escapeHtml(action.error)}</div>` : ''}
    ${action.cleanupWarning ? `<div class="lm-hook-warning">${escapeHtml(action.cleanupWarning)}</div>` : ''}
  `;
  renderRecovery(action);
}

function renderRecovery(action) {
  const recovery = panel.querySelector('#lmRecovery');
  recovery.hidden = true;
  recovery.innerHTML = '';
  if (action?.stage !== 'needs_attention') return;
  if (action.currentTx?.hash) {
    recovery.hidden = false;
    const label = action.cleanupContext ? '核对授权清理交易' : '核对链上交易';
    recovery.innerHTML = `<button id="lmResolveButton" class="secondary-button" type="button">${label}</button>`;
    recovery.querySelector('button').addEventListener('click', resolveTransaction);
  } else if (action.cleanupContext) {
    recovery.hidden = false;
    recovery.innerHTML = '<button id="lmCleanupButton" class="secondary-button" type="button">重新清理 OKX 授权</button>';
    recovery.querySelector('button').addEventListener('click', retryCleanup);
  } else if (action.pendingSwap) {
    recovery.hidden = false;
    recovery.innerHTML = '<button id="lmRetryButton" class="primary-button" type="button">仅重试稳定币兑换</button>';
    recovery.querySelector('button').addEventListener('click', retrySwap);
  }
}

async function loadPosition(event) {
  event?.preventDefault();
  const nftId = panel.querySelector('#lmNftId').value.trim();
  if (!/^\d+$/.test(nftId)) {
    setMessage('NFT ID 必须是数字', 'error');
    return;
  }
  const button = panel.querySelector('#lmLoadPosition');
  button.disabled = true;
  button.textContent = '读取中…';
  setMessage('正在读取 NFT 与池子状态…');
  try {
    state.position = await request('/position', {
      method: 'POST',
      body: JSON.stringify({ nftId })
    });
    renderPosition();
    refreshOperation();
    setMessage(`已读取 NFT #${nftId}`, 'success');
  } catch (error) {
    state.position = null;
    renderPosition();
    refreshActionButton();
    setMessage(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '读取仓位';
  }
}

async function executeOperation() {
  const reason = actionDisabledReason();
  if (reason) {
    setMessage(reason, 'error');
    return;
  }
  state.busy = true;
  refreshActionButton();
  setMessage('正在自动核对仓位、余额、价格和预计结果…');
  const payload = collectPayload();
  try {
    const plan = await request('/prepare', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    renderPlan(plan);
    if (!window.confirm(confirmationText(plan))) {
      setMessage('已取消，未发送任何链上交易');
      return;
    }
    setMessage('已确认，正在执行链上操作…');
    startStatusPolling();
    const action = await request('/execute', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        authorizationId: plan.authorizationId,
        confirmed: true,
        acknowledgeHooks: true
      })
    });
    state.status = { inFlight: false, lastAction: action };
    renderAction(action, false);
    setMessage(`${OPERATION_META[payload.operation].label}已完成`, 'success');
    showToast(`${OPERATION_META[payload.operation].label}已完成`);
    await loadPosition();
  } catch (error) {
    const action = error.data?.action;
    if (action) {
      state.status = { inFlight: false, lastAction: action };
      renderAction(action, false);
    }
    setMessage(error.message, 'error');
    showToast(error.message, 'error');
  } finally {
    state.busy = false;
    refreshActionButton();
    await refreshStatus().catch(() => {});
  }
}

async function retrySwap() {
  if (!window.confirm('只重试待处理的代币 → 稳定币兑换，不会再次撤出流动性。确认继续？')) return;
  state.busy = true;
  refreshActionButton();
  setMessage('正在重试稳定币兑换…');
  try {
    const action = await request('/retry-swap', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    state.status = { inFlight: false, lastAction: action };
    renderAction(action, false);
    setMessage('待处理兑换已完成', 'success');
  } catch (error) {
    if (error.data?.action) renderAction(error.data.action, false);
    setMessage(error.message, 'error');
  } finally {
    state.busy = false;
    refreshActionButton();
  }
}

async function retryCleanup() {
  if (!window.confirm('只重试清理本次 OKX 代币授权，不会重新兑换或撤出流动性。确认继续？')) return;
  state.busy = true;
  refreshActionButton();
  setMessage('正在清理 OKX 授权…');
  try {
    const action = await request('/retry-cleanup', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    state.status = { inFlight: false, lastAction: action };
    renderAction(action, false);
    setMessage(action.stage === 'completed' ? '授权清理及仓位任务已完成' : '授权已清理，请核对任务结果', 'success');
  } catch (error) {
    if (error.data?.action) renderAction(error.data.action, false);
    setMessage(error.message, 'error');
  } finally {
    state.busy = false;
    refreshActionButton();
    await refreshStatus().catch(() => {});
  }
}

async function resolveTransaction() {
  if (!window.confirm('将读取链上回执并核对任务状态，不会重新发送交易。确认继续？')) return;
  state.busy = true;
  refreshActionButton();
  try {
    const action = await request('/resolve', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    state.status = { inFlight: false, lastAction: action };
    renderAction(action, false);
    setMessage('链上状态已核对', 'success');
  } catch (error) {
    if (error.data?.action) renderAction(error.data.action, false);
    setMessage(error.message, 'error');
  } finally {
    state.busy = false;
    refreshActionButton();
  }
}

async function refreshStatus() {
  const status = await request('/status');
  state.status = status;
  if (status.lastAction) renderAction(status.lastAction, status.inFlight);
  refreshActionButton();
  if (status.inFlight || (status.lastAction && !TERMINAL_STAGES.has(status.lastAction.stage))) {
    startStatusPolling();
  } else {
    stopStatusPolling();
  }
}

function startStatusPolling() {
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(() => refreshStatus().catch(() => {}), 1800);
}

function stopStatusPolling() {
  if (!state.pollTimer) return;
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function bindEvents() {
  panel.querySelector('#lmPositionForm').addEventListener('submit', loadPosition);
  panel.querySelector('#lmActionButton').addEventListener('click', executeOperation);
  for (const button of panel.querySelectorAll('[data-lm-operation]')) {
    button.addEventListener('click', () => {
      state.operation = button.dataset.lmOperation;
      for (const item of panel.querySelectorAll('[data-lm-operation]')) {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      }
      refreshOperation();
      setMessage('');
    });
  }
}

async function loadManagement() {
  state.loaded = true;
  setMessage('正在读取仓位管理执行环境…');
  try {
    state.options = await request('/options');
    state.status = {
      inFlight: state.options.inFlight,
      lastAction: state.options.lastAction
    };
    if (state.options.lastAction) renderAction(state.options.lastAction, state.options.inFlight);
    refreshActionButton();
    const issues = [];
    if (!state.options.privateKeyConfigured) issues.push('缺少 PRIVATE_KEY');
    if (!state.options.executionEnabled) issues.push('LIQUIDITY_EXECUTE=false');
    setMessage(issues.length ? `当前只可查看：${issues.join('；')}` : '执行环境已就绪');
    if (state.options.inFlight) startStatusPolling();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

renderShell();
bindEvents();
renderPosition();
refreshOperation();

for (const button of tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.liquidityTab));
}

switchTab(location.hash === '#manage' ? 'manage' : 'create', false);
