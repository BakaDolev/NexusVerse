import { state, navPush } from './state.js';
import { showToast } from './utils.js';
import { launchClaude, launchVSCode, launchTerminal, openFolder } from './launch.js';
import { initTags, getTagKey, normalizeTags } from './tags.js';
import { initCategories, getAllCategories, getCategoryColor, populateCategoryFilter, renderHiddenCategories } from './categories.js';
import { initSettings, loadSettings } from './settings.js';
import { initBackfill, loadBackfill } from './backfill.js';
import { initDashboard, renderTable, getFilteredProjects, updateProjectCount, togglePin } from './dashboard.js';
import { initDetail, openDetail, scheduleProjectMetaAutosave, flushProjectMetaAutosave, setupDetailListeners } from './detail.js';
import { initIdeas, loadInbox, loadProjectIdeas, loadScratchpad, flushScratchpad, refreshInboxCache, updateInboxBadge, populateProjectHintDropdown, setupIdeaListeners, clearRecentlyToggled } from './ideas-ui.js';
import { initContextMenu, setupContextMenuListeners } from './context-menu.js';
import { initCommandPalette, setupCommandPaletteListeners } from './command-palette.js';
import { initNavigation, switchView, setupNavigationListeners } from './navigation.js';
import { setupDashboardListeners } from './dashboard.js';
import { setupCategoryListeners } from './categories.js';
import { setupSettingsListeners } from './settings.js';
import { setupBackfillListeners } from './backfill.js';

function logRenderer(level, scope, message, meta) {
  try {
    window.nexus.log?.(level, scope, message, meta);
  } catch {
    // Renderer logging is best effort.
  }
}

window.addEventListener('error', (event) => {
  logRenderer('error', 'window.error', event.message, {
    source: event.filename,
    line: event.lineno,
    column: event.colno
  });
});

window.addEventListener('unhandledrejection', (event) => {
  logRenderer('error', 'window.unhandledRejection', event.reason?.message || String(event.reason));
});

// --- Wire cross-module callbacks ---

initTags({ scheduleProjectMetaAutosave });

initCategories({
  renderTable,
  updateProjectCount,
  getFilteredProjects,
});

initSettings({
  renderTable,
  updateProjectCount,
});

initBackfill({ renderTable });

initDashboard({
  openDetail,
  launchClaude,
  launchVSCode,
  launchTerminal,
  openFolder,
  updateInboxBadge,
});

initDetail({
  switchView,
  renderTable,
  togglePin,
  launchClaude,
  launchVSCode,
  launchTerminal,
  openFolder,
  loadProjectIdeas,
  loadScratchpad,
  flushScratchpad,
});

initIdeas({
  getCategoryColor,
  getAllCategories,
  getTagKey,
  normalizeTags,
  renderTable,
});

initContextMenu({
  renderTable,
  launchClaude,
  launchVSCode,
  launchTerminal,
  openFolder,
});

initCommandPalette({
  openDetail,
  launchClaude,
  launchVSCode,
  launchTerminal,
});

initNavigation({
  openDetail,
  flushScratchpad,
  flushProjectMetaAutosave,
  loadInbox,
  loadBackfill,
  loadSettings,
  clearRecentlyToggled,
});

// --- Setup all event listeners ---

setupNavigationListeners();
setupDashboardListeners();
setupDetailListeners();
setupIdeaListeners();
setupContextMenuListeners();
setupCommandPaletteListeners();
setupCategoryListeners();
setupSettingsListeners();
setupBackfillListeners();

// --- Live Updates ---

window.nexus.onProjectsUpdated(async (projects) => {
  state.allProjects = projects;
  renderTable();
  populateCategoryFilter();
  renderHiddenCategories();
  updateProjectCount();

  if (state.currentProject) {
    const updated = state.allProjects.find(p => p.path === state.currentProject.path);
    if (updated) {
      if (state.currentView === 'detail') {
        const planEditor = document.getElementById('planEditor');
        const isEditing = planEditor && planEditor.style.display !== 'none';
        if (isEditing) {
          state.currentProject = updated;
        } else {
          await openDetail(updated.path, { pushHistory: false, preserveTab: true });
        }
      } else {
        state.currentProject = updated;
      }
    } else {
      const removedName = state.currentProject.name;
      state.currentProject = null;
      switchView('dashboard');
      document.querySelector('[data-view="dashboard"]')?.classList.add('active');
      showToast(`Project removed: ${removedName}`);
    }
  }

  if (state.currentView === 'inbox') {
    await loadInbox();
  } else {
    await refreshInboxCache();
  }
});

// --- Init ---

async function init() {
  logRenderer('info', 'init', 'Renderer init started');
  showToast('Scanning projects...');
  const cfg = await window.nexus.getConfig();
  state.pinnedIds = cfg.pinnedProjectIds || [];
  state.categoryDefs = cfg.categories || [];
  state.showLegacy = cfg.showLegacy || false;
  state.showSandbox = cfg.showSandbox || false;
  state.allProjects = await window.nexus.scan();
  renderTable();
  updateInboxBadge();
  populateProjectHintDropdown();
  populateCategoryFilter();
  renderHiddenCategories();
  updateProjectCount();
  const legacyToggle = document.getElementById('toggleLegacy');
  if (legacyToggle) legacyToggle.checked = state.showLegacy;
  const doneToggle = document.getElementById('toggleDone');
  if (doneToggle) doneToggle.checked = state.showDone;
  const sandboxToggle = document.getElementById('toggleSandbox');
  if (sandboxToggle) sandboxToggle.checked = state.showSandbox;
  const projectCompletedToggle = document.getElementById('toggleProjectCompletedIdeas');
  if (projectCompletedToggle) projectCompletedToggle.checked = state.showCompletedProjectIdeas;
  navPush({ view: 'dashboard', projectPath: null });
  showToast(`Found ${state.allProjects.length} projects`);
  logRenderer('info', 'init', 'Renderer init complete', { projectCount: state.allProjects.length });
}

init();
