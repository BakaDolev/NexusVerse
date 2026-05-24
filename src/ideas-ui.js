import { state } from './state.js';
import { escapeHtml, showToast, timeAgo, formatIdeaDate, formatIdeaStatusDate, colorWithAlpha, safeJsonParse, safeJsonParseArray, syncDateTextInput, normalizeDateText, dayFirstToIso } from './utils.js';

let _getCategoryColor;
let _getAllCategories;
let _getTagKey;
let _normalizeTags;
let _renderTable;

export function initIdeas({ getCategoryColor, getAllCategories, getTagKey, normalizeTags, renderTable } = {}) {
  _getCategoryColor = getCategoryColor;
  _getAllCategories = getAllCategories;
  _getTagKey = getTagKey;
  _normalizeTags = normalizeTags;
  _renderTable = renderTable;
}

function getCategoryColorForIdea(category) {
  return _getCategoryColor?.(category) || 'var(--accent)';
}

function getAllIdeaCategories() {
  if (_getAllCategories) return _getAllCategories();
  const configIds = (state.categoryDefs || []).map(c => c.id);
  const fromProjects = state.allProjects.map(p => p.category).filter(Boolean);
  return [...new Set([...configIds, ...fromProjects])];
}

function normalizeIdeaTags(tags) {
  if (_normalizeTags) return _normalizeTags(tags);
  const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const seen = new Set();
  const normalized = [];
  for (const value of values.map(v => String(v || '').trim()).filter(Boolean)) {
    const key = _getTagKey ? _getTagKey(value) : value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

let currentInboxTab = 'all';
let cachedInboxIdeas = [];
let lastProjectHint = '';
const recentlyToggledIdeas = new Set();

export function clearRecentlyToggled() {
  recentlyToggledIdeas.clear();
}

const inboxFilters = {
  search: '',
  project: '',
  datePreset: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'recent',
  hiddenCategories: new Set(safeJsonParseArray('nexus_inboxHiddenCategories', [])),
  includeCompletedByProject: false
};

const inboxGroupState = {
  byProject: { allCollapsed: false, collapsed: {} },
  completed: { allCollapsed: false, collapsed: {} }
};

let scratchpadDebounce = null;
let scratchpadProjectPath = null;
let scratchpadSavePromise = null;
let scratchpadSaveChain = Promise.resolve();
let ideaProjectPickerState = null;
let listenersSetup = false;

export async function loadProjectIdeas(projectPath = state.currentProject?.path, token = state.detailLoadToken) {
  if (!projectPath) return;
  const ideas = unwrapIdeasResult(await window.nexus.getProjectIdeas(projectPath));
  if (token !== state.detailLoadToken || !state.currentProject || state.currentProject.path !== projectPath) return;
  renderIdeasList(ideas, 'projectIdeasList', projectPath + '\\BRAINSTORM.md', state.showCompletedProjectIdeas);
}

export async function loadScratchpad() {
  if (!state.currentProject) return;
  const projectPath = state.currentProject.path;
  scratchpadProjectPath = projectPath;
  const editor = document.getElementById('scratchpadEditor');
  const status = document.getElementById('scratchpadStatus');
  const result = await window.nexus.readScratchpad(projectPath);
  if (scratchpadProjectPath !== projectPath || !state.currentProject) return;
  editor.value = result.content || '';
  status.textContent = result.content ? '' : 'Empty - start typing to create scratchpad';

  editor.oninput = () => {
    status.textContent = 'Saving...';
    if (scratchpadDebounce) clearTimeout(scratchpadDebounce);
    scratchpadDebounce = setTimeout(async () => {
      const savePath = scratchpadProjectPath;
      const saveResult = await saveScratchpadNow(savePath, editor.value);
      if (scratchpadProjectPath === savePath) {
        status.textContent = saveResult.success ? 'Saved' : 'Error: ' + saveResult.error;
        if (saveResult.success) setTimeout(() => {
          if (status.textContent === 'Saved') status.textContent = '';
        }, 2000);
      }
    }, 500);
  };
}

export async function saveScratchpadNow(projectPath, content) {
  if (!projectPath) return { error: 'No project selected' };
  const promise = scratchpadSaveChain
    .catch(() => {})
    .then(() => window.nexus.writeScratchpad(projectPath, content));
  scratchpadSaveChain = promise.then(() => {}, () => {});
  scratchpadSavePromise = promise;
  try {
    return await promise;
  } finally {
    if (scratchpadSavePromise === promise) scratchpadSavePromise = null;
  }
}

export function requireScratchpadSaveSuccess(result) {
  if (!result || result.success !== true) {
    throw new Error(result?.error || 'Scratchpad save failed');
  }
}

export function normalizeScratchpadSaveResult(result) {
  return result?.success ? result : { error: result?.error || 'Scratchpad save failed' };
}

export async function flushScratchpad(options = {}) {
  let failure = null;
  const handleResult = (result) => {
    const normalized = normalizeScratchpadSaveResult(result);
    if (normalized.error) failure = normalized;
  };

  if (scratchpadDebounce && scratchpadProjectPath) {
    clearTimeout(scratchpadDebounce);
    scratchpadDebounce = null;
    const editor = document.getElementById('scratchpadEditor');
    if (editor && editor.value !== undefined) {
      handleResult(await saveScratchpadNow(scratchpadProjectPath, editor.value));
    }
  }
  if (scratchpadSavePromise) {
    handleResult(await scratchpadSavePromise);
  }
  if (failure && options.throwOnError) {
    requireScratchpadSaveSuccess(failure);
  }
  return failure || { success: true };
}

window.flushScratchpadForClose = () => flushScratchpad({ throwOnError: true });

export async function loadInbox() {
  cachedInboxIdeas = await fetchAllIdeas();
  renderInboxControls();
  renderInboxTab(currentInboxTab);
  updateInboxBadge();
  updateInboxCount();
}

export async function fetchAllIdeas() {
  const result = window.nexus.getAllIdeas ? await window.nexus.getAllIdeas() : await window.nexus.getGlobalIdeas();
  return unwrapIdeasResult(result);
}

export function unwrapIdeasResult(result) {
  if (Array.isArray(result)) return result;
  if (result?.error) {
    showToast('Brainstorm failed to load: ' + result.error);
    return [];
  }
  if (Array.isArray(result?.ideas)) return result.ideas;
  return [];
}

export async function refreshInboxCache() {
  cachedInboxIdeas = await fetchAllIdeas();
  updateInboxBadge();
  updateInboxCount();
}

export async function refreshAfterIdeaMutation() {
  await refreshInboxCache();
  if (state.currentView === 'detail' && state.currentProject) {
    await loadProjectIdeas();
  } else if (state.currentView === 'inbox') {
    renderInboxControls();
    renderInboxTab(currentInboxTab);
  }
}

export function ideaActionSucceeded(result) {
  return result === true || Boolean(result && result.success);
}

export function ideaActionError(result) {
  return result?.error || 'brainstorm changed or could not be found';
}

export function ideaLocator(idea) {
  return JSON.stringify({
    raw: idea.raw,
    lineIndex: idea.lineIndex,
    rawOccurrence: idea.rawOccurrence
  });
}

export function normalizeIdeaInput(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function renderInboxControls() {
  renderProjectCaptureSelect();
  renderInboxFilterSidebar();
}

export function renderInboxTab(tab) {
  currentInboxTab = tab;
  const openFiltered = applyInboxFilters(cachedInboxIdeas, 'open');
  const completedFiltered = applyInboxFilters(cachedInboxIdeas, 'completed');
  const openTotal = cachedInboxIdeas.filter(i => !i.done && !isInboxIdeaCategoryHidden(i)).length;
  const completedTotal = cachedInboxIdeas.filter(i => i.done && !isInboxIdeaCategoryHidden(i)).length;

  document.getElementById('tabCountAll').textContent = openTotal;
  document.getElementById('tabCountByProject').textContent = openTotal;
  document.getElementById('tabCountCompleted').textContent = completedTotal;
  document.querySelectorAll('.ix-tab').forEach(btn => {
    const active = btn.dataset.inboxTab === tab;
    btn.classList.toggle('active', active);
    btn.querySelector('.ix-tab-count')?.classList.toggle('active', active);
  });

  const globalList = document.getElementById('globalIdeasList');
  const groupedList = document.getElementById('groupedIdeasList');
  const completedList = document.getElementById('completedIdeasList');
  const byProjectToolbar = document.getElementById('byProjectToolbar');
  globalList.style.display = tab === 'all' ? '' : 'none';
  groupedList.style.display = tab === 'byProject' ? '' : 'none';
  completedList.style.display = tab === 'completed' ? '' : 'none';
  byProjectToolbar.style.display = tab === 'byProject' ? 'flex' : 'none';

  if (tab === 'all') {
    renderIdeaCards(openFiltered, 'globalIdeasList', null, hasActiveInboxFilters() ? 'No brainstorms match your filters' : 'No open brainstorms yet');
    updateInboxSearchCount(openFiltered.length, openTotal);
  } else if (tab === 'byProject') {
    const mode = inboxFilters.includeCompletedByProject ? null : 'open';
    const groupedIdeas = applyInboxFilters(cachedInboxIdeas, mode);
    renderGroupedIdeas(groupedIdeas, 'groupedIdeasList', 'byProject', 'No brainstorms match your filters');
    updateInboxSearchCount(groupedIdeas.length, mode === 'open' ? openTotal : openTotal + completedTotal);
  } else if (tab === 'completed') {
    renderGroupedIdeas(completedFiltered, 'completedIdeasList', 'completed', hasActiveInboxFilters() ? 'No completed brainstorms match your filters' : 'No completed brainstorms yet');
    updateInboxSearchCount(completedFiltered.length, completedTotal);
  }
}

export function applyInboxFilters(ideas, mode) {
  let filtered = [...ideas];
  if (mode === 'open') filtered = filtered.filter(i => !i.done || recentlyToggledIdeas.has((i.filePath || '') + '::' + (i.date || '')));
  if (mode === 'completed') filtered = filtered.filter(i => i.done);

  filtered = filtered.filter(i => !isInboxIdeaCategoryHidden(i));

  const q = inboxFilters.search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(i =>
      i.text.toLowerCase().includes(q) ||
      (i.project || 'No project').toLowerCase().includes(q)
    );
  }

  if (inboxFilters.project === '__none__') filtered = filtered.filter(i => !i.project);
  else if (inboxFilters.project) filtered = filtered.filter(i => i.project === inboxFilters.project);

  filtered = filtered.filter(matchesInboxDateFilter);

  filtered.sort((a, b) => {
    if (inboxFilters.sortBy === 'oldest') return getInboxIdeaDateTime(a.date) - getInboxIdeaDateTime(b.date);
    if (inboxFilters.sortBy === 'az') return a.text.localeCompare(b.text);
    return getInboxIdeaActivityTime(b) - getInboxIdeaActivityTime(a);
  });

  return filtered;
}

export function matchesInboxDateFilter(idea) {
  const ts = getInboxIdeaDateTime(idea.done ? (idea.completedAt || idea.date) : idea.date);
  if (!ts) return true;
  const now = new Date();
  let start = 0;
  let end = Date.now() + 86400000;

  if (inboxFilters.datePreset === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    start = d.getTime();
  } else if (inboxFilters.datePreset === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    d.setHours(0, 0, 0, 0);
    start = d.getTime();
  } else if (inboxFilters.datePreset === 'month') {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    d.setHours(0, 0, 0, 0);
    start = d.getTime();
  } else if (inboxFilters.datePreset === 'older') {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    d.setHours(0, 0, 0, 0);
    end = d.getTime();
  } else if (inboxFilters.datePreset === 'custom' || inboxFilters.dateFrom || inboxFilters.dateTo) {
    if (inboxFilters.dateFrom) start = getInboxIdeaDateTime(inboxFilters.dateFrom);
    if (inboxFilters.dateTo) end = getInboxIdeaDateTime(inboxFilters.dateTo) + 86400000;
  }

  return ts >= start && ts <= end;
}

export function handleIdeaAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle-idea') {
    if (e.type !== 'change') return;
    toggleIdeaItem(el.dataset.file, el.dataset.locator, el.checked, el);
  } else if (action === 'type-picker') {
    e.stopPropagation();
    openIdeaTypePicker(el, el.dataset.file, el.dataset.locator);
  } else if (action === 'project-picker') {
    e.stopPropagation();
    openIdeaProjectPicker(el, el.dataset.file, el.dataset.locator);
  } else if (action === 'toggle-pause') {
    togglePauseItem(el.dataset.file, el.dataset.locator);
  } else if (action === 'inline-edit-btn') {
    startInlineEditBtn(el);
  } else if (action === 'delete-idea') {
    deleteIdeaItem(el.dataset.file, el.dataset.locator);
  } else if (action === 'collapse-all') {
    toggleInboxCollapseAll(el.dataset.groupType);
  } else if (action === 'toggle-group') {
    toggleInboxGroup(el.dataset.groupType, el.dataset.groupKey);
  }
}

export function handleIdeaDblClick(e) {
  const el = e.target.closest('[data-action="inline-edit-dblclick"]');
  if (el) startInlineEditFromText(el);
}

export function wireIdeaContainer(container) {
  container.addEventListener('click', handleIdeaAction);
  container.addEventListener('dblclick', handleIdeaDblClick);
  container.addEventListener('change', handleIdeaAction);
}

export function renderIdeaCards(ideas, containerId, filePath, emptyMessage = 'Nothing here yet.') {
  const container = document.getElementById(containerId);
  if (ideas.length === 0) {
    container.innerHTML = `<div class="ix-empty"><p>${escapeHtml(emptyMessage)}</p></div>`;
    return;
  }
  container.innerHTML = ideas.map(idea => renderIdeaCard(idea, filePath)).join('');
}

export function renderIdeaCard(idea, filePath) {
  const fp = filePath || idea.filePath || '';
  const locator = ideaLocator(idea);
  const pColor = getInboxProjectColor(idea.project);
  const label = idea.project || 'No project';
  const typePill = idea.type
    ? `<button class="ix-type-pill ix-type-${escapeHtml(idea.type)}" type="button" data-action="type-picker" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="Click to change type">${escapeHtml(idea.type)}</button>`
    : `<button class="ix-type-pill ix-type-none" type="button" data-action="type-picker" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="Set idea type">type</button>`;
  const pausedClass = idea.paused ? ' ix-paused' : '';
  const doneClass = idea.done ? ' ix-done' : '';
  const pauseIcon = idea.paused ? '&#9654;' : '&#10074;&#10074;';
  const pauseTitle = idea.paused ? 'Resume' : 'Pause';
  const pBg = colorWithAlpha(pColor, 0.12);
  return `
    <div class="ix-card${doneClass}${pausedClass}">
      <input type="checkbox" class="ix-check" ${idea.done ? 'checked' : ''}
        data-action="toggle-idea" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" />
      <div class="ix-card-body">
        <div class="ix-card-text" data-raw="${escapeHtml(locator)}" data-file="${escapeHtml(fp)}" data-action="inline-edit-dblclick">${escapeHtml(idea.text)}</div>
        <div class="ix-card-meta">
          ${typePill}
          <button class="ix-card-project ix-card-project-btn" type="button" style="color:${pColor};background:${pBg}" data-action="project-picker" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="Change project">${escapeHtml(label)}</button>
          ${idea.paused ? '<span class="ix-card-paused-badge">paused</span>' : ''}
          <span class="ix-card-date">${escapeHtml(formatIdeaStatusDate(idea))}</span>
          ${!idea.done && !idea.paused && idea.updatedAt ? `<span class="ix-card-activity">${escapeHtml(timeAgo(getInboxIdeaDateTime(idea.updatedAt)))}</span>` : ''}
        </div>
      </div>
      <div class="ix-card-actions">
        ${!idea.done ? `<button class="ix-action-btn ix-pause-btn" data-action="toggle-pause" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="${pauseTitle}">${pauseIcon}</button>` : ''}
        <button class="ix-action-btn" data-action="inline-edit-btn" title="Edit">&#9998;</button>
        <button class="ix-action-btn ix-delete" data-action="delete-idea" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="Delete">&times;</button>
      </div>
    </div>`;
}

export function renderGroupedIdeas(ideas, containerId, groupType, emptyMessage) {
  const container = document.getElementById(containerId);
  const groups = groupInboxIdeas(ideas);
  if (groups.length === 0) {
    container.innerHTML = `<div class="ix-empty"><p>${escapeHtml(emptyMessage)}</p></div>`;
    return;
  }

  const groupState = inboxGroupState[groupType];
  container.innerHTML = `
    <div class="ix-collapse-bar">
      <button class="ix-collapse-btn" data-action="collapse-all" data-group-type="${escapeHtml(groupType)}">
        <span class="ix-collapse-icon ${groupState.allCollapsed ? 'collapsed' : ''}">&#9662;</span>
        ${groupState.allCollapsed ? 'Expand all' : 'Collapse all'}
      </button>
    </div>
    ${groups.map(group => renderInboxGroup(group, groupType)).join('')}`;
}

export function groupInboxIdeas(ideas) {
  const map = {};
  for (const idea of ideas) {
    const key = idea.project || '__none__';
    if (!map[key]) map[key] = [];
    map[key].push(idea);
  }
  return Object.entries(map)
    .map(([key, items]) => ({ key, label: key === '__none__' ? 'No project' : key, items }))
    .sort((a, b) => a.key === '__none__' ? -1 : b.key === '__none__' ? 1 : a.label.localeCompare(b.label));
}

export function renderInboxGroup(group, groupType) {
  const groupState = inboxGroupState[groupType];
  const collapsed = groupState.collapsed[group.key] ?? groupState.allCollapsed;
  const pColor = getInboxProjectColor(group.key === '__none__' ? null : group.label);
  const pBg = colorWithAlpha(pColor, 0.12);
  const pWash = colorWithAlpha(pColor, 0.04);
  return `
    <div class="ix-group" style="border-left-color:${pColor}">
      <div class="ix-group-header" data-action="toggle-group" data-group-type="${escapeHtml(groupType)}" data-group-key="${escapeHtml(group.key)}" style="background:linear-gradient(90deg, ${pWash}, transparent);cursor:pointer">
        <span class="ix-group-arrow ${collapsed ? 'collapsed' : ''}">&#9662;</span>
        <span class="ix-group-dot" style="background:${pColor}"></span>
        <span class="ix-group-name">${escapeHtml(group.label)}</span>
        <span class="ix-group-count" style="color:${pColor};background:${pBg}">${group.items.length}</span>
      </div>
      ${collapsed ? '' : `<div class="ix-group-body">${group.items.map(i => renderIdeaCard(i, i.filePath)).join('')}</div>`}
    </div>`;
}

export function getInboxProject(projectName) {
  if (!projectName) return null;
  return state.allProjects.find(p => p.name === projectName) || null;
}

export function getInboxProjectColor(projectName) {
  if (!projectName) return '#8890a0';
  const project = getInboxProject(projectName);
  if (!project) return 'var(--accent)';
  return getCategoryColorForIdea(project.category);
}

export function getInboxProjectCategory(projectName) {
  const project = getInboxProject(projectName);
  return project?.category || null;
}

export function isInboxIdeaCategoryHidden(idea) {
  const category = getInboxProjectCategory(idea.project);
  return Boolean(category && inboxFilters.hiddenCategories.has(category));
}

export function getInboxIdeaDateTime(dateText) {
  if (!dateText) return 0;
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!match) return 0;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0)
  ).getTime();
}

export function getInboxIdeaActivityTime(idea) {
  return getInboxIdeaDateTime(idea.updatedAt || idea.completedAt || idea.date);
}

export function updateInboxSearchCount(resultCount, totalCount) {
  const el = document.getElementById('ideaSearchCount');
  const clear = document.getElementById('ideaSearchClear');
  if (!el || !clear) return;
  el.textContent = inboxFilters.search ? `${resultCount} of ${totalCount}` : '';
  clear.style.display = inboxFilters.search ? '' : 'none';
}

export function isIdeaHidden(idea) {
  return Boolean(idea.done);
}

export function startInlineEdit(textEl, currentText) {
  if (textEl.querySelector('.inline-idea-edit, .ix-inline-edit')) return;
  const raw = textEl.dataset.raw;
  const filePath = textEl.dataset.file;

  const textarea = document.createElement('textarea');
  textarea.className = textEl.classList.contains('ix-card-text') ? 'ix-inline-edit' : 'inline-idea-edit';
  textarea.value = currentText;
  textEl.textContent = '';
  textEl.appendChild(textarea);
  autoSizeInlineEditor(textarea);
  textarea.focus();
  textarea.select();

  let finished = false;

  const save = async () => {
    if (finished) return;
    finished = true;
    const newText = textarea.value.trim();
    if (newText && newText !== currentText) {
      const resolvedPath = filePath || (await getGlobalInboxPath());
      const result = await window.nexus.editIdea(resolvedPath, raw, newText);
      if (!ideaActionSucceeded(result)) {
        showToast('Update failed: ' + ideaActionError(result));
      } else {
      showToast('Brainstorm updated');
      }
    }
    await refreshAfterIdeaMutation();
  };

  const cancel = () => {
    finished = true;
    textEl.textContent = currentText;
  };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  textarea.addEventListener('input', () => autoSizeInlineEditor(textarea));
  textarea.addEventListener('blur', save);
}

export function startInlineEditFromText(textEl) {
  startInlineEdit(textEl, textEl.textContent.trim());
}

export function startInlineEditBtn(btn) {
  const card = btn.closest('.ix-card, .idea-card, .idea-item');
  const textEl = card?.querySelector('.ix-card-text, .idea-card-text, .idea-text');
  if (!textEl) return;
  const currentText = textEl.textContent.trim();
  startInlineEdit(textEl, currentText);
}

export function autoSizeInlineEditor(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function updateInboxCount() {
  const open = cachedInboxIdeas.filter(i => !i.done && !i.paused).length;
  const paused = cachedInboxIdeas.filter(i => i.paused).length;
  const total = cachedInboxIdeas.length;
  const el = document.getElementById('inboxCount');
  if (!el) return;
  const parts = [];
  if (open > 0) parts.push(`${open} open`);
  if (paused > 0) parts.push(`${paused} paused`);
  parts.push(`${total} total`);
  el.textContent = parts.join(' / ');
}

export function renderIdeasList(ideas, containerId, filePath, showAll) {
  const container = document.getElementById(containerId);
  const visible = showAll ? ideas : ideas.filter(idea => !isIdeaHidden(idea));
  const hiddenCount = ideas.length - visible.length;
  if (visible.length === 0 && hiddenCount === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px">No brainstorms yet. Capture one above.</p>';
    return;
  }
  container.innerHTML = visible.map(idea => {
    const fp = idea.filePath || filePath || '';
    const locator = ideaLocator(idea);
    const tPill = idea.type
      ? `<button class="ix-type-pill ix-type-${escapeHtml(idea.type)}" type="button" data-action="type-picker" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="Click to change type">${escapeHtml(idea.type)}</button>`
      : `<button class="ix-type-pill ix-type-none" type="button" data-action="type-picker" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="Set idea type">type</button>`;
    const pauseIcon = idea.paused ? '&#9654;' : '&#10074;&#10074;';
    const pauseTitle = idea.paused ? 'Resume' : 'Pause';
    const stateClass = idea.done ? 'done' : idea.paused ? 'paused' : '';
    return `
    <div class="idea-item ${stateClass}">
      <input type="checkbox" class="idea-checkbox" ${idea.done ? 'checked' : ''}
        data-action="toggle-idea" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" />
      <span class="idea-text" data-raw="${escapeHtml(locator)}" data-file="${escapeHtml(fp)}" data-action="inline-edit-dblclick">${escapeHtml(idea.text)}</span>
      ${tPill}
      ${idea.paused ? '<span class="idea-paused-badge">paused</span>' : ''}
      ${idea.project ? `<span class="idea-project">${escapeHtml(idea.project)}</span>` : ''}
      <span class="idea-date">${escapeHtml(formatIdeaStatusDate(idea))}</span>
      ${!idea.done ? `<button class="idea-pause" data-action="toggle-pause" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}" title="${pauseTitle}">${pauseIcon}</button>` : ''}
      <button class="idea-edit" data-action="inline-edit-btn" title="Edit">&#9998;</button>
      <button class="idea-delete" data-action="delete-idea" data-file="${escapeHtml(fp)}" data-locator="${escapeHtml(locator)}">&times;</button>
    </div>`;
  }).join('') + (hiddenCount > 0 ? `<p style="color:var(--text-muted);font-size:11px;padding:8px 12px">${hiddenCount} completed brainstorm${hiddenCount > 1 ? 's' : ''} hidden</p>` : '');
}

export async function updateInboxBadge() {
  const ideas = cachedInboxIdeas.length > 0 ? cachedInboxIdeas : await fetchAllIdeas();
  const open = ideas.filter(i => !i.done).length;
  const badge = document.getElementById('inboxBadge');
  if (open > 0) {
    badge.style.display = 'inline';
    badge.textContent = open;
  } else {
    badge.style.display = 'none';
  }
}

export async function toggleIdeaItem(filePath, text, done, checkbox) {
  const resolvedPath = filePath || (await getGlobalInboxPath());
  const result = await window.nexus.toggleIdea(resolvedPath, text, done);
  if (!ideaActionSucceeded(result)) {
    if (checkbox) checkbox.checked = !done;
    showToast('Toggle failed: ' + ideaActionError(result));
  } else if (state.currentView === 'inbox') {
    const raw = rawFromIdeaLocator(text);
    const m = raw.match(/\*\*\[(.+?)\]\*\*/);
    const ts = m ? m[1] : '';
    const key = resolvedPath + '::' + ts;
    if (done) {
      recentlyToggledIdeas.add(key);
    } else {
      recentlyToggledIdeas.delete(key);
    }
  }
  await refreshAfterIdeaMutation();
}

export async function deleteIdeaItem(filePath, text) {
  const resolvedPath = filePath || (await getGlobalInboxPath());
  const result = await window.nexus.deleteIdea(resolvedPath, text);
  if (!ideaActionSucceeded(result)) {
    showToast('Delete failed: ' + ideaActionError(result));
    return;
  }
  await refreshAfterIdeaMutation();
  showToast('Brainstorm removed');
}

export async function togglePauseItem(filePath, rawLine) {
  const resolvedPath = filePath || (await getGlobalInboxPath());
  const result = await window.nexus.togglePause(resolvedPath, rawLine);
  if (!ideaActionSucceeded(result)) {
    showToast('Pause failed: ' + ideaActionError(result));
    return;
  }
  await refreshAfterIdeaMutation();
}

export const IDEA_TYPES = [null, 'bug', 'feature', 'improvement', 'task', 'question', 'idea'];

export function parseTypeFromRaw(rawLine) {
  const raw = rawFromIdeaLocator(rawLine);
  const m = raw.match(/\*\*\[.+?\]\*\*\s+\[(\w+)\]/);
  if (m) {
    const t = m[1].toLowerCase();
    if (IDEA_TYPES.includes(t)) return t;
  }
  return null;
}

export function rawFromIdeaLocator(rawLine) {
  if (!rawLine) return '';
  if (typeof rawLine === 'object') return rawLine.raw || '';
  const value = String(rawLine);
  if (value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.raw === 'string') return parsed.raw;
    } catch {}
  }
  return value;
}

export const IDEA_TYPE_COLORS = { bug: '#ef4444', feature: '#6366f1', improvement: '#22c55e', task: '#eab308', question: '#a855f7', idea: '#c4b5fd' };

export function openIdeaTypePicker(anchor, filePath, rawLine) {
  closeIdeaTypePicker();
  const currentType = parseTypeFromRaw(rawLine);
  const menu = document.createElement('div');
  menu.id = 'ideaTypePicker';
  menu.className = 'ix-type-picker';
  const types = [
    { value: null, label: 'none', color: '#8890a0' },
    ...IDEA_TYPES.filter(Boolean).map(t => ({ value: t, label: t, color: IDEA_TYPE_COLORS[t] }))
  ];
  menu.innerHTML = types.map(t => `
    <button type="button" class="ix-type-picker-option ${t.value === currentType ? 'selected' : ''}" data-type="${t.value || ''}">
      <span class="ix-type-picker-dot" style="background:${t.color}"></span>
      <span>${t.label}</span>
      ${t.value === currentType ? '<span class="ix-select-check">✓</span>' : ''}
    </button>
  `).join('');

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 12)}px`;

  menu.querySelectorAll('[data-type]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newType = btn.dataset.type || null;
      const resolvedPath = filePath || (await getGlobalInboxPath());
      const result = await window.nexus.setIdeaType(resolvedPath, rawLine, newType);
      closeIdeaTypePicker();
      if (!ideaActionSucceeded(result)) {
        showToast('Type update failed: ' + ideaActionError(result));
        return;
      }
      await refreshAfterIdeaMutation();
      showToast(newType ? `Type: ${newType}` : 'Type cleared');
    });
  });

  setTimeout(() => {
    document.addEventListener('click', closeIdeaTypePickerOutside, true);
    document.addEventListener('keydown', closeIdeaTypePickerEscape, true);
  }, 0);
}

export function closeIdeaTypePicker() {
  const el = document.getElementById('ideaTypePicker');
  if (el) el.remove();
  document.removeEventListener('click', closeIdeaTypePickerOutside, true);
  document.removeEventListener('keydown', closeIdeaTypePickerEscape, true);
}

export function closeIdeaTypePickerOutside(e) {
  if (!e.target.closest('#ideaTypePicker, .ix-type-pill')) closeIdeaTypePicker();
}

export function closeIdeaTypePickerEscape(e) {
  if (e.key === 'Escape') { closeIdeaTypePicker(); e.stopPropagation(); }
}

export async function openIdeaProjectPicker(anchor, filePath, rawLine) {
  const resolvedPath = filePath || (await getGlobalInboxPath());
  const idea = cachedInboxIdeas.find(i => ideaMatchesLocator(i, rawLine));
  ideaProjectPickerState = {
    anchor,
    filePath: resolvedPath,
    rawLine,
    currentProjectPath: getIdeaProjectPath(idea, resolvedPath)
  };

  const picker = getOrCreateIdeaProjectPicker();
  renderIdeaProjectPicker('', true);
  positionIdeaProjectPicker(anchor);
  picker.style.display = 'block';
  picker.querySelector('.ix-project-picker-search')?.focus();
}

export function ideaMatchesLocator(idea, locatorValue) {
  try {
    const locator = typeof locatorValue === 'string' && locatorValue.trim().startsWith('{')
      ? JSON.parse(locatorValue)
      : { raw: locatorValue };
    return idea.raw === locator.raw &&
      (locator.lineIndex == null || idea.lineIndex === locator.lineIndex) &&
      (locator.rawOccurrence == null || idea.rawOccurrence === locator.rawOccurrence);
  } catch {
    return idea.raw === locatorValue;
  }
}

export function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function getUniqueProjectByName(projectName) {
  if (!projectName) return null;
  const matches = state.allProjects.filter(project => project.name === projectName);
  return matches.length === 1 ? matches[0] : null;
}

export function getIdeaProjectPath(idea, filePath) {
  const normalizedFile = normalizePathForCompare(filePath);
  const localProject = state.allProjects.find(project => {
    const normalizedProjectPath = normalizePathForCompare(project.path);
    return normalizedFile === `${normalizedProjectPath}/brainstorm.md` || normalizedFile === `${normalizedProjectPath}/ideas.md`;
  });
  if (localProject) return localProject.path;
  return getUniqueProjectByName(idea?.project)?.path || '';
}

export function getOrCreateIdeaProjectPicker() {
  let picker = document.getElementById('ideaProjectPicker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'ideaProjectPicker';
    picker.className = 'ix-select-menu ix-project-picker';
    picker.style.display = 'none';
    document.body.appendChild(picker);
  }
  return picker;
}

export function positionIdeaProjectPicker(anchor) {
  const picker = getOrCreateIdeaProjectPicker();
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
  const top = Math.min(rect.bottom + 6, window.innerHeight - 420);
  picker.style.width = `${width}px`;
  picker.style.left = `${left}px`;
  picker.style.top = `${Math.max(12, top)}px`;
}

export function renderIdeaProjectPicker(query, initSearch) {
  const picker = getOrCreateIdeaProjectPicker();
  const q = String(query || '').trim().toLowerCase();
  const projects = state.allProjects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(project =>
      !q ||
      project.name.toLowerCase().includes(q) ||
      (project.category || '').toLowerCase().includes(q) ||
      normalizeIdeaTags(project.tags || []).some(tag => tag.toLowerCase().includes(q))
    );

  const options = [
    { value: '', label: 'No project', dot: '#8890a0' },
    ...projects.map(project => ({ value: project.path, label: project.name, dot: getInboxProjectColor(project.name) }))
  ];

  const listHtml = options.map(option => `
    <button type="button" class="ix-select-option ${option.value === ideaProjectPickerState?.currentProjectPath ? 'selected' : ''}" data-project="${escapeHtml(option.value)}">
      <span class="ix-select-dot" style="background:${option.dot}"></span>
      <span>${escapeHtml(option.label)}</span>
      ${option.value === ideaProjectPickerState?.currentProjectPath ? '<span class="ix-select-check">✓</span>' : ''}
    </button>
  `).join('') + (projects.length === 0 ? '<div class="ix-project-picker-empty">No matching projects</div>' : '');

  if (initSearch) {
    picker.innerHTML = `
      <div class="ix-project-picker-head">
        <input type="text" class="ix-project-picker-search" placeholder="Find project..." />
      </div>
      <div class="ix-project-picker-list">${listHtml}</div>
    `;
    const search = picker.querySelector('.ix-project-picker-search');
    search.addEventListener('input', () => renderIdeaProjectPicker(search.value, false));
    search.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeIdeaProjectPicker();
    });
  } else {
    const list = picker.querySelector('.ix-project-picker-list');
    if (list) list.innerHTML = listHtml;
  }

  picker.querySelectorAll('[data-project]').forEach(button => {
    button.addEventListener('click', () => selectIdeaProject(button.dataset.project || ''));
  });
}

export async function selectIdeaProject(projectPath) {
  if (!ideaProjectPickerState) return;
  const { filePath, rawLine } = ideaProjectPickerState;
  const moved = await window.nexus.moveIdeaProject(filePath, rawLine, projectPath || null);
  if (!ideaActionSucceeded(moved)) {
    showToast('Move failed: ' + ideaActionError(moved));
    return;
  }
  closeIdeaProjectPicker();
  await refreshAfterIdeaMutation();
  const project = state.allProjects.find(p => p.path === projectPath);
  showToast(project ? `Moved to ${project.name}` : 'Moved to No project');
}

export function closeIdeaProjectPicker() {
  const picker = document.getElementById('ideaProjectPicker');
  if (picker) picker.style.display = 'none';
  ideaProjectPickerState = null;
}

export async function getGlobalInboxPath() {
  const config = await window.nexus.getConfig();
  return config._globalInboxPath;
}

export function renderProjectCaptureSelect() {
  const container = document.getElementById('ideaProjectSelect');
  if (!container) return;
  const options = [
    { value: '', label: 'No project', dot: '#8890a0' },
    ...state.allProjects.map(p => ({ value: p.path, label: p.name, dot: getInboxProjectColor(p.name) }))
  ];
  renderCustomSelect(container, lastProjectHint, options, (value) => {
    lastProjectHint = value;
    renderProjectCaptureSelect();
  }, 'No project');
}

export function renderCustomSelect(container, value, options, onChange, placeholder) {
  const selected = options.find(o => o.value === value);
  const label = selected ? selected.label : placeholder;
  container.innerHTML = `
    <button class="ix-select-trigger" type="button">
      ${selected?.dot ? `<span class="ix-select-dot" style="background:${selected.dot}"></span>` : ''}
      <span class="ix-select-label">${escapeHtml(label)}</span>
      <span class="ix-select-arrow">&#9662;</span>
    </button>
    <div class="ix-select-menu" style="display:none">
      ${options.map(opt => `
        <button type="button" class="ix-select-option ${opt.value === value ? 'selected' : ''}" data-value="${escapeHtml(opt.value)}">
          ${opt.dot ? `<span class="ix-select-dot" style="background:${opt.dot}"></span>` : ''}
          <span>${escapeHtml(opt.label)}</span>
          ${opt.value === value ? '<span class="ix-select-check">✓</span>' : ''}
        </button>
      `).join('')}
    </div>
  `;
  const trigger = container.querySelector('.ix-select-trigger');
  const menu = container.querySelector('.ix-select-menu');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.ix-select.open').forEach(el => {
      if (el !== container) {
        el.classList.remove('open');
        const otherMenu = el.querySelector('.ix-select-menu');
        if (otherMenu) otherMenu.style.display = 'none';
      }
    });
    const open = container.classList.toggle('open');
    menu.style.display = open ? '' : 'none';
  });
  menu.querySelectorAll('.ix-select-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      container.classList.remove('open');
      menu.style.display = 'none';
      onChange(btn.dataset.value || '');
    });
  });
}

export function renderInboxFilterSidebar() {
  renderInboxCategoryFilters();
  renderInboxProjectFilters();
  renderInboxDateFilters();
  renderInboxSortFilters();
  const include = document.getElementById('includeCompletedByProject');
  if (include) include.checked = inboxFilters.includeCompletedByProject;
  const clear = document.getElementById('ideaClearFilters');
  if (clear) clear.style.display = hasActiveInboxFilters() ? '' : 'none';
}

export function renderInboxCategoryFilters() {
  const container = document.getElementById('ideaCategoryFilters');
  if (!container) return;
  container.innerHTML = getAllIdeaCategories().map(category => {
    const hidden = inboxFilters.hiddenCategories.has(category);
    const color = getCategoryColorForIdea(category);
    return `
      <button class="ix-fsb-item ${hidden ? 'ix-fsb-hidden-cat' : 'active'}" data-category="${escapeHtml(category)}">
        <span class="ix-fsb-dot" style="background:${hidden ? 'var(--text-muted)' : color}"></span>
        <span style="${hidden ? 'text-decoration:line-through;opacity:.45' : ''}">${escapeHtml(category)}</span>
        ${hidden ? '<span class="ix-fsb-hidden-label">hidden</span>' : '<span class="ix-fsb-check">✓</span>'}
      </button>`;
  }).join('');
  container.querySelectorAll('[data-category]').forEach(btn => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      if (inboxFilters.hiddenCategories.has(category)) inboxFilters.hiddenCategories.delete(category);
      else inboxFilters.hiddenCategories.add(category);
      localStorage.setItem('nexus_inboxHiddenCategories', JSON.stringify([...inboxFilters.hiddenCategories]));
      loadInbox();
    });
  });
}

export function renderInboxProjectFilters() {
  const container = document.getElementById('ideaProjectFilters');
  if (!container) return;
  const visibleProjects = state.allProjects.filter(p => !inboxFilters.hiddenCategories.has(p.category));
  container.innerHTML = `
    <button class="ix-fsb-item ${!inboxFilters.project ? 'active' : ''}" data-project="">All projects</button>
    ${visibleProjects.map(p => `
      <button class="ix-fsb-item ${inboxFilters.project === p.name ? 'active' : ''}" data-project="${escapeHtml(p.name)}">
        <span class="ix-fsb-dot" style="background:${getInboxProjectColor(p.name)}"></span>
        ${escapeHtml(p.name)}
        ${inboxFilters.project === p.name ? '<span class="ix-fsb-check">✓</span>' : ''}
      </button>
    `).join('')}
    <button class="ix-fsb-item ${inboxFilters.project === '__none__' ? 'active' : ''}" data-project="__none__">
      <span class="ix-fsb-dot" style="background:#8890a0"></span>
      No project
      ${inboxFilters.project === '__none__' ? '<span class="ix-fsb-check">✓</span>' : ''}
    </button>
  `;
  container.querySelectorAll('[data-project]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.project;
      inboxFilters.project = inboxFilters.project === value ? '' : value;
      renderInboxControls();
      renderInboxTab(currentInboxTab);
    });
  });
}

export function renderInboxDateFilters() {
  const container = document.getElementById('ideaDateFilters');
  if (!container) return;
  const presets = [
    ['', 'All time'],
    ['today', 'Today'],
    ['week', 'This week'],
    ['month', 'This month'],
    ['older', 'Older'],
    ['custom', 'Custom range']
  ];
  container.innerHTML = presets.map(([value, label]) => `
    <button class="ix-fsb-item ${inboxFilters.datePreset === value ? 'active' : ''}" data-date-preset="${value}">${label}</button>
  `).join('');
  container.querySelectorAll('[data-date-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      inboxFilters.datePreset = btn.dataset.datePreset;
      renderInboxControls();
      renderInboxTab(currentInboxTab);
    });
  });
  const range = document.getElementById('ideaCustomDateRange');
  if (range) range.style.display = inboxFilters.datePreset === 'custom' ? '' : 'none';
  syncDateTextInput('ideaDateFrom', inboxFilters.dateFrom);
  syncDateTextInput('ideaDateTo', inboxFilters.dateTo);
}

export function renderInboxSortFilters() {
  const container = document.getElementById('ideaSortFilters');
  if (!container) return;
  const sorts = [
    ['recent', 'Recent activity'],
    ['oldest', 'Oldest first'],
    ['az', 'Alphabetical']
  ];
  container.innerHTML = sorts.map(([value, label]) => `
    <button class="ix-fsb-item ${inboxFilters.sortBy === value ? 'active' : ''}" data-sort="${value}">${label}</button>
  `).join('');
  container.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      inboxFilters.sortBy = btn.dataset.sort;
      renderInboxControls();
      renderInboxTab(currentInboxTab);
    });
  });
}

export function hasActiveInboxFilters() {
  return Boolean(
    inboxFilters.search ||
    inboxFilters.project ||
    inboxFilters.datePreset ||
    inboxFilters.dateFrom ||
    inboxFilters.dateTo ||
    inboxFilters.hiddenCategories.size > 0 ||
    inboxFilters.sortBy !== 'recent'
  );
}

export function toggleInboxCollapseAll(groupType) {
  const groupState = inboxGroupState[groupType];
  groupState.allCollapsed = !groupState.allCollapsed;
  groupState.collapsed = {};
  renderInboxTab(currentInboxTab);
}

export function toggleInboxGroup(groupType, key) {
  const groupState = inboxGroupState[groupType];
  const current = groupState.collapsed[key] ?? groupState.allCollapsed;
  groupState.collapsed[key] = !current;
  renderInboxTab(currentInboxTab);
}

export function populateProjectHintDropdown() {
  renderProjectCaptureSelect();
}

function setupIdeaButtonListeners() {
  const on = (id, eventName, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventName, handler);
  };

  on('btnAddGlobalIdea', 'click', async () => {
    const input = document.getElementById('globalIdeaInput');
    const text = normalizeIdeaInput(input.value);
    if (!text) return;
    const result = await window.nexus.addGlobalIdea(text, lastProjectHint || null);
    if (result.success) {
      input.value = '';
      await loadInbox();
      showToast('Brainstorm captured');
    } else {
      showToast('Capture failed: ' + (result.error || 'unknown'));
    }
  });

  on('globalIdeaInput', 'keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btnAddGlobalIdea')?.click();
  });

  on('ideaSearchInput', 'input', (e) => {
    inboxFilters.search = e.target.value;
    renderInboxTab(currentInboxTab);
    renderInboxControls();
  });

  on('ideaSearchClear', 'click', () => {
    inboxFilters.search = '';
    const input = document.getElementById('ideaSearchInput');
    if (input) input.value = '';
    renderInboxTab(currentInboxTab);
    renderInboxControls();
  });

  on('includeCompletedByProject', 'change', (e) => {
    inboxFilters.includeCompletedByProject = e.target.checked;
    renderInboxTab(currentInboxTab);
  });

  on('ideaClearFilters', 'click', () => {
    inboxFilters.search = '';
    inboxFilters.project = '';
    inboxFilters.datePreset = '';
    inboxFilters.dateFrom = '';
    inboxFilters.dateTo = '';
    const input = document.getElementById('ideaSearchInput');
    if (input) input.value = '';
    renderInboxControls();
    renderInboxTab(currentInboxTab);
  });

  ['ideaDateFrom', 'ideaDateTo'].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', (e) => {
      e.target.value = normalizeDateText(e.target.value);
      inboxFilters[id === 'ideaDateFrom' ? 'dateFrom' : 'dateTo'] = dayFirstToIso(e.target.value);
      renderInboxTab(currentInboxTab);
    });
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.currentView === 'inbox') {
      e.preventDefault();
      document.getElementById('ideaSearchInput')?.focus();
    }
  });

  on('btnAddProjectIdea', 'click', async () => {
    if (!state.currentProject) return;
    const input = document.getElementById('projectIdeaInput');
    const text = normalizeIdeaInput(input.value);
    if (!text) return;
    const result = await window.nexus.addProjectIdea(state.currentProject.path, text);
    if (result.success) {
      input.value = '';
      await refreshAfterIdeaMutation();
      showToast('Brainstorm captured for project');
    } else {
      showToast('Add failed: ' + (result.error || 'unknown'));
    }
  });

  on('projectIdeaInput', 'keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btnAddProjectIdea')?.click();
  });

  on('toggleProjectCompletedIdeas', 'change', (e) => {
    state.showCompletedProjectIdeas = e.target.checked;
    localStorage.setItem('nexus_showCompletedProjectIdeas', JSON.stringify(state.showCompletedProjectIdeas));
    loadProjectIdeas();
  });
}

function setupIdeaDocumentListeners() {
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.ix-project-picker, .ix-card-project-btn')) {
      closeIdeaProjectPicker();
    }

    if (!event.target.closest('.ix-select')) {
      document.querySelectorAll('.ix-select.open').forEach(el => {
        el.classList.remove('open');
        const menu = el.querySelector('.ix-select-menu');
        if (menu) menu.style.display = 'none';
      });
    }
  });

  window.addEventListener('beforeunload', () => flushScratchpad());
}

export function setupIdeaListeners() {
  if (listenersSetup) return;
  listenersSetup = true;

  ['globalIdeasList', 'groupedIdeasList', 'completedIdeasList', 'projectIdeasList'].forEach(id => {
    const el = document.getElementById(id);
    if (el) wireIdeaContainer(el);
  });

  setupIdeaButtonListeners();
  setupIdeaDocumentListeners();

  document.querySelectorAll('.ix-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      renderInboxTab(tab.dataset.inboxTab);
    });
  });
}
