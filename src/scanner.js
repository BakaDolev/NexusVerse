const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function parallelLimit(tasks, limit = 6) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

const EXPLICIT_SIGNALS = ['PROJECT_PLAN.md', 'CLAUDE.md'];
const TECHNICAL_SIGNALS = ['package.json', '.git', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];
const VALID_STATUSES = new Set(['active', 'service', 'paused', 'idea', 'sandbox', 'done', 'legacy']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
const PROJECT_ID_PATTERN = /^nxv_[a-f0-9]{8}$/i;

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

class ProjectScanner {
  constructor(config) {
    this.roots = config.roots || [];
    this.scanDepth = config.scanDepth || 4;
    this.ignore = new Set(config.ignore || ['node_modules', '.git', 'dist', 'build']);
    this.ignoredPaths = (config.ignoredPaths || []).map(p => path.resolve(p));
    this.categories = config.categories || [];
    this.categoryFallbacks = config.categoryFallbacks || {};
    this.candidates = [];
    this.cache = null;
    this._scanId = 0;
  }

  async scan() {
    const scanId = ++this._scanId;
    const candidates = [];
    for (const root of this.roots) {
      try {
        await fsp.access(root);
      } catch {
        continue;
      }
      await this._collectCandidates(root, 0, candidates);
    }

    this.candidates = candidates;
    const projects = this._resolveVisibility(candidates);

    await parallelLimit(projects.map(project => () => this._enrichProject(project)), 6);

    this._resolveDependencies(projects);

    projects.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    if (scanId === this._scanId) {
      this.cache = projects;
    }
    return projects;
  }

  // --- Phase 1: Collect all candidate directories ---

  async _collectCandidates(dir, depth, candidates) {
    if (depth > this.scanDepth) return;

    const resolved = path.resolve(dir);
    if (this.ignoredPaths.some(ip => resolved.startsWith(ip + path.sep) || resolved === ip)) return;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const signals = await this._getSignals(dir, entries);

    if (signals.isCandidate) {
      candidates.push({
        dir: resolved,
        name: path.basename(dir),
        signals,
        scanMode: signals.scanMode,
        frontmatter: signals.frontmatter,
        hasProjectPlan: signals.explicit.includes('PROJECT_PLAN.md')
      });
    }

    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (this.ignore.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      const childPath = path.join(dir, entry.name);
      const childResolved = path.resolve(childPath);
      if (this.ignoredPaths.some(ip => childResolved.startsWith(ip + path.sep) || childResolved === ip)) continue;
      tasks.push(() => this._collectCandidates(childPath, depth + 1, candidates));
    }
    await parallelLimit(tasks, 8);
  }

  async _getSignals(dir, entries) {
    const fileNames = new Set();
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git') {
        fileNames.add(e.name);
      }
    }
    // .git is a directory, check separately
    for (const e of entries) {
      if (e.isDirectory() && e.name === '.git') {
        fileNames.add('.git');
      }
    }

    const explicit = EXPLICIT_SIGNALS.filter(s => fileNames.has(s));
    const technical = TECHNICAL_SIGNALS.filter(s => fileNames.has(s));

    let frontmatter = null;
    let scanMode = 'auto';

    if (fileNames.has('PROJECT_PLAN.md')) {
      try {
        const raw = await fsp.readFile(path.join(dir, 'PROJECT_PLAN.md'), 'utf-8');
        const parsed = matter(raw);
        frontmatter = parsed.data || {};
        if (frontmatter.scan) scanMode = frontmatter.scan;
      } catch (err) {
        console.error('Failed to parse PROJECT_PLAN.md frontmatter:', dir, err.message);
      }
    }

    const hasExplicit = explicit.length > 0;
    const technicalCount = technical.length;

    const isCandidate =
      scanMode === 'project' ||
      scanMode === 'container' ||
      hasExplicit ||
      technicalCount >= 2;

    return { explicit, technical, hasExplicit, technicalCount, isCandidate, scanMode, frontmatter };
  }

  // --- Phase 2: Resolve parent/child visibility ---

  _resolveVisibility(candidates) {
    const visible = [];

    for (const candidate of candidates) {
      if (candidate.scanMode === 'container') continue;

      if (candidate.scanMode === 'project') {
        visible.push(candidate);
        continue;
      }

      // auto mode: check if this candidate has children
      const hasChildCandidates = candidates.some(other =>
        other.dir !== candidate.dir &&
        other.dir.startsWith(candidate.dir + path.sep)
      );

      if (hasChildCandidates) {
        // Parent with children: suppress parent unless it has explicit metadata
        const hasExplicitCategory = candidate.frontmatter && candidate.frontmatter.category;
        if (hasExplicitCategory) {
          visible.push(candidate);
        }
        // Otherwise skip — children win
        continue;
      }

      visible.push(candidate);
    }

    return visible.map(c => this._buildProject(c));
  }

  // --- Build project object from candidate ---

  _buildProject(candidate) {
    const data = candidate.frontmatter || {};
    const parseErrors = [];
    const rawId = this._safeString(data.id);
    const id = rawId && PROJECT_ID_PATTERN.test(rawId)
      ? rawId
      : this._generateId(candidate.dir);
    if (rawId && !PROJECT_ID_PATTERN.test(rawId)) {
      parseErrors.push(`Invalid id: ${rawId}`);
    }
    const rawStatus = this._frontmatterString(data.status, 'status', parseErrors);
    const rawPriority = this._frontmatterString(data.priority, 'priority', parseErrors);
    const rawCategory = this._frontmatterString(data.category, 'category', parseErrors);
    const status = rawStatus && VALID_STATUSES.has(rawStatus)
      ? rawStatus
      : (rawStatus ? (parseErrors.push(`Invalid status: ${rawStatus}`), 'unknown') : 'unknown');
    const priority = rawPriority && VALID_PRIORITIES.has(rawPriority)
      ? rawPriority
      : (rawPriority ? (parseErrors.push(`Invalid priority: ${rawPriority}`), 'medium') : 'medium');
    const category = rawCategory || this._detectFallbackCategory(candidate.dir) || 'uncategorized';

    return {
      id,
      name: candidate.name,
      path: candidate.dir,
      status,
      priority,
      category,
      scan: candidate.scanMode,
      lastActivity: null,
      lastActivityDate: null,
      gitBranch: null,
      gitDirty: false,
      gitUnpushed: 0,
      githubUrl: null,
      next: this._safeString(data.next),
      dependsOn: Array.isArray(data.depends_on) ? data.depends_on.filter(Boolean).map(String) : [],
      dependencies: [],
      tags: normalizeTags(data.tags),
      createdDate: null,
      hasClaude: candidate.signals.explicit.includes('CLAUDE.md') || false,
      hasProjectPlan: candidate.hasProjectPlan,
      hasIdeas: false,
      description: null,
      parseErrors,
      _needsIdWrite: !rawId || rawId !== id
    };
  }

  _safeString(value) {
    if (typeof value === 'string') return value;
    if (value == null) return null;
    return String(value);
  }

  _frontmatterString(value, field, parseErrors) {
    if (typeof value === 'string') return value;
    if (value == null) return null;
    parseErrors.push(`Invalid ${field}: ${String(value)}`);
    return null;
  }

  _generateId(dir) {
    const hash = crypto.createHash('sha256').update(dir.toLowerCase()).digest('hex').substring(0, 8);
    return `nxv_${hash}`;
  }

  _detectFallbackCategory(dir) {
    for (const [folderName, categoryId] of Object.entries(this.categoryFallbacks)) {
      if (dir.includes(path.sep + folderName + path.sep) || dir.endsWith(path.sep + folderName)) {
        return categoryId;
      }
    }
    return null;
  }

  // --- Phase 3: Enrich with git info, file checks, descriptions ---

  async _enrichProject(project) {
    const dir = project.path;

    if (project.hasProjectPlan) {
      try {
        const raw = await fsp.readFile(path.join(dir, 'PROJECT_PLAN.md'), 'utf-8');
        const parsed = matter(raw);
        const purposeMatch = parsed.content.match(/##?\s*Purpose\s*\n+([^\n#]+)/i);
        if (purposeMatch) project.description = purposeMatch[1].trim();
      } catch (err) {
        project.parseErrors.push(`PROJECT_PLAN.md: ${err.message}`);
      }
    }

    try {
      await fsp.access(path.join(dir, 'BRAINSTORM.md'));
      project.hasIdeas = true;
    } catch {}
    if (!project.hasIdeas) {
      try {
        await fsp.access(path.join(dir, 'IDEAS.md'));
        project.hasIdeas = true;
      } catch {}
    }

    if (!project.hasClaude) {
      try {
        await fsp.access(path.join(dir, 'CLAUDE.md'));
        project.hasClaude = true;
      } catch {}
    }

    try {
      const stat = await fsp.stat(dir);
      project.createdDate = stat.birthtime.toISOString().split('T')[0];
    } catch {}

    const gitInfo = await this._getGitInfo(dir);
    if (gitInfo) {
      project.gitBranch = gitInfo.branch;
      project.gitDirty = gitInfo.dirty || false;
      project.gitUnpushed = gitInfo.unpushed || 0;
      project.lastActivity = gitInfo.lastCommitTime;
      project.lastActivityDate = gitInfo.lastCommitDate;
      project.githubUrl = gitInfo.githubUrl;
    }

    if (!project.lastActivity) {
      try {
        const stat = await fsp.stat(dir);
        project.lastActivity = stat.mtimeMs;
        project.lastActivityDate = stat.mtime.toISOString().split('T')[0];
      } catch {}
    }

    if (project.status === 'unknown' && project.lastActivity) {
      const daysSince = (Date.now() - project.lastActivity) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) project.status = 'active';
      else if (daysSince < 90) project.status = 'paused';
      else project.status = 'legacy';
    }
  }

  async _getGitInfo(dir) {
    try {
      await fsp.access(path.join(dir, '.git'));
    } catch {
      return null;
    }

    const opts = { cwd: dir, timeout: 5000 };

    try {
      const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
      const branch = branchOut.trim();

      let lastCommitTime = null;
      let lastCommitDate = null;
      try {
        const { stdout: tsOut } = await execFileAsync('git', ['log', '-1', '--format=%ct'], opts);
        const timestamp = tsOut.trim();
        if (timestamp) {
          lastCommitTime = parseInt(timestamp) * 1000;
          lastCommitDate = new Date(lastCommitTime).toISOString().split('T')[0];
        }
      } catch {}

      let githubUrl = null;
      try {
        const { stdout: remoteOut } = await execFileAsync('git', ['remote', 'get-url', 'origin'], opts);
        const remote = remoteOut.trim();
        const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/);
        if (sshMatch) {
          githubUrl = `https://github.com/${sshMatch[1]}`;
        } else {
          try {
            const parsed = new URL(remote);
            if (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') {
              githubUrl = `https://github.com${parsed.pathname.replace(/\.git$/, '')}`;
            }
          } catch {}
        }
      } catch {}

      let dirty = false;
      try {
        const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], opts);
        dirty = statusOut.trim().length > 0;
      } catch {}

      let unpushed = 0;
      try {
        const { stdout: aheadOut } = await execFileAsync('git', ['rev-list', '--count', '@{u}..HEAD'], opts);
        unpushed = parseInt(aheadOut.trim()) || 0;
      } catch {}

      return { branch, lastCommitTime, lastCommitDate, githubUrl, dirty, unpushed };
    } catch {
      return null;
    }
  }

  _resolveDependencies(projects) {
    const byName = new Map();
    for (const p of projects) {
      byName.set(p.name.toLowerCase(), p);
    }
    for (const project of projects) {
      if (!project.dependsOn.length) continue;
      project.dependencies = project.dependsOn.map(raw => {
        const match = byName.get(raw.toLowerCase());
        return match
          ? { raw, resolved: true, projectPath: match.path, label: match.name }
          : { raw, resolved: false, label: raw };
      });
    }
  }

  // --- Public API ---

  getProject(projectPath) {
    if (this.cache) {
      const resolvedPath = path.resolve(projectPath).toLowerCase();
      return this.cache.find(p => path.resolve(p.path).toLowerCase() === resolvedPath);
    }
    return null;
  }

  getCached() {
    return this.cache;
  }

  getCandidates() {
    return this.candidates;
  }

  getCategoryDefinitions() {
    return this.categories;
  }

  updateCachedProject(projectPath, fields = {}) {
    if (!this.cache) return null;
    const resolvedPath = path.resolve(projectPath).toLowerCase();
    const index = this.cache.findIndex(project => path.resolve(project.path).toLowerCase() === resolvedPath);
    if (index === -1) return null;

    const current = this.cache[index];
    const updated = {
      ...current,
      status: fields.status ?? current.status,
      priority: fields.priority ?? current.priority,
      category: fields.category ?? current.category,
      next: fields.next ?? current.next,
      tags: Object.prototype.hasOwnProperty.call(fields, 'tags') ? normalizeTags(fields.tags) : current.tags,
      description: fields.description ?? current.description,
      hasProjectPlan: true
    };

    this.cache[index] = updated;
    return updated;
  }

  updateConfig(config) {
    this.roots = config.roots || this.roots;
    this.scanDepth = config.scanDepth || this.scanDepth;
    this.ignore = new Set(config.ignore || [...this.ignore]);
    this.ignoredPaths = (config.ignoredPaths || []).map(p => path.resolve(p));
    this.categories = config.categories || this.categories;
    this.categoryFallbacks = config.categoryFallbacks || this.categoryFallbacks;
  }
}

module.exports = ProjectScanner;
