const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const matter = require('gray-matter');
const chokidar = require('chokidar');
const { AppLogger } = require('./src/logger');

const userDataPath = app.getPath('userData');
if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
const logger = new AppLogger({ logDir: path.join(userDataPath, 'logs') });
logger.installConsoleCapture();

process.on('uncaughtException', (err) => {
  logger.error('process.uncaughtException', err.message, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandledRejection', reason?.message || String(reason), reason);
});

const defaultConfigPath = path.join(__dirname, 'nexusverse.config.json');
const userConfigPath = path.join(userDataPath, 'config.json');

if (!fs.existsSync(userConfigPath)) {
  fs.copyFileSync(defaultConfigPath, userConfigPath);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalizeConfig(candidate, defaults) {
  const base = defaults && typeof defaults === 'object' ? defaults : {};
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const normalized = { ...base, ...input };

  normalized.roots = Array.isArray(input.roots) && input.roots.every(r => typeof r === 'string')
    ? input.roots
    : Array.isArray(base.roots) ? base.roots : [];
  normalized.scanDepth = Number.isInteger(input.scanDepth) && input.scanDepth > 0
    ? input.scanDepth
    : Number.isInteger(base.scanDepth) ? base.scanDepth : 4;
  normalized.ignore = Array.isArray(input.ignore) && input.ignore.every(v => typeof v === 'string')
    ? input.ignore
    : Array.isArray(base.ignore) ? base.ignore : ['node_modules', '.git', 'dist', 'build'];
  normalized.categories = Array.isArray(input.categories)
    ? input.categories.filter(c => c && typeof c.id === 'string' && typeof c.label === 'string')
    : Array.isArray(base.categories) ? base.categories : [];
  if (Array.isArray(base.categories)) {
    const categoryIds = new Set(normalized.categories.map(c => c.id));
    for (const category of base.categories) {
      if (!categoryIds.has(category.id)) {
        normalized.categories.push(category);
        categoryIds.add(category.id);
      }
    }
  }
  normalized.categoryFallbacks = input.categoryFallbacks && typeof input.categoryFallbacks === 'object' && !Array.isArray(input.categoryFallbacks)
    ? input.categoryFallbacks
    : base.categoryFallbacks || {};
  normalized.ignoredPaths = Array.isArray(input.ignoredPaths) && input.ignoredPaths.every(v => typeof v === 'string')
    ? input.ignoredPaths
    : Array.isArray(base.ignoredPaths) ? base.ignoredPaths : [];
  normalized.pinnedProjectIds = Array.isArray(input.pinnedProjectIds) && input.pinnedProjectIds.every(v => typeof v === 'string')
    ? input.pinnedProjectIds
    : [];
  normalized.showLegacy = typeof input.showLegacy === 'boolean' ? input.showLegacy : Boolean(base.showLegacy);
  normalized.showSandbox = typeof input.showSandbox === 'boolean' ? input.showSandbox : Boolean(base.showSandbox);
  normalized.launch = normalizeLaunchConfig(input.launch, base.launch);

  return normalized;
}

function normalizeLaunchConfig(candidate, defaults) {
  const base = defaults && typeof defaults === 'object' ? defaults : {};
  const input = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const normalized = {};
  for (const key of ['claudeCode', 'vscode', 'terminal']) {
    const value = input[key] !== undefined ? input[key] : base[key];
    normalized[key] = sanitizeLaunchCommand(value, base[key] || '');
  }
  return normalized;
}

function sanitizeLaunchCommand(value, fallback = '') {
  const command = String(value || '').trim();
  if (!command || command.length > 200 || /[\r\n]/.test(command)) return String(fallback || '').trim();
  return command;
}

function parseCommandLine(commandLine) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(String(commandLine || ''))) !== null) {
    parts.push(match[1] ?? match[2] ?? match[0]);
  }
  if (!parts.length) return null;
  const [command, ...args] = parts;
  return { command, args };
}

function resolveLaunchExecutable(command) {
  const value = String(command || '').trim();
  if (process.platform !== 'win32' || !value) return value;
  if (path.extname(value)) return value;

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(ext => ext.trim())
    .filter(Boolean);
  const commandPaths = value.includes('\\') || value.includes('/')
    ? [value]
    : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, value));

  for (const commandPath of commandPaths) {
    for (const ext of extensions) {
      const candidate = commandPath + ext.toLowerCase();
      if (fs.existsSync(candidate)) return candidate;
      const upperCandidate = commandPath + ext.toUpperCase();
      if (fs.existsSync(upperCandidate)) return upperCandidate;
    }
  }

  if (value.toLowerCase() === 'code') return 'code.cmd';
  return value;
}

function sanitizePathList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const paths = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return paths;
}

const defaultConfig = readJsonFile(defaultConfigPath);
let config;
let rawConfig;
try {
  rawConfig = readJsonFile(userConfigPath);
  config = normalizeConfig(rawConfig, defaultConfig);
} catch (err) {
  rawConfig = null;
  config = normalizeConfig(defaultConfig, defaultConfig);
  fs.copyFileSync(defaultConfigPath, userConfigPath);
}

// Migrate old config format to new
if (rawConfig && rawConfig.categories && !Array.isArray(rawConfig.categories)) {
  const oldMap = rawConfig.categories;
  config.categoryFallbacks = oldMap;
  config.categories = [
    { id: 'work', label: 'Work', color: '#4f46e5' },
    { id: 'main', label: 'Main', color: '#818cf8' },
    { id: 'side-project', label: 'Side Projects', color: '#7c3aed' },
    { id: 'infra', label: 'Infrastructure', color: '#0f9f8f' },
    { id: 'legacy', label: 'Legacy', color: '#737373' }
  ];
  if (!config.ignoredPaths) config.ignoredPaths = [];
  if (!config.pinnedProjectIds) config.pinnedProjectIds = [];
  if (config.pinnedProjectPaths) {
    delete config.pinnedProjectPaths;
  }
  delete config.projectMarkers;
  delete config.defaultCategory;
  if (config.showLegacy === undefined) config.showLegacy = false;
  fs.writeFileSync(userConfigPath, JSON.stringify(config, null, 2));
}

const BRAINSTORM_FILENAME = 'BRAINSTORM.md';
const LEGACY_IDEAS_FILENAME = 'IDEAS.md';
const globalInboxPath = path.join(userDataPath, BRAINSTORM_FILENAME);
const legacyGlobalInboxPath = path.join(userDataPath, LEGACY_IDEAS_FILENAME);
const watcherWriteIgnores = new Map();
const approvedConfigPaths = new Set();
const VALID_PROJECT_STATUSES = new Set(['active', 'service', 'paused', 'idea', 'sandbox', 'done', 'legacy']);
const VALID_PROJECT_PRIORITIES = new Set(['high', 'medium', 'low']);
const VALID_SCAN_MODES = new Set(['auto', 'container', 'project']);
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const CATEGORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PROJECT_ID_PATTERN = /^nxv_[a-f0-9]{8}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ProjectScanner = require('./src/scanner');
const IdeasManager = require('./src/ideas');

let scanner = new ProjectScanner(config);
const ideas = new IdeasManager(globalInboxPath, { legacyGlobalInboxPath, beforeWrite: suppressWatcherFor });

let mainWindow;
let closingAfterScratchpadFlush = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'NexusVerse',
    icon: path.join(__dirname, 'assets', 'NexusVerse.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0a0a0f',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const tag = ['LOG','WARN','ERR'][level] || 'LOG';
      logger.log(level >= 3 ? 'error' : 'warn', 'renderer.console', message, { line, sourceId });
      console.log(`[Renderer ${tag}] ${message} (${sourceId}:${line})`);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', async (event) => {
    if (closingAfterScratchpadFlush || mainWindow.isDestroyed()) return;

    event.preventDefault();
    closingAfterScratchpadFlush = true;
    try {
      await mainWindow.webContents.executeJavaScript(
        'window.flushScratchpadForClose ? window.flushScratchpadForClose() : true',
        true
      );
    } catch (err) {
      console.error('Scratchpad flush error during close:', err);
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Close Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Scratchpad Save Failed',
        message: 'Could not save the scratchpad before closing.',
        detail: 'Your last edit may be lost if you close now.'
      });
      if (choice !== 0) {
        closingAfterScratchpadFlush = false;
        return;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    closingAfterScratchpadFlush = false;
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();
}

app.whenReady().then(() => {
  logger.info('app.ready', 'Application ready', { userDataPath });
  scanner.scan()
    .then(projects => logger.info('scanner.initialScan.complete', 'Initial scan complete', { projectCount: projects.length }))
    .catch(err => logger.error('scanner.initialScan.error', err.message, err));
  createWindow();
  startFileWatcher();
});
app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  logger.info('app.quit', 'All windows closed');
  logger.close();
  app.quit();
});

// --- File Watcher ---
let watcher = null;
let watcherDebounce = null;
let watcherNeedsProjectRescan = false;

function shouldRescanForMarkdownEvent(event, filePath) {
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName === 'project_plan.md' || fileName === 'claude.md') return true;
  if (isBrainstormFileName(fileName)) return event === 'add' || event === 'unlink';
  return false;
}

function isMarkdownPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.md';
}

function startFileWatcher() {
  const seenWatchPaths = new Set();
  const watchPaths = [
    ...(config.roots || []),
    globalInboxPath,
    fs.existsSync(legacyGlobalInboxPath) ? legacyGlobalInboxPath : null
  ]
    .filter(Boolean)
    .map(p => path.resolve(p))
    .filter(p => {
      const key = p.toLowerCase();
      if (seenWatchPaths.has(key)) return false;
      seenWatchPaths.add(key);
      return true;
    });

  const ignoreSet = new Set(config.ignore || ['node_modules', '.git', 'dist', 'build']);
  const ignoredPathsResolved = (config.ignoredPaths || []).map(p => path.resolve(p));
  logger.info('watcher.start', 'Starting file watcher', { watchPathCount: watchPaths.length, depth: config.scanDepth || 4 });

  watcher = chokidar.watch(watchPaths, {
    ignored: (filePath, stats) => {
      const resolved = path.resolve(filePath);
      if (ignoredPathsResolved.some(ip => resolved === ip || resolved.startsWith(ip + path.sep))) return true;
      const segments = resolved.split(path.sep);
      if (segments.some(s => ignoreSet.has(s))) return true;
      return stats?.isFile() && !isMarkdownPath(resolved);
    },
    ignoreInitial: true,
    depth: config.scanDepth || 4,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  });

  watcher.on('all', (event, filePath) => {
    if (!isMarkdownPath(filePath)) return;
    if (watcherWriteIgnores.has(path.resolve(filePath))) return;
    logger.debug('watcher.event', 'Markdown file event', { event, filePath });
    watcherNeedsProjectRescan = watcherNeedsProjectRescan || shouldRescanForMarkdownEvent(event, filePath);
    if (watcherDebounce) clearTimeout(watcherDebounce);
    watcherDebounce = setTimeout(async () => {
      try {
        const needsRescan = watcherNeedsProjectRescan;
        watcherNeedsProjectRescan = false;
        if (needsRescan || !scanner.getCached()) {
          logger.info('watcher.rescan', 'Running project rescan after file event');
          await scanner.scan();
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('projects-updated', scanner.getCached());
        }
      } catch (err) {
        logger.error('watcher.rescan.error', err.message, err);
        console.error('Watcher rescan error:', err);
      }
    }, 500);
  });

  watcher.on('error', (err) => {
    logger.error('watcher.error', err.message, err);
    console.error('Watcher error:', err);
  });
}

function restartFileWatcher() {
  if (watcher) watcher.close();
  logger.info('watcher.restart', 'Restarting file watcher');
  startFileWatcher();
}

// --- Path validation ---

function resolveReal(p) {
  try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
}

function isBrainstormFileName(fileName) {
  const name = path.basename(fileName || '').toLowerCase();
  return name === BRAINSTORM_FILENAME.toLowerCase() || name === LEGACY_IDEAS_FILENAME.toLowerCase();
}

function projectBrainstormPath(projectPath) {
  return path.join(projectPath, BRAINSTORM_FILENAME);
}

function isAllowedIdeasPath(filePath) {
  const requested = path.resolve(filePath);
  if (!isBrainstormFileName(requested)) return false;
  const resolved = resolveReal(requested);
  if (!isBrainstormFileName(resolved)) return false;
  if (resolved === resolveReal(globalInboxPath) || resolved === resolveReal(legacyGlobalInboxPath)) return true;
  return config.roots.some(root => {
    const resolvedRoot = resolveReal(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

function resolveValidatedIdeasPath(filePath) {
  const requested = path.resolve(filePath);
  if (!isBrainstormFileName(requested)) return null;
  const resolved = resolveReal(requested);
  if (!isBrainstormFileName(resolved)) return null;
  if (resolved === resolveReal(globalInboxPath) || resolved === resolveReal(legacyGlobalInboxPath)) return resolved;
  const allowed = config.roots.some(root => {
    const resolvedRoot = resolveReal(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
  return allowed ? resolved : null;
}

function isAllowedProjectPath(projectPath) {
  const resolved = resolveReal(projectPath);
  return config.roots.some(root => {
    const resolvedRoot = resolveReal(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

function resolveValidatedScratchpadPath(filePath) {
  const requested = path.resolve(filePath);
  if (path.basename(requested).toLowerCase() !== 'scratchpad.md') return null;
  const resolved = resolveReal(requested);
  if (path.basename(resolved).toLowerCase() !== 'scratchpad.md') return null;
  return isAllowedProjectPath(path.dirname(resolved)) ? resolved : null;
}

function isAllowedProjectPlanPath(filePath) {
  const requested = path.resolve(filePath);
  if (path.basename(requested).toLowerCase() !== 'project_plan.md') return false;
  const resolved = resolveReal(requested);
  if (path.basename(resolved).toLowerCase() !== 'project_plan.md') return false;
  return isAllowedProjectPath(path.dirname(resolved));
}

function resolveValidatedProjectPlanPath(filePath) {
  const requested = path.resolve(filePath);
  if (path.basename(requested).toLowerCase() !== 'project_plan.md') return null;
  const resolved = resolveReal(requested);
  if (path.basename(resolved).toLowerCase() !== 'project_plan.md') return null;
  return isAllowedProjectPath(path.dirname(resolved)) ? resolved : null;
}

async function resolveProjectRef(projectRef) {
  if (!projectRef) return null;
  const ref = String(projectRef);
  const projects = scanner.getCached() || await scanner.scan();

  if (path.isAbsolute(ref) && isAllowedProjectPath(ref)) {
    const resolvedRef = path.resolve(ref);
    const project = projects.find(p => path.resolve(p.path) === resolvedRef);
    return project || { path: resolvedRef, name: path.basename(resolvedRef) };
  }

  const byId = projects.filter(p => p.id === ref);
  if (byId.length === 1) return byId[0];

  const byName = projects.filter(p => p.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return { error: 'Project name is ambiguous' };

  return null;
}

// --- Atomic write helper ---

function atomicWriteSync(filePath, content) {
  const tmpPath = filePath + `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function preserveExistingPlanMetadata(filePath, content) {
  const incomingContent = String(content || '');
  if (!fs.existsSync(filePath)) return incomingContent;

  const current = matter(fs.readFileSync(filePath, 'utf-8'));
  const incoming = matter(incomingContent);
  const preserveKeys = ['tags', 'status', 'priority', 'category', 'next', 'id', 'scan'];
  let merged = false;

  for (const key of preserveKeys) {
    if (current.data?.[key] != null && !Object.prototype.hasOwnProperty.call(incoming.data || {}, key)) {
      incoming.data[key] = key === 'tags' ? normalizeTags(current.data[key]) : current.data[key];
      merged = true;
    }
  }

  return merged ? matter.stringify(incoming.content, incoming.data) : incomingContent;
}

function extractProjectDescription(content) {
  const purposeMatch = String(content || '').match(/##?\s*Purpose\s*\n+([^\n#]+)/i);
  return purposeMatch ? purposeMatch[1].trim() : null;
}

function suppressWatcherFor(filePath) {
  const resolved = path.resolve(filePath);
  watcherWriteIgnores.set(resolved, true);
  setTimeout(() => { watcherWriteIgnores.delete(resolved); }, 1000);
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
    } catch (err) {
      logger.error('launch.spawn.error', err.message, { command, args });
      finish({ error: err.message });
      return;
    }

    child.once('error', err => {
      logger.error('launch.spawn.error', err.message, { command, args });
      finish({ error: err.message });
    });
    child.once('spawn', () => {
      logger.info('launch.spawn.success', 'Detached process started', { command });
      child.unref();
      finish({ success: true });
    });
  });
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const seen = new Set();
  const normalized = [];
  for (const tag of values) {
    const value = String(tag || '').trim().replace(/\s+/g, ' ');
    const key = value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function generateProjectId(projectPath) {
  const hash = crypto.createHash('sha256').update(path.resolve(projectPath).toLowerCase()).digest('hex').substring(0, 8);
  return `nxv_${hash}`;
}

function normalizeBackfillCategory(category) {
  const ids = (config.categories || []).map(c => c.id);
  if (ids.includes(category)) return category;
  return category || ids[0] || 'main';
}

function getDefaultCategoryId() {
  return config.categories?.[0]?.id || defaultConfig.categories?.[0]?.id || 'main';
}

function getCategoryIds() {
  const ids = new Set((config.categories || []).map(c => c.id));
  for (const project of scanner.getCached() || []) {
    if (project.category) ids.add(project.category);
  }
  return ids;
}

function buildProjectPlanDefaults(projectPath, fields = {}) {
  const cached = scanner.getProject(projectPath) || {};
  const data = {
    id: cached.id && PROJECT_ID_PATTERN.test(cached.id) ? cached.id : generateProjectId(projectPath),
    status: VALID_PROJECT_STATUSES.has(cached.status) ? cached.status : 'active',
    priority: VALID_PROJECT_PRIORITIES.has(cached.priority) ? cached.priority : 'medium',
    category: cached.category || getDefaultCategoryId(),
    scan: VALID_SCAN_MODES.has(cached.scan) ? cached.scan : 'project'
  };

  Object.assign(data, fields);

  if (Object.prototype.hasOwnProperty.call(data, 'next')) {
    data.next = String(data.next || '').trim();
    if (!data.next) delete data.next;
  } else if (cached.next) {
    data.next = String(cached.next).trim();
  }

  if (Object.prototype.hasOwnProperty.call(data, 'tags')) {
    data.tags = normalizeTags(data.tags);
    if (data.tags.length === 0) delete data.tags;
  } else if (cached.tags?.length) {
    data.tags = normalizeTags(cached.tags);
  }

  return data;
}

function validateCategoryId(categoryId) {
  const value = String(categoryId || '').trim();
  const categoryIds = getCategoryIds();
  if (!value || !categoryIds.has(value)) return { error: `Invalid category: ${value}` };
  return { value };
}

function sanitizeCategoryDefinition(category) {
  if (!category || typeof category !== 'object' || Array.isArray(category)) {
    return { error: 'Invalid category' };
  }
  const id = String(category.id || '').trim().toLowerCase();
  const label = String(category.label || '').trim().replace(/\s+/g, ' ');
  const color = String(category.color || '').trim();
  if (!CATEGORY_ID_PATTERN.test(id)) return { error: 'Invalid category ID' };
  if (!label || label.length > 80) return { error: 'Invalid category label' };
  if (!HEX_COLOR_PATTERN.test(color)) return { error: 'Invalid category color' };
  return { category: { id, label, color } };
}

function sanitizeCategoryRenameInput(oldId, newId, newLabel) {
  const oldValue = String(oldId || '').trim();
  const nextId = String(newId || oldValue).trim().toLowerCase();
  const nextLabel = newLabel === undefined ? null : String(newLabel || '').trim().replace(/\s+/g, ' ');
  const categoryIds = getCategoryIds();
  if (!categoryIds.has(oldValue)) return { error: 'Category not found' };
  if (!CATEGORY_ID_PATTERN.test(nextId)) return { error: 'Invalid category ID' };
  if (nextLabel !== null && (!nextLabel || nextLabel.length > 80)) return { error: 'Invalid category label' };
  if (nextId !== oldValue && categoryIds.has(nextId)) return { error: 'New category ID already exists' };
  return { oldId: oldValue, newId: nextId, newLabel: nextLabel };
}

function projectCategoryFromPath(projectPath) {
  const resolved = path.resolve(projectPath);
  for (const [folderName, categoryId] of Object.entries(config.categoryFallbacks || {})) {
    if (resolved.includes(path.sep + folderName + path.sep) || resolved.endsWith(path.sep + folderName)) {
      return categoryId;
    }
  }
  return null;
}

function pathsEqual(a, b) {
  return resolveReal(a).toLowerCase() === resolveReal(b).toLowerCase();
}

function validateProjectUpdateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'Invalid project update fields' };
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'status') {
      if (!VALID_PROJECT_STATUSES.has(value)) return { error: `Invalid status: ${value}` };
      sanitized.status = value;
    } else if (key === 'priority') {
      if (!VALID_PROJECT_PRIORITIES.has(value)) return { error: `Invalid priority: ${value}` };
      sanitized.priority = value;
    } else if (key === 'category') {
      const validation = validateCategoryId(value);
      if (validation.error) return validation;
      sanitized.category = validation.value;
    } else if (key === 'next') {
      sanitized.next = String(value || '').trim();
    } else if (key === 'tags') {
      sanitized.tags = normalizeTags(value);
    }
  }

  return { fields: sanitized };
}

function validateBackfillSelection(sel) {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
    return { error: 'Invalid backfill selection' };
  }

  const status = String(sel.status || '').trim();
  const priority = String(sel.priority || '').trim();
  const category = validateCategoryId(sel.category);
  const scan = String(sel.scan || '').trim() || (sel.needsFile ? 'project' : 'auto');
  const id = String(sel.id || '').trim();
  const lastTouched = String(sel.last_touched || '').trim();
  const projectPath = typeof sel.path === 'string' ? sel.path : '';

  if (!projectPath) return { error: 'Invalid project path' };
  if (!VALID_PROJECT_STATUSES.has(status)) return { error: `Invalid status: ${status}` };
  if (!VALID_PROJECT_PRIORITIES.has(priority)) return { error: `Invalid priority: ${priority}` };
  if (category.error) return category;
  if (!VALID_SCAN_MODES.has(scan)) return { error: `Invalid scan mode: ${scan}` };
  if (id && !PROJECT_ID_PATTERN.test(id)) return { error: 'Invalid project ID' };
  if (lastTouched && !DATE_PATTERN.test(lastTouched)) return { error: 'Invalid last_touched date' };

  return {
    selection: {
      name: String(sel.name || '').trim() || path.basename(sel.path || ''),
      path: projectPath,
      needsFile: Boolean(sel.needsFile),
      id,
      status,
      priority,
      category: category.value,
      scan,
      last_touched: lastTouched,
      next: String(sel.next || '').trim()
    }
  };
}

// --- IPC Handlers ---

ipcMain.handle('scan-projects', async () => {
  return scanner.getCached() || await scanner.scan();
});

ipcMain.handle('rescan-projects', async () => {
  try {
    logger.info('scanner.rescan.start', 'Manual rescan started');
    const projects = await scanner.scan();
    logger.info('scanner.rescan.complete', 'Manual rescan complete', { projectCount: projects.length });
    return projects;
  } catch (err) {
    logger.error('scanner.rescan.error', err.message, err);
    throw err;
  }
});

ipcMain.handle('get-project', (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  return scanner.getProject(projectPath);
});

ipcMain.handle('read-file', (_, filePath) => {
  const resolved = resolveValidatedProjectPlanPath(filePath);
  if (!resolved) return { error: 'Access denied' };
  try {
    return { content: fs.readFileSync(resolved, 'utf-8') };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', (_, filePath, content) => {
  const resolved = resolveValidatedProjectPlanPath(filePath);
  if (!resolved) return { error: 'Access denied' };
  try {
    suppressWatcherFor(resolved);
    atomicWriteSync(resolved, preserveExistingPlanMetadata(resolved, content));
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('open-url', async (_, url) => {
  if (typeof url !== 'string') return { error: 'Invalid URL' };
  if (url.startsWith('https://')) {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  }
  return { error: 'Invalid URL' };
});

ipcMain.handle('launch-claude', async (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const terminal = parseCommandLine(config.launch?.terminal || defaultConfig.launch?.terminal || 'wt -d');
  const claude = parseCommandLine(config.launch?.claudeCode || defaultConfig.launch?.claudeCode || 'claude');
  if (!terminal || !claude) return { error: 'Invalid launch command' };
  return await spawnDetached(resolveLaunchExecutable(terminal.command), [...terminal.args, projectPath, resolveLaunchExecutable(claude.command), ...claude.args]);
});

ipcMain.handle('launch-vscode', async (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const vscode = parseCommandLine(config.launch?.vscode || defaultConfig.launch?.vscode || 'code');
  if (!vscode) return { error: 'Invalid VS Code launch command' };
  return await spawnDetached(resolveLaunchExecutable(vscode.command), [...vscode.args, projectPath], { shell: false });
});

ipcMain.handle('launch-terminal', async (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const terminal = parseCommandLine(config.launch?.terminal || defaultConfig.launch?.terminal || 'wt -d');
  if (!terminal) return { error: 'Invalid terminal launch command' };
  return await spawnDetached(resolveLaunchExecutable(terminal.command), [...terminal.args, projectPath]);
});

ipcMain.handle('open-folder', async (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const error = await shell.openPath(path.resolve(projectPath));
  if (error) logger.warn('openFolder.error', error, { projectPath });
  return error ? { error } : { success: true };
});

ipcMain.handle('open-log-file', async () => {
  const error = await shell.openPath(logger.logPath);
  if (error) {
    logger.warn('logs.openFile.error', error, { logPath: logger.logPath });
    return { error };
  }
  return { success: true };
});

ipcMain.handle('open-log-folder', async () => {
  const error = await shell.openPath(logger.logDir);
  if (error) {
    logger.warn('logs.openFolder.error', error, { logDir: logger.logDir });
    return { error };
  }
  return { success: true };
});

ipcMain.handle('renderer-log', (_, level, scope, message, meta) => {
  const normalizedLevel = VALID_LOG_LEVELS.has(level) ? level : 'info';
  logger.log(normalizedLevel, `renderer.${scope || 'app'}`, message, meta);
  return { success: true };
});

ipcMain.handle('update-project', async (_, projectPath, fields) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const validation = validateProjectUpdateFields(fields);
  if (validation.error) return { error: validation.error };

  const resolvedProjectPath = path.resolve(projectPath);
  const planPath = path.join(resolvedProjectPath, 'PROJECT_PLAN.md');
  const fieldsToWrite = validation.fields;

  try {
    if (fs.existsSync(planPath)) {
      const raw = fs.readFileSync(planPath, 'utf-8');
      const parsed = matter(raw);
      const defaults = buildProjectPlanDefaults(resolvedProjectPath, fieldsToWrite);
      parsed.data = { ...defaults, ...parsed.data };
      Object.assign(parsed.data, fieldsToWrite);
      if (parsed.data.next === '') delete parsed.data.next;
      if (parsed.data.tags && parsed.data.tags.length === 0) delete parsed.data.tags;
      const newContent = matter.stringify(parsed.content, parsed.data);
      suppressWatcherFor(planPath);
      atomicWriteSync(planPath, newContent);
    } else {
      const data = buildProjectPlanDefaults(resolvedProjectPath, fieldsToWrite);
      const content = `\n# ${path.basename(projectPath)}\n\n## Purpose\n\n_TODO: Describe what this project does._\n`;
      const newContent = matter.stringify(content, data);
      suppressWatcherFor(planPath);
      atomicWriteSync(planPath, newContent);
    }
    let project = scanner.updateCachedProject(resolvedProjectPath, {
      ...fieldsToWrite,
      description: fs.existsSync(planPath) ? extractProjectDescription(fs.readFileSync(planPath, 'utf-8')) : null
    });
    if (!project) {
      const updated = await scanner.scan();
      project = updated.find(p => pathsEqual(p.path, resolvedProjectPath));
    }
    if (!project) return { error: 'Project was updated but could not be found after rescan' };
    return { success: true, project };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('add-global-idea', async (_, text, projectHint) => {
  try {
    if (projectHint) {
      const project = await resolveProjectRef(projectHint);
      if (project?.error) return { error: project.error };
      if (project && isAllowedProjectPath(project.path)) {
        ideas.addToProject(project.path, text);
        return { success: true };
      }
    }
    ideas.addToGlobalInbox(text, projectHint);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('add-project-idea', (_, projectPath, text) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const ideasPath = projectBrainstormPath(projectPath);
  if (!isAllowedIdeasPath(ideasPath)) return { error: 'Access denied' };
  try {
    ideas.addToProject(projectPath, text);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-global-ideas', async () => {
  try {
    const projects = scanner.getCached() || await scanner.scan();
    const projectList = projects
      .filter(p => isAllowedIdeasPath(projectBrainstormPath(p.path)))
      .map(p => ({ name: p.name, path: p.path }));
    return ideas.getAllIdeas(projectList);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-all-ideas', async () => {
  try {
    const projects = scanner.getCached() || await scanner.scan();
    const projectList = projects
      .filter(p => isAllowedIdeasPath(projectBrainstormPath(p.path)))
      .map(p => ({ name: p.name, path: p.path }));
    return ideas.getAllIdeas(projectList);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-project-ideas', (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const ideasPath = projectBrainstormPath(projectPath);
  if (!isAllowedIdeasPath(ideasPath)) return { error: 'Access denied' };
  try {
    return ideas.getProjectIdeas(projectPath);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('toggle-idea', (_, filePath, ideaText, done) => {
  if (!isAllowedIdeasPath(filePath)) return { error: 'Access denied' };
  try {
    return ideas.toggleIdea(filePath, ideaText, done);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('toggle-pause', (_, filePath, rawLine) => {
  if (!isAllowedIdeasPath(filePath)) return { error: 'Access denied' };
  try {
    return ideas.togglePause(filePath, rawLine);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('edit-idea', (_, filePath, rawLine, newText) => {
  if (!isAllowedIdeasPath(filePath)) return { error: 'Access denied' };
  try {
    return ideas.editIdea(filePath, rawLine, newText);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('move-idea-project', async (_, filePath, rawLine, newProject) => {
  if (!isAllowedIdeasPath(filePath)) return { error: 'Access denied' };
  try {
    let toFilePath;
    let projectName = newProject;
    if (newProject) {
      const project = await resolveProjectRef(newProject);
      if (project?.error) return { error: project.error };
      if (!project) return { error: 'Project not found' };
      if (!isAllowedProjectPath(project.path)) return { error: 'Access denied' };
      toFilePath = projectBrainstormPath(project.path);
      if (!isAllowedIdeasPath(toFilePath)) return { error: 'Access denied' };
    } else {
      toFilePath = globalInboxPath;
      projectName = null;
    }
    return ideas.moveIdeaToProject(filePath, rawLine, toFilePath, projectName);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delete-idea', (_, filePath, ideaText) => {
  if (!isAllowedIdeasPath(filePath)) return { error: 'Access denied' };
  try {
    return ideas.deleteIdea(filePath, ideaText);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('set-idea-type', (_, filePath, rawLine, newType) => {
  if (!isAllowedIdeasPath(filePath)) return { error: 'Access denied' };
  try {
    return ideas.setIdeaType(filePath, rawLine, newType);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-backfill-preview', async () => {
  const projects = scanner.getCached() || await scanner.scan();
  const preview = [];
  for (const project of projects) {
    if (project.hasProjectPlan) {
      const planPath = path.join(project.path, 'PROJECT_PLAN.md');
      try {
        const raw = fs.readFileSync(planPath, 'utf-8');
        const parsed = matter(raw);
        const hasFrontmatter = Object.keys(parsed.data).length > 0;
        const hasRequiredFields = parsed.data.status && parsed.data.priority && parsed.data.category && parsed.data.id;
        if (!hasFrontmatter || !hasRequiredFields) {
          preview.push({
            name: project.name,
            path: project.path,
            existing: parsed.data,
            suggested: {
              id: parsed.data.id || generateProjectId(project.path),
              status: parsed.data.status || project.status,
              priority: parsed.data.priority || 'medium',
              category: normalizeBackfillCategory(parsed.data.category || project.category),
              scan: parsed.data.scan || project.scan || 'auto',
              last_touched: parsed.data.last_touched || project.lastActivityDate || new Date().toISOString().split('T')[0],
              next: parsed.data.next || project.next || ''
            },
            hasFrontmatter
          });
        }
      } catch {}
    } else {
      preview.push({
        name: project.name,
        path: project.path,
        existing: {},
        suggested: {
          id: generateProjectId(project.path),
          status: project.status,
          priority: 'medium',
          category: normalizeBackfillCategory(project.category),
          scan: project.scan || 'project',
          last_touched: project.lastActivityDate || new Date().toISOString().split('T')[0],
          next: ''
        },
        hasFrontmatter: false,
        needsFile: true
      });
    }
  }

  const visiblePaths = new Set(projects.map(project => project.path));
  const candidates = scanner.getCandidates ? scanner.getCandidates() : [];
  for (const candidate of candidates) {
    if (candidate.scanMode !== 'container' || visiblePaths.has(candidate.dir) || !candidate.hasProjectPlan) continue;
    const planPath = path.join(candidate.dir, 'PROJECT_PLAN.md');
    try {
      const raw = fs.readFileSync(planPath, 'utf-8');
      const parsed = matter(raw);
      if (parsed.data.id && parsed.data.scan === 'container') continue;
      preview.push({
        name: candidate.name,
        path: candidate.dir,
        existing: parsed.data,
        suggested: {
          id: parsed.data.id || generateProjectId(candidate.dir),
          status: parsed.data.status || 'active',
          priority: parsed.data.priority || 'medium',
          category: normalizeBackfillCategory(parsed.data.category || projectCategoryFromPath(candidate.dir)),
          scan: 'container',
          last_touched: parsed.data.last_touched || new Date().toISOString().split('T')[0],
          next: parsed.data.next || ''
        },
        hasFrontmatter: Object.keys(parsed.data).length > 0,
        isContainer: true
      });
    } catch {}
  }
  return preview;
});

ipcMain.handle('apply-backfill', async (_, selections) => {
  if (!Array.isArray(selections)) return [{ name: 'Backfill', success: false, error: 'Invalid selections' }];

  const results = [];
  for (const rawSelection of selections) {
    const validation = validateBackfillSelection(rawSelection);
    if (validation.error) {
      results.push({ name: rawSelection?.name || 'Unknown', success: false, error: validation.error });
      continue;
    }
    const sel = validation.selection;
    if (!isAllowedProjectPath(sel.path)) {
      results.push({ name: sel.name, success: false, error: 'Access denied' });
      continue;
    }
    const planPath = path.join(sel.path, 'PROJECT_PLAN.md');
    try {
      if (sel.needsFile) {
        const data = {
          id: sel.id || generateProjectId(sel.path),
          status: sel.status,
          priority: sel.priority,
          category: sel.category,
          scan: sel.scan || 'project'
        };
        if (sel.next) data.next = sel.next;
        if (sel.last_touched) data.last_touched = sel.last_touched;
        const content = `\n# ${sel.name}\n\n## Purpose\n\n_TODO: Describe what this project does._\n`;
        atomicWriteSync(planPath, matter.stringify(content, data));
        results.push({ name: sel.name, success: true, action: 'created' });
      } else {
        const raw = fs.readFileSync(planPath, 'utf-8');
        const parsed = matter(raw);
        parsed.data.id = sel.id || parsed.data.id || generateProjectId(sel.path);
        parsed.data.status = sel.status;
        parsed.data.priority = sel.priority;
        parsed.data.category = sel.category;
        parsed.data.scan = sel.scan;
        if (sel.last_touched) parsed.data.last_touched = sel.last_touched;
        if (sel.next) parsed.data.next = sel.next;
        else delete parsed.data.next;
        atomicWriteSync(planPath, matter.stringify(parsed.content, parsed.data));
        results.push({ name: sel.name, success: true, action: 'updated' });
      }
    } catch (err) {
      results.push({ name: sel.name, success: false, error: err.message });
    }
  }
  return results;
});

ipcMain.handle('toggle-pin', (_, projectId) => {
  try {
    const id = String(projectId || '').trim();
    if (!id || !PROJECT_ID_PATTERN.test(id)) return { error: 'Invalid project ID' };
    if (!config.pinnedProjectIds) config.pinnedProjectIds = [];
    const idx = config.pinnedProjectIds.indexOf(id);
    if (idx === -1) {
      config.pinnedProjectIds.push(id);
    } else {
      config.pinnedProjectIds.splice(idx, 1);
    }
    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    return { success: true, pinnedIds: config.pinnedProjectIds };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-config', () => {
  return {
    ...config,
    _userDataPath: userDataPath,
    _globalInboxPath: globalInboxPath,
    _logPath: logger.logPath,
    _logDir: logger.logDir
  };
});

ipcMain.handle('save-settings', (_, settings) => {
  try {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return { error: 'Invalid settings' };
    }

    const roots = sanitizePathList(settings.roots);
    if (roots.length === 0) return { error: 'At least one project root is required' };

    const currentRoots = new Set((config.roots || []).map(root => path.resolve(root).toLowerCase()));
    for (const root of roots) {
      const key = root.toLowerCase();
      if (!currentRoots.has(key) && !approvedConfigPaths.has(key)) {
        return { error: `Root was not selected with the folder picker: ${root}` };
      }
      try {
        if (!fs.statSync(root).isDirectory()) return { error: `Root is not a folder: ${root}` };
      } catch {
        return { error: `Root does not exist: ${root}` };
      }
    }

    const ignoredPaths = sanitizePathList(settings.ignoredPaths);
    const scanDepth = Number(settings.scanDepth);
    if (!Number.isInteger(scanDepth) || scanDepth < 1 || scanDepth > 12) {
      return { error: 'Scan depth must be a whole number from 1 to 12' };
    }

    config = normalizeConfig({
      ...config,
      roots,
      ignoredPaths,
      scanDepth,
      launch: normalizeLaunchConfig(settings.launch, config.launch)
    }, defaultConfig);

    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    scanner.updateConfig(config);
    restartFileWatcher();
    logger.info('settings.save', 'Settings saved', { rootCount: roots.length, ignoredPathCount: ignoredPaths.length, scanDepth });
    return {
      success: true,
      config: {
        ...config,
        _userDataPath: userDataPath,
        _globalInboxPath: globalInboxPath,
        _logPath: logger.logPath,
        _logDir: logger.logDir
      }
    };
  } catch (err) {
    logger.error('settings.save.error', err.message, err);
    return { error: err.message };
  }
});

// --- Category Management ---

ipcMain.handle('get-categories', () => {
  return config.categories || [];
});

ipcMain.handle('add-category', (_, category) => {
  try {
    if (!config.categories) config.categories = [];
    const validation = sanitizeCategoryDefinition(category);
    if (validation.error) return { error: validation.error };
    const sanitized = validation.category;
    if (config.categories.some(c => c.id === sanitized.id)) {
      return { error: 'Category ID already exists' };
    }
    config.categories.push(sanitized);
    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    return { success: true, categories: config.categories };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('rename-category', async (_, oldId, newId, newLabel) => {
  try {
    const validation = sanitizeCategoryRenameInput(oldId, newId, newLabel);
    if (validation.error) return { error: validation.error };

    const cat = config.categories.find(c => c.id === validation.oldId);
    const nextLabel = validation.newLabel;
    const shouldRenameId = validation.newId !== validation.oldId;

    if (shouldRenameId) {
      const projects = scanner.getCached() || await scanner.scan();
      const staged = [];
      const failures = [];
      for (const project of projects) {
        if (project.category !== validation.oldId) continue;
        const planPath = path.join(project.path, 'PROJECT_PLAN.md');
        try {
          const raw = fs.readFileSync(planPath, 'utf-8');
          const parsed = matter(raw);
          parsed.data.category = validation.newId;
          staged.push({ planPath, content: matter.stringify(parsed.content, parsed.data) });
        } catch (err) {
          failures.push({ name: project.name, path: project.path, error: err.message });
        }
      }
      if (failures.length) {
        return { error: `Failed to read ${failures.length} project${failures.length > 1 ? 's' : ''}`, failures };
      }
      const written = [];
      for (const entry of staged) {
        try {
          atomicWriteSync(entry.planPath, entry.content);
          written.push(entry);
        } catch (err) {
          for (const done of written) {
            try {
              const raw = fs.readFileSync(done.planPath, 'utf-8');
              const parsed = matter(raw);
              parsed.data.category = validation.oldId;
              atomicWriteSync(done.planPath, matter.stringify(parsed.content, parsed.data));
            } catch { /* best-effort rollback */ }
          }
          await scanner.scan();
          return { error: `Write failed for ${path.basename(path.dirname(entry.planPath))}, rolled back ${written.length} file(s)` };
        }
      }

      cat.id = validation.newId;

      // Update fallbacks too
      for (const [key, val] of Object.entries(config.categoryFallbacks || {})) {
        if (val === validation.oldId) config.categoryFallbacks[key] = validation.newId;
      }
    }

    if (nextLabel !== null) cat.label = nextLabel;

    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    await scanner.scan();
    return { success: true, categories: config.categories };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('update-category', (_, categoryId, updates) => {
  try {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { error: 'Invalid updates' };
    const id = String(categoryId || '').trim();
    const cat = config.categories.find(c => c.id === id);
    if (!cat) return { error: 'Category not found' };
    if (updates.label !== undefined) {
      const label = String(updates.label || '').trim().replace(/\s+/g, ' ');
      if (!label || label.length > 80) return { error: 'Invalid category label' };
      cat.label = label;
    }
    if (updates.color !== undefined) {
      const color = String(updates.color || '').trim();
      if (!HEX_COLOR_PATTERN.test(color)) return { error: 'Invalid category color' };
      cat.color = color;
    }
    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    return { success: true, categories: config.categories };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delete-category', async (_, categoryId, reassignTo) => {
  try {
    const id = String(categoryId || '').trim();
    const idx = config.categories.findIndex(c => c.id === id);
    if (idx === -1) return { error: 'Category not found' };

    // Reassign projects in this category
    const projects = scanner.getCached() || await scanner.scan();
    const affectedProjects = projects.filter(project => project.category === id);
    if (affectedProjects.length && !reassignTo) {
      return { error: 'Cannot delete a category that still has projects without a reassignment target' };
    }

    let reassignCategory = null;
    if (affectedProjects.length) {
      const validation = validateCategoryId(reassignTo);
      if (validation.error) return validation;
      if (validation.value === id) return { error: 'Cannot reassign to the deleted category' };
      reassignCategory = validation.value;

      const staged = [];
      const failures = [];
      for (const project of affectedProjects) {
        const planPath = path.join(project.path, 'PROJECT_PLAN.md');
        try {
          const raw = fs.readFileSync(planPath, 'utf-8');
          const parsed = matter(raw);
          parsed.data.category = reassignCategory;
          staged.push({ planPath, content: matter.stringify(parsed.content, parsed.data), originalCategory: id });
        } catch (err) {
          failures.push({ name: project.name, path: project.path, error: err.message });
        }
      }
      if (failures.length) {
        return { error: `Failed to read ${failures.length} project${failures.length > 1 ? 's' : ''}`, failures };
      }
      const written = [];
      for (const entry of staged) {
        try {
          atomicWriteSync(entry.planPath, entry.content);
          written.push(entry);
        } catch (err) {
          for (const done of written) {
            try {
              const raw = fs.readFileSync(done.planPath, 'utf-8');
              const parsed = matter(raw);
              parsed.data.category = done.originalCategory;
              atomicWriteSync(done.planPath, matter.stringify(parsed.content, parsed.data));
            } catch { /* best-effort rollback */ }
          }
          await scanner.scan();
          return { error: `Write failed during reassign, rolled back ${written.length} file(s)` };
        }
      }
    }

    config.categories.splice(idx, 1);

    // Clean up fallbacks pointing to deleted category
    for (const [key, val] of Object.entries(config.categoryFallbacks || {})) {
      if (val === id) delete config.categoryFallbacks[key];
    }

    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    await scanner.scan();
    return { success: true, categories: config.categories };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('reorder-categories', (_, orderedIds) => {
  try {
    if (!Array.isArray(orderedIds)) return { error: 'Invalid category order' };
    const reordered = [];
    for (const id of orderedIds) {
      const cat = config.categories.find(c => c.id === id);
      if (cat) reordered.push(cat);
    }
    // Append any categories not in the new order
    for (const cat of config.categories) {
      if (!reordered.includes(cat)) reordered.push(cat);
    }
    config.categories = reordered;
    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    return { success: true, categories: config.categories };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Folder Picker ---

ipcMain.handle('show-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select project folder',
    properties: ['openDirectory'],
    defaultPath: config.roots?.[0] || app.getPath('home')
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selectedPath = path.resolve(result.filePaths[0]);
  approvedConfigPaths.add(selectedPath.toLowerCase());
  return selectedPath;
});

// --- Add Project (manual) ---

ipcMain.handle('add-project', async (_, folderPath, metadata) => {
  if (!isAllowedProjectPath(folderPath)) return { error: 'Access denied' };
  try {
    const planPath = path.join(folderPath, 'PROJECT_PLAN.md');
    const name = path.basename(folderPath);
    const defaults = {
      status: 'active',
      priority: 'medium',
      category: getDefaultCategoryId(),
      next: '',
      tags: []
    };
    const validation = validateProjectUpdateFields({
      ...defaults,
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {})
    });
    if (validation.error) return { error: validation.error };

    const projectId = generateProjectId(folderPath);
    const existingProjects = scanner.getCached() || await scanner.scan();
    const idCollision = existingProjects.find(project => project.id === projectId && !pathsEqual(project.path, folderPath));
    if (idCollision) return { error: `Generated project ID collides with ${idCollision.name}` };

    const data = {
      id: projectId,
      scan: 'project',
      ...validation.fields
    };
    if (data.next === '') delete data.next;
    if (data.tags && data.tags.length === 0) delete data.tags;
    const content = `\n# ${name}\n\n## Purpose\n\n_TODO: Describe what this project does._\n`;
    atomicWriteSync(planPath, matter.stringify(content, data));
    await scanner.scan();
    const project = scanner.getProject(folderPath);
    return { success: true, project };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Write stable IDs to projects that need them ---

ipcMain.handle('write-stable-ids', async () => {
  const projects = scanner.getCached() || await scanner.scan();
  let written = 0;
  for (const project of projects) {
    if (!project._needsIdWrite || !project.hasProjectPlan) continue;
    const planPath = path.join(project.path, 'PROJECT_PLAN.md');
    try {
      const raw = fs.readFileSync(planPath, 'utf-8');
      const parsed = matter(raw);
      if (!parsed.data.id) {
        parsed.data.id = project.id;
        atomicWriteSync(planPath, matter.stringify(parsed.content, parsed.data));
        written++;
      }
    } catch {}
  }
  return { success: true, written };
});

// --- Scratchpad ---

ipcMain.handle('read-scratchpad', (_, projectPath) => {
  if (!isAllowedProjectPath(projectPath)) return { content: '', error: 'Access denied' };
  const scratchPath = path.join(projectPath, 'SCRATCHPAD.md');
  const resolved = resolveValidatedScratchpadPath(scratchPath);
  if (!resolved) return { content: '', error: 'Access denied' };
  try {
    if (fs.existsSync(resolved)) {
      return { content: fs.readFileSync(resolved, 'utf-8') };
    }
    return { content: '' };
  } catch (err) {
    return { content: '', error: err.message };
  }
});

ipcMain.handle('write-scratchpad', (_, projectPath, content) => {
  if (!isAllowedProjectPath(projectPath)) return { error: 'Access denied' };
  const scratchPath = path.join(projectPath, 'SCRATCHPAD.md');
  const resolved = resolveValidatedScratchpadPath(scratchPath);
  if (!resolved) return { error: 'Access denied' };
  try {
    suppressWatcherFor(resolved);
    atomicWriteSync(resolved, content);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Show Legacy toggle ---

ipcMain.handle('set-show-legacy', (_, show) => {
  try {
    config.showLegacy = !!show;
    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('set-show-sandbox', (_, show) => {
  try {
    config.showSandbox = !!show;
    atomicWriteSync(userConfigPath, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (err) {
    logger.error('settings.showSandbox.error', err.message, err);
    return { error: err.message };
  }
});
