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

function renderFooter() {
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `<p>Data for this tracker lives directly in this GitHub repository — no external database. <a href="README.md" target="_blank" rel="noopener">How it works →</a></p>`;
  document.body.appendChild(footer);
}

export function initShell() {
  renderNav();
  renderFooter();
}

document.addEventListener('DOMContentLoaded', initShell);
