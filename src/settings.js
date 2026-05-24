import { state } from './state.js';
import { escapeHtml, showToast } from './utils.js';

let settingsDraft = null;
let settingsLogPath = '';

let _renderTable, _updateProjectCount;

export function initSettings({ renderTable, updateProjectCount }) {
  _renderTable = renderTable;
  _updateProjectCount = updateProjectCount;
}

export async function loadSettings() {
  const cfg = await window.nexus.getConfig();
  settingsLogPath = cfg._logPath || '';
  settingsDraft = {
    roots: [...(cfg.roots || [])],
    scanDepth: cfg.scanDepth || 4,
    ignoredPaths: [...(cfg.ignoredPaths || [])],
    launch: {
      claudeCode: cfg.launch?.claudeCode || 'claude',
      vscode: cfg.launch?.vscode || 'code',
      terminal: cfg.launch?.terminal || 'wt -d'
    }
  };
  renderSettings();
}

function renderSettings() {
  if (!settingsDraft) return;
  renderSettingsPathList('settingsRoots', settingsDraft.roots, 'roots');
  renderSettingsPathList('settingsIgnoredPaths', settingsDraft.ignoredPaths, 'ignoredPaths');
  document.getElementById('settingsScanDepth').value = settingsDraft.scanDepth;
  document.getElementById('settingsLaunchClaude').value = settingsDraft.launch.claudeCode;
  document.getElementById('settingsLaunchVscode').value = settingsDraft.launch.vscode;
  document.getElementById('settingsLaunchTerminal').value = settingsDraft.launch.terminal;
  const logPath = document.getElementById('settingsLogPath');
  if (logPath) logPath.textContent = settingsLogPath ? `Log file: ${settingsLogPath}` : '';
}

function renderSettingsPathList(containerId, paths, kind) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = paths.length ? paths.map((value, index) => `
    <div class="settings-path-row">
      <span title="${escapeHtml(value)}">${escapeHtml(value)}</span>
      <button class="settings-remove-btn" type="button" data-action="settings-remove-path" data-kind="${kind}" data-index="${index}">&times;</button>
    </div>
  `).join('') : '<p class="settings-empty">None configured.</p>';
}

function addUniqueSettingPath(kind, folderPath) {
  if (!settingsDraft || !folderPath) return;
  const list = settingsDraft[kind];
  const key = folderPath.toLowerCase();
  if (!list.some(item => item.toLowerCase() === key)) {
    list.push(folderPath);
  }
  renderSettings();
}

async function addSettingsFolder(kind) {
  if (!settingsDraft) await loadSettings();
  const folderPath = await window.nexus.showFolderDialog();
  addUniqueSettingPath(kind, folderPath);
}

export async function saveSettings() {
  if (!settingsDraft) return;
  const status = document.getElementById('settingsSaveStatus');
  status.textContent = 'Saving...';

  settingsDraft.scanDepth = Number(document.getElementById('settingsScanDepth').value);
  settingsDraft.launch.claudeCode = document.getElementById('settingsLaunchClaude').value.trim();
  settingsDraft.launch.vscode = document.getElementById('settingsLaunchVscode').value.trim();
  settingsDraft.launch.terminal = document.getElementById('settingsLaunchTerminal').value.trim();

  const result = await window.nexus.saveSettings(settingsDraft);
  if (result.success) {
    state.categoryDefs = result.config.categories || state.categoryDefs;
    settingsDraft = {
      roots: [...(result.config.roots || [])],
      scanDepth: result.config.scanDepth || 4,
      ignoredPaths: [...(result.config.ignoredPaths || [])],
      launch: { ...(result.config.launch || {}) }
    };
    settingsLogPath = result.config._logPath || settingsLogPath;
    status.textContent = 'Saved';
    showToast('Settings saved');
    state.allProjects = await window.nexus.rescan();
    renderSettings();
    if (_renderTable) _renderTable();
    if (_updateProjectCount) _updateProjectCount();
    setTimeout(() => {
      if (status.textContent === 'Saved') status.textContent = '';
    }, 2000);
  } else {
    status.textContent = 'Error: ' + result.error;
    showToast('Settings failed: ' + result.error);
  }
}

export function setupSettingsListeners() {
  document.getElementById('btnAddRoot')?.addEventListener('click', () => addSettingsFolder('roots'));
  document.getElementById('btnAddIgnoredPath')?.addEventListener('click', () => addSettingsFolder('ignoredPaths'));
  document.getElementById('btnSaveSettings')?.addEventListener('click', saveSettings);
  document.getElementById('btnOpenLogFile')?.addEventListener('click', async () => {
    const result = await window.nexus.openLogFile();
    showToast(result.success ? 'Opened log file' : `Open log failed: ${result.error || 'unknown'}`);
  });
  document.getElementById('btnOpenLogFolder')?.addEventListener('click', async () => {
    const result = await window.nexus.openLogFolder();
    showToast(result.success ? 'Opened logs folder' : `Open logs folder failed: ${result.error || 'unknown'}`);
  });
  document.getElementById('viewSettings')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="settings-remove-path"]');
    if (!btn || !settingsDraft) return;
    const list = settingsDraft[btn.dataset.kind];
    if (!Array.isArray(list)) return;
    list.splice(Number(btn.dataset.index), 1);
    renderSettings();
  });
}
