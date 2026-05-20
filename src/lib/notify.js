/**
 * In-house notification API — replaces the native window.alert /
 * window.confirm calls that used to litter the codebase.
 *
 * Designed as a module-level event emitter so any code path (inside or
 * outside React) can call:
 *
 *     toast.success('Schedule posted!')
 *     toast.error('Something went wrong.')
 *     toast.info('Hint goes here.')
 *
 *     const ok = await confirmDialog({
 *       title: 'Delete this announcement?',
 *       message: 'This action cannot be undone.',
 *       confirmText: 'Delete',
 *       danger: true,
 *     });
 *     if (!ok) return;
 *
 * Rendering is handled by a single <NotifyHost /> component mounted near
 * the app root — it subscribes to the emitter and renders the toast
 * stack + confirm modal. There is exactly one host for the whole app, so
 * we don't need a React Context.
 *
 * The destructive variant supports `requireText` — the confirm button
 * stays disabled until the user types the matching word (e.g. "DELETE").
 * Use it for irreversible actions like "delete every shift in Firestore".
 */

let nextId = 1;
const listeners = new Set();
const state = {
  toasts: [],          // [{ id, kind, message }]
  confirmRequest: null, // { title, message, confirmText, cancelText, danger, requireText, resolve }
};

function snapshot() {
  return { toasts: [...state.toasts], confirmRequest: state.confirmRequest };
}

function emit() {
  for (const l of listeners) l(snapshot());
}

/** NotifyHost calls this on mount; returns the unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot()); // prime with current state
  return () => listeners.delete(fn);
}

const DEFAULT_DURATIONS = {
  success: 3500,
  info:    4000,
  error:   5500, // errors linger longer so users can read them
};

function pushToast(kind, message, durationMs) {
  if (!message) return;
  const id = nextId++;
  const ms = durationMs ?? DEFAULT_DURATIONS[kind] ?? 4000;
  state.toasts = [...state.toasts, { id, kind, message: String(message) }];
  emit();
  setTimeout(() => {
    state.toasts = state.toasts.filter(t => t.id !== id);
    emit();
  }, ms);
  return id;
}

/** Manually dismiss a toast (used by the close button). */
export function dismissToast(id) {
  state.toasts = state.toasts.filter(t => t.id !== id);
  emit();
}

export const toast = {
  success: (m, ms) => pushToast('success', m, ms),
  error:   (m, ms) => pushToast('error',   m, ms),
  info:    (m, ms) => pushToast('info',    m, ms),
};

/**
 * Opens a confirm dialog. Returns a Promise that resolves to true if the
 * user confirms, false if they cancel or dismiss. Only one confirm is
 * active at a time — calling again while one is open will replace the
 * pending one (rare in practice; ours are all on user click).
 */
export function confirmDialog({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  requireText = null, // e.g. 'DELETE' — user must type this to enable confirm
} = {}) {
  return new Promise(resolve => {
    // If a previous prompt was somehow still open, resolve it false so its
    // caller doesn't hang.
    if (state.confirmRequest) {
      try { state.confirmRequest.resolve(false); } catch { /* ignore */ }
    }
    state.confirmRequest = {
      title:       title || 'Are you sure?',
      message:     message || '',
      confirmText, cancelText, danger, requireText,
      resolve,
    };
    emit();
  });
}

/** Internal — called by NotifyHost to resolve the active confirm. */
export function _resolveConfirm(value) {
  const req = state.confirmRequest;
  if (!req) return;
  state.confirmRequest = null;
  emit();
  try { req.resolve(Boolean(value)); } catch { /* ignore */ }
}
