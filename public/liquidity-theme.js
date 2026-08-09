const THEME_STORAGE_KEY = 'web3auto.liquidityThemeOverride';
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';

export function scheduledLiquidityTheme(date = new Date()) {
  const hour = date.getHours();
  return hour >= 6 && hour < 18 ? LIGHT_THEME : DARK_THEME;
}

export function nextLiquidityThemeBoundary(date = new Date()) {
  const boundary = new Date(date);
  boundary.setSeconds(0, 0);
  if (date.getHours() < 6) {
    boundary.setHours(6, 0, 0, 0);
  } else if (date.getHours() < 18) {
    boundary.setHours(18, 0, 0, 0);
  } else {
    boundary.setDate(boundary.getDate() + 1);
    boundary.setHours(6, 0, 0, 0);
  }
  return boundary;
}

function readOverride(now) {
  try {
    const value = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || 'null');
    if (!value || ![LIGHT_THEME, DARK_THEME].includes(value.theme)) return null;
    if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now.getTime()) {
      localStorage.removeItem(THEME_STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function storeOverride(theme, expiresAt) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
      theme,
      expiresAt: expiresAt.getTime()
    }));
  } catch {
    // The theme still applies for this page when browser storage is unavailable.
  }
}

function initializeLiquidityTheme() {
  const root = document.documentElement;
  const button = document.querySelector('#liquidityThemeToggle');
  const tooltip = button?.querySelector('.theme-tooltip');
  let boundaryTimer = null;

  function applyTheme(theme, source) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const currentLabel = theme === LIGHT_THEME ? '白天模式' : '夜间模式';
    const targetLabel = theme === LIGHT_THEME ? '夜间模式' : '白天模式';
    const sourceLabel = source === 'manual' ? '手动' : '按时间自动';
    const message = `当前为${currentLabel}（${sourceLabel}），点击切换为${targetLabel}`;
    if (button) {
      button.dataset.theme = theme;
      button.setAttribute('aria-label', message);
      button.title = message;
    }
    if (tooltip) tooltip.textContent = message;
  }

  function scheduleBoundary(now = new Date()) {
    window.clearTimeout(boundaryTimer);
    const boundary = nextLiquidityThemeBoundary(now);
    boundaryTimer = window.setTimeout(() => {
      try {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } catch {
        // Ignore unavailable browser storage.
      }
      refreshTheme();
    }, Math.max(1000, boundary.getTime() - now.getTime() + 250));
  }

  function refreshTheme() {
    const now = new Date();
    const override = readOverride(now);
    applyTheme(override?.theme || scheduledLiquidityTheme(now), override ? 'manual' : 'scheduled');
    scheduleBoundary(now);
  }

  button?.addEventListener('click', () => {
    const now = new Date();
    const current = root.dataset.theme || scheduledLiquidityTheme(now);
    const next = current === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;
    storeOverride(next, nextLiquidityThemeBoundary(now));
    applyTheme(next, 'manual');
    scheduleBoundary(now);
  });

  window.addEventListener('focus', refreshTheme);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshTheme();
  });
  refreshTheme();
}

if (typeof document !== 'undefined') initializeLiquidityTheme();
