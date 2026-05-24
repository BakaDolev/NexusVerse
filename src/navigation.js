import { state, navPush, getNavIndex, setNavIndex, getNavHistory, setNavPushing } from './state.js';
import { capitalize } from './utils.js';
import { hideContextMenu } from './context-menu.js';

let _openDetail, _flushScratchpad, _flushProjectMetaAutosave, _loadInbox, _loadBackfill, _loadSettings, _clearRecentlyToggled;

export function initNavigation({ openDetail, flushScratchpad, flushProjectMetaAutosave, loadInbox, loadBackfill, loadSettings, clearRecentlyToggled }) {
  _openDetail = openDetail;
  _flushScratchpad = flushScratchpad;
  _flushProjectMetaAutosave = flushProjectMetaAutosave;
  _loadInbox = loadInbox;
  _loadBackfill = loadBackfill;
  _loadSettings = loadSettings;
  _clearRecentlyToggled = clearRecentlyToggled;
}

export function switchView(viewName) {
  if (state.currentView === 'detail') {
    if (_flushScratchpad) _flushScratchpad();
    if (_flushProjectMetaAutosave) _flushProjectMetaAutosave();
  }
  if (state.currentView === 'inbox' && viewName !== 'inbox' && _clearRecentlyToggled) _clearRecentlyToggled();
  if (viewName !== 'detail') state.currentProject = null;
  state.currentView = viewName;

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById(`view${capitalize(viewName)}`);
  if (viewEl) viewEl.classList.add('active');

  if (viewName !== 'detail') navPush({ view: viewName, projectPath: null });

  const sidebarCats = document.getElementById('sidebarCategories');
  if (sidebarCats) sidebarCats.style.display = viewName === 'detail' ? 'none' : '';

  if (viewName === 'inbox' && _loadInbox) _loadInbox();
  if (viewName === 'backfill' && _loadBackfill) _loadBackfill();
  if (viewName === 'settings' && _loadSettings) _loadSettings();
}

async function navGo(entry) {
  setNavPushing(false);
  try {
    if (entry.view === 'detail' && entry.projectPath) {
      if (_openDetail) await _openDetail(entry.projectPath);
    } else {
      switchView(entry.view);
      const btn = document.querySelector(`[data-view="${entry.view}"]`);
      if (btn) {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    }
  } finally {
    setNavPushing(true);
  }
}

export function setupNavigationListeners() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  const backfillLink = document.querySelector('.backfill-footer-link');
  if (backfillLink) {
    backfillLink.addEventListener('click', () => {
      switchView('backfill');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    });
  }

  window.addEventListener('mouseup', (e) => {
    const navIndex = getNavIndex();
    const navHistory = getNavHistory();
    if (e.button === 3 && navIndex > 0) {
      setNavIndex(navIndex - 1);
      navGo(navHistory[getNavIndex()]);
    } else if (e.button === 4 && navIndex < navHistory.length - 1) {
      setNavIndex(navIndex + 1);
      navGo(navHistory[getNavIndex()]);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = document.getElementById('contextMenu');
    if (menu && menu.style.display === 'block') { hideContextMenu(); return; }
    const modal = document.getElementById('modalOverlay');
    if (modal && modal.style.display !== 'none') return;
    const palette = document.getElementById('cmdPalette');
    if (palette && palette.style.display !== 'none') return;
    const picker = document.querySelector('.ix-project-picker');
    if (picker) return;
    if (state.currentView === 'detail') {
      state.currentProject = null;
      switchView('dashboard');
      document.querySelector('[data-view="dashboard"]').classList.add('active');
    }
  });
}
