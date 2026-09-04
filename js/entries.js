// Shared logic for the Trading Results and Backtesting Results pages.
//
// Data model: a "session" (one entry in trades.json / backtests.json) is
// uploaded by one person on one date, and is built up trade-by-trade. Each
// trade has its own screenshot, win/loss result, and tags. A session's
// winrate and trade count are never entered manually — they're always
// computed from its trades.

import { getLastName, setLastName, getJson, updateJsonFile, uploadImageFile, deleteFile, uuid, toast, rawUrl } from './store.js';

const PRESET_TAG_GROUPS = [
  { group: 'Market Structure', tags: ['BOS', 'CHOCH'] },
  { group: 'Trend', tags: ['With trend', 'Against trend'] },
  { group: 'Setup', tags: ['Swing'] },
  { group: 'Confirmation', tags: ['Support/Resistance'] }
];

// Guards against malformed/legacy tag data (e.g. the pre-grouping flat array
// of tag-name strings, or a stray non-object entry) so a bad read degrades
// gracefully instead of crashing every tag picker on the page.
function normalizeTagGroups(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (typeof raw[0] === 'string') {
    return [{ group: 'Tags', tags: raw.filter((t) => typeof t === 'string') }];
  }
  return raw
    .filter((g) => g && typeof g === 'object' && Array.isArray(g.tags))
    .map((g) => ({ group: String(g.group || 'Other'), tags: g.tags.filter((t) => typeof t === 'string') }));
}

function flattenTagGroups(groups) {
  const set = new Set();
  (groups || []).forEach((g) => (g.tags || []).forEach((t) => set.add(t)));
  return Array.from(set);
}

// Clones a groups array and buckets any tag not already in a group into an
// "Other" group, so historical/ad-hoc tags still show up somewhere pickable.
function tagGroupsWithExtras(groups, extraTags) {
  const normalized = normalizeTagGroups(groups);
  const cloned = (normalized.length ? normalized : PRESET_TAG_GROUPS).map((g) => ({ group: g.group, tags: [...g.tags] }));
  const known = new Set(flattenTagGroups(cloned));
  const extras = (extraTags || []).filter((t) => !known.has(t));
  if (extras.length === 0) return cloned;
  const other = cloned.find((g) => g.group === 'Other');
  if (other) extras.forEach((t) => other.tags.push(t));
  else cloned.push({ group: 'Other', tags: extras });
  return cloned;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Today" for this app is always US Eastern time (where the market session
// clock lives), regardless of the visitor's own timezone — not UTC, which is
// what `new Date().toISOString()` would give and rolls over hours before
// Eastern midnight (the bug this fixes: an evening EDT upload getting
// stamped with tomorrow's UTC date). Intl handles the EDT/EST switch itself.
function todayEastern() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
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

// Renders a grouped, toggle-select tag picker into `container`. Used by both
// the session builder's trade form and the saved-trade tag editor.
function renderGroupedTagPicker(container, groups, isSelected, onToggle) {
  container.innerHTML = '';
  groups.forEach(({ group, tags }) => {
    if (!tags.length) return;
    const section = document.createElement('div');
    section.className = 'tag-group';
    const label = document.createElement('div');
    label.className = 'tag-group-label';
    label.textContent = group;
    const row = document.createElement('div');
    row.className = 'tag-row';
    tags.forEach((t) => row.appendChild(makeTagChip(t, isSelected(t), onToggle)));
    section.appendChild(label);
    section.appendChild(row);
    container.appendChild(section);
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

// --- Global tag manager ------------------------------------------------------

function openTagManager(ctx) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal tag-manager-modal">
      <div class="modal-header">
        <h2>Edit tags</h2>
        <button type="button" class="btn-icon" id="tags-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <p class="hint">Organize the default tags into groups (e.g. Market Structure, Confirmation) — shared across Trading and Backtesting. Changes apply everywhere immediately.</p>
        <div id="tag-groups-list"></div>
        <div class="tag-add-row">
          <input type="text" id="new-group-input" placeholder="New group name and press Enter" />
          <button type="button" id="new-group-btn" class="btn btn-ghost">+ Add group</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#tags-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const normalizedInput = normalizeTagGroups(ctx.groups);
  let groups = (normalizedInput.length ? normalizedInput : PRESET_TAG_GROUPS).map((g) => ({ group: g.group, tags: [...g.tags] }));

  function render() {
    const wrap = overlay.querySelector('#tag-groups-list');
    wrap.innerHTML = '';
    if (groups.length === 0) { wrap.innerHTML = '<p class="hint">No groups yet — add one below.</p>'; return; }

    groups.forEach(({ group, tags }) => {
      const block = document.createElement('div');
      block.className = 'tag-group-block';
      block.innerHTML = `
        <div class="tag-group-header">
          <h4>${escapeHtml(group)}</h4>
          <button type="button" class="btn-icon remove-group-btn" title="Remove group" aria-label="Remove group">🗑</button>
        </div>
        <div class="tag-row group-tags"></div>
        <div class="tag-add-row">
          <input type="text" class="group-tag-input" placeholder="Add tag to ${escapeHtml(group)} and press Enter" />
          <button type="button" class="btn btn-ghost group-tag-add-btn">+ Add</button>
        </div>
      `;
      const tagRow = block.querySelector('.group-tags');
      if (tags.length === 0) tagRow.innerHTML = '<p class="hint">No tags in this group yet.</p>';
      else tags.forEach((t) => tagRow.appendChild(makeTagChip(t, true, () => removeTag(group, t), true)));

      block.querySelector('.remove-group-btn').addEventListener('click', () => removeGroup(group, tags.length));

      const input = block.querySelector('.group-tag-input');
      const addHandler = () => {
        const val = input.value.trim();
        if (!val) return;
        input.value = '';
        addTag(group, val);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addHandler(); } });
      block.querySelector('.group-tag-add-btn').addEventListener('click', addHandler);

      wrap.appendChild(block);
    });
  }

  async function save(mutateFn, successMsg) {
    try {
      const updated = await updateJsonFile('data/tags.json', mutateFn, 'Update tag groups');
      groups = updated;
      render();
      ctx.onChange(groups);
      toast(successMsg, 'success');
    } catch (err) {
      toast(err.message || 'Could not update tags.', 'error');
    }
  }

  function addTag(groupName, tag) {
    save((data) => data.map((g) => (g.group === groupName ? { ...g, tags: g.tags.includes(tag) ? g.tags : [...g.tags, tag] } : g)), `Added "${tag}" to ${groupName}.`);
  }

  function removeTag(groupName, tag) {
    save((data) => data.map((g) => (g.group === groupName ? { ...g, tags: g.tags.filter((t) => t !== tag) } : g)), `Removed "${tag}".`);
  }

  function removeGroup(groupName, tagCount) {
    if (tagCount > 0) {
      const ok = window.confirm(`Remove "${groupName}" and its ${tagCount} tag${tagCount === 1 ? '' : 's'}?`);
      if (!ok) return;
    }
    save((data) => data.filter((g) => g.group !== groupName), `Removed group "${groupName}".`);
  }

  function addGroup() {
    const input = overlay.querySelector('#new-group-input');
    const val = input.value.trim();
    if (!val) return;
    if (groups.some((g) => g.group === val)) { toast('That group already exists.', 'error'); return; }
    input.value = '';
    save((data) => (data.some((g) => g.group === val) ? data : [...data, { group: val, tags: [] }]), `Added group "${val}".`);
  }

  overlay.querySelector('#new-group-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addGroup(); }
  });
  overlay.querySelector('#new-group-btn').addEventListener('click', addGroup);

  render();
}

// --- Editing tags on an already-saved trade ---------------------------------

function openTradeTagEditor({ dataPath, commitPrefix, entryId, trade, knownTagGroups, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const thumbSrc = rawUrl(trade.image);
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Edit trade tags</h2>
        <button type="button" class="btn-icon" id="trade-tags-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <img class="file-thumb" id="trade-tags-thumb" src="${thumbSrc}" alt="Trade screenshot" />
        <label class="block-label" style="margin-top: 14px;">Tags</label>
        <div id="edit-trade-tags" class="tag-row"></div>
        <div class="tag-add-row">
          <input type="text" id="edit-trade-tag-input" placeholder="Add a custom tag and press Enter" />
          <button type="button" id="edit-trade-add-tag-btn" class="btn btn-ghost">+ Add tag</button>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" id="trade-tags-save" class="btn btn-primary">Save tags</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#trade-tags-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#trade-tags-thumb').addEventListener('click', () => openLightbox(thumbSrc));

  const selected = new Set(trade.tags || []);
  const groups = tagGroupsWithExtras(knownTagGroups, Array.from(selected));

  function renderChips() {
    const wrap = overlay.querySelector('#edit-trade-tags');
    renderGroupedTagPicker(wrap, groups, (t) => selected.has(t), (tag) => {
      if (selected.has(tag)) selected.delete(tag); else selected.add(tag);
      renderChips();
    });
  }
  renderChips();

  function addFromInput() {
    const input = overlay.querySelector('#edit-trade-tag-input');
    const val = input.value.trim();
    if (!val) return;
    selected.add(val);
    let other = groups.find((g) => g.group === 'Other');
    if (!other) { other = { group: 'Other', tags: [] }; groups.push(other); }
    if (!other.tags.includes(val)) other.tags.push(val);
    input.value = '';
    renderChips();
  }
  overlay.querySelector('#edit-trade-tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFromInput(); }
  });
  overlay.querySelector('#edit-trade-add-tag-btn').addEventListener('click', addFromInput);

  overlay.querySelector('#trade-tags-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#trade-tags-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const newTags = Array.from(selected);
      const updated = await updateJsonFile(dataPath, (data) => {
        const targetEntry = data.find((x) => x.id === entryId);
        const targetTrade = targetEntry && (targetEntry.trades || []).find((t) => t.id === trade.id);
        if (targetTrade) targetTrade.tags = newTags;
        return data;
      }, `${commitPrefix}: edit tags on trade ${trade.id}`);
      onSaved(updated);
      overlay.remove();
      toast('Tags updated.', 'success');
    } catch (err) {
      toast(err.message || 'Could not update tags.', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save tags';
    }
  });
}

// --- Session builder (the "Upload session" modal flow) ---------------------

function openSessionBuilder(ctx) {
  const session = { id: uuid(), uploader: getLastName(), date: todayEastern(), trades: [] };
  const normalizedKnown = normalizeTagGroups(ctx.knownTagGroups);
  const knownGroups = (normalizedKnown.length ? normalizedKnown : PRESET_TAG_GROUPS).map((g) => ({ group: g.group, tags: [...g.tags] }));
  let mode = 'idle'; // 'idle' | 'adding'
  let editingId = null;
  let pending = { file: null, result: null, tags: new Set(), previewUrl: null };

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
    renderGroupedTagPicker(wrap, knownGroups, (t) => pending.tags.has(t), toggleTradeTag);
  }

  function toggleTradeTag(tag) {
    if (pending.tags.has(tag)) pending.tags.delete(tag); else pending.tags.add(tag);
    renderTradeTags();
  }

  function addPendingTagFromInput() {
    const input = body.querySelector('#trade-tag-input');
    const val = input.value.trim();
    if (val) {
      pending.tags.add(val);
      // a newly-used tag becomes selectable for the rest of this session, bucketed under "Other"
      let other = knownGroups.find((g) => g.group === 'Other');
      if (!other) { other = { group: 'Other', tags: [] }; knownGroups.push(other); }
      if (!other.tags.includes(val)) other.tags.push(val);
      input.value = '';
      renderTradeTags();
    }
  }

  function renderFilePreview() {
    const preview = body.querySelector('#trade-file-preview');
    if (!preview) return;
    preview.innerHTML = '';
    if (pending.previewUrl) {
      const img = document.createElement('img');
      img.className = 'file-thumb';
      img.src = pending.previewUrl;
      img.title = 'Click to view full size';
      img.addEventListener('click', () => openLightbox(pending.previewUrl));
      preview.appendChild(img);
    }
  }

  function resetPending() {
    editingId = null;
    pending = { file: null, result: null, tags: new Set(), previewUrl: null };
  }

  function startEditTrade(trade) {
    editingId = trade.id;
    pending = { file: null, result: trade.result, tags: new Set(trade.tags || []), previewUrl: trade.previewUrl };
    mode = 'adding';
    renderBody();
  }

  function renderBody() {
    const stats = computeStats(session.trades);

    if (mode === 'adding') {
      const isEditing = !!editingId;
      body.innerHTML = `
        <div class="session-meta-row">
          <label>Uploader name<input type="text" id="s-uploader" value="${escapeHtml(session.uploader)}" /></label>
          <label>Date<input type="date" id="s-date" value="${session.date}" max="${todayEastern()}" /></label>
        </div>
        <h3 class="trade-form-title">${isEditing ? 'Edit trade' : `Add trade ${session.trades.length + 1}`}</h3>

        <label class="block-label">Screenshot</label>
        <input type="file" id="trade-file" accept="image/*" />
        <div id="trade-file-preview" class="file-preview-row"></div>

        <label class="block-label">Result</label>
        <div class="result-toggle">
          <button type="button" class="result-btn win ${pending.result === 'win' ? 'active' : ''}" data-result="win">✓ Win</button>
          <button type="button" class="result-btn loss ${pending.result === 'loss' ? 'active' : ''}" data-result="loss">✕ Loss</button>
        </div>

        <label class="block-label">Tags</label>
        <div id="trade-tags" class="tag-row"></div>
        <div class="tag-add-row">
          <input type="text" id="trade-tag-input" placeholder="Add a custom tag and press Enter" />
          <button type="button" id="trade-add-tag-btn" class="btn btn-ghost">+ Add tag</button>
        </div>

        <div class="form-actions builder-actions">
          <button type="button" id="trade-cancel-btn" class="btn btn-secondary">Cancel</button>
          ${isEditing ? '<button type="button" id="trade-remove-btn" class="btn btn-danger">Remove trade</button>' : ''}
          <button type="button" id="trade-complete-btn" class="btn btn-primary">${isEditing ? 'Save changes' : 'Complete trade'}</button>
        </div>
      `;

      body.querySelector('#s-uploader').addEventListener('input', (e) => { session.uploader = e.target.value; });
      body.querySelector('#s-date').addEventListener('input', (e) => {
        const today = todayEastern();
        if (e.target.value > today) { e.target.value = today; }
        session.date = e.target.value;
      });

      renderFilePreview();
      body.querySelector('#trade-file').addEventListener('change', (e) => {
        const file = e.target.files[0] || null;
        if (!file) return;
        pending.file = file;
        const reader = new FileReader();
        reader.onload = (ev) => { pending.previewUrl = ev.target.result; renderFilePreview(); };
        reader.readAsDataURL(file);
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
        resetPending();
        mode = 'idle';
        renderBody();
      });
      const removeBtn = body.querySelector('#trade-remove-btn');
      if (removeBtn) removeBtn.addEventListener('click', removeEditingTrade);
      body.querySelector('#trade-complete-btn').addEventListener('click', saveTrade);
    } else {
      body.innerHTML = `
        <div class="session-meta-row">
          <label>Uploader name<input type="text" id="s-uploader" value="${escapeHtml(session.uploader)}" /></label>
          <label>Date<input type="date" id="s-date" value="${session.date}" max="${todayEastern()}" /></label>
        </div>

        ${session.trades.length > 0 ? `
          <div class="session-tally">
            <span class="stat winrate ${stats.winrate >= 60 ? 'good' : stats.winrate >= 45 ? 'mid' : 'bad'}">${stats.winrate.toFixed(1)}% winrate</span>
            <span class="stat">${stats.numTrades} trade${stats.numTrades === 1 ? '' : 's'} logged</span>
            <span class="stat">${stats.wins}W / ${stats.losses}L</span>
          </div>
          <div class="logged-trades-row">
            ${session.trades.map((t, i) => `
              <div class="logged-trade-chip" data-trade-id="${escapeHtml(t.id)}" title="Click to edit">
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
      body.querySelector('#s-date').addEventListener('input', (e) => {
        const today = todayEastern();
        if (e.target.value > today) { e.target.value = today; }
        session.date = e.target.value;
      });
      body.querySelector('#add-trade-btn').addEventListener('click', () => {
        resetPending();
        mode = 'adding';
        renderBody();
      });
      body.querySelectorAll('.logged-trade-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const trade = session.trades.find((t) => t.id === chip.dataset.tradeId);
          if (trade) startEditTrade(trade);
        });
      });
      const finishBtn = body.querySelector('#finish-session-btn');
      if (finishBtn) finishBtn.addEventListener('click', finishSession);
    }
  }

  function removeEditingTrade() {
    const idx = session.trades.findIndex((t) => t.id === editingId);
    if (idx !== -1) {
      const [removed] = session.trades.splice(idx, 1);
      if (removed.imageSha) deleteFile(removed.image, removed.imageSha, `${ctx.commitPrefix}: cleanup removed photo`).catch(() => {});
    }
    resetPending();
    mode = 'idle';
    renderBody();
    toast('Trade removed.', 'success');
  }

  async function saveTrade() {
    const existingTrade = editingId ? session.trades.find((t) => t.id === editingId) : null;
    if (!editingId && !pending.file) { toast('Choose a screenshot for this trade.', 'error'); return; }
    if (!pending.result) { toast('Mark this trade as a win or a loss.', 'error'); return; }

    const saveBtn = body.querySelector('#trade-complete-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = pending.file ? 'Uploading…' : 'Saving…';
    try {
      let image;
      let imageSha;
      let previewUrl;

      if (pending.file) {
        const path = `${ctx.imageDir}/${session.id}-${uuid()}.jpg`;
        const uploadRes = await uploadImageFile(pending.file, path, `${ctx.commitPrefix}: trade photo for ${session.uploader || 'session'}`);
        image = path;
        imageSha = uploadRes.sha;
        previewUrl = rawUrl(path);
        if (existingTrade && existingTrade.imageSha) {
          deleteFile(existingTrade.image, existingTrade.imageSha, `${ctx.commitPrefix}: cleanup replaced photo`).catch(() => {});
        }
      } else if (existingTrade) {
        ({ image, imageSha, previewUrl } = existingTrade);
      }

      const tradeRecord = { id: editingId || uuid(), result: pending.result, tags: Array.from(pending.tags), image, imageSha, previewUrl };

      if (editingId) {
        const idx = session.trades.findIndex((t) => t.id === editingId);
        if (idx !== -1) session.trades[idx] = tradeRecord;
      } else {
        session.trades.push(tradeRecord);
      }

      const wasEditing = !!editingId;
      resetPending();
      mode = 'idle';
      renderBody();
      toast(wasEditing ? 'Trade updated.' : 'Trade added to session.', 'success');
    } catch (err) {
      toast(err.message || 'Could not save trade.', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = editingId ? 'Save changes' : 'Complete trade';
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
        date: session.date || todayEastern(),
        trades: session.trades.map(({ id, result, tags, image, imageSha }) => ({ id, result, tags, image, imageSha })),
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
  const state = { entries: [], tagGroups: [], activeFilterTags: new Set(), activeFilterUploader: null, tagMatchMode: 'subset' };

  const listEl = document.getElementById('entry-list');
  const emptyEl = document.getElementById('entry-empty');
  const filterBarEl = document.getElementById('filter-bar');
  const uploaderFilterBarEl = document.getElementById('uploader-filter-bar');
  const tagMatchToggleEl = document.getElementById('tag-match-toggle');
  const startBtn = document.getElementById('start-session-btn');
  const editTagsBtn = document.getElementById('edit-tags-btn');

  if (tagMatchToggleEl) {
    tagMatchToggleEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tagMatchMode = btn.dataset.mode;
        tagMatchToggleEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        renderList();
      });
    });
  }

  startBtn.addEventListener('click', () => {
    openSessionBuilder({
      dataPath,
      imageDir,
      entryNoun,
      commitPrefix,
      knownTagGroups: allKnownTagGroups(),
      onFinished: (updated) => { state.entries = updated; renderList(); renderFilterBars(); }
    });
  });

  if (editTagsBtn) {
    editTagsBtn.addEventListener('click', () => {
      openTagManager({
        groups: state.tagGroups,
        onChange: (updated) => { state.tagGroups = updated; renderFilterBar(); }
      });
    });
  }

  function allKnownTags() {
    const set = new Set(flattenTagGroups(state.tagGroups.length ? state.tagGroups : PRESET_TAG_GROUPS));
    state.entries.forEach((e) => (e.trades || []).forEach((t) => (t.tags || []).forEach((tag) => set.add(tag))));
    return Array.from(set);
  }

  function allKnownTagGroups() {
    return tagGroupsWithExtras(state.tagGroups, allKnownTags());
  }

  function allKnownUploaders() {
    const set = new Set();
    state.entries.forEach((e) => { if (e.uploader) set.add(e.uploader); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function matchesTagFilter(tags) {
    if (state.activeFilterTags.size === 0) return true;
    const tagSet = new Set(tags || []);
    const selected = Array.from(state.activeFilterTags);
    if (state.tagMatchMode === 'exact') return selected.length === tagSet.size && selected.every((t) => tagSet.has(t));
    return selected.every((t) => tagSet.has(t));
  }

  function renderFilterBar() {
    filterBarEl.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `tag-chip filter ${state.activeFilterTags.size === 0 ? 'active' : ''}`;
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { state.activeFilterTags.clear(); renderList(); renderFilterBar(); });
    filterBarEl.appendChild(allBtn);

    allKnownTags().forEach((t) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `tag-chip filter ${state.activeFilterTags.has(t) ? 'active' : ''}`;
      chip.textContent = t;
      chip.addEventListener('click', () => {
        if (state.activeFilterTags.has(t)) state.activeFilterTags.delete(t); else state.activeFilterTags.add(t);
        renderList();
        renderFilterBar();
      });
      filterBarEl.appendChild(chip);
    });
  }

  function renderUploaderFilterBar() {
    if (!uploaderFilterBarEl) return;
    uploaderFilterBarEl.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `tag-chip filter ${!state.activeFilterUploader ? 'active' : ''}`;
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { state.activeFilterUploader = null; renderList(); renderUploaderFilterBar(); });
    uploaderFilterBarEl.appendChild(allBtn);

    allKnownUploaders().forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `tag-chip filter ${state.activeFilterUploader === name ? 'active' : ''}`;
      chip.textContent = name;
      chip.addEventListener('click', () => { state.activeFilterUploader = name; renderList(); renderUploaderFilterBar(); });
      uploaderFilterBarEl.appendChild(chip);
    });
  }

  function renderFilterBars() {
    renderFilterBar();
    renderUploaderFilterBar();
  }

  async function deleteSession(entry) {
    const ok = window.confirm(`Delete this ${entryNoun} session by ${entry.uploader || 'Anonymous'}? This can't be undone.`);
    if (!ok) return;
    try {
      const updated = await updateJsonFile(dataPath, (data) => data.filter((x) => x.id !== entry.id), `${commitPrefix}: delete session by ${entry.uploader || 'Anonymous'}`);
      state.entries = updated;
      renderList();
      renderFilterBars();
      toast('Session deleted.', 'success');
      (entry.trades || []).forEach((t) => {
        if (t.imageSha) deleteFile(t.image, t.imageSha, `${commitPrefix}: cleanup photo after session delete`).catch(() => {});
      });
    } catch (err) {
      toast(err.message || 'Could not delete session.', 'error');
    }
  }

  async function deleteTrade(entry, trade) {
    const ok = window.confirm('Delete this trade from the session?');
    if (!ok) return;
    try {
      const updated = await updateJsonFile(dataPath, (data) => {
        const target = data.find((x) => x.id === entry.id);
        if (target) target.trades = (target.trades || []).filter((t) => t.id !== trade.id);
        return data;
      }, `${commitPrefix}: delete trade from session by ${entry.uploader || 'Anonymous'}`);
      state.entries = updated;
      renderList();
      renderFilterBars();
      toast('Trade deleted.', 'success');
      if (trade.imageSha) deleteFile(trade.image, trade.imageSha, `${commitPrefix}: cleanup photo after trade delete`).catch(() => {});
    } catch (err) {
      toast(err.message || 'Could not delete trade.', 'error');
    }
  }

  function renderCard(entry) {
    const stats = computeStats(entry.trades);
    const allTrades = entry.trades || [];
    const visibleTrades = allTrades.filter((t) => matchesTagFilter(t.tags));
    const isFiltered = state.activeFilterTags.size > 0 && visibleTrades.length !== allTrades.length;
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
          <button type="button" class="btn-icon delete-session-btn" title="Delete session" aria-label="Delete session">🗑</button>
        </div>
      </div>
      ${isFiltered ? `<p class="hint filter-note">Showing ${visibleTrades.length} of ${allTrades.length} trades matching the tag filter</p>` : ''}
      <div class="trade-grid">
        ${visibleTrades.map((t) => `
          <div class="trade-chip" data-trade-id="${escapeHtml(t.id)}">
            <div class="trade-thumb-wrap">
              <img class="trade-thumb" src="${rawUrl(t.image)}" data-full="${rawUrl(t.image)}" loading="lazy" alt="${t.result === 'win' ? 'Winning' : 'Losing'} trade screenshot" />
              <span class="result-badge ${t.result}">${t.result === 'win' ? 'W' : 'L'}</span>
              <button type="button" class="trade-delete-btn" title="Delete trade" aria-label="Delete trade">✕</button>
            </div>
            <div class="trade-chip-tags">${(t.tags || []).map((tag) => `<span class="tag-chip static mini">${escapeHtml(tag)}</span>`).join('')}</div>
            <button type="button" class="trade-edit-tags-btn">✏ Edit tags</button>
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

    card.querySelector('.delete-session-btn').addEventListener('click', () => deleteSession(entry));

    card.querySelectorAll('.trade-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tradeId = btn.closest('.trade-chip').dataset.tradeId;
        const trade = (entry.trades || []).find((t) => t.id === tradeId);
        if (trade) deleteTrade(entry, trade);
      });
    });

    card.querySelectorAll('.trade-edit-tags-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tradeId = btn.closest('.trade-chip').dataset.tradeId;
        const trade = (entry.trades || []).find((t) => t.id === tradeId);
        if (!trade) return;
        openTradeTagEditor({
          dataPath,
          commitPrefix,
          entryId: entry.id,
          trade,
          knownTagGroups: allKnownTagGroups(),
          onSaved: (updated) => { state.entries = updated; renderList(); renderFilterBars(); }
        });
      });
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
            target.comments.push({ id: uuid(), author, text, date: todayEastern() });
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
      .filter((e) => state.activeFilterTags.size === 0 || (e.trades || []).some((t) => matchesTagFilter(t.tags)))
      .filter((e) => !state.activeFilterUploader || e.uploader === state.activeFilterUploader)
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', visible.length > 0);
    visible.forEach((entry) => listEl.appendChild(renderCard(entry)));
  }

  async function load() {
    try {
      let rawTagGroups;
      [state.entries, rawTagGroups] = await Promise.all([
        getJson(dataPath, []),
        getJson('data/tags.json', PRESET_TAG_GROUPS)
      ]);
      state.tagGroups = normalizeTagGroups(rawTagGroups);
      renderList();
      renderFilterBars();
    } catch (err) {
      toast(err.message || 'Could not load data from GitHub.', 'error');
    }
  }

  load();
}
