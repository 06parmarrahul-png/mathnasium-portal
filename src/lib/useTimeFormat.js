/**
 * useTimeFormat — the signed-in person's clock, for any component.
 *
 *   const fmtTime = useTimeFormat();
 *   <span>{fmtTime.range(shift.startTime, shift.endTime)}</span>
 *
 * The preference lives on the user doc (`users/{uid}.timeFormat`), which
 * AuthContext already keeps live, so changing it on Account Details
 * re-renders every open page without a refresh.
 *
 * Nobody signed in — the public booking page — and no provider at all — a
 * card rendered on its own in a test — both fall back to the 12-hour
 * default rather than throwing. A clock style is never worth a blank page.
 *
 * See timeFormat.js for what the returned formatter can do.
 */
import { useMemo } from 'react';
import { useOptionalAuth } from '../contexts/AuthContext';
import { makeTimeFormatter, resolveTimeFormat } from './timeFormat';

export function useTimeFormat() {
  const auth = useOptionalAuth();
  const format = resolveTimeFormat(auth?.profile?.timeFormat);
  return useMemo(() => makeTimeFormatter(format), [format]);
}

export default useTimeFormat;
