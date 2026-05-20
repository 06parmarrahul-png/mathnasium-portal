import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, where, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { AnalyticsTab } from './Admin';
import { ShieldAlert } from 'lucide-react';

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
  const [shifts, setShifts] = useState([]);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (!activeCenterId || !canSeeCenterSettings) return;
    const u1 = onSnapshot(
      query(collection(db, 'shifts'), where('centerId', '==', activeCenterId), orderBy('date')),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    );
    const u2 = onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    );
    return () => { u1(); u2(); };
  }, [activeCenterId, canSeeCenterSettings]);

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
        users={users}
        centerConfig={centerConfig}
        activeCenterId={activeCenterId}
      />
    </div>
  );
}
