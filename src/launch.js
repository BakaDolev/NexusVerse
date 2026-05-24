import { showToast } from './utils.js';

export async function launchClaude(projectPath) {
  const result = await window.nexus.openInClaudeCode(projectPath);
  if (result.error) showToast('Failed: ' + result.error);
  else showToast('Opening Claude Code...');
}

export async function launchVSCode(projectPath) {
  const result = await window.nexus.openInVSCode(projectPath);
  if (result.error) showToast('Failed: ' + result.error);
  else showToast('Opening VS Code...');
}

export async function launchTerminal(projectPath) {
  const result = await window.nexus.openInTerminal(projectPath);
  if (result.error) showToast('Failed: ' + result.error);
  else showToast('Opening terminal...');
}

export async function openFolder(projectPath) {
  const result = await window.nexus.openFolder(projectPath);
  if (result.error) showToast('Failed: ' + result.error);
  else showToast('Opening folder...');
}
