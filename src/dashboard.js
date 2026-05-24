import { state, isPinned } from './state.js';
import { escapeHtml, showToast, timeAgo, formatDate } from './utils.js';
import { getCategoryColor, getCategoryBackgroundColor, populateCategoryFilter, renderHiddenCategories } from './categories.js';
import { getTagKey, normalizeTags } from './tags.js';

let _openDetail, _launchClaude, _launchVSCode, _launchTerminal, _openFolder, _updateInboxBadge;

export function initDashboard({ openDetail, launchClaude, launchVSCode, launchTerminal, openFolder, updateInboxBadge }) {
  _openDetail = openDetail;
  _launchClaude = launchClaude;
  _launchVSCode = launchVSCode;
  _launchTerminal = launchTerminal;
  _openFolder = openFolder;
  _updateInboxBadge = updateInboxBadge;
}

const SORT_ORDERS = {
  status: { active: 0, service: 1, paused: 2, idea: 3, sandbox: 4, done: 5, legacy: 6, unknown: 7 },
  priority: { high: 0, medium: 1, low: 2 },
};

export function renderTable() {
  const tbody = document.getElementById('projectTableBody');
  const filtered = getFilteredProjects();
  const sorted = sortProjects(filtered);

  if (sorted.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('emptyState').style.display = 'block';
    return;
  }

  document.getElementById('emptyState').style.display = 'none';

  const lastPinnedIdx = sorted.reduce((last, p, i) => isPinned(p.id) ? i : last, -1);

  tbody.innerHTML = sorted.map((p, i) => {
    const pinned = isPinned(p.id);
    const isLastPinned = i === lastPinnedIdx;
    return `
    <tr data-path="${escapeHtml(p.path)}" class="${pinned ? 'pinned-row' : ''} ${isLastPinned ? 'pinned-last' : ''}">
      <td>
        <button class="pin-btn ${pinned ? 'pinned' : ''}" data-action="toggle-pin" data-id="${escapeHtml(p.id)}" title="${pinned ? 'Unpin' : 'Pin to top'}">&#9733;</button>
        <span class="project-name">${escapeHtml(p.name)}</span>
        ${p.parseErrors.length ? '<span class="parse-error" title="' + escapeHtml(p.parseErrors.join('; ')) + '">&#9888;</span>' : ''}
      </td>
      <td><span class="badge-status ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
      <td><span class="badge-priority ${escapeHtml(p.priority)}">${escapeHtml(p.priority)}</span></td>
      <td><span class="badge-category" style="color:${getCategoryColor(p.category)};background:${getCategoryBackgroundColor(p.category)}">${escapeHtml(p.category)}</span></td>
      <td>${p.gitBranch ? `<span class="branch-name">${escapeHtml(p.gitBranch)}</span>${p.gitDirty ? '<span class="git-dirty" title="Uncommitted changes">*</span>' : ''}${p.gitUnpushed > 0 ? `<span class="git-unpushed" title="${p.gitUnpushed} unpushed commit${p.gitUnpushed > 1 ? 's' : ''}">↑${p.gitUnpushed}</span>` : ''}` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-size:13px;color:var(--text-secondary)">${p.lastActivity ? timeAgo(p.lastActivity) : '—'}</td>
      <td style="font-size:13px;color:var(--text-muted)">${formatDate(p.createdDate)}</td>
      <td><span class="next-step">${escapeHtml(p.next || '—')}</span></td>
      <td>
        <div class="action-btns">
          <button class="action-btn claude-btn" data-action="launch-claude" data-path="${escapeHtml(p.path)}" title="Claude Code">&#9672;</button>
          <button class="action-btn" data-action="launch-vscode" data-path="${escapeHtml(p.path)}" title="VS Code">&#60;/&#62;</button>
          <button class="action-btn" data-action="launch-terminal" data-path="${escapeHtml(p.path)}" title="Terminal">&#9638;</button>
          <button class="action-btn" data-action="open-folder" data-path="${escapeHtml(p.path)}" title="Folder">&#128193;</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  updateSortHeaders();
}

export async function togglePin(projectId) {
  const result = await window.nexus.togglePin(projectId);
  if (result.success) {
    state.pinnedIds = result.pinnedIds;
    renderTable();
    showToast(isPinned(projectId) ? 'Pinned to top' : 'Unpinned');
  }
}

export function getFilteredProjects() {
  const status = document.getElementById('filterStatus').value;
  const category = document.getElementById('filterCategory').value;
  const priority = document.getElementById('filterPriority').value;
  const search = document.getElementById('searchInput').value.toLowerCase();
  const tagSearch = getTagSearch(search);

  return state.allProjects.filter(p => {
    if (!state.showLegacy && p.status === 'legacy') return false;
    if (!state.showSandbox && p.status === 'sandbox' && !status) return false;
    if (!state.showDone && p.status === 'done' && !status) return false;
    if (state.hiddenCategories.has(p.category)) return false;
    if (status && p.status !== status) return false;
    if (category && p.category !== category) return false;
    if (priority && p.priority !== priority) return false;
    if (tagSearch) return normalizeTags(p.tags || []).some(t => getTagKey(t) === tagSearch);
    if (search && !p.name.toLowerCase().includes(search) &&
        !(p.description || '').toLowerCase().includes(search) &&
        !(p.next || '').toLowerCase().includes(search) &&
        !normalizeTags(p.tags || []).some(t => t.toLowerCase().includes(search))) return false;
    return true;
  });
}

function getTagSearch(search) {
  const value = String(search || '').trim();
  if (!value.startsWith('tag:')) return '';
  return getTagKey(value.slice(4));
}

function sortProjects(projects) {
  const { key, desc } = state.currentSort;
  const sorted = [...projects].sort((a, b) => {
    const primary = compareProjectField(a, b, key, desc);
    if (primary !== 0) return primary;

    if (key !== 'priority') {
      const priority = compareProjectField(a, b, 'priority', false);
      if (priority !== 0) return priority;
    }

    const activity = compareProjectField(a, b, 'lastActivity', true);
    if (activity !== 0) return activity;

    return compareProjectField(a, b, 'name', false);
  });
  const pinned = sorted.filter(p => isPinned(p.id));
  const unpinned = sorted.filter(p => !isPinned(p.id));
  return [...pinned, ...unpinned];
}

function compareProjectField(a, b, key, desc) {
  let va = a[key], vb = b[key];
  const order = SORT_ORDERS[key];

  if (order) {
    va = order[String(va || '').toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
    vb = order[String(vb || '').toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  } else {
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
  }

  if (va < vb) return desc ? 1 : -1;
  if (va > vb) return desc ? -1 : 1;
  return 0;
}

function updateSortHeaders() {
  document.querySelectorAll('#projectTable th.sortable').forEach(th => {
    th.classList.remove('sort-active', 'sort-desc');
    if (th.dataset.sort === state.currentSort.key) {
      th.classList.add('sort-active');
      if (state.currentSort.desc) th.classList.add('sort-desc');
    }
  });
}

export function updateProjectCount() {
  const filtered = getFilteredProjects();
  const hidden = state.hiddenCategories.size > 0 || document.getElementById('filterStatus').value || document.getElementById('filterCategory').value || document.getElementById('filterPriority').value;
  document.getElementById('projectCount').textContent = hidden
    ? `${filtered.length}/${state.allProjects.length} projects`
    : `${state.allProjects.length} projects`;
}

export function setupDashboardListeners() {
  document.querySelectorAll('#projectTable th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.currentSort.key === key) {
        state.currentSort.desc = !state.currentSort.desc;
      } else {
        state.currentSort = { key, desc: false };
      }
      renderTable();
    });
  });

  document.getElementById('projectTableBody').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === 'toggle-pin') togglePin(actionBtn.dataset.id);
      else if (action === 'launch-claude') _launchClaude(actionBtn.dataset.path);
      else if (action === 'launch-vscode') _launchVSCode(actionBtn.dataset.path);
      else if (action === 'launch-terminal') _launchTerminal(actionBtn.dataset.path);
      else if (action === 'open-folder') _openFolder(actionBtn.dataset.path);
      return;
    }
    const row = e.target.closest('tr[data-path]');
    if (row && _openDetail) _openDetail(row.dataset.path);
  });

  ['filterStatus', 'filterCategory', 'filterPriority'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { renderTable(); updateProjectCount(); });
  });

  document.getElementById('searchInput').addEventListener('input', () => { renderTable(); updateProjectCount(); });

  document.getElementById('btnRescan').addEventListener('click', async () => {
    showToast('Rescanning...');
    state.allProjects = await window.nexus.rescan();
    renderTable();
    if (_updateInboxBadge) _updateInboxBadge();
    populateCategoryFilter();
    renderHiddenCategories();
    updateProjectCount();
    showToast(`Rescan complete — ${state.allProjects.length} projects`);
  });
}
