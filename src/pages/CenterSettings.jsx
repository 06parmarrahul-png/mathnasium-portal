import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import CenterSettingsTab from '../components/CenterSettingsTab';
import AppearanceEditor from '../components/AppearanceEditor';
import HolidaysEditor from '../components/HolidaysEditor';
import Connectors from './Connectors';
import { ShieldAlert, Settings, CalendarX, Palette, Plug } from 'lucide-react';

/**
 * Standalone Centre Settings page with tabs.
 *
 * Tabs:
 *   General   — identity, instructional + operating hours, salaried staff
 *   Holidays  — one-off centre closures (stat holidays, renovations)
 *   Colours   — role / shift colour palette for this centre
 *
 * Visible to owners / Admin Assistants / super-admins (canSeeCenterSettings).
 * Plain admins are blocked here — they manage day-to-day ops on Manage
 * Staff / Manage Schedule, but centre config (hours, salaried list,
 * holidays, colours) is owner-level because it changes how scheduling
 * and payroll behave.
 *
 * Active tab is persisted in the URL (?tab=general|holidays|colours) so
 * refreshing or sharing the link lands you back on the same view.
 */

const TABS = [
  { key: 'general',     label: 'General',     icon: Settings },
  { key: 'holidays',    label: 'Holidays',    icon: CalendarX },
  { key: 'colours',     label: 'Colours',     icon: Palette  },
  { key: 'connections', label: 'Connections', icon: Plug     },
];

export default function CenterSettings() {
  const { activeCenterId, centerConfig, canSeeCenterSettings } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab');
    return TABS.some(x => x.key === t) ? t : 'general';
  });

  const selectTab = (key) => {
    setTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === 'general') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  if (!canSeeCenterSettings) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Centre Settings is owner / super-admin only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-purple-100 p-2 text-purple-600"><Settings size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Centre Settings</h1>
          <p className="text-sm text-gray-500">
            Configure <strong>{centerConfig?.name || activeCenterId}</strong>.
            One-time setup that affects scheduling, payroll, and the look of the schedule grid.
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {TABS.map(t => {
          const active = tab === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'border-purple-600 text-purple-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon size={16} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      {tab === 'general' && (
        <CenterSettingsTab activeCenterId={activeCenterId} centerConfig={centerConfig} />
      )}

      {tab === 'holidays' && (
        <HolidaysEditor
          activeCenterId={activeCenterId}
          centerConfig={centerConfig}
          activeCenterName={centerConfig?.name || activeCenterId}
        />
      )}

      {tab === 'colours' && (
        <AppearanceEditor
          activeCenterId={activeCenterId}
          centerConfig={centerConfig}
          activeCenterName={centerConfig?.name || activeCenterId}
        />
      )}

      {tab === 'connections' && (
        <Connectors />
      )}
    </div>
  );
}
