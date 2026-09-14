import { MASCOTS, resolveMascotId } from '../lib/mascots';
import Mascot from './Mascot';

/**
 * Pick your Cole. Four real radio inputs underneath, so arrow keys, tab and
 * screen readers all work without anything hand-rolled.
 *
 * Used on sign-up (two across, in the narrow card) and on Account (`wide`,
 * four across). `disabled` is for the moment a save is in flight.
 */
export default function MascotPicker({ value, onChange, name = 'mascot', disabled = false, wide = false }) {
  const current = resolveMascotId(value);
  return (
    <div role="radiogroup" aria-label="Your character" className={`grid grid-cols-2 gap-2.5 ${wide ? 'sm:grid-cols-4' : ''}`}>
      {MASCOTS.map(m => {
        const on = m.id === current;
        return (
          <label key={m.id}
            className={`relative flex cursor-pointer flex-col items-center rounded-xl border-2 px-2 pb-2.5 pt-2 text-center transition-colors ${
              on ? 'border-red-600 bg-red-50' : 'border-gray-200 bg-white hover:border-gray-300'
            } ${disabled ? 'cursor-wait opacity-60' : ''} has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-500/40`}>
            <input type="radio" name={name} value={m.id} checked={on} disabled={disabled}
              onChange={() => onChange?.(m.id)} className="sr-only" />
            <Mascot id={m.id} pose={m.hero} crop="full" size={64} alt="" />
            <span className="mt-1 text-[13px] font-bold leading-tight text-gray-900">{m.name}</span>
            <span className="text-[11px] leading-tight text-gray-500">{m.tagline}</span>
          </label>
        );
      })}
    </div>
  );
}
