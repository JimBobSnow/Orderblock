// Shared logic for the Trading Results and Backtesting Results pages.
//
// Data model: a "session" (one entry in trades.json / backtests.json) is
// uploaded by one person on one date, and is built up trade-by-trade. Each
// trade has its own screenshot, win/loss result, and tags. A session's
// winrate and trade count are never entered manually — they're always
// computed from its trades.

import { getLastName, setLastName, getJson, updateJsonFile, uploadImageFile, uuid, toast, rawUrl } from './store.js';

const PRESET_TAGS = ['BOS', 'CHOCH', 'Support/Resistance', 'Swing', 'With trend', 'Against trend'];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) {
    return d;
  }
}

function computeStats(trades) {
  const list = trades || [];
  const wins = list.filter((t) => t.result === 'win').length;
  const numTrades = list.length;
  return { numTrades, wins, losses: numTrades - wins, winrate: numTrades > 0 ? (wins / numTrades) * 100 : 0 };
}

function makeTagChip(tag, active, onClick, removable) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `tag-chip ${active ? 'active' : ''}`;
  chip.textContent = removable ? `${tag} ✕` : tag;
  chip.addEventListener('click', () => onClick(tag));
  return chip;
}

// --- Session builder (the "Upload session" modal flow) ---------------------

function openSessionBuilder(ctx) {
  const session = { id: uuid(), uploader: getLastName(), date: new Date().toISOString().slice(0, 10), trades: [] };
  let mode = 'idle'; // 'idle' | 'adding'
  let pending = { file: null, result: null, tags: new Set() };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal session-modal">
      <div class="modal-header">
        <h2>New ${ctx.entryNoun} session</h2>
        <button type="button" class="btn-icon" id="session-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body" id="session-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('#session-body');

  function close(force) {
    if (!force && session.trades.length > 0) {
      const ok = window.confirm("Discard this session? Trades you've logged so far won't be saved to the list (any uploaded photos will stay in the repo).");
      if (!ok) return;
    }
    overlay.remove();
  }
  overlay.querySelector('#session-close').addEventListener('click', () => close(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

  function renderTradeTags() {
    const wrap = body.querySelector('#trade-tags');
    if (!wrap) return;
    wrap.innerHTML = '';
    PRESET_TAGS.forEach((t) => wrap.appendChild(makeTagChip(t, pending.tags.has(t), toggleTradeTag)));
    Array.from(pending.tags).filter((t) => !PRESET_TAGS.includes(t)).forEach((t) => wrap.appendChild(makeTagChip(t, true, toggleTradeTag, true)));
  }

  function toggleTradeTag(tag) {
    if (pending.tags.has(tag)) pending.tags.delete(tag); else pending.tags.add(tag);
    renderTradeTags();
  }

  function addPendingTagFromInput() {
    const input = body.querySelector('#trade-tag-input');
    const val = input.value.trim();
    if (val) { pending.tags.add(val); input.value = ''; renderTradeTags(); }
  }

  function renderBody() {
    const stats = computeStats(session.trades);

    if (mode === 'adding') {
      body.innerHTML = `
        <div class="session-meta-row">
          <label>Uploader name<input type="text" id="s-uploader" value="${escapeHtml(session.uploader)}" /></label>
          <label>Date<input type="date" id="s-date" value="${session.date}" /></label>
        </div>
        <h3 class="trade-form-title">Add trade ${session.trades.length + 1}</h3>

        <label class="block-label">Screenshot</label>
        <input type="file" id="trade-file" accept="image/*" />
        <div id="trade-file-preview" class="file-preview-row"></div>

        <label class="block-label">Result</label>
        <div class="result-toggle">
          <button type="button" class="result-btn win" data-result="win">✓ Win</button>
          <button type="button" class="result-btn loss" data-result="loss">✕ Loss</button>
        </div>

        <label class="block-label">Tags</label>
        <div id="trade-tags" class="tag-row"></div>
        <div class="tag-add-row">
          <input type="text" id="trade-tag-input" placeholder="Add a custom tag and press Enter" />
          <button type="button" id="trade-add-tag-btn" class="btn btn-ghost">+ Add tag</button>
        </div>

        <div class="form-actions builder-actions">
          <button type="button" id="trade-cancel-btn" class="btn btn-secondary">Cancel</button>
          <button type="button" id="trade-complete-btn" class="btn btn-primary">Complete trade</button>
        </div>
      `;

      body.querySelector('#s-uploader').addEventListener('input', (e) => { session.uploader = e.target.value; });
      body.querySelector('#s-date').addEventListener('input', (e) => { session.date = e.target.value; });

      body.querySelector('#trade-file').addEventListener('change', (e) => {
        pending.file = e.target.files[0] || null;
        const preview = body.querySelector('#trade-file-preview');
        preview.innerHTML = '';
        if (pending.file) {
          const img = document.createElement('img');
          img.className = 'file-thumb';
          const reader = new FileReader();
          reader.onload = (ev) => { img.src = ev.target.result; };
          reader.readAsDataURL(pending.file);
          preview.appendChild(img);
        }
      });

      // Toggle active state directly (no full re-render) so the file input
      // selection and preview aren't wiped out by rebuilding the DOM.
      body.querySelectorAll('.result-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          pending.result = btn.dataset.result;
          body.querySelectorAll('.result-btn').forEach((b) => b.classList.toggle('active', b.dataset.result === pending.result));
        });
      });

      renderTradeTags();
      body.querySelector('#trade-tag-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addPendingTagFromInput(); }
      });
      body.querySelector('#trade-add-tag-btn').addEventListener('click', addPendingTagFromInput);

      body.querySelector('#trade-cancel-btn').addEventListener('click', () => {
        pending = { file: null, result: null, tags: new Set() };
        mode = 'idle';
        renderBody();
      });
      body.querySelector('#trade-complete-btn').addEventListener('click', completeTrade);
    } else {
      body.innerHTML = `
        <div class="session-meta-row">
          <label>Uploader name<input type="text" id="s-uploader" value="${escapeHtml(session.uploader)}" /></label>
          <label>Date<input type="date" id="s-date" value="${session.date}" /></label>
        </div>

        ${session.trades.length > 0 ? `
          <div class="session-tally">
            <span class="stat winrate ${stats.winrate >= 60 ? 'good' : stats.winrate >= 45 ? 'mid' : 'bad'}">${stats.winrate.toFixed(1)}% winrate</span>
            <span class="stat">${stats.numTrades} trade${stats.numTrades === 1 ? '' : 's'} logged</span>
            <span class="stat">${stats.wins}W / ${stats.losses}L</span>
          </div>
          <div class="logged-trades-row">
            ${session.trades.map((t, i) => `
              <div class="logged-trade-chip">
                <img src="${t.previewUrl}" alt="Trade ${i + 1}" />
                <span class="result-badge ${t.result}">${t.result === 'win' ? 'W' : 'L'}</span>
              </div>
            `).join('')}
          </div>
        ` : '<p class="hint">No trades logged yet in this session.</p>'}

        <div class="form-actions builder-actions">
          <button type="button" id="add-trade-btn" class="btn btn-primary">+ Add trade</button>
          ${session.trades.length > 0 ? '<button type="button" id="finish-session-btn" class="btn btn-secondary">Finish session ✓</button>' : ''}
        </div>
      `;

      body.querySelector('#s-uploader').addEventListener('input', (e) => { session.uploader = e.target.value; });
      body.querySelector('#s-date').addEventListener('input', (e) => { session.date = e.target.value; });
      body.querySelector('#add-trade-btn').addEventListener('click', () => {
        pending = { file: null, result: null, tags: new Set() };
        mode = 'adding';
        renderBody();
      });
      const finishBtn = body.querySelector('#finish-session-btn');
      if (finishBtn) finishBtn.addEventListener('click', finishSession);
    }
  }

  async function completeTrade() {
    if (!pending.file) { toast('Choose a screenshot for this trade.', 'error'); return; }
    if (!pending.result) { toast('Mark this trade as a win or a loss.', 'error'); return; }

    const completeBtn = body.querySelector('#trade-complete-btn');
    completeBtn.disabled = true;
    completeBtn.textContent = 'Uploading…';
    try {
      const tradeId = uuid();
      const path = `${ctx.imageDir}/${session.id}-${tradeId}.jpg`;
      await uploadImageFile(pending.file, path, `${ctx.commitPrefix}: trade photo for ${session.uploader || 'session'}`);
      session.trades.push({ id: tradeId, result: pending.result, tags: Array.from(pending.tags), image: path, previewUrl: rawUrl(path) });
      pending = { file: null, result: null, tags: new Set() };
      mode = 'idle';
      renderBody();
      toast('Trade added to session.', 'success');
    } catch (err) {
      toast(err.message || 'Could not upload trade photo.', 'error');
      completeBtn.disabled = false;
      completeBtn.textContent = 'Complete trade';
    }
  }

  async function finishSession() {
    if (session.trades.length === 0) { toast('Add at least one trade first.', 'error'); return; }
    const finishBtn = body.querySelector('#finish-session-btn');
    finishBtn.disabled = true;
    finishBtn.textContent = 'Saving session…';
    try {
      const entry = {
        id: session.id,
        uploader: session.uploader.trim() || 'Anonymous',
        date: session.date || new Date().toISOString().slice(0, 10),
        trades: session.trades.map(({ id, result, tags, image }) => ({ id, result, tags, image })),
        comments: [],
        createdAt: new Date().toISOString()
      };
      const updated = await updateJsonFile(ctx.dataPath, (data) => { data.push(entry); return data; }, `${ctx.commitPrefix}: session by ${entry.uploader}`);
      setLastName(entry.uploader);
      ctx.onFinished(updated);
      overlay.remove();
      toast('Session saved!', 'success');
    } catch (err) {
      toast(err.message || 'Could not save session.', 'error');
      finishBtn.disabled = false;
      finishBtn.textContent = 'Finish session ✓';
    }
  }

  renderBody();
}

// --- Page: session list + filter + comments --------------------------------

export function initEntryPage({ dataPath, imageDir, entryNoun, commitPrefix }) {
  const state = { entries: [], activeFilterTag: null };

  const listEl = document.getElementById('entry-list');
  const emptyEl = document.getElementById('entry-empty');
  const filterBarEl = document.getElementById('filter-bar');
  const startBtn = document.getElementById('start-session-btn');

  startBtn.addEventListener('click', () => {
    openSessionBuilder({
      dataPath,
      imageDir,
      entryNoun,
      commitPrefix,
      onFinished: (updated) => { state.entries = updated; renderList(); renderFilterBar(); }
    });
  });

  function allKnownTags() {
    const set = new Set(PRESET_TAGS);
    state.entries.forEach((e) => (e.trades || []).forEach((t) => (t.tags || []).forEach((tag) => set.add(tag))));
    return Array.from(set);
  }

  function renderFilterBar() {
    filterBarEl.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `tag-chip filter ${!state.activeFilterTag ? 'active' : ''}`;
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { state.activeFilterTag = null; renderList(); renderFilterBar(); });
    filterBarEl.appendChild(allBtn);

    allKnownTags().forEach((t) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `tag-chip filter ${state.activeFilterTag === t ? 'active' : ''}`;
      chip.textContent = t;
      chip.addEventListener('click', () => { state.activeFilterTag = t; renderList(); renderFilterBar(); });
      filterBarEl.appendChild(chip);
    });
  }

  function openLightbox(src) {
    let lb = document.getElementById('lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'lightbox';
      lb.className = 'lightbox hidden';
      lb.innerHTML = `<img id="lightbox-img" alt="Full size trade screenshot" /><button id="lightbox-close" type="button" class="btn-icon" aria-label="Close">✕</button>`;
      document.body.appendChild(lb);
      lb.addEventListener('click', (e) => {
        if (e.target === lb || e.target.id === 'lightbox-close') lb.classList.add('hidden');
      });
    }
    document.getElementById('lightbox-img').src = src;
    lb.classList.remove('hidden');
  }

  function renderCard(entry) {
    const stats = computeStats(entry.trades);
    const card = document.createElement('article');
    card.className = 'entry-card';
    const winClass = stats.winrate >= 60 ? 'good' : stats.winrate >= 45 ? 'mid' : 'bad';

    card.innerHTML = `
      <div class="entry-header">
        <div>
          <h3>${escapeHtml(entry.uploader || 'Anonymous')}</h3>
          <span class="entry-date">${fmtDate(entry.date)}</span>
        </div>
        <div class="entry-stats">
          <span class="stat winrate ${winClass}">${stats.winrate.toFixed(1)}% winrate</span>
          <span class="stat">${stats.numTrades} trade${stats.numTrades === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div class="trade-grid">
        ${(entry.trades || []).map((t) => `
          <div class="trade-chip">
            <div class="trade-thumb-wrap">
              <img class="trade-thumb" src="${rawUrl(t.image)}" data-full="${rawUrl(t.image)}" loading="lazy" alt="${t.result === 'win' ? 'Winning' : 'Losing'} trade screenshot" />
              <span class="result-badge ${t.result}">${t.result === 'win' ? 'W' : 'L'}</span>
            </div>
            <div class="trade-chip-tags">${(t.tags || []).map((tag) => `<span class="tag-chip static mini">${escapeHtml(tag)}</span>`).join('')}</div>
          </div>
        `).join('')}
      </div>
      <div class="entry-comments">
        <h4>Notes</h4>
        <div class="comments-list">
          ${(entry.comments || []).map((c) => `
            <div class="comment">
              <span class="comment-author">${escapeHtml(c.author || 'Anonymous')}</span>
              <span class="comment-date">${fmtDate(c.date)}</span>
              <p>${escapeHtml(c.text)}</p>
            </div>`).join('') || '<p class="hint">No notes yet.</p>'}
        </div>
        <form class="comment-form">
          <input type="text" class="comment-name" placeholder="Your name" value="${escapeHtml(getLastName())}" />
          <textarea placeholder="Add a note about this ${entryNoun} session…" rows="2" required></textarea>
          <div class="comment-form-actions"><button type="submit" class="btn btn-secondary">Add note</button></div>
        </form>
      </div>
    `;

    card.querySelectorAll('.trade-thumb').forEach((img) => {
      img.addEventListener('click', () => openLightbox(img.dataset.full));
    });

    card.querySelector('.comment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = e.target.querySelector('.comment-name');
      const textarea = e.target.querySelector('textarea');
      const author = nameInput.value.trim() || 'Anonymous';
      const text = textarea.value.trim();
      if (!text) return;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const updated = await updateJsonFile(dataPath, (data) => {
          const target = data.find((x) => x.id === entry.id);
          if (target) {
            target.comments = target.comments || [];
            target.comments.push({ id: uuid(), author, text, date: new Date().toISOString().slice(0, 10) });
          }
          return data;
        }, `${commitPrefix}: note on ${entry.uploader || entry.id}`);
        setLastName(author);
        state.entries = updated;
        renderList();
        toast('Note added.', 'success');
      } catch (err) {
        toast(err.message || 'Could not save note.', 'error');
        btn.disabled = false;
        btn.textContent = 'Add note';
      }
    });

    return card;
  }

  function renderList() {
    const visible = state.entries
      .filter((e) => !state.activeFilterTag || (e.trades || []).some((t) => (t.tags || []).includes(state.activeFilterTag)))
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', visible.length > 0);
    visible.forEach((entry) => listEl.appendChild(renderCard(entry)));
  }

  async function load() {
    try {
      state.entries = await getJson(dataPath, []);
      renderList();
      renderFilterBar();
    } catch (err) {
      toast(err.message || 'Could not load data from GitHub.', 'error');
    }
  }

  load();
}
