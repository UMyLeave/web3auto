const STORAGE_KEY = 'web3auto.sidebarCollapsed';
const MOBILE_BREAKPOINT = 820;

const page = document.body.dataset.page || (
  location.pathname.startsWith('/liquidity') ? 'liquidity' : 'monitor'
);

const items = [
  {
    id: 'monitor',
    href: '/monitor',
    label: '仓位监控',
    description: '监控、撤退与兑换',
    icon: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M12 13l4-4"/><path d="M5 19h14"/>'
  },
  {
    id: 'liquidity',
    href: '/liquidity',
    label: '初始化流动性',
    description: '创建或继续加池',
    icon: '<path d="M12 3v18"/><path d="M3 12h18"/><circle cx="12" cy="12" r="8"/>'
  }
];

function navItem(item) {
  const active = item.id === page;
  return `
    <a class="app-nav-item${active ? ' active' : ''}" href="${item.href}"
      ${active ? 'aria-current="page"' : ''} title="${item.label}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>
      <span class="app-nav-copy">
        <strong>${item.label}</strong>
        <small>${item.description}</small>
      </span>
    </a>
  `;
}

document.body.insertAdjacentHTML('afterbegin', `
  <aside class="app-sidebar" aria-label="功能导航">
    <div class="app-sidebar-brand">
      <span class="app-sidebar-mark" aria-hidden="true">V4</span>
      <span class="app-sidebar-brand-copy">
        <strong>流动性工具</strong>
        <small>BSC 控制台</small>
      </span>
    </div>
    <nav class="app-sidebar-nav">
      ${items.map(navItem).join('')}
    </nav>
    <div class="app-sidebar-foot">
      <span class="app-sidebar-dot" aria-hidden="true"></span>
      <span>本地执行</span>
    </div>
  </aside>
  <button class="app-sidebar-toggle" type="button" aria-label="隐藏侧边栏"
    aria-expanded="true" title="隐藏侧边栏">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
  </button>
  <button class="app-sidebar-overlay" type="button" aria-label="关闭侧边栏"></button>
`);

const toggle = document.querySelector('.app-sidebar-toggle');
const overlay = document.querySelector('.app-sidebar-overlay');

function isMobile() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

function setDesktopCollapsed(collapsed) {
  document.body.classList.toggle('app-sidebar-collapsed', collapsed);
  localStorage.setItem(STORAGE_KEY, String(collapsed));
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? '打开侧边栏' : '隐藏侧边栏');
  toggle.title = collapsed ? '打开侧边栏' : '隐藏侧边栏';
}

function setMobileOpen(open) {
  document.body.classList.toggle('app-sidebar-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? '关闭侧边栏' : '打开侧边栏');
  toggle.title = open ? '关闭侧边栏' : '打开侧边栏';
}

function handleToggle() {
  if (isMobile()) {
    setMobileOpen(!document.body.classList.contains('app-sidebar-open'));
    return;
  }
  setDesktopCollapsed(!document.body.classList.contains('app-sidebar-collapsed'));
}

document.body.classList.add('has-app-sidebar');
setDesktopCollapsed(localStorage.getItem(STORAGE_KEY) === 'true');
if (isMobile()) setMobileOpen(false);

toggle.addEventListener('click', handleToggle);
overlay.addEventListener('click', () => setMobileOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isMobile()) setMobileOpen(false);
});
window.addEventListener('resize', () => {
  if (isMobile()) {
    setMobileOpen(false);
  } else {
    document.body.classList.remove('app-sidebar-open');
    setDesktopCollapsed(localStorage.getItem(STORAGE_KEY) === 'true');
  }
});
