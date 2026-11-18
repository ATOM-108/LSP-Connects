// Small DOM/formatting helpers shared by every view.
// Views are plain HTML strings; behaviour is wired with data-* attributes so the
// app has no framework dependency and stays fast on low-end devices.

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

export const icon = (name) => `<span class="material-symbols-outlined">${esc(name)}</span>`;

export function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${formatDate(date)} · ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function formatTime(value) {
  if (!value) return '—';
  const raw = String(value);
  const match = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return raw;
  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatMoney(value, currency = 'USD') {
  if (value === null || value === undefined || value === '') return 'Rate on request';
  const amount = Number(value);
  if (Number.isNaN(amount)) return String(value);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'L';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function statusBadge(status) {
  const raw = String(status || 'pending').toLowerCase().replace(/\s+/g, '_');
  const label = raw.replace(/_/g, ' ');
  return `<span class="badge ${esc(raw)}">${esc(label)}</span>`;
}

export function alertBox(type, message) {
  if (!message) return '';
  const iconName = type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'check_circle';
  return `<div class="alert ${esc(type)}">${icon(iconName)}<div>${esc(message)}</div></div>`;
}

export function emptyState({ icon: iconName = 'inbox', title, message, action = '' }) {
  return `<div class="empty">${icon(iconName)}<h3>${esc(title)}</h3>${
    message ? `<p>${esc(message)}</p>` : ''
  }${action}</div>`;
}

export function skeletonRows(count = 3) {
  return `<div class="stack">${Array.from({ length: count })
    .map(
      () =>
        `<div class="card"><div class="skeleton" style="width:42%;margin-bottom:10px"></div><div class="skeleton" style="width:72%;margin-bottom:8px"></div><div class="skeleton" style="width:30%"></div></div>`,
    )
    .join('')}</div>`;
}

/* ------------------------------------------------------------------- toasts */

function toastStack() {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message, type = 'success', timeout = 4200) {
  const stack = toastStack();
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `${icon(type === 'error' ? 'error' : 'check_circle')}<div>${esc(message)}</div>`;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/* ------------------------------------------------------------------ dialogs */

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  withReason = false,
  reasonLabel = 'Reason',
}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        <p class="muted">${esc(message)}</p>
        ${
          withReason
            ? `<div class="field"><label for="modal-reason">${esc(reasonLabel)}</label>
                 <textarea class="input" id="modal-reason" placeholder="Tell the customer why"></textarea></div>`
            : ''
        }
        <div class="btn-row" style="justify-content:flex-end;margin-top:18px">
          <button class="btn ghost" data-modal="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-modal="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    const reasonField = backdrop.querySelector('#modal-reason');
    const close = (value) => {
      const reason = reasonField ? reasonField.value.trim() : '';
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value === true ? { reason } : false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
      const action = event.target.closest('[data-modal]')?.dataset.modal;
      if (action === 'ok') close(true);
      if (action === 'cancel') close(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    (reasonField || backdrop.querySelector('[data-modal="ok"]'))?.focus();
  });
}

/* ---------------------------------------------------------------- busy state */

export function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

export function on(root, eventName, selector, handler) {
  root.addEventListener(eventName, (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}
