import { state } from './state.js';
import { escapeHtml } from './utils.js';

let _scheduleProjectMetaAutosave;

export function initTags({ scheduleProjectMetaAutosave }) {
  _scheduleProjectMetaAutosave = scheduleProjectMetaAutosave;
}

export function getTagKey(tag) {
  return String(tag || '').trim().toLowerCase();
}

export function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const seen = new Set();
  const normalized = [];
  for (const tag of values) {
    const value = String(tag || '').trim().replace(/\s+/g, ' ');
    const key = getTagKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export function getAllTags() {
  const allTags = state.allProjects.flatMap(project => project.tags || []);
  return normalizeTags(allTags).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function getCurrentTags() {
  const tagList = document.getElementById('tagList');
  if (!tagList) return [];
  return normalizeTags([...tagList.querySelectorAll('.tag-pill')].map(pill => pill.dataset.tag));
}

export function addTagPill(tagValue) {
  const tagList = document.getElementById('tagList');
  const addBtn = document.getElementById('btnAddTag');
  if (!tagList || !addBtn) return false;

  const tags = getCurrentTags();
  const key = getTagKey(tagValue);
  if (!key || tags.some(tag => getTagKey(tag) === key)) {
    syncTagsHidden();
    return false;
  }

  const value = String(tagValue).trim().replace(/\s+/g, ' ');
  const pill = document.createElement('span');
  pill.className = 'tag-pill';
  pill.dataset.tag = value;
  pill.innerHTML = `${escapeHtml(value)} <span class="tag-remove" data-action="remove-tag" data-tag="${escapeHtml(value)}">&times;</span>`;
  tagList.insertBefore(pill, addBtn);
  syncTagsHidden();
  if (_scheduleProjectMetaAutosave) _scheduleProjectMetaAutosave(150);
  return true;
}

export function renderTagSuggestions(query, input) {
  const suggestions = document.getElementById('tagSuggestions');
  if (!suggestions) return;

  const currentKeys = new Set(getCurrentTags().map(getTagKey));
  const q = getTagKey(query);
  const matches = getAllTags()
    .filter(tag => !currentKeys.has(getTagKey(tag)))
    .filter(tag => !q || getTagKey(tag).includes(q))
    .slice(0, 12);

  if (matches.length === 0) {
    suggestions.style.display = 'none';
    suggestions.innerHTML = '';
    return;
  }

  suggestions.innerHTML = matches.map(tag => {
    const usage = state.allProjects.filter(project => normalizeTags(project.tags || []).some(t => getTagKey(t) === getTagKey(tag))).length;
    return `<button class="tag-suggestion" type="button" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span>${usage}</span></button>`;
  }).join('');
  suggestions.style.display = 'flex';

  suggestions.querySelectorAll('.tag-suggestion').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      addTagPill(button.dataset.tag || '');
      try { if (input.parentNode) input.remove(); } catch {}
      hideTagSuggestions();
    });
  });
}

export function hideTagSuggestions() {
  const suggestions = document.getElementById('tagSuggestions');
  if (!suggestions) return;
  suggestions.style.display = 'none';
  suggestions.innerHTML = '';
}

export function removeTag(tagValue) {
  const tagList = document.getElementById('tagList');
  if (!tagList) return;
  const pill = tagList.querySelector(`.tag-pill[data-tag="${CSS.escape(tagValue)}"]`);
  if (pill) pill.remove();
  syncTagsHidden();
  if (_scheduleProjectMetaAutosave) _scheduleProjectMetaAutosave(150);
}

export function syncTagsHidden() {
  const tagList = document.getElementById('tagList');
  const hidden = document.getElementById('editTags');
  if (!tagList || !hidden) return;
  const tags = normalizeTags([...tagList.querySelectorAll('.tag-pill')].map(p => p.dataset.tag));
  hidden.value = tags.join(', ');
}
