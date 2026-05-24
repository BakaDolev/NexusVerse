import { state, isPinned, navPush } from './state.js';
import { escapeHtml, showToast, capitalize, timeAgo, formatDate } from './utils.js';
import { getCategoryColor, getCategoryBackgroundColor, getAllCategories, populateCategoryFilter } from './categories.js';
import { normalizeTags, addTagPill, renderTagSuggestions, hideTagSuggestions, removeTag } from './tags.js';

let _switchView, _renderTable, _togglePin, _launchClaude, _launchVSCode, _launchTerminal, _openFolder;
let _loadProjectIdeas, _loadScratchpad, _flushScratchpad;

export function initDetail({ switchView, renderTable, togglePin, launchClaude, launchVSCode, launchTerminal, openFolder, loadProjectIdeas, loadScratchpad, flushScratchpad }) {
  _switchView = switchView;
  _renderTable = renderTable;
  _togglePin = togglePin;
  _launchClaude = launchClaude;
  _launchVSCode = launchVSCode;
  _launchTerminal = launchTerminal;
  _openFolder = openFolder;
  _loadProjectIdeas = loadProjectIdeas;
  _loadScratchpad = loadScratchpad;
  _flushScratchpad = flushScratchpad;
}

let projectMetaAutosaveTimer = null;
let projectMetaAutosaveInflight = false;
let projectMetaInflightPromise = null;
let projectMetaSavePromise = null;
let projectMetaAutosaveQueued = null;
let projectMetaLastSavedKey = '';
let projectMetaSaveStatusTimer = null;

export async function openDetail(projectPath, options = {}) {
  const detailToken = ++state.detailLoadToken;
  const activeDetailTab = document.querySelector('.detail-tab-btn.active')?.dataset.detailTab || 'ideas';
  const tabToRestore = options.preserveTab ? activeDetailTab : 'ideas';
  if (_flushScratchpad) await _flushScratchpad();
  await flushProjectMetaAutosave();
  state.currentProject = state.allProjects.find(p => p.path === projectPath);
  if (!state.currentProject) return;

  document.getElementById('detailName').textContent = state.currentProject.name;

  const meta = document.getElementById('detailMeta');
  const statusColors = {
    active: ['var(--status-active)','var(--status-active-bg)'],
    service: ['var(--status-service)','var(--status-service-bg)'],
    paused: ['var(--status-paused)','var(--status-paused-bg)'],
    idea: ['var(--status-idea)','var(--status-idea-bg)'],
    sandbox: ['var(--status-sandbox)','var(--status-sandbox-bg)'],
    done: ['var(--status-done)','var(--status-done-bg)'],
    legacy: ['var(--status-legacy)','var(--status-legacy-bg)']
  };
  const priorityColors = { high: ['var(--priority-high)','var(--priority-high-bg)'], medium: ['var(--priority-medium)','var(--priority-medium-bg)'], low: ['var(--priority-low)','var(--priority-low-bg)'] };
  const catColors = Object.fromEntries(getAllCategories().map(category => [
    category,
    [getCategoryColor(category), getCategoryBackgroundColor(category)]
  ]));

  function pillSelector(id, current, opts, colorMap) {
    return opts.map(opt => {
      const isActive = opt === current;
      const [color, bg] = colorMap[opt] || ['var(--text-secondary)', 'var(--bg-tertiary)'];
      const activeStyle = isActive ? `color:${color};background:${bg};border:1px solid ${color};opacity:1` : '';
      return `<span class="pill-option ${isActive ? 'active' : ''}" data-pill-group="${escapeHtml(id)}" data-pill-value="${escapeHtml(opt)}" style="${activeStyle}">${escapeHtml(opt)}</span>`;
    }).join('');
  }

  const tags = normalizeTags(state.currentProject.tags || []);

  meta.innerHTML = `
    <div class="detail-meta-row">
      <div class="meta-item">
        <label>Status</label>
        <div class="pill-selector" id="pillStatus">${pillSelector('status', state.currentProject.status, ['active','service','paused','idea','sandbox','done','legacy'], statusColors)}</div>
        <input type="hidden" id="editStatus" value="${escapeHtml(state.currentProject.status)}">
      </div>
      <div class="meta-item">
        <label>Priority</label>
        <div class="pill-selector" id="pillPriority">${pillSelector('priority', state.currentProject.priority, ['high','medium','low'], priorityColors)}</div>
        <input type="hidden" id="editPriority" value="${escapeHtml(state.currentProject.priority)}">
      </div>
      <div class="meta-item">
        <label>Category</label>
        <div class="pill-selector" id="pillCategory">${pillSelector('category', state.currentProject.category, getAllCategories(), catColors)}</div>
        <input type="hidden" id="editCategory" value="${escapeHtml(state.currentProject.category)}">
      </div>
      <div class="meta-item"><label>Branch</label><span>${state.currentProject.gitBranch ? `<span class="branch-name" style="font-size:12px">${escapeHtml(state.currentProject.gitBranch)}</span>` : '—'}</span></div>
      <div class="meta-item"><label>Last Active</label><span style="color:var(--text-secondary);font-size:14px">${state.currentProject.lastActivity ? timeAgo(state.currentProject.lastActivity) : '—'}</span></div>
      <div class="meta-item"><label>Created</label><span style="color:var(--text-muted);font-size:14px">${formatDate(state.currentProject.createdDate)}</span></div>
    </div>
    <div class="meta-next-step">
      <label>Next Step</label>
      <input type="text" id="editNext" class="edit-field" value="${escapeHtml(state.currentProject.next || '')}" placeholder="What's next for this project?" />
    </div>
    <div class="meta-tags">
      <label>Tags</label>
      <div class="tag-list" id="tagList">
        ${tags.map(t => `<span class="tag-pill" data-tag="${escapeHtml(t)}">${escapeHtml(t)} <span class="tag-remove" data-action="remove-tag" data-tag="${escapeHtml(t)}">&times;</span></span>`).join('')}
        <span class="tag-add-btn" id="btnAddTag">+ add tag</span>
      </div>
      <div class="tag-suggestions" id="tagSuggestions" style="display:none"></div>
      <input type="hidden" id="editTags" value="${escapeHtml(tags.join(', '))}">
    </div>
    ${state.currentProject.dependencies && state.currentProject.dependencies.length ? `
    <div class="meta-dependencies">
      <label>Depends on</label>
      <div class="dep-list">
        ${state.currentProject.dependencies.map(dep => dep.resolved
          ? `<span class="dep-pill dep-resolved" data-dep-path="${escapeHtml(dep.projectPath)}" title="Open ${escapeHtml(dep.label)}">${escapeHtml(dep.label)}</span>`
          : `<span class="dep-pill dep-unresolved" title="Project not found in current scan">${escapeHtml(dep.label)} ?</span>`
        ).join('')}
      </div>
    </div>` : ''}
    ${state.currentProject.parseErrors.length ? `<div style="margin-bottom:14px"><label style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);font-weight:700">Errors</label><span class="parse-error" style="display:block;margin-top:4px">${escapeHtml(state.currentProject.parseErrors.join('; '))}</span></div>` : ''}
    <div class="meta-save">
      <span class="autosave-label">Autosave</span>
      <span id="saveStatus" class="save-status">Saved</span>
    </div>
  `;
  projectMetaLastSavedKey = getProjectMetaKey(captureProjectMetaFields());
  setProjectMetaSaveStatus('Saved', { clearAfter: 1200 });

  meta.onclick = (e) => {
    const removeBtn = e.target.closest('[data-action="remove-tag"]');
    if (removeBtn) removeTag(removeBtn.dataset.tag);
  };

  meta.querySelectorAll('.pill-option').forEach(pill => {
    pill.addEventListener('click', () => {
      if (pill.classList.contains('active')) return;
      const group = pill.dataset.pillGroup;
      const value = pill.dataset.pillValue;
      const colorMaps = { status: statusColors, priority: priorityColors, category: catColors };
      const container = pill.closest('.pill-selector');
      container.querySelectorAll('.pill-option').forEach(p => {
        p.classList.remove('active');
        p.style.color = ''; p.style.background = ''; p.style.border = ''; p.style.opacity = '';
      });
      pill.classList.add('active');
      const [color, bg] = (colorMaps[group] || {})[value] || ['var(--text-secondary)', 'var(--bg-tertiary)'];
      pill.style.color = color;
      pill.style.background = bg;
      pill.style.border = `1px solid ${color}`;
      pill.style.opacity = '1';
      document.getElementById(`edit${capitalize(group)}`).value = value;
      scheduleProjectMetaAutosave(150);
    });
  });

  meta.querySelectorAll('.dep-resolved').forEach(pill => {
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => openDetail(pill.dataset.depPath));
  });

  document.getElementById('btnAddTag').addEventListener('click', function() {
    const tagList = document.getElementById('tagList');
    const addBtn = this;
    if (tagList.querySelector('.tag-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input';
    input.placeholder = 'tag name';
    tagList.insertBefore(input, addBtn);
    input.focus();
    renderTagSuggestions(input.value, input);

    let committed = false;
    const addTag = () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val) addTagPill(val);
      try { if (input.parentNode) input.remove(); } catch {}
      hideTagSuggestions();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addTag(); }
      if (e.key === 'Escape') {
        committed = true;
        try { if (input.parentNode) input.remove(); } catch {}
        hideTagSuggestions();
      }
    });
    input.addEventListener('input', () => renderTagSuggestions(input.value, input));
    input.addEventListener('blur', addTag);
  });

  const sidebarCats = document.getElementById('sidebarCategories');
  if (sidebarCats) sidebarCats.style.display = 'none';

  const nextInput = document.getElementById('editNext');
  if (nextInput) {
    nextInput.addEventListener('input', () => scheduleProjectMetaAutosave());
    nextInput.addEventListener('blur', () => scheduleProjectMetaAutosave(0));
    nextInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        scheduleProjectMetaAutosave(0);
      }
    });
  }

  const actions = document.getElementById('detailActions');
  const pinned = isPinned(state.currentProject.id);
  actions.innerHTML = `
    <span class="action-btn" style="${pinned ? 'background:var(--accent-dim);border:1px solid rgba(129,140,248,0.4);color:var(--accent);font-weight:700' : ''}" data-action="detail-pin" data-id="${escapeHtml(state.currentProject.id)}" data-path="${escapeHtml(state.currentProject.path)}" title="${pinned ? 'Unpin' : 'Pin'}">&#9733; ${pinned ? 'Pinned' : 'Pin'}</span>
    ${state.currentProject.githubUrl ? `<span class="action-btn github-btn" data-action="open-url" data-url="${escapeHtml(state.currentProject.githubUrl)}" title="${escapeHtml(state.currentProject.githubUrl)}">GitHub</span>` : ''}
    <span class="action-btn claude-btn" data-action="launch-claude" data-path="${escapeHtml(state.currentProject.path)}">Claude Code</span>
    <span class="action-btn" data-action="launch-vscode" data-path="${escapeHtml(state.currentProject.path)}">VS Code</span>
    <span class="action-btn" data-action="launch-terminal" data-path="${escapeHtml(state.currentProject.path)}">Terminal</span>
    <span class="action-btn" data-action="open-folder" data-path="${escapeHtml(state.currentProject.path)}">Folder</span>
  `;
  actions.onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'detail-pin') { if (_togglePin) _togglePin(btn.dataset.id); openDetail(btn.dataset.path); }
    else if (action === 'open-url') window.nexus.openUrl(btn.dataset.url);
    else if (action === 'launch-claude' && _launchClaude) _launchClaude(btn.dataset.path);
    else if (action === 'launch-vscode' && _launchVSCode) _launchVSCode(btn.dataset.path);
    else if (action === 'launch-terminal' && _launchTerminal) _launchTerminal(btn.dataset.path);
    else if (action === 'open-folder' && _openFolder) _openFolder(btn.dataset.path);
  };

  const content = document.getElementById('detailContent');
  if (state.currentProject.hasProjectPlan) {
    const result = await window.nexus.readFile(state.currentProject.path + '\\PROJECT_PLAN.md');
    if (detailToken !== state.detailLoadToken || !state.currentProject || state.currentProject.path !== projectPath) return;
    if (result.content) {
      const markdown = getMarkdownRenderer();
      const planCollapsed = localStorage.getItem('nexus_planCollapsed') === 'true';
      content.innerHTML = `
        <div class="detail-content-header">
          <h3 id="planCollapseToggle" style="cursor:pointer;display:flex;align-items:center;gap:8px">
            <span class="ix-group-arrow ${planCollapsed ? 'collapsed' : ''}" id="planCollapseArrow" style="font-size:12px">&#9662;</span>
            PROJECT_PLAN.md
          </h3>
          <span class="action-btn" id="btnToggleEditPlan" style="padding:5px 14px;font-size:12px">Edit</span>
        </div>
        <div id="planCollapsible" style="${planCollapsed ? 'display:none' : ''}">
          <div id="planRendered">${markdown.parse(result.content)}</div>
          <textarea id="planEditor" class="plan-editor" style="display:none">${escapeHtml(result.content)}</textarea>
          <div class="plan-edit-bar" style="display:none" id="planEditBar">
            <button class="btn-primary" id="btnSavePlan">Save Plan</button>
            <button class="action-btn" id="btnCancelEditPlan">Cancel</button>
          </div>
        </div>
      `;
      document.getElementById('planCollapseToggle').addEventListener('click', () => {
        const body = document.getElementById('planCollapsible');
        const arrow = document.getElementById('planCollapseArrow');
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        arrow.classList.toggle('collapsed', !collapsed);
        localStorage.setItem('nexus_planCollapsed', !collapsed);
      });
      document.getElementById('btnToggleEditPlan').addEventListener('click', () => {
        document.getElementById('planRendered').style.display = 'none';
        document.getElementById('planEditor').style.display = 'block';
        document.getElementById('btnToggleEditPlan').style.display = 'none';
        document.getElementById('planEditBar').style.display = 'flex';
      });
      document.getElementById('btnCancelEditPlan').addEventListener('click', () => {
        document.getElementById('planRendered').style.display = 'block';
        document.getElementById('planEditor').style.display = 'none';
        document.getElementById('btnToggleEditPlan').style.display = 'inline-block';
        document.getElementById('planEditBar').style.display = 'none';
      });
      document.getElementById('btnSavePlan').addEventListener('click', async () => {
        const newContent = document.getElementById('planEditor').value;
        const saveResult = await window.nexus.writeFile(state.currentProject.path + '\\PROJECT_PLAN.md', newContent);
        if (saveResult.success) {
          const md = getMarkdownRenderer();
          document.getElementById('planRendered').innerHTML = md.parse(newContent);
          document.getElementById('planRendered').style.display = 'block';
          document.getElementById('planEditor').style.display = 'none';
          document.getElementById('btnToggleEditPlan').style.display = 'inline-block';
          document.getElementById('planEditBar').style.display = 'none';
          showToast('Project plan saved');
          state.allProjects = await window.nexus.rescan();
          state.currentProject = state.allProjects.find(p => p.path === state.currentProject.path) || state.currentProject;
          if (_renderTable) _renderTable();
          populateCategoryFilter();
        } else {
          showToast('Save failed: ' + saveResult.error);
        }
      });
    } else {
      content.innerHTML = `<p style="color:var(--text-muted)">Could not read PROJECT_PLAN.md</p>`;
    }
  } else {
    content.innerHTML = `<p style="color:var(--text-muted)">No PROJECT_PLAN.md found</p>`;
  }

  if (_loadProjectIdeas) await _loadProjectIdeas(projectPath, detailToken);
  if (detailToken !== state.detailLoadToken || !state.currentProject || state.currentProject.path !== projectPath) return;

  wireDetailTabs();

  document.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.detailTab === tabToRestore));
  document.querySelectorAll('.detail-tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel' + capitalize(tabToRestore))?.classList.add('active');
  if (tabToRestore === 'scratchpad' && _loadScratchpad) _loadScratchpad();

  state.currentView = 'detail';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('viewDetail').classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (options.pushHistory !== false) navPush({ view: 'detail', projectPath });
}

function wireDetailTabs() {
  document.querySelectorAll('.detail-tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.detail-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('panel' + capitalize(btn.dataset.detailTab));
      if (panel) panel.classList.add('active');
      if (btn.dataset.detailTab === 'scratchpad' && _loadScratchpad) _loadScratchpad();
    };
  });
}

function captureProjectMetaFields() {
  const tagList = document.getElementById('tagList');
  const tagsFromPills = tagList ? [...tagList.querySelectorAll('.tag-pill')].map(p => p.dataset.tag) : [];
  const fallbackTags = document.getElementById('editTags')?.value.split(',').map(t => t.trim()).filter(Boolean) || [];
  return {
    status: document.getElementById('editStatus')?.value || state.currentProject?.status || 'active',
    priority: document.getElementById('editPriority')?.value || state.currentProject?.priority || 'medium',
    category: document.getElementById('editCategory')?.value || state.currentProject?.category || 'uncategorized',
    next: document.getElementById('editNext')?.value.trim() || '',
    tags: normalizeTags(tagsFromPills.length > 0 ? tagsFromPills : fallbackTags)
  };
}

function getProjectMetaKey(fields) {
  return JSON.stringify(fields);
}

function setProjectMetaSaveStatus(message, options = {}) {
  const saveStatus = document.getElementById('saveStatus');
  if (!saveStatus) return;

  if (projectMetaSaveStatusTimer) clearTimeout(projectMetaSaveStatusTimer);
  saveStatus.textContent = message;
  saveStatus.dataset.state = options.state || '';

  if (options.clearAfter) {
    projectMetaSaveStatusTimer = setTimeout(() => {
      if (saveStatus.textContent === message) saveStatus.textContent = '';
    }, options.clearAfter);
  }
}

export function scheduleProjectMetaAutosave(delay = 650) {
  if (!state.currentProject) return;
  const fields = captureProjectMetaFields();
  const nextKey = getProjectMetaKey(fields);
  if (nextKey === projectMetaLastSavedKey && !projectMetaAutosaveInflight) {
    setProjectMetaSaveStatus('Saved', { clearAfter: 1200 });
    return;
  }

  setProjectMetaSaveStatus(delay > 0 ? 'Unsaved changes' : 'Saving...', { state: delay > 0 ? 'pending' : 'saving' });
  if (projectMetaAutosaveTimer) clearTimeout(projectMetaAutosaveTimer);
  projectMetaAutosaveTimer = setTimeout(() => {
    projectMetaAutosaveTimer = null;
    saveProjectMeta();
  }, delay);
}

export async function flushProjectMetaAutosave() {
  if (!state.currentProject || !document.getElementById('detailMeta')) return;
  if (projectMetaAutosaveTimer) {
    clearTimeout(projectMetaAutosaveTimer);
    projectMetaAutosaveTimer = null;
  }

  const fields = captureProjectMetaFields();
  const projectPath = state.currentProject.path;

  if (projectMetaAutosaveInflight) {
    projectMetaAutosaveQueued = { projectPath, fields };
    if (projectMetaInflightPromise) await projectMetaInflightPromise;
    if (projectMetaSavePromise) await projectMetaSavePromise;
    return;
  }

  const fieldsKey = getProjectMetaKey(fields);
  if (fieldsKey !== projectMetaLastSavedKey) {
    await saveProjectMeta();
  }
}

async function saveProjectMeta() {
  if (!state.currentProject) return;
  if (projectMetaAutosaveInflight) {
    projectMetaAutosaveQueued = { projectPath: state.currentProject.path, fields: captureProjectMetaFields() };
    return;
  }

  const fields = captureProjectMetaFields();
  const fieldsKey = getProjectMetaKey(fields);
  if (fieldsKey === projectMetaLastSavedKey) {
    setProjectMetaSaveStatus('Saved', { clearAfter: 1200 });
    return;
  }

  projectMetaAutosaveInflight = true;
  let inflightResolve;
  projectMetaInflightPromise = new Promise(r => { inflightResolve = r; });
  setProjectMetaSaveStatus('Saving...', { state: 'saving' });

  const projectPath = state.currentProject.path;
  let result;
  try {
    result = await window.nexus.updateProject(projectPath, fields);
  } catch (err) {
    result = { error: err.message || 'unknown' };
  }
  projectMetaAutosaveInflight = false;
  inflightResolve();
  projectMetaInflightPromise = null;

  if (result.success && state.currentProject?.path === projectPath) {
    if (result.project) {
      const idx = state.allProjects.findIndex(p => p.path === state.currentProject.path);
      if (idx !== -1) state.allProjects[idx] = result.project;
      state.currentProject = result.project;
      syncPlanEditorMetadata(result.project);
    }
    projectMetaLastSavedKey = fieldsKey;
    setProjectMetaSaveStatus('Saved', { state: 'saved', clearAfter: 1200 });
    if (_renderTable) _renderTable();
  } else if (!result.success) {
    setProjectMetaSaveStatus('Save failed', { state: 'error' });
    showToast('Save failed: ' + (result.error || 'unknown'));
  }

  if (projectMetaAutosaveQueued) {
    const snapshot = projectMetaAutosaveQueued;
    projectMetaAutosaveQueued = null;
    const queuedSave = (async () => {
      try {
        const qResult = await window.nexus.updateProject(snapshot.projectPath, snapshot.fields);
        if (qResult.success && state.currentProject?.path === snapshot.projectPath) {
          if (qResult.project) {
            const qi = state.allProjects.findIndex(p => p.path === snapshot.projectPath);
            if (qi !== -1) state.allProjects[qi] = qResult.project;
            state.currentProject = qResult.project;
            syncPlanEditorMetadata(qResult.project);
          }
          projectMetaLastSavedKey = getProjectMetaKey(snapshot.fields);
          setProjectMetaSaveStatus('Saved', { state: 'saved', clearAfter: 1200 });
          if (_renderTable) _renderTable();
        } else if (!qResult.success) {
          setProjectMetaSaveStatus('Save failed', { state: 'error' });
        }
      } catch {}
    })();
    projectMetaSavePromise = queuedSave;
    await queuedSave;
    if (projectMetaSavePromise === queuedSave) projectMetaSavePromise = null;
  }
}

function getMarkdownRenderer() {
  return { parse: simpleMarkdown };
}

function simpleMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/^---[\s\S]*?---\n*/m, '');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><h([123])>/g, '<h$1>');
  html = html.replace(/<\/h([123])><\/p>/g, '</h$1>');
  html = html.replace(/<p><ul>/g, '<ul>');
  html = html.replace(/<\/ul><\/p>/g, '</ul>');
  return html;
}

function syncPlanEditorMetadata(project) {
  const planEditor = document.getElementById('planEditor');
  if (!planEditor || !project) return;

  const previousContent = planEditor.value;
  const mergedContent = mergePlanContentMetadata(previousContent, project);
  if (mergedContent === previousContent) return;

  const wasFocused = document.activeElement === planEditor;
  const selectionStart = planEditor.selectionStart;
  const selectionEnd = planEditor.selectionEnd;
  const selectionDirection = planEditor.selectionDirection;
  const scrollTop = planEditor.scrollTop;
  const frontmatterDelta = getFrontmatterBlockLength(mergedContent) - getFrontmatterBlockLength(previousContent);

  planEditor.value = mergedContent;
  if (wasFocused) {
    const adjust = value => Math.max(0, Math.min(mergedContent.length, value + frontmatterDelta));
    planEditor.focus();
    planEditor.setSelectionRange(adjust(selectionStart), adjust(selectionEnd), selectionDirection);
    planEditor.scrollTop = scrollTop;
  }

  const rendered = document.getElementById('planRendered');
  if (rendered && rendered.style.display !== 'none') {
    rendered.innerHTML = getMarkdownRenderer().parse(mergedContent);
  }
}

function getFrontmatterBlockLength(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return match ? match[0].length : 0;
}

function mergePlanContentMetadata(content, project) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = match ? text.slice(match[0].length) : text;
  const existingFrontmatter = match ? match[1] : '';
  const preservedFrontmatter = stripYamlKeys(existingFrontmatter, ['status', 'priority', 'category', 'next', 'tags']);
  const lines = [
    `status: ${formatYamlScalar(project.status || 'active')}`,
    `priority: ${formatYamlScalar(project.priority || 'medium')}`,
    `category: ${formatYamlScalar(project.category || 'uncategorized')}`
  ];

  if (project.next) lines.push(`next: ${formatYamlScalar(project.next)}`);

  const tags = normalizeTags(project.tags || []);
  if (tags.length > 0) {
    lines.push('tags:');
    tags.forEach(tag => lines.push(`  - ${formatYamlScalar(tag)}`));
  }

  if (preservedFrontmatter) lines.push(...preservedFrontmatter.split(/\r?\n/));
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function stripYamlKeys(frontmatter, keys) {
  const keySet = new Set(keys);
  const lines = String(frontmatter || '').split(/\r?\n/);
  const kept = [];
  let skippingBlock = false;

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/);
    if (keyMatch && keySet.has(keyMatch[1])) {
      skippingBlock = true;
      continue;
    }
    if (skippingBlock) {
      if (/^\s+/.test(line) || line.trim() === '') continue;
      skippingBlock = false;
    }
    kept.push(line);
  }

  return kept.join('\n').trim();
}

function formatYamlScalar(value) {
  const text = String(value || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(text)) return text;
  return JSON.stringify(text);
}

export function setupDetailListeners() {
  document.getElementById('btnBack').addEventListener('click', () => {
    state.currentProject = null;
    if (_switchView) _switchView('dashboard');
    document.querySelector('[data-view="dashboard"]').classList.add('active');
  });
}
