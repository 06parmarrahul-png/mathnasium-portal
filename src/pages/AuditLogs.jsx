import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Shield, ShieldAlert } from 'lucide-react';

/**
 * Audit Logs page. Read-only viewer for the `auditLog` collection —
 * a tamper-evident record of every sensitive platform-operator action
 * (centre switch, centre creation, billing edit, marked-paid).
 *
 * Super-admin only. The Firestore rules enforce this on the read side
 * too: even if someone routed here directly, the listener would error
 * out rather than expose data to a non-super-admin.
 */
export default function AuditLogs() {
  const { isSuperAdmin } = useAuth();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Non-super-admins fall through to the unauthorized screen below
    // before `loading` ever matters, so we leave it true and just skip
    // setting up the listener.
    if (!isSuperAdmin) return;
    return onSnapshot(
      query(collection(db, 'auditLog'), orderBy('createdAt', 'desc'), limit(200)),
      (snap) => {
        setEntries(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [isSuperAdmin]);

  if (!isSuperAdmin) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Audit Logs are visible to the platform operator only.</p>
      </div>
    );
  }

  // Pretty-print known action codes. Anything we don't recognise falls
  // through as the raw code so we don't silently swallow new actions.
  const describe = (e) => {
    const c = e.centerId ? ` · ${e.centerId}` : '';
    switch (e.action) {
      case 'super_admin.center_switch':
        return `Switched into centre${c}` + (e.details?.fromCenterId ? ` (from ${e.details.fromCenterId})` : '');
      case 'super_admin.center_create':
        return `Created new centre${c}` + (e.details?.name ? ` (${e.details.name})` : '');
      case 'super_admin.billing_update': {
        const keys = Object.keys(e.details?.changed || {});
        return `Updated billing${c}` + (keys.length ? ` — ${keys.join(', ')}` : '');
      }
      case 'super_admin.billing_mark_paid':
        return `Marked paid${c}` + (e.details?.amount ? ` ($${e.details.amount})` : '');
      default:
        return e.action + c;
    }
  };

  const fmt = (ts) => {
    if (!ts?.seconds) return '';
    return new Date(ts.seconds * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-purple-100 p-2 text-purple-600"><Shield size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Audit Logs</h1>
          <p className="text-sm text-gray-500">Tamper-evident record of platform-operator actions across every centre.</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <p className="text-sm text-gray-500 mb-4">
          Append-only by design — entries can be created but never edited or deleted.
          Showing the {entries.length > 0 ? `${entries.length} most recent` : '200 most recent'} entries.
        </p>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12">
            <Shield size={28} className="mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-400 italic">
              No activity yet — actions will appear here as they happen.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {entries.map(e => (
              <li key={e.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-800 leading-snug">{describe(e)}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    <span className="font-medium text-gray-500">{e.actorName || e.actorUid}</span>
                    {e.actorRole ? ` · ${e.actorRole}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-gray-400 whitespace-nowrap">{fmt(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
