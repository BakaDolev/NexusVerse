import { state, isPinned } from './state.js';
import { escapeHtml, showToast } from './utils.js';
import { getAllCategories } from './categories.js';

let contextTarget = null;

let _renderTable, _launchClaude, _launchVSCode, _launchTerminal, _openFolder;

export function initContextMenu({ renderTable, launchClaude, launchVSCode, launchTerminal, openFolder }) {
  _renderTable = renderTable;
  _launchClaude = launchClaude;
  _launchVSCode = launchVSCode;
  _launchTerminal = launchTerminal;
  _openFolder = openFolder;
}

export function setContextTarget(project) {
  contextTarget = project;
}

export function getContextTarget() {
  return contextTarget;
}

export function renderContextMenu(x, y) {
  const menu = getOrCreateContextMenu();
  const pinned = isPinned(contextTarget.id);
  menu.classList.remove('open-left');
  menu.innerHTML = `
    <div class="ctx-header">${escapeHtml(contextTarget.name)}</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item" data-action="ctx-pin">&#9733; ${pinned ? 'Unpin' : 'Pin to top'}</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item ctx-has-sub">
      Status <span class="ctx-arrow">&#9656;</span>
      <div class="ctx-submenu">
        ${['active','service','paused','idea','sandbox','done','legacy'].map(s =>
          `<div class="ctx-sub-item ${contextTarget.status === s ? 'ctx-active' : ''}" data-action="ctx-set-field" data-field="status" data-value="${s}">${s}</div>`
        ).join('')}
      </div>
    </div>
    <div class="ctx-item ctx-has-sub">
      Priority <span class="ctx-arrow">&#9656;</span>
      <div class="ctx-submenu">
        ${['high','medium','low'].map(s =>
          `<div class="ctx-sub-item ${contextTarget.priority === s ? 'ctx-active' : ''}" data-action="ctx-set-field" data-field="priority" data-value="${s}">${s}</div>`
        ).join('')}
      </div>
    </div>
    <div class="ctx-item ctx-has-sub">
      Category <span class="ctx-arrow">&#9656;</span>
      <div class="ctx-submenu">
        ${getAllCategories().map(s =>
          `<div class="ctx-sub-item ${contextTarget.category === s ? 'ctx-active' : ''}" data-action="ctx-set-field" data-field="category" data-value="${escapeHtml(s)}">${escapeHtml(s)}</div>`
        ).join('')}
      </div>
    </div>
    <div class="ctx-divider"></div>
    <div class="ctx-item" data-action="ctx-launch" data-type="claude">Open in Claude Code</div>
    <div class="ctx-item" data-action="ctx-launch" data-type="vscode">Open in VS Code</div>
    <div class="ctx-item" data-action="ctx-launch" data-type="terminal">Open Terminal</div>
    <div class="ctx-item" data-action="ctx-launch" data-type="folder">Open Folder</div>
  `;

  menu.style.visibility = 'hidden';
  menu.style.display = 'block';
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const menuX = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const menuY = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  const submenuWidth = 180;
  menu.classList.toggle('open-left', menuX + rect.width + submenuWidth + margin > window.innerWidth);
  menu.style.left = menuX + 'px';
  menu.style.top = menuY + 'px';
  menu.style.visibility = 'visible';
}

export function hideContextMenu() {
  const menu = document.getElementById('contextMenu');
  if (menu) menu.style.display = 'none';
}

function getOrCreateContextMenu() {
  let menu = document.getElementById('contextMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'contextMenu';
    menu.className = 'context-menu';
    document.body.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'ctx-pin') ctxTogglePin();
      else if (action === 'ctx-set-field') ctxSetField(el.dataset.field, el.dataset.value);
      else if (action === 'ctx-launch') ctxLaunch(el.dataset.type);
    });
  }
  return menu;
}

async function ctxTogglePin() {
  if (!contextTarget) return;
  const result = await window.nexus.togglePin(contextTarget.id);
  if (result.success) {
    state.pinnedIds = result.pinnedIds;
    if (_renderTable) _renderTable();
    const menu = document.getElementById('contextMenu');
    if (menu && menu.style.display === 'block') {
      contextTarget = state.allProjects.find(p => p.path === contextTarget.path) || contextTarget;
      renderContextMenu(parseInt(menu.style.left), parseInt(menu.style.top));
    }
  }
}

async function ctxSetField(field, value) {
  if (!contextTarget) return;
  const result = await window.nexus.updateProject(contextTarget.path, { [field]: value });
  if (result.success && result.project) {
    const idx = state.allProjects.findIndex(p => p.path === contextTarget.path);
    if (idx !== -1) state.allProjects[idx] = result.project;
    contextTarget = result.project;
    if (_renderTable) _renderTable();
    showToast(`${contextTarget.name}: ${field} → ${value}`);
    const menu = document.getElementById('contextMenu');
    if (menu && menu.style.display === 'block') {
      renderContextMenu(parseInt(menu.style.left), parseInt(menu.style.top));
    }
  } else {
    showToast('Update failed: ' + (result.error || 'unknown'));
  }
}

function ctxLaunch(type) {
  if (!contextTarget) return;
  hideContextMenu();
  if (type === 'claude' && _launchClaude) _launchClaude(contextTarget.path);
  else if (type === 'vscode' && _launchVSCode) _launchVSCode(contextTarget.path);
  else if (type === 'terminal' && _launchTerminal) _launchTerminal(contextTarget.path);
  else if (type === 'folder' && _openFolder) _openFolder(contextTarget.path);
}

export function setupContextMenuListeners() {
  document.addEventListener('contextmenu', (e) => {
    const menu = document.getElementById('contextMenu');
    if (menu && menu.style.display === 'block' && !e.target.closest('.context-menu')) {
      e.preventDefault();
      hideContextMenu();
      return;
    }

    const row = e.target.closest('#projectTableBody tr');
    if (!row) return;
    e.preventDefault();

    contextTarget = state.allProjects.find(p => p.path === row.dataset.path);
    if (!contextTarget) return;

    renderContextMenu(e.clientX, e.clientY);
  });

  document.addEventListener('click', (e) => {
    const menu = document.getElementById('contextMenu');
    if (menu && menu.style.display === 'block' && !e.target.closest('.context-menu')) {
      e.stopPropagation();
      e.preventDefault();
      hideContextMenu();
      return;
    }
  }, true);
}
