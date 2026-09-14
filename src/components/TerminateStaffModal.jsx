import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Check, Download, Loader2, Trash2, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';

/** The small dialog shell Manage Staff uses, so this looks the same wherever it opens. */
function Modal({ title, onClose, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 rounded p-1 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Terminate Staff — the irreversible one.
 *
 * Erases a person from Ratio: their sign-in, their profile, and every
 * document that belongs to them (shifts, availability, time off, chat they
 * wrote, notification preferences, availability and audit log entries).
 *
 * Two guards, because this cannot be undone:
 *
 *   1. It downloads a full JSON record of everything about to be deleted
 *      BEFORE deleting any of it. Payroll records have to be kept for four
 *      years in BC; erasing 100+ shifts with no copy would break that.
 *      The download is not optional and not a checkbox.
 *
 *   2. It requires typing the person's full name. A confirm dialog is one
 *      misplaced click; a name is not something you type by accident.
 *
 * Opened from Manage Staff, and from Manage Roles for accounts Manage Staff
 * deliberately hides (owners, internal accounts, the shared "Admin Team"
 * login). The server — api/users/reject-user.js — decides who may.
 */
export default function TerminateStaffModal({ user, onClose, onDone }) {
  const { user: authUser } = useAuth();
  const [loading, setLoading]   = useState(true);
  const [working, setWorking]   = useState(false);
  const [error, setError]       = useState(null);
  const [preview, setPreview]   = useState(null);
  const [typed, setTyped]       = useState('');
  const [exported, setExported] = useState(false);

  const fullName = (user?.displayName || '').trim();
  // Forgiving on case and inner spacing — this is a confirmation, not a
  // spelling test. It still can't be satisfied by a stray click.
  const norm = (v) => v.trim().toLowerCase().replace(/\s+/g, ' ');
  const nameMatches = fullName.length > 0 && norm(typed) === norm(fullName);

  const call = async (mode) => {
    const idToken = authUser ? await authUser.getIdToken() : null;
    if (!idToken) throw new Error('Not signed in.');
    const r = await fetch('/api/users/reject-user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: user.uid, mode }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) throw new Error(data?.error || `Failed (${r.status}).`);
    return data;
  };

  // Count what's there as soon as the modal opens, so the number in front
  // of you is the real one rather than a guess.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await call('preview');
        if (alive) { setPreview(data); setLoading(false); }
      } catch (err) {
        if (alive) { setError(err.message); setLoading(false); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  const downloadRecord = () => {
    const blob = new Blob([JSON.stringify(preview.export, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ratio-termination-${fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${format(new Date(), 'yyyy-MM-dd')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExported(true);
  };

  const terminate = async () => {
    setWorking(true);
    setError(null);
    try {
      const data = await call('terminate');
      if (data.warning) toast.error(data.warning, 9000);
      else toast.success(`${fullName} has been terminated and removed from Ratio.`);
      onDone();
    } catch (err) {
      setError(err.message);
      setWorking(false);
    }
  };

  const rows = Object.entries(preview?.counts || {});
  const LABELS = {
    shifts: 'Shifts', availability: 'Availability', openShifts: 'Open shifts',
    timeOffRequests: 'Time-off requests', chat: 'Chat messages they wrote',
    availabilityLog: 'Availability log entries', notificationPreferences: 'Notification preferences',
    auditLog: 'Audit log entries',
  };

  return (
    <Modal title={`Terminate ${fullName || 'staff member'}`} onClose={working ? () => {} : onClose}>
      <div className="space-y-3">
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-900">
          <b>This cannot be undone.</b> It deletes their sign-in and every record of them in Ratio.
          They will not be able to log in, and they will disappear from the schedule, availability,
          payroll and every other screen.
        </p>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 size={15} className="animate-spin" /> Counting what would be deleted…
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{error}</p>
        )}

        {preview && (
          <>
            <div className="rounded-xl border bg-gray-50 px-3 py-2.5">
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                What will be deleted — {preview.total} document{preview.total === 1 ? '' : 's'}
              </p>
              {rows.length === 0 ? (
                <p className="text-xs text-gray-500">No records beyond their profile and sign-in.</p>
              ) : (
                <ul className="space-y-0.5">
                  {rows.map(([k, n]) => (
                    <li key={k} className="flex justify-between text-xs text-gray-700">
                      <span>{LABELS[k] || k}</span>
                      <span className="font-mono font-semibold">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 border-t pt-2 text-xs text-gray-500">
                Plus their profile and their Firebase sign-in account.
              </p>
            </div>

            {/* Step 1 — the record leaves the building first. */}
            <button
              onClick={downloadRecord}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                exported
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50'
              }`}
            >
              {exported ? <Check size={15} /> : <Download size={15} />}
              {exported ? 'Record downloaded' : '1. Download their record first'}
            </button>
            <p className="text-xs text-gray-500">
              A JSON file with every shift, date and hour. Payroll records have to be kept for four
              years, so keep this somewhere safe before continuing.
            </p>

            {/* Step 2 — type the name. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                2. Type <b>{fullName}</b> to confirm
              </label>
              <input
                type="text"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder={fullName}
                autoComplete="off"
                disabled={working}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none disabled:bg-gray-50"
              />
            </div>

            <button
              onClick={terminate}
              disabled={!exported || !nameMatches || working}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-40"
            >
              {working ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              {working ? 'Terminating…' : `Terminate ${fullName}`}
            </button>
            {!exported && (
              <p className="text-center text-xs text-gray-400">Download the record to continue.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
