import { state } from './state.js';
import { escapeHtml, timeAgo, colorWithAlpha } from './utils.js';
import { getCategoryColor } from './categories.js';
import { setContextTarget, renderContextMenu } from './context-menu.js';

let cmdSelectedIndex = 0;
let cmdFilteredProjects = [];

let _openDetail, _launchClaude, _launchVSCode, _launchTerminal;

export function initCommandPalette({ openDetail, launchClaude, launchVSCode, launchTerminal }) {
  _openDetail = openDetail;
  _launchClaude = launchClaude;
  _launchVSCode = launchVSCode;
  _launchTerminal = launchTerminal;
}

function openCommandPalette() {
  const overlay = document.getElementById('cmdPalette');
  const input = document.getElementById('cmdInput');
  overlay.style.display = 'flex';
  input.value = '';
  cmdSelectedIndex = 0;
  renderCmdResults('');
  input.focus();
}

function closeCommandPalette() {
  document.getElementById('cmdPalette').style.display = 'none';
}

function renderCmdResults(query) {
  const container = document.getElementById('cmdResults');
  const q = query.toLowerCase().trim();

  if (!q) {
    const recent = [...state.allProjects]
      .filter(p => p.status !== 'legacy' && p.status !== 'done')
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, 8);
    cmdFilteredProjects = recent;
  } else {
    cmdFilteredProjects = state.allProjects
      .filter(p => {
        const name = p.name.toLowerCase();
        const tags = (p.tags || []).join(' ').toLowerCase();
        const cat = (p.category || '').toLowerCase();
        const status = (p.status || '').toLowerCase();
        return name.includes(q) || tags.includes(q) || cat.includes(q) || status.includes(q);
      })
      .sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aStarts = aName.startsWith(q) ? 0 : 1;
        const bStarts = bName.startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      })
      .slice(0, 12);
  }

  if (cmdSelectedIndex >= cmdFilteredProjects.length) cmdSelectedIndex = Math.max(0, cmdFilteredProjects.length - 1);

  if (cmdFilteredProjects.length === 0) {
    container.innerHTML = '<div class="cmd-empty">No projects found</div>';
    return;
  }

  container.innerHTML = cmdFilteredProjects.map((p, i) => {
    const statusColors = {
      active: 'var(--status-active)',
      service: 'var(--status-service)',
      paused: 'var(--status-paused)',
      idea: 'var(--status-idea)',
      sandbox: 'var(--status-sandbox)',
      done: 'var(--status-done)',
      legacy: 'var(--status-legacy)'
    };
    const color = statusColors[p.status] || 'var(--text-muted)';
    const colorBg = colorWithAlpha(color, 0.12);
    const catColor = getCategoryColor(p.category);
    const highlighted = q ? highlightMatch(p.name, q) : escapeHtml(p.name);
    const gitInfo = [];
    if (p.gitBranch) gitInfo.push(p.gitBranch);
    if (p.gitDirty) gitInfo.push('*');
    if (p.gitUnpushed > 0) gitInfo.push(`↑${p.gitUnpushed}`);

    return `
      <div class="cmd-result ${i === cmdSelectedIndex ? 'selected' : ''}" data-index="${i}" data-path="${escapeHtml(p.path)}">
        <div class="cmd-result-icon" style="background:${colorBg};color:${color}">
          <span class="badge-status ${escapeHtml(p.status)}" style="padding:0;background:none;font-size:11px">${escapeHtml(p.status)}</span>
        </div>
        <div class="cmd-result-body">
          <div class="cmd-result-name">${highlighted}</div>
          <div class="cmd-result-detail">
            <span style="color:${catColor}">${escapeHtml(p.category)}</span>
            ${gitInfo.length ? `<span>${escapeHtml(gitInfo.join(' '))}</span>` : ''}
            ${p.lastActivity ? `<span>${timeAgo(p.lastActivity)}</span>` : ''}
          </div>
        </div>
        <div class="cmd-result-actions">
          <button class="cmd-action-btn claude-action" data-action="cmd-claude" data-index="${i}" title="Claude Code">&#9672;</button>
          <button class="cmd-action-btn" data-action="cmd-vscode" data-index="${i}" title="VS Code">&lt;/&gt;</button>
          <button class="cmd-action-btn" data-action="cmd-terminal" data-index="${i}" title="Terminal">&#9638;</button>
        </div>
      </div>`;
  }).join('') + `
    <div class="cmd-hint">
      <span><kbd>↵</kbd> Open</span>
      <span><kbd>⇧↵</kbd> Claude Code</span>
      <span><kbd>↑↓</kbd> Navigate</span>
    </div>`;
}

function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.substring(0, idx)) +
    '<mark>' + escapeHtml(text.substring(idx, idx + query.length)) + '</mark>' +
    escapeHtml(text.substring(idx + query.length));
}

function updateCmdSelection() {
  document.querySelectorAll('.cmd-result').forEach((el, i) => {
    el.classList.toggle('selected', i === cmdSelectedIndex);
  });
  const selected = document.querySelector('.cmd-result.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function cmdSelectProject(index) {
  const p = cmdFilteredProjects[index];
  if (!p) return;
  closeCommandPalette();
  if (_openDetail) _openDetail(p.path);
}

function cmdOpenClaude(index) {
  const p = cmdFilteredProjects[index];
  if (!p) return;
  closeCommandPalette();
  if (_launchClaude) _launchClaude(p.path);
}

function cmdOpenVSCode(index) {
  const p = cmdFilteredProjects[index];
  if (!p) return;
  closeCommandPalette();
  if (_launchVSCode) _launchVSCode(p.path);
}

function cmdOpenTerminal(index) {
  const p = cmdFilteredProjects[index];
  if (!p) return;
  closeCommandPalette();
  if (_launchTerminal) _launchTerminal(p.path);
}

export function setupCommandPaletteListeners() {
  const container = document.getElementById('cmdResults');
  if (container) {
    container.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const idx = parseInt(actionBtn.dataset.index);
        if (actionBtn.dataset.action === 'cmd-claude') cmdOpenClaude(idx);
        else if (actionBtn.dataset.action === 'cmd-vscode') cmdOpenVSCode(idx);
        else if (actionBtn.dataset.action === 'cmd-terminal') cmdOpenTerminal(idx);
        return;
      }
      const result = e.target.closest('.cmd-result');
      if (result) cmdSelectProject(parseInt(result.dataset.index));
    });
    container.addEventListener('mousemove', (e) => {
      const result = e.target.closest('.cmd-result');
      if (result) {
        const idx = parseInt(result.dataset.index);
        if (cmdSelectedIndex !== idx) { cmdSelectedIndex = idx; updateCmdSelection(); }
      }
    });
    container.addEventListener('contextmenu', (e) => {
      const result = e.target.closest('.cmd-result');
      if (!result) return;
      e.preventDefault();
      e.stopPropagation();
      const p = cmdFilteredProjects[parseInt(result.dataset.index)];
      if (!p) return;
      setContextTarget(p);
      renderContextMenu(e.clientX, e.clientY);
    });
  }

  document.getElementById('cmdInput').addEventListener('input', (e) => {
    cmdSelectedIndex = 0;
    renderCmdResults(e.target.value);
  });

  document.getElementById('cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdSelectedIndex < cmdFilteredProjects.length - 1) {
        cmdSelectedIndex++;
        updateCmdSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdSelectedIndex > 0) {
        cmdSelectedIndex--;
        updateCmdSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = cmdFilteredProjects[cmdSelectedIndex];
      if (!p) return;
      closeCommandPalette();
      if (e.shiftKey) {
        if (_launchClaude) _launchClaude(p.path);
      } else {
        if (_openDetail) _openDetail(p.path);
      }
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  });

  document.getElementById('cmdPalette').addEventListener('click', (e) => {
    if (e.target.id === 'cmdPalette') closeCommandPalette();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const overlay = document.getElementById('cmdPalette');
      if (overlay.style.display === 'flex') closeCommandPalette();
      else openCommandPalette();
    }
  });
}
