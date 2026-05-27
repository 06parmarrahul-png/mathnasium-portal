import { useAuth } from '../contexts/AuthContext';
import CenterSettingsTab from '../components/CenterSettingsTab';
import AppearanceEditor from '../components/AppearanceEditor';
import { ShieldAlert } from 'lucide-react';

/**
 * Standalone Centre Settings page. Thin wrapper around the existing
 * CenterSettingsTab component so it can be reached directly from the
 * sidebar instead of as a tab inside the Admin Panel.
 *
 * Visible to owners and super-admins (canSeeCenterSettings = true).
 * Plain admins are blocked here — they manage day-to-day ops on the
 * Admin Panel, but Center Settings (instructional hours, fixed staff,
 * etc.) is owner-only because it changes how scheduling works.
 */
export default function CenterSettings() {
  const { activeCenterId, centerConfig, canSeeCenterSettings } = useAuth();

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
      <CenterSettingsTab activeCenterId={activeCenterId} centerConfig={centerConfig} />
      {/* Role / shift colours — owners + Enterprise can rebrand their own
          centre here. (Previously lived only on Manage Centres, but owners
          asked to have it under their own Centre Settings page.) */}
      <AppearanceEditor
        activeCenterId={activeCenterId}
        centerConfig={centerConfig}
        activeCenterName={centerConfig?.name || activeCenterId}
      />
    </div>
  );
}
