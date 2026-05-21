import { useEffect, useMemo, useState, useRef } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Building2, ChevronDown, Check, Shield } from 'lucide-react';

/**
 * Center switcher dropdown shown in the sidebar.
 *
 * Visibility:
 *  - Super-admin: always shown (lists EVERY center on the platform)
 *  - Multi-center staff: shown when their centerIds[] has more than 1 entry
 *  - Single-center users: hidden (no point — only one option)
 *
 * Selecting a center calls switchCenter() from AuthContext, which updates
 * state + localStorage. Every Firestore listener in the app re-subscribes
 * because they all depend on activeCenterId.
 */
export default function CenterSwitcher() {
  const { activeCenterId, switchCenter, userCenters, isSuperAdmin } = useAuth();
  const [centers, setCenters] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Subscribe to all centers (public read). Super-admins see every center;
  // regular users still see the same list but we filter to their centerIds.
  useEffect(() => (
    onSnapshot(
      collection(db, 'centers'),
      snap => setCenters(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setCenters([]),
    )
  ), []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // What to show in the dropdown
  const visibleCenters = useMemo(() => {
    if (isSuperAdmin) return centers; // super-admin sees everything
    return centers.filter(c => (userCenters || []).includes(c.id));
  }, [centers, userCenters, isSuperAdmin]);

  // Hide entirely if there's nothing meaningful to switch between
  if (visibleCenters.length <= 1 && !isSuperAdmin) return null;

  const active = centers.find(c => c.id === activeCenterId);
  const activeLabel = active?.name || activeCenterId;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 rounded-lg bg-gray-800/70 px-3 py-2 text-left hover:bg-gray-700 transition-colors border border-gray-700"
      >
        <div className={`shrink-0 rounded-md p-1.5 ${isSuperAdmin ? 'bg-purple-600' : 'bg-red-600'}`}>
          {isSuperAdmin ? <Shield size={13} className="text-white" /> : <Building2 size={13} className="text-white" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-400 leading-tight">
            {isSuperAdmin ? 'Viewing as Enterprise' : 'Center'}
          </p>
          <p className="text-sm font-semibold text-white truncate leading-tight">{activeLabel}</p>
        </div>
        <ChevronDown size={14} className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 rounded-lg border border-gray-700 bg-gray-900 shadow-2xl max-h-72 overflow-y-auto">
          {visibleCenters.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-400 italic">No centers yet. Use Manage Centres → New Centre to create one.</p>
          ) : (
            visibleCenters.map(c => {
              const isActive = c.id === activeCenterId;
              return (
                <button
                  key={c.id}
                  onClick={() => { switchCenter(c.id); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${isActive ? 'bg-red-600 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}
                >
                  <Building2 size={13} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate leading-tight">{c.name || c.id}</p>
                    {(c.city || c.province) && (
                      <p className="text-xs opacity-75 truncate leading-tight">
                        {[c.city, c.province].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  {isActive && <Check size={13} className="shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
