export function safeJsonParse(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function safeJsonParseArray(key, fallback = []) {
  const value = safeJsonParse(key, fallback);
  return Array.isArray(value) ? value : fallback;
}

export function escapeHtml(value) {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

export function timeAgo(timestamp) {
  if (!timestamp) return '—';
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (weeks === 1) return '1 week ago';
  if (weeks < 5) return `${weeks} weeks ago`;
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

export function formatDate(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate + 'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
}

export function formatIdeaDate(dateText) {
  if (!dateText) return '';
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}))?/);
  if (!match) return String(dateText);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const formattedDate = `${parseInt(match[3], 10)} ${months[Number(match[2]) - 1]}, ${match[1]}`;
  return match[4] ? `${formattedDate} ${match[4]}` : formattedDate;
}

export function formatIdeaStatusDate(idea) {
  if (idea.done && idea.completedAt) return `completed ${formatIdeaDate(idea.completedAt)}`;
  if (idea.paused) return `paused - ${formatIdeaDate(idea.date)}`;
  return formatIdeaDate(idea.date);
}

export function colorWithAlpha(color, alpha = 0.16) {
  const value = String(color || '').trim();
  const clamped = Math.max(0, Math.min(1, alpha));
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map(ch => ch + ch).join('')
      : hex[1];
    const int = parseInt(raw, 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${clamped})`;
  return `color-mix(in srgb, ${value || 'var(--accent)'} ${Math.round(clamped * 100)}%, transparent)`;
}

export function syncDateTextInput(id, isoValue) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = isoToDayFirst(isoValue);
}

export function isoToDayFirst(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export function dayFirstToIso(text) {
  const m = String(text || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

export function normalizeDateText(value) {
  const digits = String(value || '').replace(/[^\d]/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
