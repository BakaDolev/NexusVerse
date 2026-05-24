import { escapeHtml } from './utils.js';

export function showModal({ title, body, inputs, buttons }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const actionsEl = document.getElementById('modalActions');

    titleEl.textContent = title || '';
    bodyEl.innerHTML = (body ? `<p>${escapeHtml(body)}</p>` : '') +
      (inputs || []).map(inp => {
        if (inp.type === 'select') {
          return `<select class="modal-select" id="modalInput_${inp.id}">${inp.options.map(o =>
            `<option value="${escapeHtml(o.value)}" ${o.value === inp.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
          ).join('')}</select>`;
        }
        return `<input class="modal-input" id="modalInput_${inp.id}" type="${inp.type || 'text'}" placeholder="${escapeHtml(inp.placeholder || '')}" value="${escapeHtml(inp.value || '')}" />`;
      }).join('');

    actionsEl.innerHTML = (buttons || []).map(btn =>
      `<button class="modal-btn ${btn.class || 'modal-btn-cancel'}" data-modal-action="${escapeHtml(btn.action)}">${escapeHtml(btn.label)}</button>`
    ).join('');

    overlay.style.display = '';

    const cleanup = (result) => {
      overlay.style.display = 'none';
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const getInputValues = () => {
      const values = {};
      (inputs || []).forEach(inp => {
        const el = document.getElementById(`modalInput_${inp.id}`);
        if (el) values[inp.id] = el.value;
      });
      return values;
    };

    const onOverlayClick = (e) => {
      if (e.target === overlay) cleanup(null);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(null);
      if (e.key === 'Enter' && e.target.tagName !== 'SELECT') {
        const primaryBtn = buttons?.find(b => b.class === 'modal-btn-primary');
        if (primaryBtn) cleanup({ action: primaryBtn.action, values: getInputValues() });
      }
    };

    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);

    actionsEl.querySelectorAll('[data-modal-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        cleanup({ action: btn.dataset.modalAction, values: getInputValues() });
      });
    });

    const firstInput = bodyEl.querySelector('.modal-input');
    if (firstInput) { firstInput.focus(); firstInput.select(); }
  });
}

export async function showInputModal(title, placeholder, defaultValue) {
  const result = await showModal({
    title,
    inputs: [{ id: 'value', placeholder, value: defaultValue || '' }],
    buttons: [
      { label: 'Cancel', action: 'cancel', class: 'modal-btn-cancel' },
      { label: 'OK', action: 'ok', class: 'modal-btn-primary' }
    ]
  });
  if (!result || result.action !== 'ok') return null;
  return result.values.value.trim() || null;
}
