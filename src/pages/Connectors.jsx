// Connectors — in-app view of every Mathnasium-approved vendor and
// which ones are wired into this centre. Reads the same catalog the
// landing page uses (src/lib/vendors.js), so adding a vendor or
// flipping a status updates both surfaces.
//
// Per-centre connection state lives at
//   centers/{centerId}/connectors/{vendorId} = { connected: bool, settings }
// Only owners + admin assistants + super_admin can see / toggle.

import { useEffect, useMemo, useState } from 'react';
import {
  collection, doc, onSnapshot, setDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Plug, Search, ExternalLink, CheckCircle2, AlertTriangle, Sparkles, Clock,
} from 'lucide-react';
import { VENDOR_CATEGORIES, VENDOR_STATUS } from '../lib/vendors';

function vendorId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function Connectors() {
  const { activeCenterId, isSuperAdmin, isOwner, isAdminAssistant } = useAuth();
  const allowed = isSuperAdmin || isOwner || isAdminAssistant;
  const [connections, setConnections] = useState({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    if (!activeCenterId) return;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'connectors'),
      snap => {
        const map = {};
        snap.forEach(d => { map[d.id] = d.data(); });
        setConnections(map);
      }
    );
  }, [activeCenterId]);

  const toggleConnected = async (name) => {
    const id = vendorId(name);
    const cur = connections[id]?.connected || false;
    await setDoc(
      doc(db, 'centers', activeCenterId, 'connectors', id),
      { connected: !cur, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  };

  // Filter + search.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return VENDOR_CATEGORIES.map(cat => ({
      ...cat,
      vendors: cat.vendors.filter(v => {
        if (q && !v.name.toLowerCase().includes(q)) return false;
        if (filter === 'live'      && v.status !== 'live') return false;
        if (filter === 'soon'      && v.status !== 'soon') return false;
        if (filter === 'connected' && !connections[vendorId(v.name)]?.connected) return false;
        return true;
      }),
    })).filter(cat => cat.vendors.length > 0);
  }, [search, filter, connections]);

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
        <p className="text-3xl mb-2">🔒</p>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Not available</h1>
        <p className="text-sm text-gray-500">Connectors is open to Owners, Admin Assistants, and Enterprise only.</p>
      </div>
    );
  }

  const connectedCount = Object.values(connections).filter(c => c?.connected).length;
  const liveCount = VENDOR_CATEGORIES.reduce(
    (n, c) => n + c.vendors.filter(v => v.status === 'live').length, 0
  );

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="rounded-xl bg-red-100 p-2.5 text-red-700"><Plug size={22} /></div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Connectors</h1>
          <p className="text-sm text-gray-500">
            Mathnasium-approved vendor integrations. Mark the ones you use so Ratio surfaces the right things in the right places.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-emerald-800">
            <b>{connectedCount}</b> connected
          </span>
          <span className="rounded-full bg-red-50 border border-red-200 px-3 py-1 text-red-700">
            <b>{liveCount}</b> available
          </span>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search vendors…"
            className="w-full rounded border border-gray-300 pl-8 pr-3 py-1.5 text-sm" />
        </div>
        <FilterPill label="All"          active={filter === 'all'}       onClick={() => setFilter('all')} />
        <FilterPill label="Live"         active={filter === 'live'}      onClick={() => setFilter('live')} />
        <FilterPill label="Coming soon"  active={filter === 'soon'}      onClick={() => setFilter('soon')} />
        <FilterPill label="Connected"    active={filter === 'connected'} onClick={() => setFilter('connected')} />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl bg-white border border-gray-200 p-8 text-center text-gray-500">
          No vendors match your filter.
        </div>
      ) : (
        <div className="space-y-8">
          {filtered.map(cat => (
            <section key={cat.id}>
              <div className="mb-2">
                <h2 className="font-bold text-gray-900">{cat.title}</h2>
                <p className="text-xs text-gray-500">{cat.blurb}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {cat.vendors.map(v => (
                  <ConnectorCard
                    key={v.name} vendor={v}
                    connection={connections[vendorId(v.name)]}
                    onToggle={() => toggleConnected(v.name)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({ label, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}>
      {label}
    </button>
  );
}

function ConnectorCard({ vendor, connection, onToggle }) {
  const s = VENDOR_STATUS[vendor.status] || VENDOR_STATUS.planned;
  const connected = !!connection?.connected;
  const isLive = vendor.status === 'live' || vendor.status === 'beta';

  return (
    <div className={`rounded-lg border bg-white p-3 flex items-start gap-3 ${
      connected ? 'border-emerald-300 bg-emerald-50/30' : 'border-gray-200'
    }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 text-sm">{vendor.name}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${s.color}`}>
            {s.label}
          </span>
          {connected && (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 font-bold uppercase tracking-wider">
              <CheckCircle2 size={11} /> Connected
            </span>
          )}
        </div>
        {vendor.note && (
          <div className="text-xs text-gray-500 mt-1 leading-snug">{vendor.note}</div>
        )}
        {!isLive && (
          <div className="text-[11px] text-amber-700 mt-1 inline-flex items-center gap-1">
            <Clock size={11} /> Not available yet — mark interest below.
          </div>
        )}
      </div>
      <button onClick={onToggle}
        className={`shrink-0 rounded px-2.5 py-1 text-xs font-semibold border transition-colors ${
          connected
            ? 'border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
            : isLive
              ? 'border-red-300 bg-white text-red-700 hover:bg-red-50'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
        }`}>
        {connected ? 'Connected' : isLive ? 'Mark connected' : 'I want this'}
      </button>
    </div>
  );
}
