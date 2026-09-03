// Analytics page: performance breakdowns by tag and by uploader (bar chart +
// "best performer" card + table, each), plus a win/loss and uploader-share
// pie overview. Works on individual trades (each with its own result +
// tags), not on sessions, since tags and win/loss live at the trade level.

import { getJson, toast } from './store.js';

let trades = [];
let backtests = [];
let source = 'trading';
let chartTags = null;
let chartUploaders = null;
let chartWinLoss = null;
let chartUploaderPie = null;

const PIE_PALETTE = ['#4da6ff', '#a855f7', '#2ecc71', '#f1c40f', '#e74c3c', '#38bdf8', '#f472b6', '#fb923c'];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isLightMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function axisColor() {
  return isLightMode() ? '#5a6785' : '#9aa7c2';
}

function gridColor() {
  return isLightMode() ? 'rgba(20,30,60,0.08)' : 'rgba(255,255,255,0.06)';
}

function combinedSessions() {
  const t = source !== 'backtesting' ? trades.map((s) => ({ ...s, source: 'Trading' })) : [];
  const b = source !== 'trading' ? backtests.map((s) => ({ ...s, source: 'Backtesting' })) : [];
  return [...t, ...b];
}

function combinedTrades(sessions) {
  return sessions.flatMap((s) => (s.trades || []).map((t) => ({ ...t, uploader: s.uploader || 'Anonymous' })));
}

function statsFor(tradeList) {
  const numTrades = tradeList.length;
  const wins = tradeList.filter((t) => t.result === 'win').length;
  return { totalTrades: numTrades, wins, winrate: numTrades > 0 ? (wins / numTrades) * 100 : 0 };
}

function byTag(tradeList) {
  const map = new Map();
  tradeList.forEach((t) => {
    (t.tags || []).forEach((tag) => {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(t);
    });
  });
  return Array.from(map.entries())
    .map(([tag, list]) => ({ tag, ...statsFor(list) }))
    .sort((a, b) => b.totalTrades - a.totalTrades);
}

function byUploader(sessions) {
  const map = new Map();
  sessions.forEach((s) => {
    const name = s.uploader || 'Anonymous';
    if (!map.has(name)) map.set(name, { sessions: 0, trades: [] });
    const rec = map.get(name);
    rec.sessions += 1;
    rec.trades.push(...(s.trades || []));
  });
  return Array.from(map.entries())
    .map(([name, rec]) => ({ name, sessions: rec.sessions, ...statsFor(rec.trades) }))
    .sort((a, b) => b.winrate - a.winrate);
}

function renderSummary(sessions, allTrades) {
  const s = statsFor(allTrades);
  document.getElementById('summary-cards').innerHTML = `
    <div class="stat-tile"><span class="stat-value">${sessions.length}</span><span class="stat-label">Sessions</span></div>
    <div class="stat-tile"><span class="stat-value">${s.totalTrades}</span><span class="stat-label">Total trades</span></div>
    <div class="stat-tile"><span class="stat-value">${s.winrate.toFixed(1)}%</span><span class="stat-label">Weighted winrate</span></div>
  `;
}

// Shared renderer for the Tag Performance / Uploader Performance cards:
// a horizontal bar chart, a "best performer" highlight, and a data table.
function renderPerfSection({ rows, canvasEl, existingChart, color, bestEl, bestIcon, bestLabel, tableEl, labelKey, nameLabel, extraCol }) {
  if (existingChart) existingChart.destroy();
  let chart = null;

  if (rows.length > 0) {
    chart = new Chart(canvasEl, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r[labelKey]),
        datasets: [{ data: rows.map((r) => r.winrate), backgroundColor: color, borderRadius: 4, maxBarThickness: 28 }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        scales: {
          x: { beginAtZero: true, max: 100, ticks: { color: axisColor(), callback: (v) => `${v}%` }, grid: { color: gridColor() } },
          y: { ticks: { color: axisColor() }, grid: { display: false } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.parsed.x.toFixed(1)}% winrate` } }
        }
      }
    });
  } else {
    canvasEl.getContext('2d').clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  const best = rows.slice().sort((a, b) => b.winrate - a.winrate || b.totalTrades - a.totalTrades)[0];
  bestEl.innerHTML = best ? `
    <span class="perf-best-icon">${bestIcon}</span>
    <div class="perf-best-label">${bestLabel}</div>
    <div class="perf-best-name">${escapeHtml(best[labelKey])}</div>
    <div class="perf-best-sub">${best.winrate.toFixed(1)}% win rate · ${best.totalTrades} trade${best.totalTrades === 1 ? '' : 's'}</div>
  ` : '<p class="hint">No data yet.</p>';

  const colCount = extraCol ? 5 : 4;
  tableEl.innerHTML = `
    <thead><tr><th>${nameLabel}</th>${extraCol ? `<th>${extraCol.label}</th>` : ''}<th>Trades</th><th>Wins</th><th>Win Rate</th></tr></thead>
    <tbody>
      ${rows.map((r) => `<tr><td>${escapeHtml(r[labelKey])}</td>${extraCol ? `<td>${r[extraCol.key]}</td>` : ''}<td>${r.totalTrades}</td><td>${r.wins}</td><td>${r.winrate.toFixed(1)}%</td></tr>`).join('') || `<tr><td colspan="${colCount}" class="hint">No entries yet.</td></tr>`}
    </tbody>
  `;

  return chart;
}

function renderWinLossPie(allTrades) {
  const wins = allTrades.filter((t) => t.result === 'win').length;
  const losses = allTrades.length - wins;
  if (chartWinLoss) chartWinLoss.destroy();
  const canvas = document.getElementById('chart-winloss-pie');
  if (allTrades.length === 0) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); return; }
  chartWinLoss = new Chart(canvas, {
    type: 'pie',
    data: { labels: ['Wins', 'Losses'], datasets: [{ data: [wins, losses], backgroundColor: ['#2ecc71', '#e74c3c'] }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: axisColor() } } } }
  });
}

function renderUploaderPie(sessions) {
  const rows = byUploader(sessions);
  if (chartUploaderPie) chartUploaderPie.destroy();
  const canvas = document.getElementById('chart-uploader-pie');
  if (rows.length === 0) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); return; }
  chartUploaderPie = new Chart(canvas, {
    type: 'pie',
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{ data: rows.map((r) => r.totalTrades), backgroundColor: rows.map((_, i) => PIE_PALETTE[i % PIE_PALETTE.length]) }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: axisColor() } } } }
  });
}

function render() {
  const sessions = combinedSessions();
  const allTrades = combinedTrades(sessions);
  renderSummary(sessions, allTrades);

  chartTags = renderPerfSection({
    rows: byTag(allTrades),
    canvasEl: document.getElementById('chart-tags'),
    existingChart: chartTags,
    color: '#2ecc71',
    bestEl: document.getElementById('best-tag-card'),
    bestIcon: '📈',
    bestLabel: 'Best tag',
    tableEl: document.getElementById('tag-table'),
    labelKey: 'tag',
    nameLabel: 'Tag'
  });

  chartUploaders = renderPerfSection({
    rows: byUploader(sessions),
    canvasEl: document.getElementById('chart-uploaders'),
    existingChart: chartUploaders,
    color: '#a855f7',
    bestEl: document.getElementById('best-uploader-card'),
    bestIcon: '🏆',
    bestLabel: 'Best uploader',
    tableEl: document.getElementById('uploader-table'),
    labelKey: 'name',
    nameLabel: 'Uploader',
    extraCol: { key: 'sessions', label: 'Sessions' }
  });

  renderWinLossPie(allTrades);
  renderUploaderPie(sessions);
}

document.querySelectorAll('#source-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#source-toggle button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    source = btn.dataset.source;
    render();
  });
});

async function load() {
  try {
    [trades, backtests] = await Promise.all([getJson('data/trades.json', []), getJson('data/backtests.json', [])]);
    render();
  } catch (err) {
    toast(err.message || 'Could not load analytics data.', 'error');
  }
}

load();
