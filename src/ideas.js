const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_IDEA_TYPES = new Set(['bug', 'feature', 'improvement', 'idea', 'question', 'task']);
const BRAINSTORM_FILENAME = 'BRAINSTORM.md';
const LEGACY_IDEAS_FILENAME = 'IDEAS.md';
const BRAINSTORM_HEADER = '# Brainstorm\n\n';

class IdeasManager {
  constructor(globalInboxPath, options = {}) {
    this.globalInboxPath = globalInboxPath;
    this.legacyGlobalInboxPath = options.legacyGlobalInboxPath || path.join(path.dirname(this.globalInboxPath), LEGACY_IDEAS_FILENAME);
    this.beforeWrite = typeof options.beforeWrite === 'function' ? options.beforeWrite : null;
    this.transactionDir = path.join(path.dirname(this.globalInboxPath), 'brainstorm-transactions');
    this.legacyTransactionDir = path.join(path.dirname(this.globalInboxPath), 'idea-transactions');
    fs.mkdirSync(this.transactionDir, { recursive: true });
    this._migrateLegacyFile(this.globalInboxPath, this.legacyGlobalInboxPath);
    this._ensureFile(this.globalInboxPath);
    this._recoverMoveTransactions(this.legacyTransactionDir);
    this._recoverMoveTransactions(this.transactionDir);
  }

  _ensureFile(filePath) {
    if (!fs.existsSync(filePath)) {
      this._atomicWrite(filePath, BRAINSTORM_HEADER);
    }
  }

  _migrateLegacyFile(primaryPath, legacyPath) {
    if (path.resolve(primaryPath) === path.resolve(legacyPath)) return;
    if (fs.existsSync(primaryPath) || !fs.existsSync(legacyPath)) return;
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.renameSync(legacyPath, primaryPath);
  }

  _legacyPathForProject(projectPath) {
    return path.join(projectPath, LEGACY_IDEAS_FILENAME);
  }

  _brainstormPathForProject(projectPath) {
    const primaryPath = path.join(projectPath, BRAINSTORM_FILENAME);
    this._migrateLegacyFile(primaryPath, this._legacyPathForProject(projectPath));
    return primaryPath;
  }

  _readBrainstormFiles(primaryPath, legacyPath, options = {}) {
    this._migrateLegacyFile(primaryPath, legacyPath);
    const files = [];
    if (fs.existsSync(primaryPath)) files.push(primaryPath);
    if (path.resolve(primaryPath) !== path.resolve(legacyPath) && fs.existsSync(legacyPath)) {
      files.push(legacyPath);
    }
    return files.flatMap(filePath => {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this._parseIdeas(content, { ...options, filePath });
    });
  }

  _atomicWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp.' + Date.now() + Math.random().toString(36).slice(2, 8);
    if (this.beforeWrite) this.beforeWrite(filePath);
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  _transactionPath(transactionId) {
    return path.join(this.transactionDir, `${transactionId}.json`);
  }

  _hashContent(content) {
    return crypto.createHash('sha256').update(String(content || '')).digest('hex');
  }

  _hashFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return this._hashContent(fs.readFileSync(filePath, 'utf-8'));
  }

  _writeMoveTransaction(transactionId, files) {
    const manifest = {
      type: 'move-idea',
      createdAt: new Date().toISOString(),
      files: files.map(file => ({
        filePath: path.resolve(file.filePath),
        beforeHash: this._hashContent(file.before),
        afterHash: this._hashContent(file.after),
        after: file.after
      }))
    };
    this._atomicWrite(this._transactionPath(transactionId), JSON.stringify(manifest, null, 2));
  }

  _applyMoveTransaction(manifest) {
    for (const file of manifest.files || []) {
      if (!file?.filePath || typeof file.after !== 'string') continue;
      if (file.afterHash && this._hashFile(file.filePath) === file.afterHash) continue;
      this._atomicWrite(file.filePath, file.after);
    }
  }

  _canRecoverMoveTransaction(manifest) {
    for (const file of manifest.files || []) {
      if (!file?.filePath || typeof file.after !== 'string' || !file.beforeHash || !file.afterHash) {
        return false;
      }
      const currentHash = this._hashFile(file.filePath);
      if (currentHash !== file.beforeHash && currentHash !== file.afterHash) return false;
    }
    return true;
  }

  _quarantineMoveTransaction(manifestPath) {
    const quarantinePath = `${manifestPath}.conflict.${Date.now()}`;
    try {
      fs.renameSync(manifestPath, quarantinePath);
    } catch (err) {
      console.error('Failed to quarantine move transaction:', path.basename(manifestPath), err.message);
    }
  }

  _recoverMoveTransactions(transactionDir = this.transactionDir) {
    if (!fs.existsSync(transactionDir)) return;
    const entries = fs.readdirSync(transactionDir).filter(name => name.endsWith('.json'));
    for (const entry of entries) {
      const manifestPath = path.join(transactionDir, entry);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest.type === 'move-idea') {
          if (!this._canRecoverMoveTransaction(manifest)) {
            console.warn('Quarantining conflicting move transaction:', entry);
            this._quarantineMoveTransaction(manifestPath);
            continue;
          }
          this._applyMoveTransaction(manifest);
        }
        fs.unlinkSync(manifestPath);
      } catch (err) {
        console.error('Failed to recover move transaction:', entry, err.message);
      }
    }
  }

  _commitMoveTransaction(files) {
    const transactionId = `move-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const manifestPath = this._transactionPath(transactionId);
    this._writeMoveTransaction(transactionId, files);
    try {
      this._applyMoveTransaction({ files });
      fs.unlinkSync(manifestPath);
    } catch (err) {
      throw err;
    }
  }

  _formatTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }

  _formatIdea(text, project, options = {}) {
    const timestamp = this._formatTimestamp();
    const includeProject = options.includeProject !== false;
    return this._buildIdeaLine(' ', timestamp, text, project, null, timestamp, { includeProject });
  }

  _stripIdeaSuffixes(text) {
    let remaining = text.trim();
    let project = null;
    let completedAt = null;
    let updatedAt = null;
    let changed = true;

    while (changed) {
      changed = false;

      const updatedMatch = remaining.match(/^(.*?)\s*_\((updated):\s*([^)]+)\)_\s*$/);
      if (updatedMatch) {
        if (updatedMatch[1].endsWith('\\')) break;
        remaining = updatedMatch[1].trim();
        updatedAt = this._unescapeMetadataText(updatedMatch[3].trim());
        changed = true;
        continue;
      }

      const completedMatch = remaining.match(/^(.*?)\s*_\((completed):\s*([^)]+)\)_\s*$/);
      if (completedMatch) {
        if (completedMatch[1].endsWith('\\')) break;
        remaining = completedMatch[1].trim();
        completedAt = this._unescapeMetadataText(completedMatch[3].trim());
        changed = true;
        continue;
      }

      const projectMatch = remaining.match(/^(.*?)\s*_\((for):\s*([^)]+)\)_\s*$/);
      if (projectMatch) {
        if (projectMatch[1].endsWith('\\')) break;
        remaining = projectMatch[1].trim();
        project = this._unescapeMetadataText(projectMatch[3].trim());
        changed = true;
      }
    }

    return { text: this._unescapeUserText(remaining), project, completedAt, updatedAt };
  }

  _buildIdeaLine(doneMark, date, text, project, completedAt, updatedAt, options = {}) {
    const includeProject = options.includeProject !== false;
    const body = this._escapeUserText(this._normalizeIdeaText(text));
    let line = `- [${doneMark}] **[${date}]** ${body}`;
    if (includeProject && project) line += ` _(for: ${this._escapeMetadataText(project)})_`;
    if (completedAt) line += ` _(completed: ${this._escapeMetadataText(completedAt)})_`;
    if (updatedAt) line += ` _(updated: ${this._escapeMetadataText(updatedAt)})_`;
    return line;
  }

  _normalizeIdeaText(text) {
    return String(text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  _escapeUserText(text) {
    return String(text || '').replace(/\s_\((for|completed|updated):\s*([^)]+)\)_/gi, ' \\_($1: $2)_');
  }

  _unescapeUserText(text) {
    return String(text || '').replace(/\\_\((for|completed|updated):\s*([^)]+)\)_/gi, '_($1: $2)_');
  }

  _escapeMetadataText(text) {
    return this._normalizeIdeaText(text)
      .replace(/&/g, '&amp;')
      .replace(/\)/g, '&#41;');
  }

  _unescapeMetadataText(text) {
    return String(text || '')
      .replace(/&#41;/g, ')')
      .replace(/&amp;/g, '&');
  }

  _isGlobalInbox(filePath) {
    const resolved = path.resolve(filePath);
    return resolved === path.resolve(this.globalInboxPath) || resolved === path.resolve(this.legacyGlobalInboxPath);
  }

  _projectNameFromPath(projectPath, fallback) {
    const name = path.basename(path.resolve(projectPath));
    return name || fallback || null;
  }

  _contentWithInsertedIdea(content, entry) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let insertIndex = -1;
    let i = 0;

    if (lines[0]?.trim() === '---') {
      i = 1;
      while (i < lines.length && lines[i].trim() !== '---') i++;
      if (i < lines.length) i++;
    }

    for (; i < lines.length; i++) {
      if (lines[i].startsWith('# ') || lines[i].startsWith('## ')) continue;
      if (lines[i].trim() === '') continue;
      insertIndex = i;
      break;
    }

    if (insertIndex === -1) {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      if (lines.length > 0) lines.push('', entry);
      else lines.push(entry);
    } else {
      lines.splice(insertIndex, 0, entry);
    }

    return lines.join('\n');
  }

  _insertIdea(filePath, entry) {
    this._ensureFile(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    this._atomicWrite(filePath, this._contentWithInsertedIdea(content, entry));
  }

  addToGlobalInbox(text, projectHint) {
    const entry = this._formatIdea(text, projectHint, { includeProject: true });
    this._insertIdea(this.globalInboxPath, entry);
    return entry;
  }

  addToProject(projectPath, text) {
    const ideasPath = this._brainstormPathForProject(projectPath);
    const entry = this._formatIdea(text, null, { includeProject: false });
    this._insertIdea(ideasPath, entry);
    return entry;
  }

  getGlobalIdeas() {
    return this._readBrainstormFiles(this.globalInboxPath, this.legacyGlobalInboxPath);
  }

  getProjectIdeas(projectPath) {
    return this._readBrainstormFiles(
      this._brainstormPathForProject(projectPath),
      this._legacyPathForProject(projectPath),
      {
      project: this._projectNameFromPath(projectPath)
      }
    );
  }

  getAllIdeas(projectList) {
    const ideas = this.getGlobalIdeas();
    for (const project of projectList || []) {
      if (!project || !project.path) continue;
      ideas.push(...this._readBrainstormFiles(
        this._brainstormPathForProject(project.path),
        this._legacyPathForProject(project.path),
        {
          project: this._projectNameFromPath(project.path, project.name)
        }
      ));
    }
    return ideas;
  }

  _parseIdeas(content, options = {}) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const ideas = [];
    const occurrenceCounts = new Map();
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const rawKey = line.trim();
      const occurrence = occurrenceCounts.get(rawKey) || 0;
      const idea = this._parseIdeaLine(line, { ...options, lineIndex, rawOccurrence: occurrence });
      if (idea) ideas.push(idea);
      occurrenceCounts.set(rawKey, occurrence + 1);
    }
    return ideas;
  }

  _parseIdeaLine(line, options = {}) {
    const match = line.match(/^- \[([ x~])\] \*\*\[(.+?)\]\*\* (.+)$/);
    if (!match) return null;

    const mark = match[1];
    const { text, project, completedAt, updatedAt } = this._stripIdeaSuffixes(match[3]);
    const { type, body } = this._extractType(text);
    const done = mark === 'x';
    const paused = mark === '~';
    const status = done ? 'done' : paused ? 'paused' : 'open';

    return {
      done,
      paused,
      status,
      date: match[2],
      completedAt,
      updatedAt: updatedAt || completedAt || match[2],
      text: body,
      type,
      project: options.project || project,
      filePath: options.filePath || null,
      lineIndex: Number.isInteger(options.lineIndex) ? options.lineIndex : null,
      rawOccurrence: Number.isInteger(options.rawOccurrence) ? options.rawOccurrence : 0,
      raw: line
    };
  }

  _extractType(text) {
    const m = text.match(/^\[(\w+)\]\s*(.*)$/);
    if (m) {
      const t = m[1].toLowerCase();
      if (VALID_IDEA_TYPES.has(t)) return { type: t, body: m[2] };
    }
    return { type: null, body: text };
  }

  _textWithType(idea) {
    return idea.type ? `[${idea.type}] ${idea.text}` : idea.text;
  }

  _normalizeLocator(rawLine) {
    if (rawLine && typeof rawLine === 'object') {
      return {
        raw: String(rawLine.raw || ''),
        lineIndex: Number.isInteger(rawLine.lineIndex) ? rawLine.lineIndex : null,
        rawOccurrence: Number.isInteger(rawLine.rawOccurrence) ? rawLine.rawOccurrence : null
      };
    }

    const raw = String(rawLine || '');
    if (raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.raw === 'string') return this._normalizeLocator(parsed);
      } catch {}
    }
    return { raw, lineIndex: null, rawOccurrence: null };
  }

  _findIdeaLine(lines, rawLine) {
    const locator = this._normalizeLocator(rawLine);
    const target = locator.raw.trim();
    if (!target) return -1;

    if (
      Number.isInteger(locator.lineIndex) &&
      locator.lineIndex >= 0 &&
      locator.lineIndex < lines.length &&
      lines[locator.lineIndex].trim() === target
    ) {
      return locator.lineIndex;
    }

    let occurrence = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== target) continue;
      if (locator.rawOccurrence == null || occurrence === locator.rawOccurrence) return i;
      occurrence++;
    }
    return -1;
  }

  setIdeaType(filePath, rawLine, newType) {
    if (newType && !VALID_IDEA_TYPES.has(String(newType).toLowerCase())) return { success: false };
    if (!fs.existsSync(filePath)) return { success: false };
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const index = this._findIdeaLine(lines, rawLine);
    if (index === -1) return { success: false };

    const parsed = lines[index].match(/^- \[([ x~])\] \*\*\[(.+?)\]\*\* (.+)$/);
    if (!parsed) return { success: false };

    const { text, project, completedAt, updatedAt } = this._stripIdeaSuffixes(parsed[3]);
    const { body } = this._extractType(text);
    const prefix = newType ? `[${String(newType).toLowerCase()}] ` : '';
    lines[index] = this._buildIdeaLine(
      parsed[1],
      parsed[2],
      prefix + body,
      project,
      completedAt,
      updatedAt,
      { includeProject: this._isGlobalInbox(filePath) }
    );

    this._atomicWrite(filePath, lines.join('\n'));
    return { success: true };
  }

  toggleIdea(filePath, rawLine, done) {
    if (!fs.existsSync(filePath)) return { success: false };
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const index = this._findIdeaLine(lines, rawLine);
    if (index === -1) return { success: false };

    const parsed = lines[index].match(/^- \[([ x~])\] \*\*\[(.+?)\]\*\* (.+)$/);
    if (!parsed) return { success: false };

    const now = this._formatTimestamp();
    const { text, project, updatedAt } = this._stripIdeaSuffixes(parsed[3]);
    if (done) {
      lines[index] = this._buildIdeaLine('x', parsed[2], text, project, now, updatedAt, {
        includeProject: this._isGlobalInbox(filePath)
      });
    } else {
      lines[index] = this._buildIdeaLine(' ', parsed[2], text, project, null, now, {
        includeProject: this._isGlobalInbox(filePath)
      });
    }

    this._atomicWrite(filePath, lines.join('\n'));
    return { success: true };
  }

  togglePause(filePath, rawLine) {
    if (!fs.existsSync(filePath)) return { success: false };
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const index = this._findIdeaLine(lines, rawLine);
    if (index === -1) return { success: false };

    const parsed = lines[index].match(/^- \[([ x~])\] \*\*\[(.+?)\]\*\* (.+)$/);
    if (!parsed || parsed[1] === 'x') return { success: false };

    const nextMark = parsed[1] === '~' ? ' ' : '~';
    const { text, project, completedAt, updatedAt } = this._stripIdeaSuffixes(parsed[3]);
    lines[index] = this._buildIdeaLine(nextMark, parsed[2], text, project, completedAt, updatedAt, {
      includeProject: this._isGlobalInbox(filePath)
    });

    this._atomicWrite(filePath, lines.join('\n'));
    return { success: true };
  }

  editIdea(filePath, rawLine, newText) {
    if (!fs.existsSync(filePath)) return { success: false };
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const index = this._findIdeaLine(lines, rawLine);
    if (index === -1) return { success: false };

    const parsed = lines[index].match(/^- \[([ x~])\] \*\*\[(.+?)\]\*\* (.+)$/);
    if (!parsed) return { success: false };

    const stripped = this._stripIdeaSuffixes(parsed[3]);
    const { type } = this._extractType(stripped.text);
    const prefix = type ? `[${type}] ` : '';
    lines[index] = this._buildIdeaLine(
      parsed[1],
      parsed[2],
      prefix + newText,
      stripped.project,
      stripped.completedAt,
      this._formatTimestamp(),
      { includeProject: this._isGlobalInbox(filePath) }
    );

    this._atomicWrite(filePath, lines.join('\n'));
    return { success: true };
  }

  moveIdeaToProject(fromFilePath, rawLine, toFilePath, projectName) {
    if (!fs.existsSync(fromFilePath)) return { success: false };

    const sourceContent = fs.readFileSync(fromFilePath, 'utf-8').replace(/\r\n/g, '\n');
    const sourceLines = sourceContent.split('\n');
    const sourceIndex = this._findIdeaLine(sourceLines, rawLine);
    if (sourceIndex === -1) return { success: false };

    const idea = this._parseIdeaLine(sourceLines[sourceIndex], { filePath: fromFilePath });
    if (!idea) return { success: false };

    const now = this._formatTimestamp();
    const includeProject = this._isGlobalInbox(toFilePath);
    const project = includeProject ? projectName : null;
    const sameFile = path.resolve(fromFilePath) === path.resolve(toFilePath);
    const movedLine = this._buildIdeaLine(
      idea.done ? 'x' : idea.paused ? '~' : ' ',
      idea.date,
      this._textWithType(idea),
      project,
      idea.completedAt,
      now,
      { includeProject }
    );

    if (sameFile) {
      sourceLines[sourceIndex] = movedLine;
      this._atomicWrite(fromFilePath, sourceLines.join('\n'));
      return { success: true };
    }

    this._ensureFile(toFilePath);
    const destinationContent = fs.readFileSync(toFilePath, 'utf-8').replace(/\r\n/g, '\n');
    const destinationAfter = this._contentWithInsertedIdea(destinationContent, movedLine);
    const updatedSourceLines = sourceLines.filter((line, index) => index !== sourceIndex);

    this._commitMoveTransaction([
      { filePath: fromFilePath, before: sourceContent, after: updatedSourceLines.join('\n') },
      { filePath: toFilePath, before: destinationContent, after: destinationAfter }
    ]);
    return { success: true };
  }

  deleteIdea(filePath, rawLine) {
    if (!fs.existsSync(filePath)) return { success: false };
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const index = this._findIdeaLine(lines, rawLine);
    if (index === -1) return { success: false };

    lines.splice(index, 1);
    this._atomicWrite(filePath, lines.join('\n'));
    return { success: true };
  }
}

module.exports = IdeasManager;
