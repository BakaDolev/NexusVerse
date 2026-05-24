const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  scan: () => ipcRenderer.invoke('scan-projects'),
  rescan: () => ipcRenderer.invoke('rescan-projects'),
  getProject: (projectPath) => ipcRenderer.invoke('get-project', projectPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openLogFile: () => ipcRenderer.invoke('open-log-file'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  log: (level, scope, message, meta) => ipcRenderer.invoke('renderer-log', level, scope, message, meta),

  openInClaudeCode: (projectPath) => ipcRenderer.invoke('launch-claude', projectPath),
  openInVSCode: (projectPath) => ipcRenderer.invoke('launch-vscode', projectPath),
  openInTerminal: (projectPath) => ipcRenderer.invoke('launch-terminal', projectPath),
  openFolder: (projectPath) => ipcRenderer.invoke('open-folder', projectPath),

  addGlobalIdea: (text, projectHint) => ipcRenderer.invoke('add-global-idea', text, projectHint),
  addProjectIdea: (projectPath, text) => ipcRenderer.invoke('add-project-idea', projectPath, text),
  getAllIdeas: () => ipcRenderer.invoke('get-all-ideas'),
  getGlobalIdeas: () => ipcRenderer.invoke('get-global-ideas'),
  getProjectIdeas: (projectPath) => ipcRenderer.invoke('get-project-ideas', projectPath),
  toggleIdea: (filePath, ideaText, done) => ipcRenderer.invoke('toggle-idea', filePath, ideaText, done),
  togglePause: (filePath, rawLine) => ipcRenderer.invoke('toggle-pause', filePath, rawLine),
  editIdea: (filePath, rawLine, newText) => ipcRenderer.invoke('edit-idea', filePath, rawLine, newText),
  moveIdeaProject: (filePath, rawLine, newProject) => ipcRenderer.invoke('move-idea-project', filePath, rawLine, newProject),
  deleteIdea: (filePath, ideaText) => ipcRenderer.invoke('delete-idea', filePath, ideaText),
  setIdeaType: (filePath, rawLine, newType) => ipcRenderer.invoke('set-idea-type', filePath, rawLine, newType),

  updateProject: (projectPath, fields) => ipcRenderer.invoke('update-project', projectPath, fields),
  togglePin: (projectId) => ipcRenderer.invoke('toggle-pin', projectId),

  getBackfillPreview: () => ipcRenderer.invoke('get-backfill-preview'),
  applyBackfill: (selections) => ipcRenderer.invoke('apply-backfill', selections),

  getConfig: () => ipcRenderer.invoke('get-config'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Category management
  getCategories: () => ipcRenderer.invoke('get-categories'),
  addCategory: (category) => ipcRenderer.invoke('add-category', category),
  renameCategory: (oldId, newId, newLabel) => ipcRenderer.invoke('rename-category', oldId, newId, newLabel),
  updateCategory: (categoryId, updates) => ipcRenderer.invoke('update-category', categoryId, updates),
  deleteCategory: (categoryId, reassignTo) => ipcRenderer.invoke('delete-category', categoryId, reassignTo),
  reorderCategories: (orderedIds) => ipcRenderer.invoke('reorder-categories', orderedIds),

  // Add project manually
  showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog'),
  addProject: (folderPath, metadata) => ipcRenderer.invoke('add-project', folderPath, metadata),

  // Stable IDs
  writeStableIds: () => ipcRenderer.invoke('write-stable-ids'),

  // Scratchpad
  readScratchpad: (projectPath) => ipcRenderer.invoke('read-scratchpad', projectPath),
  writeScratchpad: (projectPath, content) => ipcRenderer.invoke('write-scratchpad', projectPath, content),

  // Show legacy toggle
  setShowLegacy: (show) => ipcRenderer.invoke('set-show-legacy', show),
  setShowSandbox: (show) => ipcRenderer.invoke('set-show-sandbox', show),

  onProjectsUpdated: (callback) => {
    const listener = (_, projects) => callback(projects);
    ipcRenderer.on('projects-updated', listener);
    return () => ipcRenderer.removeListener('projects-updated', listener);
  }
});
