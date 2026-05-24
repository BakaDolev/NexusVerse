import { safeJsonParse, safeJsonParseArray } from './utils.js';

export const state = {
  allProjects: [],
  currentSort: { key: 'lastActivity', desc: true },
  currentProject: null,
  hiddenCategories: new Set(safeJsonParseArray('nexus_hiddenCategories', [])),
  pinnedIds: [],
  categoryDefs: [],
  showLegacy: false,
  showSandbox: false,
  showDone: safeJsonParse('nexus_showDone', false),
  showCompletedProjectIdeas: safeJsonParse('nexus_showCompletedProjectIdeas', false),
  currentView: 'dashboard',
  detailLoadToken: 0,
};

const navHistory = [];
let navIndex = -1;
let navPushing = true;

export function navPush(entry) {
  if (!navPushing) return;
  if (navIndex >= 0) {
    const cur = navHistory[navIndex];
    if (cur.view === entry.view && cur.projectPath === entry.projectPath) return;
  }
  navHistory.splice(navIndex + 1);
  navHistory.push(entry);
  navIndex = navHistory.length - 1;
}

export function getNavIndex() { return navIndex; }
export function setNavIndex(i) { navIndex = i; }
export function getNavHistory() { return navHistory; }

export function setNavPushing(val) { navPushing = val; }
export function getNavPushing() { return navPushing; }

export function isPinned(projectId) {
  return state.pinnedIds.includes(projectId);
}
