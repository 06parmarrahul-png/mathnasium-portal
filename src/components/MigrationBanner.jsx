import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, setDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { DEFAULT_CENTER_ID } from '../lib/centers';
import { LANGLEY_DEFAULT_CONFIG } from '../lib/centerConfig';

/**
 * Detects whether the multi-center migration has been run yet, and if not,
 * shows a giant banner across the app forcing the owner to run it.
 *
 * Detection: the existence of `centers/{activeCenterId}` doc. The migration
 * creates that doc. If it doesn't exist, queries that filter by centerId
 * will silently return nothing — the banner makes that fail loudly instead.
 *
 * Only owners can dismiss / run the migration. Instructors see a friendly
 * "Tell your owner the portal needs setup" message.
 */
export default function MigrationBanner() {
  const { profile, activeCenterId } = useAuth();
  const [needsMigration, setNeedsMigration] = useState(null); // null=loading, true/false=known
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  // Check on mount — and re-check after a successful run
  useEffect(() => {
    if (!profile || !activeCenterId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'centers', activeCenterId));
        if (!cancelled) setNeedsMigration(!snap.exists());
      } catch {
        if (!cancelled) setNeedsMigration(true); // assume yes on error
      }
    })();
    return () => { cancelled = true; };
  }, [profile, activeCenterId]);

  if (!profile || !activeCenterId) return null;
  if (needsMigration === null) return null; // checking — render nothing
  if (needsMigration === false) return null; // already done — get out of the way

  const isOwner = profile.role === 'owner';

  const runMigration = async () => {
    setRunning(true);
    setError('');
    try {
      const tally = { center: 0, config: 0, users: 0, shifts: 0, availability: 0, openShifts: 0, timeOffRequests: 0, chat: 0, announcements: 0, notificationPreferences: 0 };

      // 1. Center identity doc
      const centerRef = doc(db, 'centers', DEFAULT_CENTER_ID);
      const centerSnap = await getDoc(centerRef);
      if (!centerSnap.exists()) {
        await setDoc(centerRef, {
          id: DEFAULT_CENTER_ID,
          name: 'Mathnasium Langley',
          city: 'Langley',
          province: 'BC',
          country: 'Canada',
          timezone: 'America/Vancouver',
          createdAt: serverTimestamp(),
        });
        tally.center = 1;
      }

      // 2. Center config doc
      const configRef = doc(db, 'centers', DEFAULT_CENTER_ID, 'config', 'main');
      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        await setDoc(configRef, {
          ...LANGLEY_DEFAULT_CONFIG,
          createdAt: serverTimestamp(),
        });
        tally.config = 1;
      }

      // 3. Backfill every collection with centerId='langley' on any doc that's missing it
      const cols = ['users', 'shifts', 'availability', 'openShifts', 'timeOffRequests', 'chat', 'announcements', 'notificationPreferences'];
      for (const colName of cols) {
        const allDocs = await getDocs(collection(db, colName));
        const toUpdate = allDocs.docs.filter(d => !d.data().centerId);
        const CHUNK = 450;
        for (let i = 0; i < toUpdate.length; i += CHUNK) {
          const b = writeBatch(db);
          for (const d of toUpdate.slice(i, i + CHUNK)) {
            const updates = { centerId: DEFAULT_CENTER_ID };
            if (colName === 'users' && !Array.isArray(d.data().centerIds)) {
              updates.centerIds = [DEFAULT_CENTER_ID];
            }
            b.update(d.ref, updates);
          }
          await b.commit();
        }
        tally[colName] = toUpdate.length;
      }

      setStats(tally);
      // Re-check the gate so the banner disappears.
      setNeedsMigration(false);
    } catch (err) {
      setError(err?.message || 'Migration failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-4 flex items-start gap-3">
          <ShieldAlert size={22} className="text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-base font-bold text-amber-900">Multi-Center Setup Required</h2>
            <p className="text-xs text-amber-700 mt-0.5">
              The portal has been upgraded to support multiple Mathnasium centers, but your existing data hasn't been tagged yet.
            </p>
          </div>
        </div>

        <div className="p-6 space-y-3">
          <p className="text-sm text-gray-700">
            Until this one-time migration runs, every page in the portal will appear empty (because all queries now filter by center, and no docs are tagged). It's safe to run, idempotent, and finishes in seconds.
          </p>

          {!isOwner ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <p className="font-semibold mb-0.5">Tell your center owner.</p>
              <p>Only the owner can run the migration. Once it's done, you'll have full access. Refresh this page after they finish.</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Click the button below. It'll create the Langley center record, seed your scheduler config, and stamp every existing user/shift/announcement/etc. with <code className="rounded bg-gray-100 px-1 text-xs text-gray-700">centerId: 'langley'</code>.
              </p>

              {stats && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs">
                  <p className="font-semibold text-emerald-800 mb-1">✓ Migration complete</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-emerald-700">
                    {Object.entries(stats).map(([k, v]) => (
                      <span key={k}>{k}: <strong>{v}</strong></span>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p className="font-semibold mb-0.5 flex items-center gap-1.5">
                    <AlertTriangle size={14} /> Migration failed
                  </p>
                  <p className="text-xs">{error}</p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  onClick={runMigration}
                  disabled={running}
                  className="flex items-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-50 transition-colors"
                >
                  {running ? (
                    <>
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Running migration…
                    </>
                  ) : 'Run multi-center migration'}
                </button>
                <Link
                  to="/admin"
                  className="text-xs text-gray-500 hover:text-gray-700"
                  onClick={(e) => e.preventDefault()}
                >
                  (Same button is also in Admin → Manage Users)
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
