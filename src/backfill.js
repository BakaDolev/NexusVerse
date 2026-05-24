import { state } from './state.js';
import { escapeHtml, showToast } from './utils.js';
import { getAllCategories } from './categories.js';

let _renderTable;

export function initBackfill({ renderTable }) {
  _renderTable = renderTable;
}

export async function loadBackfill() {
  const list = document.getElementById('backfillList');
  const actions = document.getElementById('backfillActions');
  const loading = document.getElementById('backfillLoading');

  list.innerHTML = '';
  loading.style.display = 'block';
  actions.style.display = 'none';

  const preview = await window.nexus.getBackfillPreview();
  loading.style.display = 'none';

  if (preview.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:20px">All projects have complete frontmatter. Nothing to backfill.</p>';
    return;
  }

  list.innerHTML = preview.map((item, i) => `
    <div class="backfill-item" data-index="${i}">
      <div class="backfill-header">
        <input type="checkbox" checked data-backfill-check="${i}" />
        <span class="name">${escapeHtml(item.name)}</span>
        <span class="action-tag">${item.isContainer ? 'Container' : item.needsFile ? 'New file' : 'Update'}</span>
      </div>
      <div class="backfill-fields">
        <div class="backfill-field">
          <label>ID</label>
          <input type="text" data-bf="${i}" data-field="id" value="${escapeHtml(item.suggested.id || '')}" />
        </div>
        <div class="backfill-field">
          <label>Status</label>
          <select data-bf="${i}" data-field="status">
            ${['active','service','paused','idea','sandbox','done','legacy'].map(s =>
              `<option value="${s}" ${item.suggested.status === s ? 'selected' : ''}>${s}</option>`
            ).join('')}
          </select>
        </div>
        <div class="backfill-field">
          <label>Priority</label>
          <select data-bf="${i}" data-field="priority">
            ${['high','medium','low'].map(s =>
              `<option value="${s}" ${item.suggested.priority === s ? 'selected' : ''}>${s}</option>`
            ).join('')}
          </select>
        </div>
        <div class="backfill-field">
          <label>Category</label>
          <select data-bf="${i}" data-field="category">
            ${getAllCategories().map(s =>
              `<option value="${escapeHtml(s)}" ${item.suggested.category === s ? 'selected' : ''}>${escapeHtml(s)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="backfill-field">
          <label>Scan</label>
          <select data-bf="${i}" data-field="scan">
            ${['auto','container','project'].map(s =>
              `<option value="${s}" ${item.suggested.scan === s ? 'selected' : ''}>${s}</option>`
            ).join('')}
          </select>
        </div>
        <div class="backfill-field">
          <label>Last Touched</label>
          <input type="date" data-bf="${i}" data-field="last_touched" value="${escapeHtml(item.suggested.last_touched || '')}" />
        </div>
        <div class="backfill-field">
          <label>Next Step</label>
          <input type="text" data-bf="${i}" data-field="next" value="${escapeHtml(item.suggested.next || '')}" placeholder="What's next?" />
        </div>
      </div>
    </div>
  `).join('');

  actions.style.display = 'block';

  window._backfillPreview = preview;
}

export function setupBackfillListeners() {
  document.getElementById('btnApplyBackfill').addEventListener('click', async () => {
    const preview = window._backfillPreview;
    if (!preview) return;

    const selections = [];
    for (let i = 0; i < preview.length; i++) {
      const checked = document.querySelector(`[data-backfill-check="${i}"]`);
      if (!checked || !checked.checked) continue;

      const item = preview[i];
      const fields = {};
      document.querySelectorAll(`[data-bf="${i}"]`).forEach(el => {
        fields[el.dataset.field] = el.value;
      });

      selections.push({
        name: item.name,
        path: item.path,
        needsFile: item.needsFile || false,
        ...fields
      });
    }

    if (selections.length === 0) {
      showToast('Nothing selected');
      return;
    }

    showToast(`Applying to ${selections.length} projects...`);
    const results = await window.nexus.applyBackfill(selections);
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    showToast(`Done: ${success} updated${failed ? `, ${failed} failed` : ''}`);

    state.allProjects = await window.nexus.rescan();
    if (_renderTable) _renderTable();
    await loadBackfill();
  });
}
