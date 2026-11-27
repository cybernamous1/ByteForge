// Small UI helpers: toasts and promise-based dialogs (replaces alert/confirm/prompt).
const $ = id => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(title, message = '', { level = 'info', action = null, ttl = 9000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (level === 'info' ? '' : ' ' + level);
  const b = document.createElement('b'); b.textContent = title; el.append(b);
  if (message) { const p = document.createElement('p'); p.textContent = message; el.append(p); }
  if (action) { const btn = document.createElement('button'); btn.textContent = action.label; btn.onclick = () => { action.run(); el.remove(); }; el.append(btn); }
  $('toastStack').append(el);
  if (ttl) setTimeout(() => el.remove(), ttl);
  return el;
}

let current = null;
export function closeDialog(value = null) { current?.(value); }

/**
 * Open a modal dialog. Resolves with the clicked action's value (or null when dismissed).
 * action.value may be a function(bodyElement); action.validate(body) may return an error string to keep the dialog open.
 */
export function dialog({ title, html = '', node = null, actions = [{ label: 'OK', primary: true, value: true }] }) {
  closeDialog(null);
  return new Promise(resolve => {
    const modal = $('modal'), body = $('modalBody'), foot = $('modalActions');
    $('modalTitle').textContent = title;
    body.innerHTML = '';
    if (node) body.append(node); else body.innerHTML = html;
    foot.innerHTML = '';
    const previouslyFocused = document.activeElement;
    const done = value => {
      current = null;
      modal.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      $('modalClose').onclick = null; modal.onmousedown = null;
      if (previouslyFocused?.focus) previouslyFocused.focus();
      resolve(value);
    };
    const err = document.createElement('p'); err.className = 'muted'; err.style.color = 'var(--danger)'; err.setAttribute('role', 'alert');
    const submit = a => {
      const problem = a.validate?.(body);
      if (problem) { err.textContent = problem; body.append(err); return; }
      done(typeof a.value === 'function' ? a.value(body) : (a.value ?? null));
    };
    const primary = actions.find(a => a.primary);
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label; if (a.primary) b.className = 'primary'; if (a.danger) b.classList.add('danger');
      b.onclick = () => submit(a);
      foot.append(b);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && primary && e.target.tagName === 'INPUT' && e.target.type === 'text' && !e.target.dataset.noSubmit) { e.preventDefault(); submit(primary); }
      else if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...modal.querySelectorAll('button, input, select, textarea, a[href]')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    $('modalClose').onclick = () => done(null);
    modal.onmousedown = e => { if (e.target === modal) done(null); };
    current = done;
    modal.classList.remove('hidden');
    (body.querySelector('input, select, textarea') || foot.querySelector('.primary') || foot.querySelector('button') || $('modalClose')).focus();
  });
}

export async function askInput(title, label, value = '', { placeholder = '' } = {}) {
  const wrap = document.createElement('div');
  const l = document.createElement('label'); l.textContent = label; l.style.display = 'block'; l.style.marginBottom = '6px';
  const input = document.createElement('input'); input.type = 'text'; input.value = value; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false;
  wrap.append(l, input);
  const r = await dialog({ title, node: wrap, actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: b => b.querySelector('input').value }] });
  return r === null ? null : r.trim();
}

export async function confirmDialog(title, html, { confirmLabel = 'Continue', danger = false } = {}) {
  const r = await dialog({ title, html, actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, primary: true, danger, value: true }] });
  return r === true;
}
