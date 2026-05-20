import { useEffect, useState, useRef } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, AlertOctagon } from 'lucide-react';
import { subscribe, dismissToast, _resolveConfirm } from '../lib/notify';

/**
 * Single-instance UI host for toasts and the confirm dialog. Mount once
 * near the app root and forget about it — every page can call
 * toast.success / confirmDialog from `src/lib/notify.js`.
 *
 * No portals or refs to document.body — Tailwind's fixed positioning is
 * enough, and keeping the markup inside React's tree means it inherits
 * the app's theming and doesn't fight z-index with the rest of the UI.
 */
export default function NotifyHost() {
  const [{ toasts, confirmRequest }, setSnapshot] = useState({ toasts: [], confirmRequest: null });

  useEffect(() => subscribe(setSnapshot), []);

  return (
    <>
      {/* Toast stack — top-right on desktop, top on mobile. Stacks newest at the bottom. */}
      <div
        className="pointer-events-none fixed inset-x-0 top-4 z-[9999] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map(t => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
        ))}
      </div>

      {/* Confirm dialog — only one at a time. */}
      {confirmRequest && (
        <ConfirmModal req={confirmRequest} />
      )}
    </>
  );
}

const KIND_STYLES = {
  success: { bg: 'bg-emerald-600', icon: CheckCircle2, ring: 'ring-emerald-200' },
  error:   { bg: 'bg-rose-600',    icon: AlertOctagon, ring: 'ring-rose-200' },
  info:    { bg: 'bg-gray-800',    icon: Info,         ring: 'ring-gray-200' },
};

function ToastCard({ toast, onDismiss }) {
  const style = KIND_STYLES[toast.kind] || KIND_STYLES.info;
  const Icon = style.icon;
  return (
    <div
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ring-1 ring-black/5 ${style.bg}`}
      role="status"
    >
      <Icon size={18} className="mt-0.5 shrink-0" />
      <div className="flex-1 leading-snug whitespace-pre-line">{toast.message}</div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded-md p-0.5 text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ConfirmModal({ req }) {
  const [typed, setTyped] = useState('');
  const cancelRef = useRef(null);

  // Auto-focus the safer choice (Cancel) on open so an accidental Enter
  // press doesn't immediately confirm a destructive action.
  useEffect(() => { cancelRef.current?.focus(); }, []);

  // Esc cancels; Enter confirms only when not gated by requireText.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _resolveConfirm(false); }
      else if (e.key === 'Enter') {
        if (!req.requireText || typed === req.requireText) {
          e.preventDefault();
          _resolveConfirm(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req.requireText, typed]);

  const gated = !!req.requireText && typed !== req.requireText;
  const confirmDisabled = gated;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) _resolveConfirm(false); }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          {req.danger && (
            <div className="shrink-0 rounded-full bg-rose-100 p-2 text-rose-600">
              <AlertTriangle size={20} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-gray-900">{req.title}</h2>
            {req.message && (
              <p className="mt-1 text-sm text-gray-600 whitespace-pre-line">{req.message}</p>
            )}
            {req.requireText && (
              <div className="mt-3">
                <label className="mb-1 block text-xs font-medium text-gray-500">
                  Type <code className="rounded bg-gray-100 px-1 font-mono text-gray-700">{req.requireText}</code> to confirm
                </label>
                <input
                  type="text"
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
                />
              </div>
            )}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={() => _resolveConfirm(false)}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {req.cancelText}
          </button>
          <button
            onClick={() => _resolveConfirm(true)}
            disabled={confirmDisabled}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              req.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {req.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
