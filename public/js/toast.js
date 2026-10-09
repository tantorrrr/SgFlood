const DURATION_MS = 4000;

// action = { label, onClick } adds a button and keeps the toast up longer.
export function toast(message, kind = 'info', action = null) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.remove(); action.onClick(); });
    el.append(' ', btn);
  }
  box.append(el);
  setTimeout(() => el.remove(), action ? 4 * DURATION_MS : DURATION_MS);
}
