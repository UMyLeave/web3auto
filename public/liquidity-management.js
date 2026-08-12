const API_ROOT = '/api/liquidity-management';
const POSITION_POLL_INTERVAL_MS = 1500;
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
const createModal = document.querySelector('#liquidityCreateModal');

const state = {
  options: null,
  positions: [],
  position: null,
  selectedNftId: null,
  operation: 'increase',
  budgetPreset: '10',
  busy: false,
  modalOpen: false,
  recordsOpen: false,
  confirmResolver: null,
  status: null,
  actionHistory: [],
  pollTimer: null,
  positionPollTimer: null,
  positionPollInFlight: false,
  positionPollStopped: false,
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

function precisePrice(value, significantDigits = 9) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '—');
  if (number === 0) return '0';
  const absolute = Math.abs(number);
  if (absolute >= 1) {
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 8 });
  }
  if (absolute < 1e-18) return number.toExponential(8);
  const leadingZeros = Math.max(0, Math.floor(-Math.log10(absolute)) - 1);
  return number.toFixed(Math.min(18, leadingZeros + significantDigits))
    .replace(/0+$/, '')
    .replace(/\.$/, '');
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
    error.status = response.status;
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

function openCreateModal() {
  if (!createModal) return;
  createModal.hidden = false;
  panel.querySelector('#lmOpenCreateButton')?.setAttribute('aria-expanded', 'true');
  syncModalState();
  window.dispatchEvent(new CustomEvent('liquidity:open-create'));
  window.setTimeout(() => createModal.querySelector('#tradeToken')?.focus(), 0);
}

function closeCreateModal() {
  if (!createModal) return;
  // The form remains mounted, and the form snapshot restores inputs on the next
  // open. Failed execution is never auto-closed.
  createModal.hidden = true;
  panel.querySelector('#lmOpenCreateButton')?.setAttribute('aria-expanded', 'false');
  syncModalState();
}

function renderShell() {
  panel.innerHTML = `
    <div class="lm-workspace">
      <div class="lm-management-toolbar">
        <div class="lm-toolbar-actions">
          <button id="lmClearInvalidButton" class="secondary-button" type="button" hidden>
            清空无效策略
          </button>
          <button id="lmOpenCreateButton" class="primary-button" type="button"
            aria-controls="liquidityCreateModal" aria-haspopup="dialog" aria-expanded="false">
            <span aria-hidden="true">＋</span> 初始化流动性
          </button>
        </div>
      </div>

      <div class="lm-poll-status" aria-live="polite">
        <i></i><span id="lmPollStatusText">正在发现当前钱包策略…</span>
      </div>
      <div id="lmPositionCard" class="lm-position-list">
        <div class="lm-position-empty">正在读取当前钱包的策略仓位…</div>
      </div>
      <p id="lmMessage" class="lm-message" aria-live="polite"></p>

    </div>

    <div id="lmOperationModal" class="lm-modal" role="dialog" aria-modal="true"
      aria-labelledby="lmModalTitle" hidden>
      <div class="lm-modal-backdrop" data-lm-close-operation></div>
      <section class="lm-modal-card">
        <header class="lm-modal-heading">
          <div>
            <span>仓位操作</span>
            <strong id="lmModalTitle">补仓</strong>
          </div>
          <button id="lmModalClose" type="button" aria-label="关闭操作窗口">×</button>
        </header>
        <div id="lmOperationBody" class="lm-operation-body"></div>
        <div id="lmModalSummary" class="lm-modal-summary" hidden></div>
        <div class="lm-action-row">
          <button id="lmActionButton" class="primary-button" type="button" disabled>继续补仓</button>
        </div>
      </section>
    </div>

    <div id="lmRecordsModal" class="lm-modal" role="dialog" aria-modal="true"
      aria-labelledby="lmRecordsTitle" hidden>
      <div class="lm-modal-backdrop" data-lm-close-records></div>
      <section class="lm-modal-card lm-records-card">
        <header class="lm-modal-heading">
          <div>
            <span>策略仓位</span>
            <strong id="lmRecordsTitle">操作记录</strong>
          </div>
          <button id="lmRecordsClose" type="button" aria-label="关闭操作记录">×</button>
        </header>
        <div id="lmRecordsBody" class="lm-records-body"></div>
      </section>
    </div>

    <div id="lmConfirmModal" class="lm-modal lm-confirm-modal" role="alertdialog" aria-modal="true"
      aria-labelledby="lmConfirmTitle" aria-describedby="lmConfirmMessage" hidden>
      <div class="lm-modal-backdrop" data-lm-cancel-confirm></div>
      <section class="lm-modal-card lm-confirm-card">
        <header class="lm-modal-heading">
          <div>
            <span>请确认</span>
            <strong id="lmConfirmTitle">确认操作</strong>
          </div>
        </header>
        <p id="lmConfirmMessage" class="lm-confirm-message"></p>
        <div class="lm-confirm-actions">
          <button id="lmConfirmCancel" class="secondary-button" type="button">取消</button>
          <button id="lmConfirmAccept" class="primary-button" type="button">确认</button>
        </div>
      </section>
    </div>
  `;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function tokenValueShare(position) {
  const price = Number(position.activePrice);
  const amount0 = Number(position.token0.amount);
  const amount1 = Number(position.token1.amount);
  if (![price, amount0, amount1].every(Number.isFinite) || price <= 0) return 50;
  const value0 = position.token0.isStablecoin ? amount0 : amount0 * price;
  const value1 = position.token1.isStablecoin ? amount1 : amount1 * price;
  const total = value0 + value1;
  return total > 0 ? clampPercent(value0 * 100 / total) : 50;
}

function fallbackPriceRange(position) {
  const lowerTick = Number(position.tickLower);
  const upperTick = Number(position.tickUpper);
  const currentTick = Number(position.currentTick);
  const spacing = Math.abs(Number(position.poolKey?.tickSpacing));
  const currentPrice = Number(position.activePrice);
  const tradeIsCurrency0 = !position.token0?.isStablecoin;
  const tradeDecimals = Number((tradeIsCurrency0 ? position.token0 : position.token1)?.decimals);
  const stableDecimals = Number((tradeIsCurrency0 ? position.token1 : position.token0)?.decimals);
  if (![lowerTick, upperTick, currentTick, spacing, currentPrice, tradeDecimals, stableDecimals]
    .every(Number.isFinite)
    || spacing <= 0 || currentPrice <= 0 || upperTick <= lowerTick
    || !position.stablecoin || !position.tradeToken) {
    return null;
  }
  const scale = 10 ** (tradeDecimals - stableDecimals);
  const priceAtTick = (tick) => {
    const rawPrice = 1.0001 ** tick;
    return tradeIsCurrency0 ? rawPrice * scale : scale / rawPrice;
  };
  const prices = [priceAtTick(lowerTick), priceAtTick(upperTick)].sort((left, right) => left - right);
  if (!prices.every((price) => Number.isFinite(price) && price > 0)) return null;
  const gridCount = Math.max(1, Math.round((upperTick - lowerTick) / spacing));
  const rawGrid = tradeIsCurrency0
    ? Math.floor((currentTick - lowerTick) / spacing)
    : Math.floor((upperTick - currentTick) / spacing);
  const rawPosition = tradeIsCurrency0
    ? (currentTick - lowerTick) / (upperTick - lowerTick)
    : (upperTick - currentTick) / (upperTick - lowerTick);
  const rangeState = currentPrice < prices[0]
    ? 'below'
    : currentPrice > prices[1] ? 'above' : 'inside';
  const distancePercent = rangeState === 'below'
    ? (prices[0] - currentPrice) * 100 / currentPrice
    : rangeState === 'above'
      ? (currentPrice - prices[1]) * 100 / currentPrice
      : 0;
  return {
    lowerPrice: String(prices[0]),
    currentPrice: String(position.activePrice),
    upperPrice: String(prices[1]),
    rangeWidthPercent: ((prices[1] - prices[0]) * 100 / currentPrice).toFixed(2),
    gridCount,
    currentGrid: rangeState === 'below'
      ? 0
      : rangeState === 'above' ? gridCount + 1 : Math.max(0, Math.min(gridCount, rawGrid)),
    positionPercent: rawPosition * 100,
    rangeState,
    distancePercent: distancePercent.toFixed(2)
  };
}

function operationIcon(operation) {
  const icons = {
    increase: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    reduce: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
    withdraw: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h5v16h-5M3 12h11M10 8l4 4-4 4"/></svg>',
    emergency: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.6 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    records: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    cleanup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>'
  };
  return icons[operation] || '';
}

function actionTimestamp(action) {
  return action?.completedAt || action?.failedAt || action?.startedAt || '';
}

function actionTimeValue(action) {
  const value = Date.parse(actionTimestamp(action));
  return Number.isFinite(value) ? value : 0;
}

function mergeActionRecord(action) {
  if (!action?.id) return;
  const record = {
    id: action.id,
    operation: action.operation,
    nftId: String(action.nftId),
    stage: action.stage,
    startedAt: action.startedAt || null,
    completedAt: action.completedAt || null,
    failedAt: action.failedAt || null,
    finalLiquidity: action.finalLiquidity ?? null,
    error: action.error || null
  };
  state.actionHistory = [
    record,
    ...state.actionHistory.filter((item) => item?.id !== record.id)
  ].slice(0, 50);
}

function positionActionRecords(position = state.position) {
  if (!position) return [];
  const records = [...state.actionHistory];
  if (state.status?.lastAction?.id) records.unshift(state.status.lastAction);
  const seen = new Set();
  return records
    .filter((action) => String(action?.nftId) === String(position.nftId))
    .filter((action) => {
      if (!action?.id || seen.has(action.id)) return false;
      seen.add(action.id);
      return true;
    })
    .sort((left, right) => actionTimeValue(right) - actionTimeValue(left));
}

function isEmergencyRetired(position = state.position) {
  if (!position || String(position.liquidity) !== '0') return false;
  const latestCompleted = positionActionRecords(position)
    .find((action) => action.stage === 'completed');
  return latestCompleted?.operation === 'emergency'
    && String(latestCompleted.finalLiquidity) === '0';
}

function isEmptyLiquidity(position) {
  return String(position?.liquidity) === '0';
}

function isInvalidStrategy(position) {
  // Any strategy without liquidity is stale from the management view, even
  // when it reached zero through an emergency withdrawal. Keep the card and
  // its operation history visible until the user explicitly clears it.
  return isEmptyLiquidity(position);
}

function invalidStrategies() {
  return state.positions.filter(isInvalidStrategy);
}

function refreshInvalidCleanupButton() {
  const button = panel.querySelector('#lmClearInvalidButton');
  if (!button) return;
  const count = invalidStrategies().length;
  button.hidden = count === 0;
  button.disabled = state.busy || Boolean(state.status?.inFlight) || count === 0;
  button.textContent = count ? `清空无效策略（${count}）` : '清空无效策略';
}

function refreshPositionActions() {
  const taskIssue = state.busy || state.status?.inFlight
    ? '当前有链上任务待完成'
    : state.status?.lastAction?.stage === 'needs_attention'
      ? '请先处理上一次未完成任务'
      : '';
  for (const button of panel.querySelectorAll('[data-lm-open-operation]')) {
    const card = button.closest('[data-lm-position-card]');
    const position = state.positions.find((item) => (
      String(item.nftId) === String(card?.dataset.nftId)
    ));
    const positionIssue = position && !position.supported
      ? position.unsupportedReason || '当前仓位不受支持'
      : isEmptyLiquidity(position)
        ? '当前仓位没有流动性，请先清理无效策略'
      : '';
    const disabledReason = positionIssue || taskIssue;
    button.disabled = Boolean(disabledReason);
    button.dataset.tooltip = disabledReason || button.getAttribute('aria-label') || '';
  }
  for (const button of panel.querySelectorAll('[data-lm-clean-invalid]')) {
    button.disabled = state.busy || Boolean(state.status?.inFlight);
  }
}

function bindPositionActions() {
  for (const button of panel.querySelectorAll('[data-lm-open-operation]')) {
    button.addEventListener('click', () => {
      const card = button.closest('[data-lm-position-card]');
      openOperation(button.dataset.lmOpenOperation, card?.dataset.nftId);
    });
  }
  for (const button of panel.querySelectorAll('[data-lm-open-records]')) {
    button.addEventListener('click', () => {
      const card = button.closest('[data-lm-position-card]');
      selectPosition(card?.dataset.nftId);
      openRecords();
    });
  }
  for (const button of panel.querySelectorAll('[data-lm-copy]')) {
    button.addEventListener('click', () => {
      copyPositionValue(button.dataset.lmCopy, button.dataset.copyLabel || '内容');
    });
  }
  for (const button of panel.querySelectorAll('[data-lm-clean-invalid]')) {
    button.addEventListener('click', () => {
      cleanupInvalidStrategies([button.closest('[data-lm-position-card]')?.dataset.nftId]);
    });
  }
  refreshPositionActions();
}

async function copyPositionValue(value, label) {
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const input = document.createElement('textarea');
      input.value = value;
      input.setAttribute('readonly', 'true');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    showToast(`${label}已复制`);
  } catch (error) {
    showToast(`复制失败：${error.message}`, 'error');
  }
}

function selectPosition(nftId) {
  const position = state.positions.find((item) => String(item.nftId) === String(nftId));
  if (!position) return null;
  state.selectedNftId = String(position.nftId);
  state.position = position;
  return position;
}

function positionCardMarkup(position) {
  const value = position.valueInStablecoin
    ? `≈ ${compactNumber(position.valueInStablecoin.formatted, 4)} ${position.valueInStablecoin.symbol}`
    : '暂不支持估值';
  const token0Share = tokenValueShare(position);
  const range = position.priceRange || fallbackPriceRange(position);
  const retired = isEmergencyRetired(position);
  const emptyLiquidity = isEmptyLiquidity(position);
  const invalid = isInvalidStrategy(position);
  const rangeState = range?.rangeState || (position.inRange
    ? 'inside'
    : Number(range?.currentPrice) < Number(range?.lowerPrice) ? 'below' : 'above');
  const currentPricePosition = range
    ? rangeState === 'below' ? 3 : rangeState === 'above' ? 97 : 8 + clampPercent(range.positionPercent) * 0.84
    : 50;
  const rangeStatusText = rangeState === 'below'
    ? `低于下限 ${escapeHtml(range.distancePercent || '0.00')}%`
    : rangeState === 'above'
      ? `高于上限 ${escapeHtml(range.distancePercent || '0.00')}%`
      : '价格在范围内';
  const tokenAmountMarkup = (token, className) => {
    const fee = token.uncollectedFee;
    return `<strong>${escapeHtml(compactNumber(token.amount))}${fee === null || fee === undefined
      ? '<small class="lm-fee-pending">（手续费读取中）</small>'
      : `<small class="lm-token-fee">(+${escapeHtml(compactNumber(fee))})</small>`}</strong>`;
  };
  const rangeMarkup = range ? `
    <div class="lm-price-range">
      <div class="lm-price-heading">
        <span>价格区间（${escapeHtml(position.stablecoin.symbol)}/${escapeHtml(position.tradeToken.symbol)} ${escapeHtml(range.gridCount)} 格）</span>
        <strong>${escapeHtml(range.rangeWidthPercent)}%</strong>
      </div>
      <div class="lm-price-track-wrap${emptyLiquidity ? ' is-empty' : ''}">
        <div class="lm-price-track" aria-hidden="true">
          <span class="lm-price-lower-bound"></span>
          <span class="lm-price-upper-bound"></span>
          ${retired || emptyLiquidity ? '' : `<i class="lm-current-price ${rangeState === 'inside' ? '' : 'is-outside'}" style="left:${currentPricePosition}%">
            <b>${escapeHtml(precisePrice(range.currentPrice))}</b>
          </i>`}
        </div>
        <div class="lm-price-labels">
          <span><b>${escapeHtml(precisePrice(range.lowerPrice))}</b><small>下限</small></span>
          <span><b>${escapeHtml(precisePrice(range.upperPrice))}</b><small>上限</small></span>
        </div>
      </div>
      ${retired ? '' : `<div class="lm-range-status ${position.inRange ? 'in-range' : 'out-range'}">
        <span><i></i>${rangeStatusText}</span>
        <strong>${escapeHtml(range.currentGrid)}/${escapeHtml(range.gridCount)} 格</strong>
      </div>`}
      <div class="lm-raw-ticks">
        <span>Tick</span>
        <b>${escapeHtml(position.tickLower)} / ${escapeHtml(position.currentTick)} / ${escapeHtml(position.tickUpper)}</b>
      </div>
    </div>
  ` : `
    <div class="lm-raw-ticks lm-raw-ticks-only">
      <span>范围 Tick</span>
      <b>${escapeHtml(position.tickLower)} / ${escapeHtml(position.currentTick)} / ${escapeHtml(position.tickUpper)}</b>
    </div>
  `;
  return `
  <article class="lm-position-card" data-lm-position-card data-nft-id="${escapeHtml(position.nftId)}">
    <header class="lm-position-heading">
      <div class="lm-position-identity">
        <strong>${escapeHtml(position.token0.symbol)} / ${escapeHtml(position.token1.symbol)}</strong>
        <div class="lm-position-ids">
          <span>Pool ID <button class="lm-copy-value" type="button" data-lm-copy="${escapeHtml(position.poolId)}"
            data-copy-label="Pool ID" data-tooltip="复制 Pool ID" aria-label="复制 Pool ID">
            <b title="${escapeHtml(position.poolId)}">${escapeHtml(shortAddress(position.poolId))}</b>${operationIcon('copy')}
          </button></span>
          <span>NFT ID <button class="lm-copy-value" type="button" data-lm-copy="${escapeHtml(position.nftId)}"
            data-copy-label="NFT ID" data-tooltip="复制 NFT ID" aria-label="复制 NFT ID">
            <b>#${escapeHtml(position.nftId)}</b>${operationIcon('copy')}
          </button></span>
        </div>
      </div>
    </header>

    <section class="lm-strategy-position">
      <div class="lm-card-action-bar">
        <button class="lm-record-action" type="button" data-lm-open-records
          data-tooltip="操作记录" aria-label="操作记录">
          ${operationIcon('records')}
        </button>
        <div class="lm-position-actions" aria-label="仓位操作">
          ${retired ? '' : `
            <button class="lm-icon-action increase" type="button" data-lm-open-operation="increase"
              data-tooltip="补仓" aria-label="补仓">${operationIcon('increase')}</button>
            <button class="lm-icon-action reduce" type="button" data-lm-open-operation="reduce"
              data-tooltip="减仓" aria-label="减仓">${operationIcon('reduce')}</button>
            <button class="lm-icon-action withdraw" type="button" data-lm-open-operation="withdraw"
              data-tooltip="撤出流动性" aria-label="撤出流动性">${operationIcon('withdraw')}</button>
            <button class="lm-icon-action emergency" type="button" data-lm-open-operation="emergency"
              data-tooltip="紧急撤退" aria-label="紧急撤退">${operationIcon('emergency')}</button>
          `}
          ${invalid ? `<button class="lm-icon-action cleanup" type="button" data-lm-clean-invalid
            data-tooltip="清理无效策略" aria-label="清理无效策略">${operationIcon('cleanup')}</button>` : ''}
        </div>
      </div>

      ${emptyLiquidity ? `
        <div class="lm-empty-liquidity" role="status">仓位中没有流动性</div>
      ` : `
        <div class="lm-composition-track" aria-hidden="true">
          <span style="width:${token0Share}%"></span>
          <span style="width:${100 - token0Share}%"></span>
        </div>

        <div class="lm-token-rows">
          <div>
            <span><i class="token0"></i>${escapeHtml(position.token0.symbol)}</span>
            ${tokenAmountMarkup(position.token0, 'token0')}
          </div>
          <div>
            <span><i class="token1"></i>${escapeHtml(position.token1.symbol)}</span>
            ${tokenAmountMarkup(position.token1, 'token1')}
          </div>
        </div>

        <div class="lm-position-total-row">
          <span>仓位总价值 (${escapeHtml(position.valueInStablecoin?.symbol || 'U')})<small>含未领取手续费</small></span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `}

      ${rangeMarkup}
    </section>
    ${position.hooksWarning ? `<div class="lm-hook-warning">${escapeHtml(position.hooksWarning)}</div>` : ''}
    ${position.unsupportedReason ? `<div class="preview-error">${escapeHtml(position.unsupportedReason)}</div>` : ''}
  </article>
  `;
}

function renderPosition() {
  const element = panel.querySelector('#lmPositionCard');
  if (!element) return;
  if (!state.positions.length) {
    element.className = 'lm-position-list';
    element.innerHTML = `
      <div class="lm-position-empty">
        <strong>${state.positionPollStopped ? '暂时无法读取策略仓位' : '当前钱包暂无策略仓位'}</strong>
        <span>${state.positionPollStopped ? '请检查 RPC 或 PRIVATE_KEY 配置后重试。' : '初始化流动性后，仓位会自动出现在这里。'}</span>
      </div>
    `;
    refreshInvalidCleanupButton();
    return;
  }
  element.className = 'lm-position-list';
  element.innerHTML = state.positions.map(positionCardMarkup).join('');
  if (state.selectedNftId) selectPosition(state.selectedNftId);
  bindPositionActions();
  refreshInvalidCleanupButton();
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
  if (!state.position) return '请先选择策略仓位';
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

function openOperation(operation, nftId = state.selectedNftId) {
  const position = selectPosition(nftId);
  if (!OPERATION_META[operation] || !position || isEmergencyRetired(position)) return;
  state.operation = operation;
  state.modalOpen = true;
  const modal = panel.querySelector('#lmOperationModal');
  const title = panel.querySelector('#lmModalTitle');
  const summary = panel.querySelector('#lmModalSummary');
  title.textContent = OPERATION_META[operation].label;
  summary.hidden = true;
  summary.innerHTML = '';
  modal.hidden = false;
  syncModalState();
  refreshOperation();
  window.setTimeout(() => panel.querySelector('#lmActionButton')?.focus(), 0);
}

function closeOperation(force = false) {
  if (state.busy && !force) return;
  state.modalOpen = false;
  panel.querySelector('#lmOperationModal').hidden = true;
  syncModalState();
}

function syncModalState() {
  document.body.classList.toggle('lm-modal-open', Boolean(document.querySelector('.lm-modal:not([hidden])')));
}

function formatActionTime(action) {
  const timestamp = actionTimestamp(action);
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function actionOutcome(action) {
  const inFlight = state.status?.inFlight && state.status?.lastAction?.id === action.id;
  if (inFlight) return { label: '执行中', className: 'running' };
  if (action.stage === 'completed') return { label: '成功', className: 'success' };
  if (action.stage === 'needs_attention') return { label: '需要处理', className: 'attention' };
  if (action.stage === 'failed') return { label: '失败', className: 'failed' };
  if (action.stage === 'cancelled') return { label: '已取消', className: 'cancelled' };
  return { label: stageLabel(action.stage), className: 'running' };
}

function renderRecords() {
  const body = panel.querySelector('#lmRecordsBody');
  if (!body) return;
  const records = positionActionRecords();
  if (!records.length) {
    body.innerHTML = '<div class="lm-records-empty">当前策略暂无操作记录。</div>';
    return;
  }
  const blockingAction = state.status?.lastAction?.stage === 'needs_attention'
    && String(state.status.lastAction.nftId) === String(state.position?.nftId)
    ? state.status.lastAction
    : null;
  body.innerHTML = `
    <div class="lm-record-list">
      ${records.map((action) => {
        const outcome = actionOutcome(action);
        return `
          <article class="lm-record-item">
            <dl>
              <div><dt>操作行为</dt><dd>${escapeHtml(OPERATION_META[action.operation]?.label || action.operation)}</dd></div>
              <div><dt>操作结果</dt><dd><span class="lm-record-result ${outcome.className}">${escapeHtml(outcome.label)}</span></dd></div>
              <div><dt>操作时间</dt><dd>${escapeHtml(formatActionTime(action))}</dd></div>
            </dl>
            ${action.error ? `<p class="lm-record-error">${escapeHtml(action.error)}</p>` : ''}
          </article>
        `;
      }).join('')}
    </div>
    ${blockingAction ? '<div id="lmRecordRecovery" class="lm-record-recovery"></div>' : ''}
  `;
  if (blockingAction) renderRecovery(blockingAction);
}

function openRecords() {
  if (!state.position) return;
  state.recordsOpen = true;
  renderRecords();
  panel.querySelector('#lmRecordsModal').hidden = false;
  syncModalState();
  window.setTimeout(() => panel.querySelector('#lmRecordsClose')?.focus(), 0);
}

function closeRecords() {
  state.recordsOpen = false;
  panel.querySelector('#lmRecordsModal').hidden = true;
  syncModalState();
}

function resolveConfirm(accepted) {
  const resolver = state.confirmResolver;
  if (!resolver) return;
  state.confirmResolver = null;
  panel.querySelector('#lmConfirmModal').hidden = true;
  syncModalState();
  resolver(Boolean(accepted));
}

function confirmAction({ title, message, confirmLabel = '确认', danger = false }) {
  if (state.confirmResolver) resolveConfirm(false);
  const modal = panel.querySelector('#lmConfirmModal');
  const accept = panel.querySelector('#lmConfirmAccept');
  panel.querySelector('#lmConfirmTitle').textContent = title;
  panel.querySelector('#lmConfirmMessage').textContent = message;
  accept.textContent = confirmLabel;
  accept.className = danger ? 'danger-button' : 'primary-button';
  modal.hidden = false;
  syncModalState();
  window.setTimeout(() => accept.focus(), 0);
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
  });
}

async function cleanupInvalidStrategies(nftIds = invalidStrategies().map((position) => position.nftId)) {
  const ids = [...new Set(nftIds.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)))];
  if (!ids.length || state.busy || state.status?.inFlight) return;
  const confirmed = await confirmAction({
    title: '清空无效策略',
    message: `将从策略列表移除 ${ids.length} 个没有流动性的仓位：\nNFT #${ids.join('、#')}\n\n不会影响已有代币余额；后续自动发现也不会再次展示这些无效策略。确认继续吗？`,
    confirmLabel: '确认清理',
    danger: true
  });
  if (!confirmed) return;

  state.busy = true;
  refreshInvalidCleanupButton();
  refreshPositionActions();
  setMessage('正在清理无效策略…');
  try {
    const result = await request('/cleanup-invalid', {
      method: 'POST',
      body: JSON.stringify({ nftIds: ids, confirmed: true })
    });
    showToast(`已清理 ${result.cleaned?.length || ids.length} 个无效策略`);
    setMessage('无效策略已从列表移除', 'success');
    await refreshPositions();
  } catch (error) {
    setMessage(error.message, 'error');
    showToast(error.message, 'error');
  } finally {
    state.busy = false;
    refreshInvalidCleanupButton();
    refreshPositionActions();
  }
}

function refreshOperation() {
  const body = panel.querySelector('#lmOperationBody');
  if (!body) return;
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
      refreshActionButton();
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
  refreshPositionActions();
}

function collectPayload() {
  const nftId = String(state.position?.nftId || '').trim();
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
  const summary = panel.querySelector('#lmModalSummary');
  const settlementNotice = ['increase', 'emergency'].includes(plan.operation)
    ? '预计值用于确认操作范围；兑换按链上实际成交数量结算，撤出结果包含本次领取的手续费。'
    : '预计值用于确认操作范围；撤出按链上实际到账数量结算，双币直接到账且不兑换。';
  summary.hidden = false;
  summary.className = 'lm-modal-summary visible';
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

function renderAction(action, inFlight = false) {
  if (!action) return;
  state.status = { ...state.status, inFlight, lastAction: action };
  mergeActionRecord(action);
  if (state.recordsOpen) renderRecords();
  refreshPositionActions();
}

function renderRecovery(action) {
  const recovery = panel.querySelector('#lmRecordRecovery');
  if (!recovery) return;
  recovery.innerHTML = '';
  if (action?.stage !== 'needs_attention') return;
  if (action.currentTx?.hash) {
    const label = action.cleanupContext ? '核对授权清理交易' : '核对链上交易';
    recovery.innerHTML = `<button id="lmResolveButton" class="secondary-button" type="button">${label}</button>`;
    recovery.querySelector('button').addEventListener('click', resolveTransaction);
  } else if (action.cleanupContext) {
    recovery.innerHTML = '<button id="lmCleanupButton" class="secondary-button" type="button">重新清理 OKX 授权</button>';
    recovery.querySelector('button').addEventListener('click', retryCleanup);
  } else if (action.pendingSwap) {
    recovery.innerHTML = '<button id="lmRetryButton" class="primary-button" type="button">仅重试稳定币兑换</button>';
    recovery.querySelector('button').addEventListener('click', retrySwap);
  }
}

async function requestPositions() {
  try {
    return await request('/positions');
  } catch (error) {
    // Older running services exposed a different discovery path. Keep the UI
    // usable during a rolling restart while the canonical route is deployed.
    if (error.status !== 404) throw error;
    return request('/position-list');
  }
}

function schedulePositionPolling(delay = POSITION_POLL_INTERVAL_MS) {
  window.clearTimeout(state.positionPollTimer);
  if (state.positionPollStopped) return;
  state.positionPollTimer = window.setTimeout(() => refreshPositions(), delay);
}

async function refreshPositions() {
  if (state.positionPollInFlight || state.positionPollStopped) return;
  state.positionPollInFlight = true;
  try {
    const data = await requestPositions();
    state.positions = Array.isArray(data.positions) ? data.positions : [];
    if (state.selectedNftId) {
      state.position = state.positions.find((item) => (
        String(item.nftId) === String(state.selectedNftId)
      )) || null;
    }
    if (!state.position && state.positions.length) {
      state.position = state.positions[0];
      state.selectedNftId = String(state.position.nftId);
    }
    if (state.modalOpen && !state.position) closeOperation(true);
    state.positionPollStopped = false;
    renderPosition();
    if (!state.modalOpen) refreshOperation();
    const pollStatus = panel.querySelector('#lmPollStatusText');
    if (pollStatus) {
      const discovery = data.discovery || {};
      const emptyPositionCount = Number(discovery.emptyPositionCount) || 0;
      pollStatus.textContent = discovery.scanning
        ? `正在发现仓位 · ${state.positions.length} 个已载入`
        : `已载入 ${state.positions.length} 个有流动性策略`
          + (emptyPositionCount ? ` · 已忽略 ${emptyPositionCount} 个空仓` : '')
          + ' · 每 1.5s 检查';
    }
    if (data.discovery?.error && !state.positions.length) {
      setMessage(`仓位发现受限：${data.discovery.error}`, 'error');
    }
  } catch (error) {
    state.positionPollStopped = false;
    const pollStatus = panel.querySelector('#lmPollStatusText');
    if (pollStatus) pollStatus.textContent = `自动刷新失败 · 将重试（${error.message}）`;
    setMessage(error.message, 'error');
  } finally {
    state.positionPollInFlight = false;
    schedulePositionPolling(POSITION_POLL_INTERVAL_MS);
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
    const confirmed = await confirmAction({
      title: `确认${OPERATION_META[plan.operation].label}`,
      message: confirmationText(plan),
      confirmLabel: OPERATION_META[plan.operation].label,
      danger: ['withdraw', 'emergency'].includes(plan.operation)
    });
    if (!confirmed) {
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
    closeOperation(true);
    await refreshPositions();
  } catch (error) {
    const action = error.data?.action;
    if (action) {
      state.status = { inFlight: false, lastAction: action };
      renderAction(action, false);
      closeOperation(true);
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
  const confirmed = await confirmAction({
    title: '重试稳定币兑换',
    message: '只重试待处理的代币 → 稳定币兑换，不会再次撤出流动性。',
    confirmLabel: '确认重试'
  });
  if (!confirmed) return;
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
  const confirmed = await confirmAction({
    title: '重新清理授权',
    message: '只重试清理本次 OKX 代币授权，不会重新兑换或撤出流动性。',
    confirmLabel: '确认清理'
  });
  if (!confirmed) return;
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
  const confirmed = await confirmAction({
    title: '核对链上交易',
    message: '将读取链上回执并核对任务状态，不会重新发送交易。',
    confirmLabel: '开始核对'
  });
  if (!confirmed) return;
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
  if (Array.isArray(status.actionHistory)) state.actionHistory = status.actionHistory;
  if (status.lastAction) renderAction(status.lastAction, status.inFlight);
  if (state.recordsOpen) renderRecords();
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
  panel.querySelector('#lmOpenCreateButton').addEventListener('click', openCreateModal);
  panel.querySelector('#lmClearInvalidButton').addEventListener('click', () => cleanupInvalidStrategies());
  createModal?.querySelector('#liquidityCreateModalClose')?.addEventListener('click', closeCreateModal);
  createModal?.querySelector('[data-lm-close-create]')?.addEventListener('click', closeCreateModal);
  panel.querySelector('#lmActionButton').addEventListener('click', executeOperation);
  panel.querySelector('#lmModalClose').addEventListener('click', () => closeOperation());
  panel.querySelector('[data-lm-close-operation]').addEventListener('click', () => closeOperation());
  panel.querySelector('#lmRecordsClose').addEventListener('click', closeRecords);
  panel.querySelector('[data-lm-close-records]').addEventListener('click', closeRecords);
  panel.querySelector('#lmConfirmCancel').addEventListener('click', () => resolveConfirm(false));
  panel.querySelector('#lmConfirmAccept').addEventListener('click', () => resolveConfirm(true));
  panel.querySelector('[data-lm-cancel-confirm]').addEventListener('click', () => resolveConfirm(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.confirmResolver) resolveConfirm(false);
    else if (state.recordsOpen) closeRecords();
    else if (state.modalOpen) closeOperation();
    else if (createModal && !createModal.hidden) closeCreateModal();
  });
  window.addEventListener('liquidity:create-completed', () => {
    closeCreateModal();
    showToast('流动性初始化成功');
    refreshPositions();
  });
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
    state.actionHistory = Array.isArray(state.options.actionHistory) ? state.options.actionHistory : [];
    if (state.options.lastAction) renderAction(state.options.lastAction, state.options.inFlight);
    refreshActionButton();
    const issues = [];
    if (!state.options.privateKeyConfigured) issues.push('缺少 PRIVATE_KEY');
    if (!state.options.executionEnabled) issues.push('LIQUIDITY_EXECUTE=false');
    setMessage(issues.length ? `当前只可查看：${issues.join('；')}` : '执行环境已就绪');
    if (state.options.inFlight) startStatusPolling();
    refreshPositions();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

renderShell();
bindEvents();
renderPosition();
refreshOperation();
loadManagement();
