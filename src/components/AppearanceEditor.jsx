import { useState, useEffect } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import {
  DEFAULT_ASSIGNMENT_COLORS, ASSIGNMENT_COLOR_KEYS,
  DEFAULT_STATE_COLORS, STATE_COLOR_KEYS, stateColorHex,
  assignmentColorHex, contrastText,
} from '../lib/centerConfig';
import { Palette, Save, RotateCcw, AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * Per-center shift / role colour editor.
 *
 * Lives in Centre Settings (owner-accessible) so owners can rebrand their
 * own centre. Enterprise users hit the same control through the same page
 * after switching centres — the standalone copy that used to live on
 * Manage Centres has been retired to keep one source of truth.
 *
 * Writes to centers/{activeCenterId}/config/main.assignmentColors and the
 * change flows out via the AuthContext subscription to everyone viewing
 * that centre.
 */
export default function AppearanceEditor({ activeCenterId, centerConfig, activeCenterName }) {
  // Local working copy of the shift-assignment color map. Seeded from the
  // active center's config (merged with the built-in defaults so every
  // assignment has a value to start from).
  const seedColors = () => {
    const out = {};
    for (const role of ASSIGNMENT_COLOR_KEYS) out[role] = assignmentColorHex(role, centerConfig);
    return out;
  };
  const seedStates = () => {
    const out = {};
    for (const name of STATE_COLOR_KEYS) out[name] = stateColorHex(name, centerConfig);
    return out;
  };
  const [colors, setColors] = useState(seedColors);
  const [stateColorsLocal, setStateColorsLocal] = useState(seedStates);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');

  // Re-seed if the active center changes (switchCenter) or config updates.
  useEffect(() => {
    setColors(seedColors());
    setStateColorsLocal(seedStates());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerConfig, activeCenterId]);

  const dirty =
    ASSIGNMENT_COLOR_KEYS.some(r => colors[r] !== assignmentColorHex(r, centerConfig)) ||
    STATE_COLOR_KEYS.some(n => stateColorsLocal[n] !== stateColorHex(n, centerConfig));

  const setOne = (role, hex) => setColors(c => ({ ...c, [role]: hex }));
  const setOneState = (name, hex) => setStateColorsLocal(c => ({ ...c, [name]: hex }));

  // One editable colour row — shared by the assignment and state grids so
  // both look and behave identically.
  const swatchRow = (label, value, onChange) => (
    <div key={label} className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
      <span
        className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold"
        style={{ backgroundColor: value, color: contrastText(value) }}
      >
        {label.split(' ').map(w => w[0]).join('').slice(0, 2)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-800 truncate">{label}</p>
        <p className="text-xs text-gray-400 font-mono">{value}</p>
      </div>
      <input
        type="color"
        value={value}
        onChange={e => onChange(label, e.target.value)}
        className="shrink-0 h-9 w-12 rounded cursor-pointer border border-gray-200 bg-white"
        title={`Pick color for ${label}`}
      />
    </div>
  );

  const handleSave = async () => {
    if (!activeCenterId) return;
    setSaving(true);
    setError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { assignmentColors: colors, stateColors: stateColorsLocal, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (err) {
      setError(err?.message || 'Failed to save colors.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    // Reset to the built-in defaults (visually) — not saved until "Save".
    const out = {};
    for (const role of ASSIGNMENT_COLOR_KEYS) out[role] = DEFAULT_ASSIGNMENT_COLORS[role];
    setColors(out);
    const st = {};
    for (const name of STATE_COLOR_KEYS) st[name] = DEFAULT_STATE_COLORS[name];
    setStateColorsLocal(st);
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <Palette size={18} className="text-purple-600" />
        <h3 className="font-semibold text-gray-900">Appearance — Shift Colors</h3>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Each shift on the admin weekly grid is filled with its assignment's
        color (these also tint the payroll cards). Changes apply to{' '}
        <strong>{activeCenterName || activeCenterId}</strong> only.
      </p>

      <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">Roles &amp; Assignments</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        {ASSIGNMENT_COLOR_KEYS.map(role => swatchRow(role, colors[role], setOne))}
      </div>

      <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500 mt-6 mb-1">States &amp; Flex Roles</h4>
      <p className="text-xs text-gray-500 mb-2">
        STEAM and Summer Camp are paid flex work (not counted as instructors); Volunteer, Sick Pay
        and No-Show are shift states. These fills override the assignment color on the grid, coverage
        and staffing views.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {STATE_COLOR_KEYS.map(name => swatchRow(name, stateColorsLocal[name], setOneState))}
      </div>

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save Colors'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RotateCcw size={13} />
          Reset to defaults
        </button>
        {dirty && !savedAt && (
          <span className="flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={13} /> Unsaved changes
          </span>
        )}
        {savedAt && !dirty && (
          <span className="flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 size={13} /> Saved
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
