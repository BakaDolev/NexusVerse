import { state } from './state.js';
import { escapeHtml, showToast, colorWithAlpha } from './utils.js';
import { showModal, showInputModal } from './modals.js';

let _renderTable, _updateProjectCount, _getFilteredProjects;

export function initCategories({ renderTable, updateProjectCount, getFilteredProjects }) {
  _renderTable = renderTable;
  _updateProjectCount = updateProjectCount;
  _getFilteredProjects = getFilteredProjects;
}

export function getAllCategories() {
  const configIds = state.categoryDefs.map(c => c.id);
  const fromProjects = state.allProjects.map(p => p.category).filter(Boolean);
  return [...new Set([...configIds, ...fromProjects])];
}

export function getCatDef(categoryId) {
  return state.categoryDefs.find(c => c.id === categoryId);
}

export function getCatColor(category) {
  const def = getCatDef(category);
  if (def) return def.color;
  const fallback = {
    'work': '#4f46e5',
    'main': '#818cf8',
    'side-project': '#7c3aed',
    'infra': '#0f9f8f',
    'legacy': '#737373',
  };
  return fallback[category] || 'var(--text-secondary)';
}

export function getCatLabel(categoryId) {
  const def = getCatDef(categoryId);
  return def ? def.label : categoryId;
}

export function getCategoryColor(category) {
  return getCatColor(category) || 'var(--accent)';
}

export function getCategoryBackgroundColor(category, alpha = 0.16) {
  return colorWithAlpha(getCategoryColor(category), alpha);
}

export function populateCategoryFilter() {
  const select = document.getElementById('filterCategory');
  const current = select.value;
  const categories = getAllCategories();
  select.innerHTML = '<option value="">All Categories</option>' +
    categories.map(c => `<option value="${escapeHtml(c)}" ${c === current ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
}

export function renderHiddenCategories() {
  const container = document.getElementById('categoryList') || document.getElementById('hiddenCategories');
  if (!container) return;
  const categories = getAllCategories();
  const counts = {};
  for (const p of state.allProjects) {
    counts[p.category] = (counts[p.category] || 0) + 1;
  }
  container.innerHTML = categories.map(c => {
    const isHidden = state.hiddenCategories.has(c);
    const color = getCatColor(c);
    const label = getCatLabel(c);
    const count = counts[c] || 0;
    return `
    <div class="category-item ${isHidden ? 'hidden-cat' : ''}" data-action="toggle-hidden-cat" data-category="${escapeHtml(c)}">
      <span class="cat-dot" style="background:${isHidden ? 'var(--text-muted)' : color}"></span>
      <span class="cat-label">${escapeHtml(label)}</span>
      <span class="cat-count">${count}</span>
      <button class="cat-edit-btn" data-action="edit-cat" data-category="${escapeHtml(c)}" title="Edit category">&#9998;</button>
      <button class="cat-delete-btn" data-action="delete-cat" data-category="${escapeHtml(c)}" title="Delete category">&times;</button>
      <button class="cat-toggle-btn" data-action="toggle-hidden-cat" data-category="${escapeHtml(c)}" title="${isHidden ? 'Show' : 'Hide'}">
        ${isHidden ? '&#10005;' : '&#128065;'}
      </button>
    </div>`;
  }).join('');
}

export function toggleHiddenCategory(category) {
  if (state.hiddenCategories.has(category)) {
    state.hiddenCategories.delete(category);
  } else {
    state.hiddenCategories.add(category);
  }
  localStorage.setItem('nexus_hiddenCategories', JSON.stringify([...state.hiddenCategories]));
  renderHiddenCategories();
  if (_renderTable) _renderTable();
  const el = document.getElementById('projectCount');
  if (el && _getFilteredProjects) el.textContent = `${_getFilteredProjects().length}/${state.allProjects.length} projects`;
}

export async function addCategory() {
  try {
    const name = await showInputModal('New category', 'Category name');
    if (!name) return;
    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    const result = await window.nexus.addCategory({ id, label: name, color });
    if (result.success) {
      state.categoryDefs = result.categories;
      renderHiddenCategories();
      populateCategoryFilter();
      showToast(`Category "${name}" created`);
    } else {
      showToast(result.error || 'Failed to create category');
    }
  } catch (err) {
    showToast('Error: ' + err.message);
    console.error('addCategory error:', err);
  }
}

export async function editCategory(categoryId) {
  const def = getCatDef(categoryId);
  const currentLabel = def ? def.label : categoryId;
  const newLabel = await showInputModal('Rename category', 'New name', currentLabel);
  if (!newLabel || newLabel === currentLabel) return;
  const result = await window.nexus.renameCategory(categoryId, categoryId, newLabel);
  if (result.success) {
    state.categoryDefs = result.categories;
    renderHiddenCategories();
    populateCategoryFilter();
    if (_renderTable) _renderTable();
    showToast(`Category renamed to "${newLabel}"`);
  }
}

export async function deleteCategory(categoryId) {
  const def = getCatDef(categoryId);
  const label = def ? def.label : categoryId;
  const counts = {};
  for (const p of state.allProjects) {
    counts[p.category] = (counts[p.category] || 0) + 1;
  }
  const count = counts[categoryId] || 0;
  const otherCategories = getAllCategories().filter(c => c !== categoryId);

  if (otherCategories.length === 0) {
    showToast('Cannot delete the only category');
    return;
  }

  const bodyText = count > 0
    ? `"${label}" has ${count} project${count > 1 ? 's' : ''}. Choose a category to reassign them to.`
    : `Delete category "${label}"? It has no projects.`;

  const inputs = count > 0
    ? [{ id: 'reassign', type: 'select', options: otherCategories.map(c => ({ value: c, label: getCatLabel(c) })), value: otherCategories[0] }]
    : [];

  const result = await showModal({
    title: 'Delete category',
    body: bodyText,
    inputs,
    buttons: [
      { label: 'Cancel', action: 'cancel', class: 'modal-btn-cancel' },
      { label: 'Delete', action: 'delete', class: 'modal-btn-danger' }
    ]
  });

  if (!result || result.action !== 'delete') return;
  const reassignTo = count > 0 ? result.values.reassign : null;
  const delResult = await window.nexus.deleteCategory(categoryId, reassignTo);
  if (delResult.success) {
    state.categoryDefs = delResult.categories;
    state.hiddenCategories.delete(categoryId);
    localStorage.setItem('nexus_hiddenCategories', JSON.stringify([...state.hiddenCategories]));
    state.allProjects = await window.nexus.scan();
    renderHiddenCategories();
    populateCategoryFilter();
    if (_renderTable) _renderTable();
    if (_updateProjectCount) _updateProjectCount();
    showToast(`Category "${label}" deleted`);
  } else {
    showToast(delResult.error || 'Failed to delete category');
  }
}

export async function toggleShowLegacy() {
  state.showLegacy = !state.showLegacy;
  await window.nexus.setShowLegacy(state.showLegacy);
  const toggle = document.getElementById('toggleLegacy');
  if (toggle) toggle.checked = state.showLegacy;
  if (_renderTable) _renderTable();
  if (_updateProjectCount) _updateProjectCount();
  showToast(state.showLegacy ? 'Showing legacy projects' : 'Hiding legacy projects');
}

export function toggleShowDone() {
  state.showDone = !state.showDone;
  localStorage.setItem('nexus_showDone', JSON.stringify(state.showDone));
  const toggle = document.getElementById('toggleDone');
  if (toggle) toggle.checked = state.showDone;
  if (_renderTable) _renderTable();
  if (_updateProjectCount) _updateProjectCount();
  showToast(state.showDone ? 'Showing done projects' : 'Hiding done projects');
}

export async function toggleShowSandbox() {
  state.showSandbox = !state.showSandbox;
  await window.nexus.setShowSandbox(state.showSandbox);
  const toggle = document.getElementById('toggleSandbox');
  if (toggle) toggle.checked = state.showSandbox;
  if (_renderTable) _renderTable();
  if (_updateProjectCount) _updateProjectCount();
  showToast(state.showSandbox ? 'Showing sandbox projects' : 'Hiding sandbox projects');
}

export async function addProjectManual() {
  const folderPath = await window.nexus.showFolderDialog();
  if (!folderPath) return;
  const result = await window.nexus.addProject(folderPath, {});
  if (result.success) {
    state.allProjects = await window.nexus.scan();
    if (_renderTable) _renderTable();
    if (_updateProjectCount) _updateProjectCount();
    showToast(`Project "${result.project?.name || 'Unknown'}" added`);
  } else {
    showToast(result.error || 'Failed to add project');
  }
}

export function toggleToolsSection() {
  const section = document.getElementById('toolsSection');
  if (section) section.classList.toggle('collapsed');
}

export async function renameCategoryBulk() {
  const categories = getAllCategories();
  const categoryOptions = categories.map(c => ({ value: c, label: getCatLabel(c) }));
  const result = await showModal({
    title: 'Rename category',
    inputs: [
      { id: 'oldId', type: 'select', options: categoryOptions, value: categories[0] },
      { id: 'newLabel', placeholder: 'New label' },
      { id: 'newId', placeholder: 'New ID (optional)' }
    ],
    buttons: [
      { label: 'Cancel', action: 'cancel', class: 'modal-btn-cancel' },
      { label: 'Rename', action: 'ok', class: 'modal-btn-primary' }
    ]
  });
  if (!result || result.action !== 'ok') return;
  const { oldId, newLabel, newId } = result.values;
  if (!oldId || !newLabel.trim()) { showToast('Name is required'); return; }
  const renameResult = await window.nexus.renameCategory(oldId, newId.trim() || oldId, newLabel.trim());
  if (renameResult.success) {
    state.categoryDefs = renameResult.categories;
    state.allProjects = await window.nexus.scan();
    renderHiddenCategories();
    populateCategoryFilter();
    if (_renderTable) _renderTable();
    showToast('Category renamed');
  } else {
    showToast(renameResult.error || 'Failed to rename');
  }
}

export function setupCategoryListeners() {
  const el = document.getElementById('categoryList') || document.getElementById('hiddenCategories');
  if (el) {
    el.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'edit-cat') { e.stopPropagation(); editCategory(target.dataset.category); }
      else if (action === 'delete-cat') { e.stopPropagation(); deleteCategory(target.dataset.category); }
      else if (action === 'toggle-hidden-cat') toggleHiddenCategory(target.dataset.category);
    });
  }

  const btnAddCategory = document.getElementById('btnAddCategory');
  if (btnAddCategory) btnAddCategory.addEventListener('click', () => addCategory());

  const btnToggleTools = document.getElementById('btnToggleTools');
  if (btnToggleTools) btnToggleTools.addEventListener('click', () => toggleToolsSection());

  const btnAddProject = document.getElementById('btnAddProject');
  if (btnAddProject) btnAddProject.addEventListener('click', () => addProjectManual());

  const btnRenameBulk = document.getElementById('btnRenameCategoryBulk');
  if (btnRenameBulk) btnRenameBulk.addEventListener('click', () => renameCategoryBulk());

  const legacyToggle = document.getElementById('toggleLegacy');
  if (legacyToggle) legacyToggle.addEventListener('change', () => toggleShowLegacy());

  const doneToggle = document.getElementById('toggleDone');
  if (doneToggle) doneToggle.addEventListener('change', () => toggleShowDone());

  const sandboxToggle = document.getElementById('toggleSandbox');
  if (sandboxToggle) sandboxToggle.addEventListener('change', () => toggleShowSandbox());
}
