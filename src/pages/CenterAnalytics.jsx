import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { collection, onSnapshot, query, where, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { AnalyticsTab } from './Admin';
import { ShieldAlert } from 'lucide-react';
import { resolveUserForCenter } from '../lib/centerMembership';

// Which :section route segments map to a real AnalyticsTab view. Anything
// outside this list falls back to the hub. Keeps URL typos from rendering
// a blank page.
const VALID_VIEWS = new Set(['snapshot', 'intakes', 'coverage', 'assignments', 'hiring']);

/**
 * Standalone Centre Analytics page. Pulls `shifts` + `users` for the
 * active centre and hands them to the existing AnalyticsTab component
 * (which lives in Admin.jsx and is re-used here so we don't duplicate
 * its ~900 lines of derived metrics).
 *
 * Owners and super-admins only — admins explicitly do NOT see strategic
 * metrics under the current role model (canSeeCenterSettings rule).
 */
export default function CenterAnalytics() {
  const { activeCenterId, centerConfig, canSeeCenterSettings } = useAuth();
  const { section } = useParams();
  const view = VALID_VIEWS.has(section) ? section : 'hub';
  const [shifts, setShifts] = useState([]);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (!activeCenterId || !canSeeCenterSettings) return;
    // Sliding date window so live reads don't scale with centre-age — same
    // 180-day window Admin.jsx's AnalyticsTab data feed already uses for
    // this exact component; older docs still exist in Firestore for
    // ad-hoc queries.
    const WINDOW_DAYS = 180;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const y = cutoff.getFullYear();
    const m = String(cutoff.getMonth() + 1).padStart(2, '0');
    const d = String(cutoff.getDate()).padStart(2, '0');
    const windowStart = `${y}-${m}-${d}`;

    const u1 = onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    );
    const u2 = onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    );
    return () => { u1(); u2(); };
  }, [activeCenterId, canSeeCenterSettings]);

  // Resolve users against the active centre so analytics counts use the
  // per-centre `approved` flag — a user approved at another centre but
  // pending here should not show up as active for this centre. Mirrors
  // the same hoisting we do in Admin.jsx → usersForCentre. Hooks must
  // run before any early return.
  const usersForCentre = useMemo(
    () => users.map(u => resolveUserForCenter(u, activeCenterId)),
    [users, activeCenterId],
  );

  if (!canSeeCenterSettings) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Centre Analytics is owner / super-admin only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <AnalyticsTab
        shifts={shifts}
        users={usersForCentre}
        centerConfig={centerConfig}
        activeCenterId={activeCenterId}
        view={view}
      />
    </div>
  );
}
