# NexusVerse

A desktop app for developers juggling multiple projects. Scans your project directories, reads metadata from markdown files, and gives you a single dashboard to track status, capture ideas, and launch your tools.

Built with Electron for Windows. No database — everything is stored in markdown files inside your projects.

## Features

- **Dashboard** — sortable, filterable table of all your projects with status, priority, category, git branch, and next step
- **Project Detail** — edit metadata with inline pill selectors, manage tags, view/edit your PROJECT_PLAN.md
- **Brainstorm Inbox** — capture ideas globally or per-project, with tabs (All Open / By Project / Completed), filters, search, and type flagging (bug, feature, improvement, task, question, idea)
- **Scratchpad** — per-project freeform notes for error logs, commands, JSON, URLs
- **Live Updates** — file watcher auto-refreshes the dashboard when project files change
- **Quick Launch** — open any project in Claude Code, VS Code, terminal, or file explorer
- **Command Palette** — Ctrl+K to fuzzy-find and jump to any project
- **Right-Click Context Menu** — quick-change status, priority, category from the dashboard
- **Git Indicators** — see uncommitted changes and unpushed commits at a glance
- **Dependency Linking** — define project dependencies in frontmatter, shown as clickable pills
- **Backfill Tool** — batch-add frontmatter metadata to projects that don't have it yet
- **Category Management** — create, rename, recolor, delete categories with automatic project reassignment

## How It Works

NexusVerse scans configurable root directories for projects. A project is detected by the presence of `PROJECT_PLAN.md`, `CLAUDE.md`, or 2+ technical signals (`.git`, `package.json`, `Dockerfile`, etc.).

Project metadata is stored as YAML frontmatter in each project's `PROJECT_PLAN.md`:

```yaml
---
status: active
priority: high
category: main
tags: [electron, dashboard]
next: "Add search filtering"
---
```

User data (config, global brainstorms, logs) lives in `%APPDATA%\NexusVerse\` and survives app updates.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ (chokidar 5 requires `>=20.19.0`)
- npm

### Install and Run

```bash
git clone https://github.com/BakaDolev/NexusVerse.git
cd NexusVerse
npm install
npm start
```

On first launch, go to **Settings** and add your project root directories.

### Build

```bash
# Unpacked app folder (for development)
npm run build

# Windows installer
npm run build:installer
```

## Tech Stack

- **Electron 42** — desktop app framework
- **Vanilla JS** — no frontend framework, ES modules
- **gray-matter** — YAML frontmatter parsing
- **chokidar** — file system watching
- **electron-builder** — packaging and installers

## Security

- `contextIsolation: true`, `nodeIntegration: false`
- All file access goes through IPC with path validation and symlink resolution
- No shell execution for launch commands
- CSP locks scripts to `'self'`

## License

[MIT](LICENSE)
