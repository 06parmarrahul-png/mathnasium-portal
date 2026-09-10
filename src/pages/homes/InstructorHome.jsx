import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { Mail, ArrowRight, Megaphone, CalendarDays, MoveRight, ChevronDown } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { setNewLook } from '../../lib/newLook';
import {
  watchLastSeen, markSeen, newestDate, unreadCount, unreadLabel,
} from '../../lib/announcementReads';
import {
  weekAhead, monthAhead, weekWindow, monthWindow, eventTypeShort,
} from '../../lib/centreEvents';
import { watchInstructorAssignments } from '../../lib/scheduler-data';
import {
  blocksForPerson, blockAt, nextSwitch, hasSwitch, sideLabel,
} from '../../lib/sideAssignments';
import { Card, Pill, Btn, Lbl, AllClear, Loading } from '../../components/newlook/ui';
import { fmtTime, fmtDay, todayISO, minutesOf, asDate } from '../../components/newlook/format';

/**
 * The floor-staff home — built for a phone held in one hand.
 *
 * Her question is "am I on today, and does anyone need anything from me?"
 * She is standing outside about to walk in, and she wants to close the app.
 *
 * SO: the thing to DO sits above the thing to KNOW. Today's shift is the
 * headline, but the only button on the page belongs to whatever Ratio needs
 * from her. When that card is absent, she is done.
 *
 * EVERY FIGURE IS A DIRECT READ of her own shifts, the open-shift board, or
 * the announcements feed. That is deliberate, and it is why this page
 * survived when the owner, director and host boards did not: those needed
 * live Radius data and cross-collection maths this app cannot yet do
 * quickly or completely, so their numbers could not be trusted. Nothing
 * here is derived, estimated, or illustrative.
 *
 * MOBILE RULES FOLLOWED THROUGHOUT
 *   - one column, always; nothing side-by-side that could squeeze
 *   - every tappable thing is at least 44px tall
 *   - buttons go full width on a phone, shrink to fit from `sm` up
 *   - the page ends with clearance for the bottom tab bar
 */

/**
 * How many announcements the home reads. Five is plenty to show the latest
 * and count what is new; the badge says "5+" rather than "5" when the count
 * fills the fetch, so the number is never quietly short.
 */
const ANNOUNCEMENT_FETCH = 5;

export default function InstructorHome() {
  const { profile, activeCenterId, mySubRoles, canTakeShifts, centerConfig } = useAuth();
  const [shifts, setShifts] = useState(null);        // null = still loading
  const [dayRoster, setDayRoster] = useState({ date: null, rows: null });
  const [openShifts, setOpenShifts] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [seenAt, setSeenAt] = useState(null);        // their own read marker
  const [events, setEvents] = useState([]);
  // { date, map } — stamped so staleness is derived, never reset in an effect.
  const [sides, setSides] = useState({ date: null, map: null });
  const [roster, setRoster] = useState(null);
  const today = todayISO();

  useEffect(() => {
    if (!profile?.uid || !activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('userId', '==', profile.uid),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setShifts([]),
    );
  }, [profile?.uid, activeCenterId]);

  const upcoming = useMemo(() => (shifts || [])
    .filter(s => s.date >= today && s.status !== 'draft' && s.status !== 'cancelled')
    .sort((a, b) => a.date.localeCompare(b.date)
      || String(a.startTime).localeCompare(String(b.startTime))), [shifts, today]);

  const next = upcoming[0] || null;

  // Everyone rostered the same day, so she knows how busy the floor will be
  // before she walks in. Stamped with its date so staleness is derived
  // rather than reset from inside an effect.
  useEffect(() => {
    const date = next?.date;
    if (!activeCenterId || !date) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '==', date),
      ),
      snap => setDayRoster({ date, rows: snap.docs.map(d => ({ id: d.id, ...d.data() })) }),
      () => setDayRoster({ date, rows: [] }),
    );
  }, [activeCenterId, next?.date]);

  // Which side of the room, per half hour. Neeru sets this in the Student
  // Scheduler before the day; until now the only copies were her screen and
  // the printed sheet, so instructors arrived asking out loud.
  useEffect(() => {
    const date = next?.date;
    if (!activeCenterId || !date) return undefined;
    let unsub;
    try {
      unsub = watchInstructorAssignments(activeCenterId, date,
        (map) => setSides({ date, map: map || {} }));
    } catch (err) {
      console.warn('[home] side assignments unavailable:', err?.message || err);
    }
    return () => unsub?.();
  }, [activeCenterId, next?.date]);

  useEffect(() => {
    if (!activeCenterId || !canTakeShifts) return undefined;
    return onSnapshot(
      query(
        collection(db, 'openShifts'),
        where('centerId', '==', activeCenterId),
        orderBy('date', 'asc'),
      ),
      snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= today && !s.claimedBy)),
      () => setOpenShifts([]),
    );
  }, [activeCenterId, canTakeShifts, today]);

  // Staff meetings, fun days and training. New collection — before it,
  // neither had anywhere to live with a real date on it.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'events'),
      snap => setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setEvents([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'announcements'),
        where('centerId', '==', activeCenterId),
        orderBy('date', 'desc'),
        limit(ANNOUNCEMENT_FETCH),
      ),
      snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Pinned first decides which one the strip SHOWS. The unread count
        // is worked out from dates, so this ordering cannot skew it.
        rows.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
        setAnnouncements(rows);
      },
      () => setAnnouncements([]),
    );
  }, [activeCenterId]);

  // What they have already read. Stored per PERSON, not per browser — the
  // front desk tablet is shared, and a device-level marker would clear one
  // instructor's badge because a different one read it.
  useEffect(() => {
    if (!profile?.uid) return undefined;
    return watchLastSeen(profile.uid, setSeenAt);
  }, [profile?.uid]);

  // Expanding it IS reading it. Applied locally first so the badge clears
  // on the tap rather than after a round trip.
  const readAnnouncements = () => {
    const newest = newestDate(announcements);
    if (!newest || !profile?.uid) return;
    const previous = seenAt || '';
    setSeenAt(newest);
    markSeen(profile.uid, newest, previous).catch(() => {});
  };

  // What Ratio needs FROM her. The confirm itself happens through the
  // emailed single-use link, so this points at the email rather than
  // pretending to be a second way in.
  const pending = useMemo(() => (shifts || []).filter(s =>
    s.signOutRequestSentAt && !s.signOutConfirmedTime), [shifts]);

  const eligibleOpen = useMemo(() => {
    const mine = mySubRoles || [];
    if (mine.length === 0) return [];
    return openShifts.filter(s => !s.subRole || mine.includes(s.subRole));
  }, [openShifts, mySubRoles]);

  const sideMap = sides.date === next?.date ? sides.map : null;
  const myName = profile?.displayName || '';

  // Exact display name matches every current member of staff — checked
  // against every live assignment document. The roster is only needed to
  // disambiguate a bare first name ("Bri", "Sofie"), which the sheet
  // occasionally carries, so it is fetched ONLY when the exact pass finds
  // nothing. That keeps 50-odd user reads off the common path.
  const exactBlocks = useMemo(
    () => blocksForPerson(sideMap, myName, []), [sideMap, myName]);
  const needRoster = !!sideMap && Object.keys(sideMap).length > 0
    && exactBlocks.length === 0 && roster === null;

  useEffect(() => {
    if (!needRoster || !activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setRoster(snap.docs.map(d => d.data()?.displayName).filter(Boolean)),
      () => setRoster([]),
    );
  }, [needRoster, activeCenterId]);

  const blocks = useMemo(
    () => (exactBlocks.length > 0 ? exactBlocks : blocksForPerson(sideMap, myName, roster || [])),
    [exactBlocks, sideMap, myName, roster]);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const currentBlock = isTodayDate(next?.date, today) ? blockAt(blocks, nowMin) : null;
  const upNext = isTodayDate(next?.date, today) ? nextSwitch(blocks, nowMin) : null;

  // One merged, date-ordered list. The question is "what's happening this
  // week", not "shifts, and separately, events" — splitting them makes the
  // reader do the interleaving.
  const week = useMemo(() => {
    const w = weekWindow(today);
    return weekAhead({ shifts: shifts || [], events, from: w.from, to: w.to });
  }, [shifts, events, today]);

  const onThisMonth = useMemo(() => {
    const m = monthWindow(today);
    return monthAhead({
      events,
      holidays: Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [],
      from: m.from, to: m.to,
    });
  }, [events, centerConfig, today]);

  const dayShifts = dayRoster.date === next?.date ? dayRoster.rows : null;
  const onFloor = (dayShifts || []).filter(s => s.status !== 'draft').length;
  const first = (profile?.displayName || '').split(' ')[0] || 'there';
  const isToday = next?.date === today;

  return (
    // pb-28 clears the bottom tab bar on phones; it drops away at lg, where
    // the bar isn't rendered and the sidebar is back.
    // Two columns from `md` up — a tablet on the front desk has the room,
    // and the split follows the reading order: what is happening to you
    // right now on the left, what is coming on the right. A phone keeps
    // one column, because two on 375px is two narrow columns.
    <div className="nl mx-auto w-full max-w-2xl pb-28 md:max-w-4xl lg:pb-4">
      <div className="mb-3.5">

        <div className="flex items-start justify-between gap-3">
          <h1 className="nl-display text-[26px] font-semibold leading-tight">
            {greeting()}, {first}
          </h1>
          <button
            type="button"
            onClick={() => { setNewLook(profile?.uid, false); window.location.reload(); }}
            className="-mr-1 mt-1 shrink-0 rounded-lg px-2 py-1.5 text-[11.5px] font-semibold underline underline-offset-2"
            style={{ color: 'var(--nl-muted)' }}>
            Classic view
          </button>
        </div>
      </div>

      {/* Announcements — at the top, one line tall. */}
      {announcements.length > 0 && (
        <AnnouncementStrip rows={announcements} seenAt={seenAt} onRead={readAnnouncements} />
      )}

      <div className="grid gap-3.5 md:grid-cols-2 md:items-start">
        <div className="space-y-3.5">
        {shifts === null ? (
          <Loading label="Getting your shifts…" />
        ) : next ? (
          <div className="rounded-2xl p-5" style={{ background: 'var(--nl-brand)', color: '#fff' }}>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-80">
              {isToday ? "You're on today" : `Next shift · ${fmtDay(next.date)}`}
            </div>
            {/* The biggest thing on the page, because it's the answer. */}
            <div className="nl-display mt-1.5 text-[32px] font-bold leading-none sm:text-[36px]">
              {fmtTime(next.startTime)} – {fmtTime(next.endTime)}
            </div>
            <div className="mt-2 text-[14px] opacity-90">
              {[next.subRole, next.instructorType].filter(Boolean).join(' · ') || 'Floor'}
              {isToday && startsIn(next.startTime)}
            </div>

            {dayShifts && onFloor > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
                style={{ borderColor: 'rgba(255,255,255,.3)' }}>
                <span className="text-[13px] opacity-90">
                  {onFloor} {onFloor === 1 ? 'person' : 'people'} rostered that day
                </span>
                <Btn to="/schedule" size="sm" variant="ghost"
                  className="!border-white/60 !text-white">
                  Full schedule <ArrowRight size={13} />
                </Btn>
              </div>
            )}
          </div>
        ) : (
          <AllClear title="No shifts booked"
            note="Nothing scheduled for you yet. Submitting your availability is how you get on the sheet." />
        )}

        {/* ── Which side, and when you move ───────────────────────── */}
        {next && blocks.length > 0 && (
          <div>
            <Lbl className="mb-1.5">
              {isTodayDate(next.date, today) ? 'Your day' : `Your day · ${fmtDay(next.date)}`}
            </Lbl>
            <Card className="!p-0 overflow-hidden">
              {blocks.map((b, i) => {
                const live = currentBlock && b.startMin === currentBlock.startMin;
                return (
                  <div key={`${b.side}-${b.start}`}
                    className={`flex items-center gap-3 px-4 py-3.5 ${i > 0 ? 'border-t' : ''}`}
                    style={{
                      borderColor: 'var(--nl-rule)',
                      background: live ? 'var(--nl-raised)' : undefined,
                    }}>
                    {/* A colour stripe rather than a dot: it survives being
                        glanced at, and matches the HS/EM colours on the sheet
                        Neeru prints, so the two read as the same thing. */}
                    <span className="h-9 w-1.5 shrink-0 rounded-full"
                      style={{ background: sideColour(b.side) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold tabular-nums">
                        {fmtTime(b.start)} – {fmtTime(b.end)}
                      </span>
                      <span className="block text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                        {sideLabel(b.side)}
                      </span>
                    </span>
                    {live && <Pill tone="brand">Now</Pill>}
                  </div>
                );
              })}
            </Card>

            {/* The second half of the question, said in words. */}
            {upNext && (
              <p className="mt-2 flex items-start gap-1.5 px-1 text-[13px] leading-relaxed"
                style={{ color: 'var(--nl-ink2)' }}>
                <MoveRight size={15} className="mt-0.5 shrink-0" style={{ color: sideColour(upNext.side) }} />
                <span>You move to <b>{sideLabel(upNext.side)}</b> at <b>{fmtTime(upNext.start)}</b>.</span>
              </p>
            )}
            {!upNext && hasSwitch(blocks) && isTodayDate(next.date, today) && currentBlock && (
              <p className="mt-2 px-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                No more moves today — you finish on {sideLabel(currentBlock.side)}.
              </p>
            )}
            {!hasSwitch(blocks) && (
              <p className="mt-2 px-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                You&apos;re on {sideLabel(blocks[0].side)} the whole shift.
              </p>
            )}
          </div>
        )}

        {/* Sides not posted yet. Only said on the day itself — for a shift
            next week it is simply too early, and a permanent "not posted"
            note would train people to ignore this whole section. */}
        {next && isTodayDate(next.date, today) && sideMap && blocks.length === 0 && (
          <p className="px-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            Sides aren&apos;t posted for today yet. Ask whoever&apos;s running the floor.
          </p>
        )}

        {/* ── The only thing with a button ────────────────────────── */}
        {pending.length > 0 && (
          <Card tone="warn" className="!border-[1.5px]">
            <Pill tone="warn"><Mail size={12} /> Needs you</Pill>
            {pending.slice(0, 3).map(s => (
              <p key={s.id} className="mt-2.5 text-[14px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
                <b>{fmtDay(s.date)}</b> — you signed in but never signed out.
                We emailed you a link to confirm you finished at {fmtTime(s.endTime)}.
              </p>
            ))}
            <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--nl-muted)' }}>
              Check your email — the link confirms it in one tap. Left at a
              different time? Tell the centre instead.
            </p>
          </Card>
        )}
        </div>

        <div className="space-y-3.5">
        {/* ── This week — shifts and events together ──────────────── */}
        {week.length > 0 && (
          <div>
            <Lbl className="mb-1.5">This week</Lbl>
            <Card className="!p-0">
              {week.slice(0, 6).map((r, i) => (
                <div key={`${r.kind}-${r.id}`}
                  className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t' : ''}`}
                  style={{ borderColor: 'var(--nl-rule)' }}>
                  <span className="w-10 shrink-0 text-center">
                    <span className="block text-[9.5px] font-bold uppercase tracking-[0.08em]"
                      style={{ color: 'var(--nl-muted)' }}>
                      {fmtDay(r.date, { weekday: 'short' })}
                    </span>
                    <span className="nl-display block text-[17px] font-bold leading-none">
                      {asDate(r.date).getDate()}
                    </span>
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">
                      {r.kind === 'shift'
                        ? `Shift${r.subRole ? ` · ${r.subRole}` : ''}`
                        : r.title}
                    </span>
                    <span className="block truncate text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                      {r.startTime
                        ? `${fmtTime(r.startTime)}${r.endTime ? ` – ${fmtTime(r.endTime)}` : ''}`
                        : 'All day'}
                      {r.kind === 'event' && r.note ? ` · ${r.note}` : ''}
                    </span>
                  </span>

                  {r.kind === 'event' && (
                    <Pill tone="note" className="shrink-0">{eventTypeShort(r.type)}</Pill>
                  )}
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ── What's on this month ────────────────────────────────── */}
        {onThisMonth.length > 0 && (
          <div>
            <Lbl className="mb-1.5">What&apos;s on this month</Lbl>
            <Card className="!p-0">
              {onThisMonth.slice(0, 6).map((r, i) => (
                <div key={`${r.kind}-${r.id}`}
                  className={`flex items-start gap-3 px-4 py-3 ${i > 0 ? 'border-t' : ''}`}
                  style={{ borderColor: 'var(--nl-rule)' }}>
                  <span className="w-11 shrink-0 rounded-lg py-1.5 text-center"
                    style={{ background: 'var(--nl-raised)' }}>
                    <span className="block text-[9px] font-bold uppercase tracking-[0.08em]"
                      style={{ color: 'var(--nl-muted)' }}>
                      {fmtDay(r.date, { month: 'short' })}
                    </span>
                    <span className="nl-display block text-[15px] font-bold leading-tight">
                      {asDate(r.date).getDate()}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold leading-snug">{r.title}</span>
                    <span className="block text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                      {r.startTime ? `${fmtTime(r.startTime)} · ` : ''}
                      {/* Short form here too: an event titled "Staff meeting"
                          was labelling itself "Staff meeting". */}
                      {r.kind === 'closure' ? r.note : eventTypeShort(r.type)}
                      {r.kind === 'event' && r.note ? ` · ${r.note}` : ''}
                    </span>
                  </span>
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ── Open shifts ─────────────────────────────────────────── */}
        {canTakeShifts && eligibleOpen.length > 0 && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <b className="block text-[14.5px]">
                  {eligibleOpen.length} open {eligibleOpen.length === 1 ? 'shift' : 'shifts'}
                </b>
                <span className="mt-0.5 block text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
                  You can cover {eligibleOpen.length === 1 ? 'it' : 'all of them'}
                </span>
              </div>
              <Btn to="/shift-board" variant="ghost" size="sm"
                className="w-full justify-center sm:w-auto">
                <CalendarDays size={14} /> Look
              </Btn>
            </div>
          </Card>
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * The announcements strip — top of the page, one line tall.
 *
 * It used to be a card at the very BOTTOM, under the week, the month and
 * the open shifts. That is the last place a person looks and the first
 * place they stop scrolling, so an announcement could be posted and simply
 * never be seen. Moving it up cost nothing: a title fits on one line, and
 * the rest is one tap away.
 *
 * The badge is the whole point of it being up here. Quiet grey when there
 * is nothing new — a strip that always looks urgent is one people stop
 * seeing — and expanding it is what marks it read, because a separate
 * "mark as read" control is one nobody would ever press.
 */
function AnnouncementStrip({ rows, seenAt, onRead }) {
  const [open, setOpen] = useState(false);
  const latest = rows[0];
  const count = unreadCount(rows, seenAt);
  const badge = unreadLabel(count, rows.length, ANNOUNCEMENT_FETCH);
  const isNew = count > 0;

  const toggle = () => {
    if (!open) onRead();      // opening it IS reading it
    setOpen(o => !o);
  };

  return (
    <div className="mb-3.5 overflow-hidden rounded-xl border"
      style={{
        background: isNew ? 'var(--nl-brandw)' : 'var(--nl-card)',
        borderColor: isNew ? 'var(--nl-brand)' : 'var(--nl-rule)',
      }}>
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex min-h-[48px] w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        <Megaphone size={15} className="shrink-0" style={{ color: 'var(--nl-brand)' }} />

        {/* The title wraps rather than truncating. A one-line preview of
            the body underneath it looked tidier, but it stole the width
            that made the title readable — and the title is the part
            written to be read at a glance. */}
        <span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] font-semibold leading-snug">
          {latest.title}
        </span>

        {badge && (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold"
            style={{ background: 'var(--nl-brand)', color: '#fff' }}>
            {badge} new
          </span>
        )}

        <ChevronDown size={16} aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--nl-muted)' }} />
      </button>

      {open && (
        <div className="border-t px-3.5 pb-3.5 pt-3" style={{ borderColor: 'var(--nl-rule)' }}>
          <p className="whitespace-pre-line text-[13.5px] leading-relaxed"
            style={{ color: 'var(--nl-ink2)' }}>
            {latest.text}
          </p>
          <Btn to="/announcements" variant="quiet" size="sm"
            className="mt-3 w-full justify-center sm:w-auto">
            {rows.length > 1 ? 'All announcements' : 'Open announcements'}
          </Btn>
        </div>
      )}
    </div>
  );
}

/** Same two colours as the printed sheet, so they read as the same thing. */
function sideColour(side) {
  return side === 'HS' ? '#1e3a8a' : '#065f46';   // blue-900 / emerald-800
}

/** Is this ISO date today? Compared as strings — both are centre-local. */
function isTodayDate(date, today) {
  return !!date && date === today;
}

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

/** " · starts in 2h 15m", or " · underway" once it has begun. */
function startsIn(startTime) {
  const start = minutesOf(startTime);
  if (start == null) return '';
  const now = new Date();
  const mins = start - (now.getHours() * 60 + now.getMinutes());
  if (mins <= 0) return ' · underway';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return ` · starts in ${h > 0 ? `${h}h ` : ''}${m}m`;
}
