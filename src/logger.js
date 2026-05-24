const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY_PATTERN = /(content|body|raw|text|secret|token|password|key)/i;

class AppLogger {
  constructor({ logDir, level = 'info', maxBytes = 2 * 1024 * 1024, maxFiles = 5 } = {}) {
    if (!logDir) throw new Error('logDir is required');
    this.logDir = logDir;
    this.logPath = path.join(logDir, 'nexusverse.log');
    this.level = LEVELS[level] ? level : 'info';
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.originalConsole = null;

    fs.mkdirSync(this.logDir, { recursive: true });
    this._rotateIfNeeded();
    this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
  }

  debug(scope, message, meta) { this.log('debug', scope, message, meta); }
  info(scope, message, meta) { this.log('info', scope, message, meta); }
  warn(scope, message, meta) { this.log('warn', scope, message, meta); }
  error(scope, message, meta) { this.log('error', scope, message, meta); }

  log(level, scope, message, meta = undefined) {
    if ((LEVELS[level] || LEVELS.info) < LEVELS[this.level]) return;

    const record = {
      ts: new Date().toISOString(),
      level,
      scope: this._safeString(scope || 'app', 120),
      message: this._safeString(message, 2000)
    };
    if (meta !== undefined) record.meta = this._sanitizeMeta(meta);

    try {
      this.stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging must never break the app.
    }
  }

  installConsoleCapture() {
    if (this.originalConsole) return;
    this.originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };

    console.log = (...args) => {
      this.info('console', this._formatConsoleArgs(args));
      this.originalConsole.log(...args);
    };
    console.warn = (...args) => {
      this.warn('console', this._formatConsoleArgs(args));
      this.originalConsole.warn(...args);
    };
    console.error = (...args) => {
      this.error('console', this._formatConsoleArgs(args));
      this.originalConsole.error(...args);
    };
  }

  close() {
    try {
      this.stream.end();
    } catch {
      // Best effort on app shutdown.
    }
  }

  _rotateIfNeeded() {
    try {
      const stat = fs.existsSync(this.logPath) ? fs.statSync(this.logPath) : null;
      if (!stat || stat.size < this.maxBytes) return;

      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.logPath}.${i}`;
        const to = `${this.logPath}.${i + 1}`;
        if (fs.existsSync(to)) fs.unlinkSync(to);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      // Rotation failures should not prevent startup.
    }
  }

  _formatConsoleArgs(args) {
    return util.format(...args);
  }

  _sanitizeMeta(value, depth = 0) {
    if (depth > 4) return '[max-depth]';
    if (value == null) return value;
    if (typeof value === 'string') return this._safeString(value, 1000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this._safeString(value.message, 1000),
        stack: this._safeString(value.stack, 2000)
      };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map(item => this._sanitizeMeta(item, depth + 1));
    }
    if (typeof value === 'object') {
      const output = {};
      for (const [key, nested] of Object.entries(value).slice(0, 40)) {
        output[key] = SENSITIVE_KEY_PATTERN.test(key)
          ? '[redacted]'
          : this._sanitizeMeta(nested, depth + 1);
      }
      return output;
    }
    return this._safeString(value, 1000);
  }

  _safeString(value, maxLength) {
    const str = String(value ?? '');
    return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
  }
}

module.exports = { AppLogger };
