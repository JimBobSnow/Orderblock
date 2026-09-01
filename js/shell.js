// Shared site chrome: header/nav + footer, injected into every page.

const PAGES = [
  { id: 'home', href: 'index.html', label: 'Home' },
  { id: 'trading', href: 'trading.html', label: 'Trading Results' },
  { id: 'backtesting', href: 'backtesting.html', label: 'Backtesting Results' },
  { id: 'analytics', href: 'analytics.html', label: 'Analytics' }
];

function renderNav() {
  const active = document.body.dataset.page;
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `
    <div class="site-header-inner">
      <a class="brand" href="index.html">📈 BO Tracker</a>
      <nav class="site-nav">
        ${PAGES.map((p) => `<a href="${p.href}" class="${p.id === active ? 'active' : ''}">${p.label}</a>`).join('')}
      </nav>
    </div>
  `;
  document.body.prepend(header);
}

export function initShell() {
  renderNav();
}

document.addEventListener('DOMContentLoaded', initShell);
