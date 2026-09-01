// Analytics page: aggregates trading + backtesting sessions by tag and by
// uploader, with a source filter (trading / backtesting / both). Works on
// individual trades (each with its own result + tags), not on sessions,
// since tags and win/loss now live at the trade level.

import { getJson, toast } from './store.js';

let trades = [];
let backtests = [];
let view = 'overall';
let source = 'both';
let chartTags = null;
let chartUploaders = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  return { totalTrades: numTrades, winrate: numTrades > 0 ? (wins / numTrades) * 100 : 0 };
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

function colorFor(rate) {
  if (rate >= 60) return '#2ecc71';
  if (rate >= 45) return '#f1c40f';
  return '#e74c3c';
}

function renderSummary(sessions, allTrades) {
  const s = statsFor(allTrades);
  document.getElementById('summary-cards').innerHTML = `
    <div class="stat-tile"><span class="stat-value">${sessions.length}</span><span class="stat-label">Sessions</span></div>
    <div class="stat-tile"><span class="stat-value">${s.totalTrades}</span><span class="stat-label">Total trades</span></div>
    <div class="stat-tile"><span class="stat-value">${s.winrate.toFixed(1)}%</span><span class="stat-label">Weighted winrate</span></div>
  `;
}

function renderTagChart(allTrades) {
  const rows = byTag(allTrades);
  const ctx = document.getElementById('chart-tags');
  if (chartTags) chartTags.destroy();
  if (rows.length === 0) { ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height); return; }

  chartTags = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.tag),
      datasets: [{ label: 'Winrate %', data: rows.map((r) => r.winrate), backgroundColor: rows.map((r) => colorFor(r.winrate)) }]
    },
    options: {
      scales: { y: { beginAtZero: true, max: 100 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { afterLabel: (c) => `${rows[c.dataIndex].totalTrades} trades tagged` } }
      }
    }
  });
}

function renderUploaderView(sessions) {
  const rows = byUploader(sessions);
  const ctx = document.getElementById('chart-uploaders');
  if (chartUploaders) chartUploaders.destroy();

  if (rows.length > 0) {
    chartUploaders = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.name),
        datasets: [{ label: 'Winrate %', data: rows.map((r) => r.winrate), backgroundColor: rows.map((r) => colorFor(r.winrate)) }]
      },
      options: { scales: { y: { beginAtZero: true, max: 100 } }, plugins: { legend: { display: false } } }
    });
  }

  document.getElementById('uploader-table').innerHTML = `
    <table class="data-table">
      <thead><tr><th>Uploader</th><th>Sessions</th><th>Trades</th><th>Winrate</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.sessions}</td><td>${r.totalTrades}</td><td>${r.winrate.toFixed(1)}%</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No entries yet.</td></tr>'}
      </tbody>
    </table>
  `;
}

function render() {
  const sessions = combinedSessions();
  const allTrades = combinedTrades(sessions);
  renderSummary(sessions, allTrades);
  renderTagChart(allTrades);
  document.getElementById('uploader-section').classList.toggle('hidden', view !== 'uploader');
  if (view === 'uploader') renderUploaderView(sessions);
}

document.querySelectorAll('#view-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#view-toggle button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    view = btn.dataset.view;
    render();
  });
});

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
